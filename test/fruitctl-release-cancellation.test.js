// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrokerExecutor } from '../lib/broker/client.mjs';
import { createBroker } from '../lib/broker/server.mjs';
import { readFrames, writeFrame } from '../lib/broker/protocol.mjs';
import { createNativeExecutor } from '../lib/mcp/native.js';

const ownedLinux = { skip: process.platform !== 'linux' && 'Owned-child identity proof uses Linux /proc' };

// This owned Node process exercises NDJSON acknowledgement and actual exit.
// It consumes a synthetic credential pipe and never opens VNC or a GUI.
const source = `
const fs = require('node:fs');
const readline = require('node:readline');
const record = event => fs.appendFileSync(process.env.FRUITCTL_RELEASE_EVENTS,
  JSON.stringify({ event, pid: process.pid, ppid: process.ppid }) + '\\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
async function main() {
  let credential = Buffer.alloc(0);
  for await (const chunk of fs.createReadStream(null, { fd: 3 })) credential = Buffer.concat([credential, chunk]);
  if (credential.readUInt32BE(0) !== credential.length - 4 || Object.hasOwn(process.env, 'VNC_PASSWORD')) process.exit(70);
  credential.fill(0);
  record('started');
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    record('owned-term');
    setTimeout(() => { record('owned-exit'); process.exit(0); }, 250);
  });
  emit({ method: 'ready', params: { scaledWidth: 32, scaledHeight: 16 } });
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    record('request:' + request.method);
    emit({ id: request.id, result: { detail: 'OK' } });
    if (request.method === 'shutdown') {
      record('shutdown-ack');
      if (process.env.FRUITCTL_RELEASE_MODE === 'normal') { record('owned-exit'); process.exit(0); }
    }
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

async function fixture(t, mode = 'slow-exit') {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const stat = await fs.lstat(scratch);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid());
  const directory = await fs.mkdtemp(path.join(scratch, 'r-'));
  await fs.chmod(directory, 0o700);
  const daemonPath = path.join(directory, 'native.cjs');
  const eventsPath = path.join(directory, 'events.jsonl');
  await fs.writeFile(daemonPath, `#!${process.execPath}\n${source}`, { mode: 0o700, flag: 'wx' });
  await fs.writeFile(eventsPath, '', { mode: 0o600, flag: 'wx' });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = async () => (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  const proveChild = async native => {
    const pid = native.child.pid;
    await waitUntil(async () => (await events()).some(event => event.event === 'started' && event.pid === pid), 'owned child did not start');
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    assert.match(status, new RegExp(`^PPid:\\s+${process.pid}$`, 'm'));
    assert.match(status, new RegExp(`^Uid:\\s+${process.getuid()}\\s`, 'm'));
    assert.equal(await fs.readlink(`/proc/${pid}/exe`), await fs.realpath(process.execPath));
    assert.ok((await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0').includes(daemonPath));
    t.diagnostic(JSON.stringify({ event: 'owned-child-proof', pid, ppid: process.pid,
      uid: process.getuid(), executable: await fs.realpath(process.execPath), fixture: daemonPath }));
    return pid;
  };
  return { directory, socketPath: path.join(directory, 's'), events, proveChild,
    nativeOptions: { daemonPath, emitDiagnostics: false, env: {
      VNC_PASSWORD: 'synthetic-only-release-fixture', FRUITCTL_RELEASE_EVENTS: eventsPath,
      FRUITCTL_RELEASE_MODE: mode,
    } } };
}

async function ownedBroker(t, mode, { holdMs = 0, failReleaseAfterAck = false } = {}) {
  const owned = await fixture(t, mode);
  const natives = [];
  const releaseOptions = [];
  const dispatched = [];
  const broker = await createBroker({ socketPath: owned.socketPath,
    config: { targets: { desktop: {} } }, factory: async (_profile, options) => {
      const native = await createNativeExecutor({ ...owned.nativeOptions,
        env: { ...owned.nativeOptions.env }, ...options });
      natives.push(native);
      return {
        async execute(actions, options) {
          dispatched.push(actions[0].action);
          if (actions[0].action === 'hold') {
            // Deliberately ignores cancellation to prove the queue wait itself
            // cannot extend an explicit release deadline or admit queued input.
            await delay(holdMs);
            return [{ result: { detail: 'synthetic held request finished' } }];
          }
          return native.execute(actions, options);
        },
        release(options) {
          releaseOptions.push(options);
          if (failReleaseAfterAck) {
            return native.execute([{ action: 'shutdown' }], options).then(() => {
              throw new Error('Synthetic executor release deadline exceeded');
            });
          }
          return native.release(options);
        },
        close(options) { return native.close(options); },
      };
    } });
  const a = new BrokerExecutor({ socketPath: owned.socketPath, target: 'desktop' });
  const b = new BrokerExecutor({ socketPath: owned.socketPath, target: 'desktop' });
  const lane = broker.lanes.get('desktop');
  t.after(async () => {
    await a.close(); await b.close();
    await Promise.all(natives.map(native => native.close({ graceful: false })));
    if (lane.cleanupFailure) await assert.rejects(broker.close(), /unconfirmed/);
    else await broker.close();
  });
  await Promise.all([a.opened, b.opened]);
  await a.execute([{ action: 'health' }]);
  const pid = await owned.proveChild(natives[0]);
  return { ...owned, broker, lane, a, b, natives, releaseOptions, dispatched, pid };
}

for (const trigger of ['abort', 'deadline', 'wire-cancel']) {
  test(`explicit release ${trigger} reaches owned cleanup promptly and stays unconfirmed after late exit`, ownedLinux, async t => {
    const owned = await ownedBroker(t, 'slow-exit');
    const controller = new AbortController();
    const startedAt = performance.now();
    const releasing = owned.a.release({ signal: controller.signal, timeoutMs: trigger === 'deadline' ? 100 : 1000 });
    const rejected = assert.rejects(releasing, /unconfirmed/);
    await waitUntil(async () => (await owned.events()).some(event => event.event === 'shutdown-ack'), 'release did not receive shutdown acknowledgement');
    assert.equal(owned.releaseOptions.length, 1);
    assert.ok(owned.releaseOptions[0].signal instanceof AbortSignal);
    assert.ok(owned.releaseOptions[0].timeoutMs > 0 && owned.releaseOptions[0].timeoutMs <= (trigger === 'deadline' ? 100 : 1000));
    await assert.rejects(owned.b.execute([{ action: 'key_tap', key: 'enter' }]), /controlled|releasing/);
    const cancelledAt = performance.now();
    if (trigger === 'abort') controller.abort(new Error('operator release abort'));
    if (trigger === 'wire-cancel') {
      const [id] = owned.a.pending.keys();
      writeFrame(owned.a.socket, { v: 1, kind: 'cancel', id });
    }
    await rejected;
    const terminalMs = performance.now() - (trigger === 'deadline' ? startedAt : cancelledAt);
    assert.ok(terminalMs < 300, 'release must not wait for the fresh native default or the owned late exit');
    await waitUntil(() => Boolean(owned.lane.cleanupFailure) && owned.releaseOptions[0].signal.aborted, 'server release controller did not retain cancellation');
    const sticky = owned.lane.cleanupFailure;
    assert.ok((await fs.stat(`/proc/${owned.pid}`)).isDirectory(), 'prompt rejection must not claim that the owned child already exited');
    if (trigger === 'wire-cancel') assert.equal(owned.a.closed, false, 'wire cancellation must work without relying on client disconnect');
    await assert.rejects(owned.b.execute([{ action: 'key_tap', key: 'tab' }]), /unconfirmed/);
    await owned.natives[0].closed;
    await assert.rejects(fs.stat(`/proc/${owned.pid}`), { code: 'ENOENT' });
    await assert.rejects(owned.b.execute([{ action: 'health' }]), /unconfirmed/);
    assert.equal(owned.lane.cleanupFailure, sticky, 'actual late exit cannot erase unconfirmed input cleanup');
    assert.equal(owned.natives.length, 1);
    assert.deepEqual(owned.dispatched, ['health']);
    assert.deepEqual((await owned.events()).filter(event => event.event.startsWith('request:')).map(event => event.event),
      ['request:health', 'request:shutdown']);
    assert.equal(owned.a.pending.size, 0);
    t.diagnostic(JSON.stringify({ trigger, pid: owned.pid, terminalMs,
      requestedBudgetMs: trigger === 'deadline' ? 100 : 1000, nativeRemainingMs: owned.releaseOptions[0].timeoutMs,
      lateExitConfirmed: true, successorStarts: 0, cleanupSticky: true }));
  });
}

test('executor-originated release failure aborts its shared retirement before the outer deadline', ownedLinux, async t => {
  const owned = await ownedBroker(t, 'slow-exit', { failReleaseAfterAck: true });
  const startedAt = performance.now();
  await assert.rejects(owned.a.release({ timeoutMs: 1000 }), /unconfirmed/);
  const terminalMs = performance.now() - startedAt;
  const failure = owned.lane.cleanupFailure;
  assert.ok(failure);
  assert.equal(owned.a.closed, false, 'the executor failure must settle through the broker before the client deadline');
  assert.equal(owned.releaseOptions.length, 1);
  assert.equal(owned.releaseOptions[0].signal.aborted, true, 'executor failure must revoke shared retirement without waiting for another timer');
  assert.equal(owned.releaseOptions[0].signal.reason, failure);
  assert.equal(owned.natives[0].shutdownAcknowledged, true);
  assert.ok((await fs.stat(`/proc/${owned.pid}`)).isDirectory(), 'unconfirmed acknowledgement must not claim owned exit');
  await assert.rejects(owned.b.execute([{ action: 'key_tap', key: 'tab' }]), /unconfirmed/);
  await owned.natives[0].closed;
  await assert.rejects(fs.stat(`/proc/${owned.pid}`), { code: 'ENOENT' });
  await assert.rejects(owned.b.execute([{ action: 'health' }]), /unconfirmed/);
  assert.equal(owned.lane.cleanupFailure, failure, 'later owned exit cannot clear executor-originated failure');
  assert.deepEqual(owned.dispatched, ['health']);
  assert.equal(owned.natives.length, 1);
  assert.deepEqual((await owned.events()).filter(event => event.event.startsWith('request:')).map(event => event.event),
    ['request:health', 'request:shutdown']);
  t.diagnostic(JSON.stringify({ trigger: 'executor-originated', pid: owned.pid,
    terminalMs, requestedBudgetMs: 1000,
    signalAborted: true, failureBoundAsSignalReason: true, lateExitConfirmed: true,
    successorStarts: 0, cleanupSticky: true }));
});

test('explicit release deadline includes an uncooperative active queue and revokes queued input', ownedLinux, async t => {
  const owned = await ownedBroker(t, 'slow-exit', { holdMs: 200 });
  const active = owned.a.execute([{ action: 'hold' }]);
  const activeRejected = assert.rejects(active, /unconfirmed/);
  const queued = owned.a.execute([{ action: 'key_tap', key: 'tab' }]);
  const queuedRejected = assert.rejects(queued, /revoked|released|unconfirmed/);
  await waitUntil(() => owned.lane.waiting === 2 && owned.dispatched.includes('hold'), 'owned hold did not enter the queue');
  const startedAt = performance.now();
  await assert.rejects(owned.a.release({ timeoutMs: 60 }), /unconfirmed/);
  assert.ok(performance.now() - startedAt < 180, 'queue drain must consume the same release budget');
  await activeRejected;
  await queuedRejected;
  await waitUntil(() => owned.lane.waiting === 0, 'revoked queue did not drain');
  await owned.natives[0].closed;
  await assert.rejects(owned.b.execute([{ action: 'health' }]), /unconfirmed/);
  assert.deepEqual(owned.dispatched, ['health', 'hold']);
  assert.equal(owned.releaseOptions.length, 1, 'interrupted execution starts safety retirement once');
  assert.ok(owned.releaseOptions[0].timeoutMs > 0 && owned.releaseOptions[0].timeoutMs <= 60,
    'active retirement inherits the tighter explicit release budget');
  assert.equal(owned.releaseOptions[0].signal.aborted, true);
  assert.equal(owned.natives.length, 1);
});

test('confirmed explicit release waits for acknowledgement and actual owned exit before a successor', ownedLinux, async t => {
  const owned = await ownedBroker(t, 'normal');
  await owned.a.release({ timeoutMs: 1000 });
  await assert.rejects(fs.stat(`/proc/${owned.pid}`), { code: 'ENOENT' });
  assert.equal(owned.natives[0].shutdownAcknowledged, true);
  assert.equal(owned.lane.owner, null);
  assert.equal(owned.lane.cleanupFailure, undefined);
  await owned.b.execute([{ action: 'health' }]);
  await owned.proveChild(owned.natives[1]);
  await owned.b.release({ timeoutMs: 1000 });
  assert.equal(owned.natives.length, 2);
  const events = await owned.events();
  const firstExit = events.findIndex(event => event.event === 'owned-exit' && event.pid === owned.pid);
  const successor = events.findIndex(event => event.event === 'started' && event.pid !== owned.pid);
  assert.ok(firstExit >= 0 && successor > firstExit);
});

test('a second release caller can shorten an existing owned retirement budget', ownedLinux, async t => {
  const owned = await ownedBroker(t, 'slow-exit');
  const original = owned.a.release({ timeoutMs: 1000 });
  const originalRejected = assert.rejects(original, /unconfirmed/);
  await waitUntil(async () => (await owned.events()).some(event => event.event === 'shutdown-ack'), 'first release did not acknowledge shutdown');
  const startedAt = performance.now();
  await assert.rejects(owned.lane.release(owned.lane.owner, { timeoutMs: 40 }), /unconfirmed/);
  await originalRejected;
  assert.ok(performance.now() - startedAt < 160, 'a reused release promise cannot discard the second caller deadline');
  assert.equal(owned.releaseOptions.length, 1, 'retirement is never replayed for the second caller');
  assert.equal(owned.releaseOptions[0].signal.aborted, true);
  await owned.natives[0].closed;
  await assert.rejects(owned.b.execute([{ action: 'health' }]), /unconfirmed/);
  assert.equal(owned.natives.length, 1);
});

test('client release shares one deadline between delayed opening and RPC and emits the remaining budget', ownedLinux, async t => {
  const owned = await fixture(t);
  const frames = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    readFrames(socket, frame => {
      frames.push(frame);
      if (frame.kind === 'open') setTimeout(() => writeFrame(socket, { v: 1, kind: 'opened' }), 100);
    }, error => assert.fail(error.message));
  });
  await new Promise(resolve => server.listen(owned.socketPath, resolve));
  await fs.chmod(owned.socketPath, 0o600);
  const client = new BrokerExecutor({ socketPath: owned.socketPath, target: 'desktop' });
  t.after(async () => { await client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const startedAt = performance.now();
  await assert.rejects(client.release({ timeoutMs: 180 }), /unconfirmed.*deadline/i);
  const terminalMs = performance.now() - startedAt;
  assert.ok(terminalMs >= 140 && terminalMs < 260, 'opening cannot reset the release deadline');
  await waitUntil(() => frames.some(frame => frame.kind === 'release'), 'release frame was not received');
  const release = frames.find(frame => frame.kind === 'release');
  assert.ok(release.timeoutMs > 0 && release.timeoutMs < 110, 'RPC must carry only the remaining budget');
  assert.equal(client.pending.size, 0);
  assert.equal(client.closed, true);
  t.diagnostic(JSON.stringify({ event: 'total-open-rpc-budget', timeoutMs: 180, terminalMs, remainingMs: release.timeoutMs }));
});

test('client release refuses invalid or pre-aborted deadlines before any release frame', ownedLinux, async t => {
  const owned = await fixture(t);
  const frames = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    readFrames(socket, frame => {
      frames.push(frame);
      if (frame.kind === 'open') writeFrame(socket, { v: 1, kind: 'opened' });
    }, error => assert.fail(error.message));
  });
  await new Promise(resolve => server.listen(owned.socketPath, resolve));
  await fs.chmod(owned.socketPath, 0o600);
  const client = new BrokerExecutor({ socketPath: owned.socketPath, target: 'desktop' });
  t.after(async () => { await client.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  await client.opened;
  for (const timeoutMs of [0, -1, NaN, Infinity]) await assert.rejects(client.release({ timeoutMs }), /Invalid operation deadline/);
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted release'));
  await assert.rejects(client.release({ signal: controller.signal }), /pre-aborted/);
  await delay(10);
  assert.equal(frames.filter(frame => frame.kind === 'release').length, 0);
  assert.equal(client.pending.size, 0);
});
