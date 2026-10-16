// SPDX-License-Identifier: MIT
// Native input parity (TIN-6597): schema, D27 batch-scoped mouse holds and
// their private native scope. Offline; never connects to a desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNativeExecutor } from '../index.js';
import { createMcpServer, McpSession } from '../lib/mcp/server.js';
import { validateActionParameters, validateActionBatch, INPUT_REFUSED_CODE } from '../tools/index.js';

const NEW_ACTIONS = ['triple_click', 'cursor_position', 'hold_key', 'mouse_down', 'mouse_up'];
const undeclared = { route: 'unknown', indicator: 'unknown' };

function recordingExecutor() {
  return {
    batches: [],
    async execute(actions) {
      this.batches.push(actions);
      return actions.map(() => ({ result: { detail: 'OK' } }));
    },
  };
}

test('both tools publish the parity actions and fields without a public hold scope', async (t) => {
  const { server } = createMcpServer({ executor: recordingExecutor() });
  const client = new Client({ name: 'offline-native-input-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  const command = tools.find(tool => tool.name === 'vnc_command').inputSchema;
  const queue = tools.find(tool => tool.name === 'action_queue').inputSchema.properties.actions.items;
  for (const schema of [command, queue]) {
    for (const action of NEW_ACTIONS) assert.ok(schema.properties.action.enum.includes(action), action);
    assert.deepEqual(schema.properties.button.enum, ['left', 'right', 'middle']);
    assert.ok(schema.properties.modifiers.items.enum.includes('cmd'));
    assert.equal(schema.properties.duration_ms.maximum, 10000);
    assert.equal(Object.hasOwn(schema.properties, 'hold_scope'), false);
  }
  const description = tools.find(tool => tool.name === 'action_queue').description;
  assert.match(description, /force-released at\s+batch end or abort/);
});

test('vnc_command refuses mouse_down and mouse_up with a typed error before the executor', async () => {
  const executor = recordingExecutor();
  const session = new McpSession(executor);
  for (const action of ['mouse_down', 'mouse_up']) {
    const result = await session.command({ action, x: 1, y: 1 });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /only valid inside one action_queue batch/);
    assert.deepEqual(result.structuredContent, { error: { code: INPUT_REFUSED_CODE,
      message: `${action} is only valid inside one action_queue batch`,
      data: { reason: 'hold_outside_batch' } }, ...undeclared });
  }
  assert.deepEqual(executor.batches, []);
  // Every other parity action reaches the executor as one ordinary command.
  for (const input of [{ action: 'triple_click', x: 1, y: 2 }, { action: 'cursor_position' },
    { action: 'hold_key', key: 'shift', duration_ms: 200 },
    { action: 'mouse_click', x: 1, y: 1, button: 'right', modifiers: ['cmd', 'shift'] },
    { action: 'mouse_drag', x: 1, y: 1, toX: 9, toY: 9, button: 'middle' }]) {
    assert.equal((await session.command(input)).isError, undefined);
  }
  assert.equal(executor.batches.length, 5);
});

test('action_queue admits a balanced hold batch and refuses an unbalanced one before admission', async () => {
  const executor = recordingExecutor();
  const session = new McpSession(executor);
  const actions = [{ action: 'mouse_down', x: 1, y: 1 }, { action: 'mouse_move', x: 5, y: 5 },
    { action: 'mouse_down', x: 5, y: 5, button: 'right' }, { action: 'mouse_up', button: 'right' },
    { action: 'mouse_up', x: 6, y: 6 }];
  const ok = await session.queue({ actions });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(ok.structuredContent, { completed: 5, ...undeclared });
  // A hold left open is legal: the executor force-releases it at batch end.
  assert.equal((await session.queue({ actions: [{ action: 'mouse_down', x: 1, y: 1 }] })).isError, undefined);
  assert.equal(executor.batches.length, 2);
  for (const [unbalanced, reason] of [
    [[{ action: 'mouse_up' }], 'button_not_held'],
    [[{ action: 'mouse_down', x: 1, y: 1 }, { action: 'mouse_up', button: 'middle' }], 'button_not_held'],
    [[{ action: 'mouse_down', x: 1, y: 1 }, { action: 'mouse_down', x: 2, y: 2 }], 'button_already_held'],
  ]) {
    const result = await session.queue({ actions: unbalanced });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.completed, 0);
    assert.equal(result.structuredContent.failedIndex, 1);
    assert.equal(result.structuredContent.error.code, INPUT_REFUSED_CODE);
    assert.deepEqual(result.structuredContent.error.data, { reason });
  }
  assert.equal(executor.batches.length, 2);
});

test('parameter validation covers hold_key, modifier placement and mouse_up coordinates', () => {
  assert.throws(() => validateActionParameters({ action: 'hold_key', key: 'a' }), /Missing duration_ms/);
  assert.throws(() => validateActionParameters({ action: 'triple_click', x: 1 }), /Missing y/);
  assert.throws(() => validateActionParameters({ action: 'mouse_down', x: 1 }), /Missing y/);
  assert.throws(() => validateActionParameters({ action: 'mouse_up', x: 1 }), /both x and y/);
  assert.throws(() => validateActionParameters({ action: 'mouse_double_click', x: 1, y: 1, modifiers: ['cmd'] }),
    /only to mouse_click/);
  validateActionParameters({ action: 'mouse_up' });
  validateActionParameters({ action: 'cursor_position' });
  validateActionBatch([{ action: 'mouse_down', x: 1, y: 1 }, { action: 'mouse_up' },
    { action: 'mouse_down', x: 1, y: 1 }]);
});

// A recording native daemon: it answers every request and reports what it
// received through health. Mode "release-error" refuses release_holds.
const source = `
const fs = require('node:fs');
const readline = require('node:readline');
const received = [];
const emit = value => new Promise((resolve, reject) =>
  process.stdout.write(JSON.stringify(value) + '\\n', error => error ? reject(error) : resolve()));
async function main() {
  let credential = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(null, { fd: 3, autoClose: true })) credential = Buffer.concat([credential, chunk]);
  credential.fill(0);
  const mode = process.env.FRUITCTL_FIXTURE_MODE;
  await emit({ method: 'ready', params: { scaledWidth: 64, scaledHeight: 32 } });
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === 'shutdown') { await emit({ id: request.id, result: { detail: 'OK' } }); process.exit(0); }
    if (request.method === 'health') { await emit({ id: request.id, result: { detail: JSON.stringify(received) } }); continue; }
    received.push({ method: request.method, ...(request.params || {}) });
    if (request.method === 'release_holds' && mode === 'release-error') {
      await emit({ id: request.id, error: { code: -32000, message: 'release unconfirmed' } }); continue;
    }
    if (request.params?.button === 'middle') {
      await emit({ id: request.id, error: { code: -32011, message: 'Mouse button is not held in this batch',
        data: { reason: 'button_not_held' } } });
      continue;
    }
    await emit({ id: request.id, result: { detail: 'OK' } });
  }
}
main().catch(() => process.exit(70));
`;

async function nativeFixture(t, mode = 'normal') {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const directory = fs.mkdtempSync(path.join(scratch, 'fruitctl-native-input-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'native.cjs');
  fs.writeFileSync(file, `#!${process.execPath}\n${source}`, { mode: 0o700, flag: 'wx' });
  let executor;
  t.after(async () => {
    if (executor) await executor.close();
    fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  executor = await createNativeExecutor({ env: { VNC_PASSWORD: 'owned-offline-fixture', FRUITCTL_FIXTURE_MODE: mode },
    daemonPath: file, log: () => {} });
  const received = async () => JSON.parse((await executor.execute([{ action: 'health' }]))[0].result.detail);
  return { executor, received };
}

test('native executor scopes one hold batch, strips caller scopes and releases at batch end', async (t) => {
  const { executor, received } = await nativeFixture(t);
  const responses = await executor.execute([{ action: 'mouse_down', x: 1, y: 1, hold_scope: 'caller-forged' },
    { action: 'mouse_move', x: 5, y: 5 }, { action: 'mouse_up' }]);
  assert.equal(responses.length, 3); // The release acknowledgement is not a batch result.
  await executor.execute([{ action: 'mouse_click', x: 1, y: 1, hold_scope: 'caller-forged' }]);
  const log = await received();
  assert.deepEqual(log.map(entry => entry.method),
    ['mouse_down', 'mouse_move', 'mouse_up', 'release_holds', 'mouse_click']);
  const scope = log[0].hold_scope;
  assert.match(scope, /^[0-9a-f-]{36}$/);
  assert.ok(log.slice(0, 4).every(entry => entry.hold_scope === scope));
  // A batch without a hold carries no scope and sends no release.
  assert.equal(Object.hasOwn(log[4], 'hold_scope'), false);
});

test('native executor releases after a failed hold batch and keeps the first error as the result', async (t) => {
  const { executor, received } = await nativeFixture(t);
  const responses = await executor.execute([{ action: 'mouse_down', x: 1, y: 1 },
    { action: 'mouse_up', button: 'middle' }, { action: 'mouse_move', x: 2, y: 2 }]);
  assert.equal(responses.length, 2);
  assert.equal(responses[1].error.data.reason, 'button_not_held');
  const log = await received();
  assert.deepEqual(log.map(entry => entry.method), ['mouse_down', 'mouse_up', 'release_holds']);
  assert.equal(log[2].hold_scope, log[0].hold_scope);
});

test('an outer executor scope is forwarded without an extra release; invalid scopes are refused', async (t) => {
  const { executor, received } = await nativeFixture(t);
  await executor.execute([{ action: 'mouse_down', x: 1, y: 1 }], { holdScope: 'outer-batch' });
  await executor.execute([{ action: 'release_holds' }], { holdScope: 'outer-batch' });
  // Every executor request also carries its own deadline_ms budget (TIN-5509).
  const log = await received();
  assert.ok(log.every(entry => Number.isSafeInteger(entry.deadline_ms) && entry.deadline_ms > 0));
  assert.deepEqual(log.map(({ deadline_ms: _budget, ...entry }) => entry),
    [{ method: 'mouse_down', x: 1, y: 1, hold_scope: 'outer-batch' },
      { method: 'release_holds', hold_scope: 'outer-batch' }]);
  await assert.rejects(executor.execute([{ action: 'wait' }], { holdScope: 'not a token' }), /Invalid native hold scope/);
});

test('an unconfirmed batch-end release retires the native executor', async (t) => {
  const { executor } = await nativeFixture(t, 'release-error');
  await assert.rejects(executor.execute([{ action: 'mouse_down', x: 1, y: 1 }]), /hold release unconfirmed/);
  await assert.rejects(executor.execute([{ action: 'wait' }]), /release unconfirmed|not ready/);
});
