// SPDX-License-Identifier: MIT
// D7 route/indicator labels: offline only; no desktop, Host or VNC server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { presentationLabels, unattestedLabels, RAW_PRESENTATION, nativeCapabilities,
  isPreAdmissionRefusal } from '../lib/mcp/capabilities.js';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';
import { readFrames, writeFrame } from '../lib/broker/protocol.mjs';
import { createMcpServer, McpSession } from '../lib/mcp/server.js';
import { NativeExecutor } from '../lib/mcp/native.js';
import { HostHelperExecutor } from '../lib/broker/host-helper.mjs';
import { createBroker } from '../lib/broker/server.mjs';
import { BrokerExecutor } from '../lib/broker/client.mjs';

const presentationOf = (Class, state) =>
  Object.getOwnPropertyDescriptor(Class.prototype, 'presentation').get.call(state);

test('label normalization keeps raw absent and never lets an unknown route claim the indicator', () => {
  assert.equal(presentationLabels({ route: 'raw', indicator: 'present' }), RAW_PRESENTATION);
  assert.deepEqual(presentationLabels({ route: 'host', indicator: 'present' }), { route: 'host', indicator: 'present' });
  assert.deepEqual(presentationLabels({ route: 'host', indicator: 'visible' }), { route: 'host', indicator: 'unknown' });
  assert.deepEqual(presentationLabels({ route: 'vnc', indicator: 'present' }), { route: 'unknown', indicator: 'unknown' });
  assert.deepEqual(presentationLabels(), { route: 'unknown', indicator: 'unknown' });
  assert.deepEqual(presentationLabels('raw'), { route: 'unknown', indicator: 'unknown' });
});

test('native executor is the raw route; the Host attests present only under a live permit', () => {
  assert.equal(presentationOf(NativeExecutor, {}), RAW_PRESENTATION);
  const live = { activityActive: true, permitUntil: 10, now: () => 5 };
  assert.deepEqual(presentationOf(HostHelperExecutor, live), { route: 'host', indicator: 'present' });
  for (const state of [
    { ...live, activityActive: false }, { ...live, now: () => 10 }, { ...live, failed: new Error('x') },
    { ...live, releasing: Promise.resolve() }, { ...live, released: true }, { ...live, permitUntil: undefined },
  ]) assert.deepEqual(presentationOf(HostHelperExecutor, state), { route: 'host', indicator: 'unknown' });
});

test('every MCP result carries labels, health shows them, and executor fields cannot override them', async t => {
  const executor = {
    presentation: RAW_PRESENTATION,
    async execute(actions) {
      if (actions[0].action === 'key_tap') return [{ error: { code: -1, message: 'refused' } }];
      return actions.map(() => ({ result: { detail: 'OK', scaledWidth: 2, scaledHeight: 1,
        route: 'host', indicator: 'present' } }));
    },
    async release() {},
  };
  const session = new McpSession(executor);
  const health = await session.command({ action: 'health' });
  assert.deepEqual({ route: health.structuredContent.route, indicator: health.structuredContent.indicator }, RAW_PRESENTATION);
  assert.ok(health.content.some(block => block.text === 'route: raw; indicator: absent'));
  const refused = await session.command({ action: 'key_tap', key: 'tab' });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.structuredContent, { error: { code: -1, message: 'refused' }, ...RAW_PRESENTATION });
  const queued = await session.queue({ actions: [{ action: 'wait' }] });
  assert.deepEqual(queued.structuredContent, { completed: 1, ...RAW_PRESENTATION });

  const { server } = createMcpServer({ executor });
  const client = new Client({ name: 'offline-labels', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const complete = await client.callTool({ name: 'task_complete', arguments: { summary: 'done' } });
  assert.deepEqual(complete.structuredContent, { summary: 'done', ...RAW_PRESENTATION });
  const failed = await client.callTool({ name: 'task_failed', arguments: { reason: 'stopped' } });
  assert.deepEqual(failed.structuredContent, { reason: 'stopped', ...RAW_PRESENTATION });
});

test('broker frames carry the lane route from the profile before startup and the executor after', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-labels-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'broker.sock');
  let indicator = 'present';
  const broker = await createBroker({ socketPath, config: { targets: {
    raw: { targetId: 'raw-desktop' },
    host: { targetId: 'host-desktop', hostHelper: { sshHost: 'target.example' } },
  } }, factory: async profile => ({
    // A raw-route executor claiming the indicator is normalized to absent.
    get presentation() { return profile.hostHelper ? { route: 'host', indicator } : { route: 'raw', indicator: 'present' }; },
    async execute(actions) { return actions.map(() => ({ result: { detail: 'OK' } })); },
    async close() {},
  }) });
  t.after(() => broker.close());
  const raw = new BrokerExecutor({ socketPath, target: 'raw' });
  const host = new BrokerExecutor({ socketPath, target: 'host' });
  t.after(async () => { await raw.close(); await host.close(); });
  await Promise.all([raw.opened, host.opened]);
  assert.deepEqual(raw.presentation, RAW_PRESENTATION);
  assert.deepEqual(host.presentation, { route: 'host', indicator: 'unknown' });
  await raw.execute([{ action: 'wait' }]);
  await host.execute([{ action: 'wait' }]);
  assert.deepEqual(raw.presentation, RAW_PRESENTATION);
  assert.deepEqual(host.presentation, { route: 'host', indicator: 'present' });
  indicator = 'unknown';
  await host.execute([{ action: 'wait' }]);
  assert.deepEqual(host.presentation, { route: 'host', indicator: 'unknown' });
  const session = new McpSession(host);
  const result = await session.command({ action: 'wait' });
  assert.equal(result.structuredContent.route, 'host');
});

test('regression: failures never carry a present indicator into MCP results', async t => {
  assert.deepEqual(unattestedLabels({ route: 'host', indicator: 'present' }), { route: 'host', indicator: 'unknown' });
  assert.equal(unattestedLabels({ route: 'raw', indicator: 'present' }), RAW_PRESENTATION);
  const live = { route: 'host', indicator: 'present' };
  const executor = {
    presentation: live,
    async execute(actions) {
      if (actions.some(action => action.action === 'key_tap')) return [{ error: { code: -1, message: 'refused' } }];
      throw Object.assign(new Error('transport lost'), { responses: [] });
    },
    async release() { throw new Error('release unconfirmed'); },
  };
  const session = new McpSession(executor);
  const thrown = await session.command({ action: 'wait' });
  assert.deepEqual(thrown.structuredContent, { error: { message: 'transport lost' }, route: 'host', indicator: 'unknown' });
  const refused = await session.command({ action: 'key_tap', key: 'tab' });
  assert.deepEqual(refused.structuredContent, { error: { code: -1, message: 'refused' }, route: 'host', indicator: 'unknown' });
  const queued = await session.queue({ actions: [{ action: 'key_tap', key: 'tab' }] });
  assert.deepEqual(queued.structuredContent, { completed: 0, failedIndex: 1,
    error: { code: -1, message: 'refused' }, route: 'host', indicator: 'unknown' });

  const { server } = createMcpServer({ executor });
  const client = new Client({ name: 'offline-label-failures', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const failedRelease = await client.callTool({ name: 'task_complete', arguments: { summary: 'done' } });
  assert.equal(failedRelease.isError, true);
  assert.deepEqual(failedRelease.structuredContent, { error: { message: 'release unconfirmed' }, route: 'host', indicator: 'unknown' });
});

async function hostBroker(t, executorFor) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-labels-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'broker.sock');
  const broker = await createBroker({ socketPath, config: { targets: {
    host: { targetId: 'host-desktop', hostHelper: { sshHost: 'target.example' } } } },
  factory: async () => executorFor() });
  t.after(() => broker.close().catch(() => {}));
  return { broker, socketPath };
}

const presentExecutor = (execute = async actions => actions.map(() => ({ result: { detail: 'OK' } }))) => ({
  get presentation() { return { route: 'host', indicator: 'present' }; }, execute, async close() {},
});

test('regression: a broker disconnect resets client labels to unknown', async t => {
  const { broker, socketPath } = await hostBroker(t, () => presentExecutor());
  const client = new BrokerExecutor({ socketPath, target: 'host' });
  t.after(() => client.close());
  await client.opened;
  await client.execute([{ action: 'wait' }]);
  assert.deepEqual(client.presentation, { route: 'host', indicator: 'present' });
  await broker.close();
  await delay(20);
  assert.deepEqual(client.presentation, { route: 'unknown', indicator: 'unknown' });
  const result = await new McpSession(client).command({ action: 'wait' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.indicator, 'unknown');
  assert.equal(result.structuredContent.route, 'unknown');
});

test('regression: a local timeout or cancel resets labels and late frames cannot revive them', async t => {
  // A broker that attests the Host and then goes silent: only the client's own
  // deadline or cancellation can end each request.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-labels-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'silent.sock');
  const present = { route: 'host', indicator: 'present' };
  const ids = [];
  const sockets = new Set();
  const server = net.createServer(socket => sockets.add(socket) && readFrames(socket, frame => {
    if (frame.kind === 'open') writeFrame(socket, { v: 1, kind: 'opened', presentation: present });
    if (frame.kind === 'execute') {
      ids.push(frame.id);
      writeFrame(socket, { v: 1, kind: 'progress', id: frame.id, response: { result: { detail: 'OK' } }, presentation: present });
    }
  }, () => socket.destroy()));
  await new Promise(resolve => server.listen(socketPath, resolve));
  const client = new BrokerExecutor({ socketPath, target: 'host' });
  t.after(async () => {
    await client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await client.opened;
  assert.deepEqual(client.presentation, present);

  await assert.rejects(client.execute([{ action: 'wait' }], { timeoutMs: 50 }), /deadline/);
  assert.deepEqual(client.presentation, { route: 'unknown', indicator: 'unknown' });
  client.receive({ v: 1, kind: 'result', id: ids[0], responses: [], presentation: present });
  assert.deepEqual(client.presentation, { route: 'unknown', indicator: 'unknown' });

  const controller = new AbortController();
  const pending = client.execute([{ action: 'wait' }], { signal: controller.signal, onResponse: () => controller.abort(new Error('operator cancelled')) });
  await assert.rejects(pending, /operator cancelled/);
  assert.deepEqual(client.presentation, { route: 'unknown', indicator: 'unknown' });
  client.receive({ v: 1, kind: 'progress', id: ids[1], response: { result: {} }, presentation: present });
  assert.deepEqual(client.presentation, { route: 'unknown', indicator: 'unknown' });
});

test('regression: an error frame from the broker cannot attest the indicator', async t => {
  const { socketPath } = await hostBroker(t, () => presentExecutor(async () => { throw new Error('queue failed'); }));
  const client = new BrokerExecutor({ socketPath, target: 'host' });
  t.after(() => client.close());
  await client.opened;
  await assert.rejects(client.execute([{ action: 'wait' }]), /queue failed/);
  assert.deepEqual(client.presentation, { route: 'host', indicator: 'unknown' });
});

const HOST_ONLY = [{ action: 'ax_snapshot' }, { action: 'click_element', ref: 'ax:1:0' },
  { action: 'focus_element', ref: 'ax:1:0' }];

test('the raw route refuses Host-only AX actions with typed unsupported_on_route before any admission', async t => {
  const typed = error => isPreAdmissionRefusal(error) && error.code === 'unsupported_on_route' &&
    /raw VNC route/.test(error.message);
  for (const hostOnly of HOST_ONLY) {
    for (const capabilities of [nativeCapabilities(), nativeCapabilities(['health', hostOnly.action])]) {
      assert.throws(() => NativeExecutor.prototype.preflight.call({ isReady: true, terminal: false, capabilities },
        [{ action: 'wait' }, hostOnly]), typed);
    }
  }
  const calls = [];
  const executor = { presentation: RAW_PRESENTATION, async execute(actions) {
    calls.push(...actions);
    NativeExecutor.prototype.preflight.call({ isReady: true, terminal: false, capabilities: nativeCapabilities() }, actions);
    return actions.map(() => ({ result: { detail: 'OK' } }));
  } };
  const session = new McpSession(executor);
  const refused = await session.command({ action: 'ax_snapshot', depth: 2 });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.error.code, 'unsupported_on_route');
  assert.deepEqual({ route: refused.structuredContent.route, indicator: refused.structuredContent.indicator },
    RAW_PRESENTATION);
  // Other thrown failures keep the message-only shape.
  const failing = new McpSession({ presentation: RAW_PRESENTATION, async execute() {
    throw Object.assign(new Error('transport'), { code: 'operation_failed' });
  } });
  assert.equal((await failing.command({ action: 'wait' })).structuredContent.error.code, undefined);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-route-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, 'broker.sock');
  const started = [];
  const broker = await createBroker({ socketPath, config: { targets: {
    raw: { targetId: 'raw-desktop' },
    host: { targetId: 'host-desktop', hostHelper: { sshHost: 'target.example' } },
  } }, factory: async profile => {
    started.push(profile.targetId);
    return { presentation: profile.hostHelper ? { route: 'host', indicator: 'unknown' } : RAW_PRESENTATION,
      async execute(actions) {
        if (actions[0].action === 'click_element') throw Object.assign(new Error('Host helper refused request: stale_ref'), { code: 'stale_ref' });
        return actions.map(() => ({ result: { detail: 'OK' } }));
      }, async close() {} };
  } });
  t.after(() => broker.close());
  const raw = new BrokerExecutor({ socketPath, target: 'raw' });
  const host = new BrokerExecutor({ socketPath, target: 'host' });
  t.after(async () => { await raw.close(); await host.close(); });
  await Promise.all([raw.opened, host.opened]);
  for (const hostOnly of HOST_ONLY) {
    const viaBroker = await new McpSession(raw).command(hostOnly);
    assert.equal(viaBroker.structuredContent.error.code, 'unsupported_on_route');
  }
  assert.deepEqual(started, []);
  await raw.execute([{ action: 'wait' }]);
  await host.execute([{ action: 'ax_snapshot' }]);
  assert.deepEqual(started, ['raw-desktop', 'host-desktop']);
  // A Host's typed element refusal keeps its code through the broker to MCP.
  const stale = await new McpSession(host).command({ action: 'click_element', ref: 'ax:1:0.4' });
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.error.code, 'stale_ref');
});
