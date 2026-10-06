// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, TargetLane } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { NativeExecutor, createNativeExecutor } from '../lib/mcp/native.js';

const ownedLinux = { skip: process.platform !== 'linux' && 'Owned-child PID/executable proof uses Linux /proc' };

// An owned Node child models only the controller's startup/NDJSON boundary.
// It never connects to VNC, launches an application, or uses a real credential.
const source = `
const fs = require('node:fs');
const readline = require('node:readline');
const record = event => fs.appendFileSync(process.env.FRUITCTL_STARTUP_EVENTS,
  JSON.stringify({ event, pid: process.pid, ppid: process.ppid }) + '\\n');
const emit = message => process.stdout.write(JSON.stringify(message) + '\\n');
async function main() {
  let bytes = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(null, { fd: 3 })) bytes = Buffer.concat([bytes, chunk]);
  if (bytes.readUInt32BE(0) !== bytes.length - 4 || Object.hasOwn(process.env, 'VNC_PASSWORD')) process.exit(70);
  bytes.fill(0);
  record('started');
  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    record('owned-term');
    if (process.env.FRUITCTL_STARTUP_MODE === 'never-ready') {
      setTimeout(() => { record('late-ready'); emit({ method: 'ready', params: { scaledWidth: 32, scaledHeight: 16 } }); }, 80);
      setTimeout(() => process.exit(0), 180);
    } else process.exit(0);
  });
  if (process.env.FRUITCTL_STARTUP_MODE === 'normal') {
    emit({ method: 'ready', params: { scaledWidth: 32, scaledHeight: 16 } });
  }
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    record('request:' + request.method);
    emit({ id: request.id, result: { detail: 'OK' } });
    if (request.method === 'shutdown') { clearInterval(keepAlive); process.exit(0); }
  }
}
main().catch(() => process.exit(70));
`;

async function waitUntil(predicate, message, timeoutMs = 1500) {
  const deadline = performance.now() + timeoutMs;
  while (!await predicate()) {
    if (performance.now() >= deadline) assert.fail(message);
    await delay(5);
  }
}

async function fixture(t, mode = 'never-ready') {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const parent = await fs.lstat(scratch);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
  // Keep the socket below the Unix path limit even in a durable evidence root.
  const directory = await fs.mkdtemp(path.join(scratch, 's-'));
  await fs.chmod(directory, 0o700);
  const daemonPath = path.join(directory, 'native.cjs');
  const eventsPath = path.join(directory, 'events.jsonl');
  const credentialFile = path.join(directory, 'synthetic-credential');
  await fs.writeFile(daemonPath, `#!${process.execPath}\n${source}`, { mode: 0o700, flag: 'wx' });
  await fs.writeFile(credentialFile, 'synthetic-only-startup-fixture', { mode: 0o600, flag: 'wx' });
  await fs.writeFile(eventsPath, '', { mode: 0o600, flag: 'wx' });
  const original = { events: process.env.FRUITCTL_STARTUP_EVENTS, mode: process.env.FRUITCTL_STARTUP_MODE };
  process.env.FRUITCTL_STARTUP_EVENTS = eventsPath;
  process.env.FRUITCTL_STARTUP_MODE = mode;
  t.after(async () => {
    for (const [key, value] of [['FRUITCTL_STARTUP_EVENTS', original.events], ['FRUITCTL_STARTUP_MODE', original.mode]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const events = async () => (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const ownership = async () => {
    let started;
    await waitUntil(async () => { started = (await events()).find(event => event.event === 'started'); return started; }, 'owned fixture did not start');
    assert.equal(started.ppid, process.pid, 'the signal target must be this test process\'s own child');
    const status = await fs.readFile(`/proc/${started.pid}/status`, 'utf8');
    assert.match(status, new RegExp(`^PPid:\\s+${process.pid}$`, 'm'));
    assert.match(status, new RegExp(`^Uid:\\s+${process.getuid()}\\s`, 'm'));
    assert.equal(await fs.readlink(`/proc/${started.pid}/exe`), await fs.realpath(process.execPath));
    const arguments_ = (await fs.readFile(`/proc/${started.pid}/cmdline`)).toString().split('\0');
    assert.ok(arguments_.includes(daemonPath), 'owned executable identity must match the generated fixture');
    t.diagnostic(JSON.stringify({ event: 'owned-child-proof', pid: started.pid, ppid: started.ppid,
      uid: process.getuid(), executable: await fs.realpath(process.execPath), fixture: daemonPath }));
    return started.pid;
  };
  return { directory, daemonPath, eventsPath, events, ownership,
    profile: { daemonPath, credentialFile, vnc: { host: '127.0.0.1', port: 5900 } },
    env: { VNC_PASSWORD: 'synthetic-only-startup-fixture', FRUITCTL_STARTUP_EVENTS: eventsPath, FRUITCTL_STARTUP_MODE: mode } };
}

for (const trigger of ['abort', 'deadline']) {
  test(`cold broker ${trigger} retires an owned never-ready child, drains its queue and ignores late readiness`, ownedLinux, async t => {
    const owned = await fixture(t);
    const socketPath = path.join(owned.directory, 's');
    const broker = await createBroker({ socketPath, config: { targets: { desktop: owned.profile } } });
    const lane = broker.lanes.get('desktop');
    const a = new BrokerExecutor({ socketPath, target: 'desktop' });
    const b = new BrokerExecutor({ socketPath, target: 'desktop' });
    t.after(async () => { await a.close(); await b.close(); await broker.close(); });
    await Promise.all([a.opened, b.opened]);
    const controller = new AbortController();
    const startedAt = performance.now();
    const first = a.execute([{ action: 'key_tap', key: 'tab' }],
      { signal: controller.signal, timeoutMs: trigger === 'deadline' ? 250 : 1500 });
    const firstRejected = assert.rejects(first, /deadline|operator startup abort/i);
    const pid = await owned.ownership();
    const queued = a.execute([{ action: 'key_tap', key: 'enter' }], { timeoutMs: 1500 });
    const queuedRejected = assert.rejects(queued, /revoked|released/i);
    await waitUntil(() => lane.waiting === 2, 'second request did not enter the cold queue');
    if (trigger === 'abort') controller.abort(new Error('operator startup abort'));
    await firstRejected;
    const clientTerminalMs = performance.now() - startedAt;
    assert.ok(clientTerminalMs < 600, 'client cancellation must not wait for a fresh 30-second startup budget');
    await assert.rejects(b.execute([{ action: 'health' }]), /another session|releasing/i);
    await queuedRejected;
    await waitUntil(() => lane.waiting === 0 && lane.owner === null, 'cold queue and lease were not retired');
    assert.equal(lane.controllers.size, 0);
    assert.equal(lane.executor, null);
    assert.equal(lane.startup, null);
    await assert.rejects(fs.stat(`/proc/${pid}`), { code: 'ENOENT' });
    const observed = await owned.events();
    assert.equal(observed.filter(event => event.event === 'started').length, 1);
    assert.ok(observed.some(event => event.event === 'owned-term'));
    assert.ok(observed.some(event => event.event === 'late-ready'));
    assert.equal(observed.filter(event => event.event.startsWith('request:')).length, 0,
      'neither the first request nor queued input may reach the late-ready child');
    t.diagnostic(JSON.stringify({ trigger, pid, clientTerminalMs, targetRetiredMs: performance.now() - startedAt,
      lateReadyObserved: true, dispatched: 0, waiting: lane.waiting, controllers: lane.controllers.size }));
  });
}

test('native startup cancellation exposes and confirms its owned child before rejecting readiness', ownedLinux, async t => {
  const owned = await fixture(t);
  const controller = new AbortController();
  let executor;
  const starting = createNativeExecutor({ env: owned.env, daemonPath: owned.daemonPath,
    signal: controller.signal, deadline: performance.now() + 1000, onExecutor: value => { executor = value; } });
  const rejected = assert.rejects(starting, /owned startup abort/);
  const pid = await owned.ownership();
  assert.equal(executor.child.pid, pid);
  controller.abort(new Error('owned startup abort'));
  await rejected;
  assert.ok(executor.terminal);
  assert.equal(executor.isReady, false);
  await executor.closed;
  await assert.rejects(executor.execute([{ action: 'health' }]), /not ready/);
  assert.equal((await owned.events()).filter(event => event.event.startsWith('request:')).length, 0);
});

test('unconfirmed cold close remains sticky while and after the owned child is alive', ownedLinux, async t => {
  const owned = await fixture(t);
  let native;
  const lane = new TargetLane({}, async (_profile, { signal, onExecutor }) => {
    native = new NativeExecutor({ env: owned.env, daemonPath: owned.daemonPath, emitDiagnostics: false });
    onExecutor({ async close() { throw new Error('Synthetic close acknowledgement unavailable'); } });
    await delay(10000, undefined, { signal });
    return native;
  });
  t.after(async () => { await native?.close({ graceful: false }); await assert.rejects(lane.close(), /unconfirmed/); });
  lane.acquire('first');
  const controller = new AbortController();
  const pending = lane.execute([{ action: 'key_tap', key: 'tab' }], { signal: controller.signal });
  const rejected = assert.rejects(pending, /startup cleanup is unconfirmed/);
  const pid = await owned.ownership();
  controller.abort(new Error('owned startup abort'));
  await rejected;
  assert.equal(lane.waiting, 0);
  assert.equal(lane.controllers.size, 0);
  assert.ok((await fs.stat(`/proc/${pid}`)).isDirectory(), 'failed cleanup must not imply the owned child exited');
  assert.throws(() => lane.acquire('successor'), /unconfirmed/);
  await assert.rejects(lane.execute([{ action: 'health' }]), /unconfirmed/);
  assert.equal((await owned.events()).filter(event => event.event.startsWith('request:')).length, 0);
  await native.close({ graceful: false });
  assert.throws(() => lane.acquire('successor'), /unconfirmed/, 'later exit cannot erase prior cleanup uncertainty');
});

test('healthy cold broker preserves one child per lease and confirms release before a successor', ownedLinux, async t => {
  const owned = await fixture(t, 'normal');
  const socketPath = path.join(owned.directory, 's');
  const broker = await createBroker({ socketPath, config: { targets: { desktop: owned.profile } } });
  const a = new BrokerExecutor({ socketPath, target: 'desktop' });
  const b = new BrokerExecutor({ socketPath, target: 'desktop' });
  t.after(async () => { await a.close(); await b.close(); await broker.close(); });
  await Promise.all([a.opened, b.opened]);
  assert.equal((await a.execute([{ action: 'health' }]))[0].result.detail, 'OK');
  const pid = await owned.ownership();
  await a.execute([{ action: 'key_tap', key: 'tab' }]);
  assert.equal((await owned.events()).filter(event => event.event === 'started').length, 1);
  await a.release();
  await assert.rejects(fs.stat(`/proc/${pid}`), { code: 'ENOENT' });
  await b.execute([{ action: 'health' }]);
  await b.release();
  assert.deepEqual((await owned.events()).filter(event => event.event.startsWith('request:')).map(event => event.event),
    ['request:health', 'request:key_tap', 'request:shutdown', 'request:health', 'request:shutdown']);
  assert.equal((await owned.events()).filter(event => event.event === 'started').length, 2);
});

test('cold factory options retain compatibility with existing one-argument executors', async () => {
  let starts = 0;
  const lane = new TargetLane({}, async profile => {
    assert.deepEqual(profile, {});
    starts++;
    return { async execute() { return [{ result: { detail: 'compatible' } }]; }, async close() {} };
  });
  assert.equal((await lane.execute([{ action: 'health' }]))[0].result.detail, 'compatible');
  assert.equal(starts, 1);
  await lane.close();
});
