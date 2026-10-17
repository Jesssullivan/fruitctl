// SPDX-License-Identifier: MIT
// D8/D29 clipboard and text policy on the Darwin broker: profile to daemon
// launch, the private routing field, and clipboard_read bounding/redaction.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { boundClipboard } from '../lib/mcp/clipboard.js';
import { nativeFactory } from '../lib/broker/server.mjs';
import { loadConfig, usCompatibleInputSource } from '../lib/broker/paths.mjs';
import { summarizeResponse } from '../lib/broker/journal.mjs';
import { isPreAdmissionRefusal } from '../lib/mcp/capabilities.js';

// Owned fake controller: answers health with its argv, key_type/paste with
// the params it received, and clipboard_read with FRUITCTL_FIXTURE_CLIPBOARD.
const source = `
const fs = require('node:fs');
const readline = require('node:readline');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
async function main() {
  for await (const _chunk of fs.createReadStream(null, { fd: 3, autoClose: true })) {}
  emit({ method: 'ready', params: { scaledWidth: 64, scaledHeight: 32,
    capabilities: ['health', 'key_type', 'paste', 'clipboard_read', 'shutdown'] } });
  const received = [];
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    received.push(request.method);
    if (request.method === 'shutdown') { emit({ id: request.id, result: { detail: 'OK' } }); process.exit(0); }
    if (request.method === 'health') {
      emit({ id: request.id, result: { detail: JSON.stringify({ argv: process.argv.slice(2), received }) } });
    } else if (request.method === 'clipboard_read') {
      emit({ id: request.id, result: { clipboard: { text: process.env.FRUITCTL_FIXTURE_CLIPBOARD,
        encoding: 'utf8', age_ms: 0, fresh: true } } });
    } else {
      const { deadline_ms: _budget, ...params } = request.params || {};
      emit({ id: request.id, result: { detail: JSON.stringify(params) } });
    }
  }
}
main().catch(() => process.exit(70));
`;

function ownedTarget(t) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const directory = fs.mkdtempSync(path.join(scratch, 'fruitctl-clipboard-'));
  fs.chmodSync(directory, 0o700);
  const daemonPath = path.join(directory, 'native.cjs');
  const credentialFile = path.join(directory, 'credential');
  fs.writeFileSync(daemonPath, `#!${process.execPath}\n${source}`, { mode: 0o700, flag: 'wx' });
  fs.writeFileSync(credentialFile, 'owned-fixture-vnc-credential\n', { mode: 0o600, flag: 'wx' });
  const previous = process.env.FRUITCTL_FIXTURE_CLIPBOARD;
  t.after(() => {
    if (previous === undefined) delete process.env.FRUITCTL_FIXTURE_CLIPBOARD;
    else process.env.FRUITCTL_FIXTURE_CLIPBOARD = previous;
    fs.rmSync(directory, { recursive: true });
  });
  const start = async (profile) => {
    const executor = await nativeFactory({ vnc: { host: '127.0.0.1', port: 5900 }, credentialFile, daemonPath,
      ...profile }, { deadline: performance.now() + 10000 });
    t.after(() => executor.close());
    return executor;
  };
  return { start, directory };
}

const detail = response => JSON.parse(response.result.detail);

test('clipboard text containing a declared secret is withheld whole, before truncation', () => {
  const secrets = ['owned-secret-value', 'pin'];
  assert.deepEqual(boundClipboard({ text: 'prefix owned-secret-value', encoding: 'utf8' }, { secrets, maxBytes: 4 }),
    { encoding: 'utf8', bytes: 25, redacted: true });
  // Short secrets match only exactly, so ordinary words still read.
  assert.equal(boundClipboard({ text: 'pin', encoding: 'utf8' }, { secrets }).redacted, true);
  assert.equal(boundClipboard({ text: 'spinning', encoding: 'utf8' }, { secrets }).text, 'spinning');
  // Truncation keeps whole UTF-8 code points and reports the original size.
  assert.deepEqual(boundClipboard({ text: 'ab€cd', encoding: 'utf8' }, { maxBytes: 4 }),
    { encoding: 'utf8', text: 'ab', bytes: 7, truncated: true });
  assert.deepEqual(boundClipboard({ text: 'ab€cd', encoding: 'utf8' }, { maxBytes: 5 }),
    { encoding: 'utf8', text: 'ab€', bytes: 7, truncated: true });
  assert.throws(() => boundClipboard(undefined), /Invalid native clipboard result/);
});

test('an opted-in profile launches the controller with its policy and routes only key_type', async (t) => {
  const { start } = ownedTarget(t);
  process.env.FRUITCTL_FIXTURE_CLIPBOARD = 'copied owned-fixture-vnc-credential';
  const executor = await start({ inputSource: 'com.apple.keylayout.German', input: { pasteUnmappable: true },
    clipboard: { read: true, ttlMs: 5000, extended: false } });
  const [typed, pasted, read, health] = await executor.execute([
    { action: 'key_type', text: 'Grüße' }, { action: 'paste', text: 'x', unmappable: 'paste' },
    { action: 'clipboard_read' }, { action: 'health' }]);
  assert.deepEqual(detail(typed), { text: 'Grüße', unmappable: 'paste' });
  // A caller cannot request routing; only the executor adds it, to key_type.
  assert.deepEqual(detail(pasted), { text: 'x' });
  // The VNC credential is a declared secret: the text never leaves the broker.
  assert.deepEqual(read.result.clipboard, { encoding: 'utf8', age_ms: 0, fresh: true, bytes: 35, redacted: true });
  assert.equal(JSON.stringify(read).includes('owned-fixture-vnc-credential'), false);
  assert.equal(JSON.stringify(summarizeResponse(read)).includes('copied'), false);
  const { argv } = detail(health);
  for (const flag of ['--no-extended-clipboard', '--clipboard-read', '--paste-unmappable', '--non-us-input-source']) {
    assert.ok(argv.includes(flag), flag);
  }
  assert.deepEqual(argv.slice(argv.indexOf('--clipboard-ttl-ms'), argv.indexOf('--clipboard-ttl-ms') + 2),
    ['--clipboard-ttl-ms', '5000']);
});

test('a default profile adds no flags, never routes, and refuses clipboard_read before admission', async (t) => {
  const { start } = ownedTarget(t);
  process.env.FRUITCTL_FIXTURE_CLIPBOARD = 'never returned';
  const executor = await start({ inputSource: 'com.apple.keylayout.US' });
  const [typed] = await executor.execute([{ action: 'key_type', text: 'é', unmappable: 'paste' }]);
  assert.deepEqual(detail(typed), { text: 'é' });
  await assert.rejects(executor.execute([{ action: 'clipboard_read' }]), error => {
    assert.equal(error.code, 'clipboard_read_disabled');
    assert.ok(isPreAdmissionRefusal(error));
    return true;
  });
  const { argv, received } = detail((await executor.execute([{ action: 'health' }]))[0]);
  assert.deepEqual(received, ['key_type', 'health']);
  for (const flag of ['--no-extended-clipboard', '--clipboard-read', '--clipboard-ttl-ms', '--paste-unmappable',
    '--non-us-input-source']) assert.equal(argv.includes(flag), false, flag);
});

test('profile input and clipboard policies are validated, and only US-type sources skip refusal', async (t) => {
  const { directory } = ownedTarget(t);
  const file = path.join(directory, 'config.json');
  const load = async target => {
    fs.writeFileSync(file, JSON.stringify({ schema: 'fruitctl.config.v1', targets: { desktop: target } }));
    return loadConfig(file);
  };
  await load({ input: { pasteUnmappable: true }, clipboard: { read: true, ttlMs: 1000, maxBytes: 1, extended: true } });
  for (const invalid of [{ input: { pasteUnmappable: 'yes' } }, { input: { pasteUnmapable: true } },
    { clipboard: { ttlMs: 60000 } }, { clipboard: { read: true, maxBytes: 0 } },
    { clipboard: { read: true, ttlMs: 999 } }, { clipboard: { reads: true } }, { clipboard: [] }]) {
    await assert.rejects(load(invalid), /Invalid target profile input or clipboard policy/, JSON.stringify(invalid));
  }
  for (const source of [undefined, 'com.apple.keylayout.US', 'com.apple.keylayout.ABC', 'U.S.']) {
    assert.equal(usCompatibleInputSource(source), true, source);
  }
  for (const source of ['com.apple.keylayout.German', 'com.apple.keylayout.Dvorak',
    'com.apple.keylayout.USInternational-PC', 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese']) {
    assert.equal(usCompatibleInputSource(source), false, source);
  }
});

test('MCP output shows bounded clipboard text, and only a notice when it was withheld', async () => {
  const { McpSession } = await import('../lib/mcp/server.js');
  const answer = clipboard => new McpSession({ execute: async () => [{ result: { clipboard } }] })
    .command({ action: 'clipboard_read' });
  const shown = await answer({ text: 'ab', encoding: 'latin1', age_ms: 1200, fresh: false, bytes: 7, truncated: true });
  assert.deepEqual(shown.content.map(block => block.text), ['ab', 'clipboard: 7 bytes, latin1, 1200ms old, truncated']);
  const withheld = await answer({ encoding: 'utf8', age_ms: 0, fresh: true, bytes: 9, redacted: true });
  assert.deepEqual(withheld.content.map(block => block.text), ['clipboard: withheld; it contains a declared secret']);
  assert.equal(withheld.structuredContent.clipboard.text, undefined);
});

test('the journal records a paste-routed key_type as kind paste and never clipboard text', () => {
  assert.deepEqual(summarizeResponse({ result: { detail: 'OK', kind: 'paste' } }).summary,
    { outcome: 'ok', detail: 'OK', kind: 'paste' });
  assert.deepEqual(summarizeResponse({ result: { detail: 'OK' } }).summary, { outcome: 'ok', detail: 'OK' });
  assert.deepEqual(summarizeResponse({ result: { clipboard: { text: 'copied text', encoding: 'utf8' } } }).summary,
    { outcome: 'ok', clipboard: { redacted: false } });
});

test('the broker lane withholds clipboard text holding an allowlisted secret and caps the rest', async t => {
  const { TargetLane } = await import('../lib/broker/server.mjs');
  const { directory } = ownedTarget(t);
  const login = path.join(directory, 'login');
  fs.writeFileSync(login, 'lane-allowlisted-secret\n', { mode: 0o600, flag: 'wx' });
  let text;
  let executed = 0;
  const executor = { capabilities: { known: true, actions: ['clipboard_read'] },
    async execute(actions, { onResponse }) {
      executed++;
      const responses = actions.map((_, id) => ({ id, result: { clipboard: { text, encoding: 'utf8', age_ms: 0,
        fresh: true, bytes: Buffer.byteLength(text) } } }));
      responses.forEach(response => onResponse?.(response));
      return responses;
    }, async close() {} };
  const profile = { clipboard: { read: true, maxBytes: 8 }, secrets: { login: { provider: 'file', path: login } } };
  const lane = new TargetLane(profile, async () => executor, { name: 'desk' });
  t.after(() => lane.close());
  // The check runs on the whole text, so a secret past the cap is still found.
  text = 'copied: lane-allowlisted-secret';
  const progress = [];
  const [held] = await lane.execute([{ action: 'clipboard_read' }], { onResponse: response => progress.push(response) });
  assert.deepEqual(held.result.clipboard, { encoding: 'utf8', age_ms: 0, fresh: true, bytes: 31, redacted: true });
  assert.equal(JSON.stringify(progress).includes('lane-allowlisted'), false);
  text = 'harmless clipboard';
  const [capped] = await lane.execute([{ action: 'clipboard_read' }]);
  assert.deepEqual(capped.result.clipboard,
    { encoding: 'utf8', age_ms: 0, fresh: true, text: 'harmless', bytes: 18, truncated: true });
  // An allowlisted secret that cannot be resolved refuses the read before admission.
  const broken = new TargetLane({ clipboard: { read: true },
    secrets: { gone: { provider: 'file', path: path.join(directory, 'never-materialized') } } }, async () => executor);
  t.after(() => broken.close());
  await assert.rejects(broken.execute([{ action: 'clipboard_read' }]), error => {
    assert.equal(error.code, 'secret_unavailable');
    assert.ok(isPreAdmissionRefusal(error));
    return true;
  });
  assert.equal(executed, 2);
});
