// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, McpSession } from '../lib/mcp/server.js';
import { NdjsonParser, ResponseBudget, responseMetadata, validateResponse,
  encodeRequest, MAX_REQUEST_FRAME_BYTES } from '../lib/mcp/protocol.js';

const success = (result = {}) => ({ result });

test('framing preserves split UTF-8, multiple frames and CRLF without logging payloads', () => {
  const received = [];
  const parser = new NdjsonParser((value) => received.push(value));
  const bytes = Buffer.from('{"result":{"detail":"π 🍇"}}\r\n\n{"result":{}}\n');
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.end();
  assert.deepEqual(received, [success({ detail: 'π 🍇' }), success()]);
});

test('framing bounds unterminated frames and refuses invalid UTF-8 or partial EOF', () => {
  const bounded = new NdjsonParser(() => {}, { maxFrameBytes: 8 });
  bounded.push(Buffer.from('12345678'));
  assert.throws(() => bounded.push(Buffer.from('9')), /byte limit/);
  assert.equal(bounded.buffer.length, 0);
  bounded.push(Buffer.from('{"result":{}}\n'));
  const invalid = new NdjsonParser(() => {});
  assert.throws(() => invalid.push(Buffer.from([0xff, 10])), /Invalid daemon protocol frame/);
  assert.equal(invalid.buffer.length, 0);
  const partial = new NdjsonParser(() => {});
  partial.push(Buffer.from('{'));
  assert.throws(() => partial.end(), /Incomplete/);
  assert.equal(partial.buffer.length, 0);
});

test('stopping a parser callback prevents processing a coalesced successor frame', () => {
  const received = [];
  const parser = new NdjsonParser((response) => { received.push(response); return false; });
  parser.push(Buffer.from('{"result":{}}\nmalformed private tail\n'));
  assert.deepEqual(received, [success()]);
  assert.equal(parser.buffer.length, 0);
  parser.push(Buffer.from('malformed later chunk\n'));
  parser.end();
});

test('response budget exactly counts escaped JSON and UTF-8 without duplicating image buffers', () => {
  const responses = [
    { result: { image: 'A'.repeat(100), detail: 'π 🍇 \u0000 \b \t \n \f \r " \\ \ud800 \udfff',
      nested: [null, undefined, -0, 1e30, true, false, { absent: undefined, detail: '🍇' }] } },
    { error: { code: -1, message: 'refused' } },
  ];
  const bytes = Buffer.byteLength(JSON.stringify(responses));
  const budget = new ResponseBudget({ maxBytes: bytes, maxResponses: 2 });
  assert.equal(budget.add(responses[0]), responses[0]);
  budget.add(responses[1]);
  assert.equal(budget.bytes, bytes);
  assert.equal(budget.count, 2);
  assert.throws(() => budget.add(success()), /count exceeds/);
  assert.equal(budget.bytes, bytes);
  const tooSmall = new ResponseBudget({ maxBytes: bytes - 1 });
  tooSmall.add(responses[0]);
  const before = tooSmall.bytes;
  assert.throws(() => tooSmall.add(responses[1]), /byte limit/);
  assert.equal(tooSmall.bytes, before);
  assert.equal(tooSmall.count, 1);
  assert.deepEqual(responseMetadata(responses[0]).result.nested, responses[0].result.nested);
  assert.equal(Object.hasOwn(responseMetadata(responses[0]).result, 'image'), false);
});

test('response budget rejects cycles and non-JSON objects before retaining them', () => {
  const budget = new ResponseBudget();
  const cycle = {}; cycle.self = cycle;
  for (const response of [cycle, { result: { at: new Date() } }, { result: { value: 1n } }]) {
    assert.throws(() => budget.add(response), /Invalid response JSON/);
    assert.equal(budget.count, 0);
    assert.equal(budget.bytes, 2);
  }
});

test('response validation refuses malformed success, errors and half geometry', () => {
  for (const value of [null, [], {}, { result: null }, { result: {}, error: { code: 1, message: 'x' } },
    success({ scaledWidth: 100 }), success({ scaledWidth: -1, scaledHeight: 100 }),
    success({ detail: 42 }), { error: { code: 1, message: {} } }]) {
    assert.throws(() => validateResponse(value), /response shape/);
  }
  assert.deepEqual(validateResponse(success({ detail: 'OK', capture: { generation: 2 } })),
    success({ detail: 'OK', capture: { generation: 2 } }));
});

test('request framing limits paste payloads by UTF-8 bytes before executor input', () => {
  assert.equal(JSON.parse(encodeRequest({ method: 'paste', params: { text: 'π\n🍇' } })).params.text, 'π\n🍇');
  assert.throws(() => encodeRequest({ method: 'paste',
    params: { text: '🍇'.repeat(MAX_REQUEST_FRAME_BYTES / 4) } }), /request exceeds byte limit/);
});

test('real MCP publishes four descriptions and keeps coordinate schemas stable across configure/reset', async (t) => {
  const calls = [];
  let max = 1280;
  const executor = {
    async execute(actions) {
      calls.push(actions);
      return actions.map((input) => {
        if (input.action === 'configure') max = input.reset ? 1280 : input.max_dimension;
        return success({ detail: 'OK', scaledWidth: max, scaledHeight: max / 2,
          ...(input.reset ? { timing: { max_dimension: max } } : {}) });
      });
    },
  };
  const { server, session } = createMcpServer({ executor });
  const client = new Client({ name: 'offline-fruitctl-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const before = await client.listTools();
  assert.deepEqual(before.tools.map((tool) => tool.name), ['vnc_command', 'action_queue', 'task_complete', 'task_failed']);
  assert.ok(before.tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 20));
  assert.match(before.tools[0].description, /current scaled display/);
  assert.match(before.tools[1].description, /30-second/);
  const command = (arguments_) => client.callTool({ name: 'vnc_command', arguments: arguments_ });
  await command({ action: 'configure', max_dimension: 3840 });
  const moved = await command({ action: 'mouse_move', x: 3000, y: 1000 });
  assert.notEqual(moved.isError, true);
  assert.deepEqual(session.display, { width: 3840, height: 1920 });
  await command({ action: 'configure', reset: true });
  assert.deepEqual(session.display, { width: 1280, height: 640 });
  assert.deepEqual((await client.listTools()).tools, before.tools);
  const missing = await command({ action: 'mouse_click' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Missing x/);
  assert.equal(calls.length, 3);
});

test('queue is one executor operation and first daemon error reports completed actions', async () => {
  let invocations = 0;
  const session = new McpSession({ async execute(actions, options) {
    invocations++;
    assert.equal(actions.length, 3);
    assert.equal(options.timeoutMs, 30000);
    return [success({ detail: 'clicked' }), { error: { code: -32000, message: 'key refused' } }];
  } });
  const result = await session.queue({ actions: [
    { action: 'mouse_click', x: 1, y: 1 }, { action: 'key_tap', key: 'tab' }, { action: 'wait' },
  ] });
  assert.equal(invocations, 1);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { completed: 1, failedIndex: 2 });
  assert.match(result.content[0].text, /\[1\] mouse_click: clicked\n\[2\] key_tap: ERROR/);
});

test('queue transport failure retains partial progress and incomplete success is an error', async () => {
  const actions = [{ action: 'wait' }, { action: 'wait' }];
  const failed = new McpSession({ async execute() {
    const error = new Error('transport disconnected');
    error.responses = [success({ detail: 'first finished' })];
    throw error;
  } });
  const result = await failed.queue({ actions });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { completed: 1, failedIndex: 2 });
  assert.match(result.content[0].text, /first finished/);
  const incomplete = await new McpSession({ async execute() { return [success()]; } }).queue({ actions });
  assert.equal(incomplete.isError, true);
  assert.match(incomplete.content[0].text, /incomplete batch results/);
});

test('MCP admits aggregate response bytes and refuses oversized or malformed partial results', async () => {
  const actions = [{ action: 'wait' }, { action: 'wait' }];
  let aborted = false;
  const responses = [success({ image: 'A'.repeat(64), detail: 'first finished' }),
    success({ image: 'A'.repeat(64), detail: 'second finished' })];
  const session = new McpSession({ async execute(_, { signal, onResponse }) {
    signal.addEventListener('abort', () => { aborted = true; });
    for (const response of responses) onResponse(response);
    return responses;
  } }, { maxBatchResponseBytes: 150 });
  const result = await session.queue({ actions });
  assert.equal(result.isError, true);
  assert.equal(aborted, true);
  assert.deepEqual(result.structuredContent, { completed: 1, failedIndex: 2 });
  assert.match(result.content[0].text, /Batch response exceeds byte limit/);
  const malformed = new McpSession({ async execute() {
    const error = new Error('lost transport');
    error.responses = [success({ detail: 'first finished' }), { result: { detail: {} } }];
    throw error;
  } });
  const partial = await malformed.queue({ actions });
  assert.equal(partial.isError, true);
  assert.deepEqual(partial.structuredContent, { completed: 1, failedIndex: 2 });
  assert.match(partial.content[0].text, /Invalid daemon response shape/);
});

test('MCP progress limits cancel the executor before excess metadata can be retained', async () => {
  let aborted = false;
  const session = new McpSession({ async execute(_, { signal, onResponse }) {
    signal.addEventListener('abort', () => { aborted = true; });
    onResponse(success({ detail: 'first finished' }));
    onResponse(success({ detail: 'A'.repeat(150) }));
    return [];
  } }, { maxBatchResponseBytes: 100 });
  const result = await session.queue({ actions: [{ action: 'wait' }, { action: 'wait' }] });
  assert.equal(aborted, true);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { completed: 1, failedIndex: 2 });
});

test('batch deadline includes every action, aborts executor and keeps completed progress', async () => {
  let aborted = false;
  const session = new McpSession({ execute(_, { signal, onResponse }) {
    onResponse(success({ detail: 'first finished' }));
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } }, { timeoutMs: 20 });
  const result = await session.queue({ actions: [{ action: 'wait' }, { action: 'wait' }] });
  assert.equal(aborted, true);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { completed: 1, failedIndex: 2 });
  assert.match(result.content[0].text, /timed out after 20ms/);
});

test('client cancellation reaches executor and pre-cancelled calls cannot execute input', async () => {
  const controller = new AbortController();
  let calls = 0;
  let aborted = false;
  const session = new McpSession({ execute(_, { signal }) {
    calls++;
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } });
  const pending = session.command({ action: 'wait' }, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).isError, true);
  assert.equal(aborted, true);
  assert.equal((await session.command({ action: 'wait' }, controller.signal)).isError, true);
  assert.equal(calls, 1);
});

test('real MCP cancellation notification aborts the executor operation', async (t) => {
  let started;
  let aborted;
  const entered = new Promise((resolve) => { started = resolve; });
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  const { server } = createMcpServer({ executor: { execute(_, { signal }) {
    signal.addEventListener('abort', aborted, { once: true });
    started();
    return new Promise(() => {});
  } } });
  const client = new Client({ name: 'offline-cancellation-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const controller = new AbortController();
  const operation = client.callTool({ name: 'vnc_command', arguments: { action: 'wait' } }, undefined,
    { signal: controller.signal });
  await entered;
  controller.abort();
  await assert.rejects(operation);
  await cancelled;
});

test('real MCP image responses retain PNG content and admitted geometry metadata', async (t) => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBXsAAAAASUVORK5CYII=';
  const { server } = createMcpServer({ executor: { async execute() {
    return [success({ image: png, scaledWidth: 1, scaledHeight: 1,
      capture: { generation: 2, allocation: 3 } })];
  } } });
  const client = new Client({ name: 'offline-image-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const result = await client.callTool({ name: 'vnc_command', arguments: { action: 'screenshot' } });
  assert.deepEqual(result.content, [{ type: 'image', data: png, mimeType: 'image/png' }]);
  assert.equal(result.structuredContent.scaledWidth, 1);
  assert.equal(Object.hasOwn(result.structuredContent, 'image'), false);
  assert.deepEqual(result.structuredContent.capture, { generation: 2, allocation: 3 });
});

test('real MCP task outcomes await ownership release and refuse completion when release fails', async (t) => {
  let entered;
  let acknowledge;
  const releasing = new Promise((resolve) => { entered = resolve; });
  const released = new Promise((resolve) => { acknowledge = resolve; });
  let releases = 0;
  const { server } = createMcpServer({ executor: {
    async execute() { return [success()]; },
    async release() {
      releases++;
      if (releases === 1) { entered(); await released; }
      if (releases === 3) throw new Error('Ownership release unconfirmed');
    },
  } });
  const client = new Client({ name: 'offline-release-fixture', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let completed = false;
  const pending = client.callTool({ name: 'task_complete', arguments: { summary: 'observed setting changed' } })
    .then((result) => { completed = true; return result; });
  await releasing;
  assert.equal(completed, false);
  acknowledge();
  assert.equal((await pending).content[0].text, 'observed setting changed');
  const failed = await client.callTool({ name: 'task_failed', arguments: { reason: 'pixels unavailable' } });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, 'pixels unavailable');
  const unconfirmed = await client.callTool({ name: 'task_complete', arguments: { summary: 'must not claim completion' } });
  assert.equal(unconfirmed.isError, true);
  assert.match(unconfirmed.content[0].text, /Ownership release unconfirmed/);
  assert.equal(releases, 3);
});

test('MCP ownership release has an ordinary deadline and cancellation cannot report completion', async () => {
  let aborted = false;
  const executor = { execute() {}, release({ signal, timeoutMs }) {
    assert.equal(timeoutMs, 20);
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return new Promise(() => {});
  } };
  const session = new McpSession(executor, { timeoutMs: 20 });
  await assert.rejects(session.release(), /Ownership release timed out after 20ms/);
  assert.equal(aborted, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(session.release(controller.signal), /cancelled/);
});
