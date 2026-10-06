// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { deflateSync } from 'node:zlib';
import { createHostHelperExecutor } from '../lib/broker/host-helper.mjs';
import { ResponseBudget } from '../lib/mcp/protocol.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, content) {
  const type = Buffer.from(name);
  const value = Buffer.alloc(content.length + 12);
  value.writeUInt32BE(content.length, 0);
  type.copy(value, 4); content.copy(value, 8);
  value.writeUInt32BE(crc32(Buffer.concat([type, content])), content.length + 8);
  return value;
}
function image(width = 256, height = 128, rawPixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const pixels = rawPixels || Buffer.alloc((width * 4 + 1) * height);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}

const bounds = { x: 0, y: 0, width: 256, height: 128 };
const mapping = { qualificationReceipt: 'test-fixture:explicit-geometry-proof', displayId: 42,
  nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128, displayBounds: bounds };
const configuration = () => ({ sshHost: 'configured-target',
  command: ['/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost', '--stdio'], displayId: 42 });

function native({ health = {}, run, releaseError, releaseRun, adopt } = {}) {
  return {
    display: { width: 256, height: 128 }, calls: [], closes: [], releases: [], permitControls: [],
    async inputPermitControl(method, params) {
      this.permitControls.push({ method, params });
      const { lease_remaining_ms, ...binding } = params;
      return { id: 'native-permit', result: { ...binding, challenge: params.challenge || randomUUID(),
        native_permit_protocol: 'fruitctl.native-input-permit.v1', input_permit_ms: 1000,
        maximum_round_trip_ms: 500, native_permit_remaining_ms: 1000 } };
    },
    async execute(actions, options = {}) {
      this.calls.push(...actions);
      if (actions[0].action === 'health') return [{ id: 'native-health', result: {
        nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128,
        connectionGeneration: 3, allocation: 9, ...health } }];
      if (actions[0].action === 'adopt_observation') {
        if (adopt) return adopt(actions[0]);
        const { action, ...result } = actions[0];
        return [{ id: 'native-adoption', result }];
      }
      if (actions.some(action => action.action === 'screenshot')) throw new Error('Raw VNC capture must not run');
      if (run) return run(actions, options);
      return actions.map(() => ({ id: 'native-input', result: { detail: 'input acknowledged' } }));
    },
    async release(options) {
      this.releases.push(options);
      if (releaseError) throw releaseError;
      if (releaseRun) await releaseRun(options);
    },
    async close(options) { this.closes.push(options); },
  };
}

function helper({ alter, ignoreTerm = false, ignoreKill = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    if ((signal === 'SIGTERM' && ignoreTerm) || (signal === 'SIGKILL' && ignoreKill)) return true;
    child.signalCode = signal;
    queueMicrotask(() => { child.emit('exit', null, signal); child.emit('close', null, signal); });
    return true;
  };
  const requests = [];
  const launches = [];
  let owner;
  const state = () => ({ instance_id: 'resident-test-app', capture_backend: 'owned_sck',
    capture_enabled: true, screen_capture_permission: true, raw_vnc_exclusion: false,
    display_id: 42, displayGeneration: 7, renewal_interval_ms: 500,
    input_permit_ms: 1000, maximum_round_trip_ms: 500,
    capture_ready: Boolean(owner), overlay_ready: Boolean(owner), ready: Boolean(owner),
    ui_heartbeat_age_ms: owner ? 0 : null, lease_remaining_ms: owner ? 3000 : 0,
    ...(owner || {}) });
  child.stdin = new Writable({ write(bytes, encoding, callback) {
    const request = JSON.parse(bytes.toString());
    requests.push(request);
    if (request.action === 'begin_activity' || request.action === 'renew_activity') {
      owner = { session_id: request.params.session_id, sequence: request.params.sequence,
        challenge: request.params.challenge };
    } else if (request.action === 'release_activity') owner = undefined;
    let result = state();
    if (request.action === 'capture') result = { ...result, image: image(), mimeType: 'image/png',
      nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128,
      display_bounds: bounds, pixels_per_point_x: 2, pixels_per_point_y: 2, cursor_included: true };
    let response = { id: request.id, success: true, result };
    if (alter) response = alter(request, response);
    callback();
    if (response !== null) queueMicrotask(() => child.stdout.write(JSON.stringify(response) + '\n'));
  } });
  return { child, requests, launches, state, spawnImpl(command, args, options) {
    launches.push({ command, args, options }); return child;
  } };
}

async function fixture({ config = configuration(), nativeOptions, helperOptions, now, responseBudgetFactory } = {}) {
  const vnc = native(nativeOptions);
  const host = helper(helperOptions);
  const executor = await createHostHelperExecutor({ nativeExecutor: vnc, hostHelper: config,
    spawnImpl: host.spawnImpl, ...(now ? { now } : {}),
    ...(responseBudgetFactory ? { responseBudgetFactory } : {}) });
  return { executor, vnc, host };
}

test('configured helper screenshots use owned SCK PNG and retain ownership indication, never raw VNC', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    const [response] = await executor.execute([{ action: 'screenshot' }]);
    assert.equal(response.result.image, image());
    assert.equal(response.result.capture_backend, 'owned_sck');
    assert.equal(response.result.display_id, 42);
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(host.requests.map(request => request.action),
      ['health', 'begin_activity', 'renew_activity', 'capture']);
    assert.equal(host.state().overlay_ready, true);
  } finally { await executor.close(); }
});

test('helper transport only executes configured SSH stdio attachment and forwards no VNC credentials', async () => {
  const config = configuration();
  config.command[0] = "/Applications/Operator's App.app/Contents/MacOS/FruitctlHost";
  const { executor, host } = await fixture({ config });
  try {
    const launch = host.launches[0];
    assert.equal(launch.command, 'ssh');
    assert.deepEqual(launch.args.slice(0, 9),
      ['-T', '-oBatchMode=yes', '-oForwardAgent=no', '-oClearAllForwardings=yes',
        '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no', '--', 'configured-target']);
    assert.equal(launch.args[9], "'/Applications/Operator'\\''s App.app/Contents/MacOS/FruitctlHost' '--stdio'");
    assert.equal(Object.hasOwn(launch.options.env, 'VNC_PASSWORD'), false);
    assert.equal(host.launches.length, 1);
  } finally { await executor.close(); }
});

test('unqualified mapping refuses input and closes only the owned native executor', async () => {
  const { executor, vnc, host } = await fixture();
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), /not qualified/);
  assert.deepEqual(vnc.calls, []);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
  assert.deepEqual(host.child.kills, ['SIGTERM']);
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 1, y: 1 }]), /not qualified/);
  assert.equal(vnc.closes.length, 1);
});

test('qualified exact geometry renews a permit before native input and never replays it', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc, host } = await fixture({ config });
  try {
    const action = { action: 'mouse_click', x: 12, y: 20 };
    await executor.execute([action]);
    assert.deepEqual(vnc.calls, [{ action: 'health' }, { action: 'adopt_observation',
      nativeWidth: 512, nativeHeight: 256, scaledWidth: 256, scaledHeight: 128,
      connectionGeneration: 3, allocation: 9 }, action]);
    const verbs = host.requests.map(request => request.action);
    assert.deepEqual(verbs, ['health', 'begin_activity', 'capture', 'renew_activity']);
    const begin = host.requests[1].params;
    const renew = host.requests[3].params;
    assert.equal(renew.session_id, begin.session_id);
    assert.ok(renew.sequence > begin.sequence);
    assert.notEqual(renew.challenge, begin.challenge);
  } finally { await executor.close(); }
});

test('VNC/native geometry mismatch prevents input even with a configured receipt', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    nativeOptions: { health: { nativeWidth: 513 } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /geometry mismatch/);
  assert.deepEqual(vnc.calls, [{ action: 'health' }]);
  assert.equal(vnc.closes.length, 1);
});

test('unavailable native allocation binding prevents external adoption and input', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    nativeOptions: { health: { allocation: undefined } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /allocation binding unavailable/);
  assert.deepEqual(vnc.calls, [{ action: 'health' }]);
  assert.equal(vnc.closes.length, 1);
});

test('missing private adoption seam refuses input without seeding a raw VNC capture', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    adopt() { return [{ id: 'native-adoption', error: { code: -32601, message: 'unsupported' } }]; } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /adoption unconfirmed/);
  assert.deepEqual(vnc.calls.map(action => action.action), ['health', 'adopt_observation']);
  assert.equal(vnc.closes.length, 1);
});

test('changed native allocation in adoption acknowledgement prevents input', async () => {
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    adopt({ action, ...binding }) { return [{ id: 'native-adoption', result: { ...binding, allocation: binding.allocation + 1 } }]; } } });
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /adoption unconfirmed/);
  assert.deepEqual(vnc.calls.map(action => action.action), ['health', 'adopt_observation']);
  assert.equal(vnc.closes.length, 1);
});

for (const field of ['challenge', 'session_id', 'sequence', 'displayGeneration', 'display_id', 'instance_id']) {
  test(`mismatched helper ${field} acknowledgement closes native before input`, async () => {
    const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, helperOptions: {
      alter(request, response) {
        if (request.action === 'begin_activity') response.result[field] =
          typeof response.result[field] === 'number' ? response.result[field] + 1 : 'wrong-binding';
        return response;
      } } });
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /receipt mismatch/);
    assert.deepEqual(vnc.calls, []);
    assert.equal(vnc.closes.length, 1);
  });
}

test('a partial or corrupt helper PNG is rejected without raw capture fallback', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') response.result.image =
      Buffer.from(response.result.image, 'base64').subarray(0, -4).toString('base64');
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /corrupt host-helper PNG/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('valid PNG chunk CRCs cannot conceal incomplete decoded pixel coverage', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') response.result.image = image(256, 128, Buffer.alloc(1));
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /Incomplete host-helper PNG pixels/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('PNG inflate output is bounded by the admitted dimensions', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') response.result.image = image(256, 128,
      Buffer.alloc((256 * 4 + 1) * 129));
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /corrupt host-helper PNG pixels/);
  assert.deepEqual(vnc.calls, []);
});

test('unknown critical PNG chunks are rejected even when CRC and pixel coverage pass', async () => {
  const { executor } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') {
      const png = Buffer.from(response.result.image, 'base64');
      response.result.image = Buffer.concat([png.subarray(0, -12),
        chunk('EVIL', Buffer.alloc(0)), png.subarray(-12)]).toString('base64');
    }
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /corrupt host-helper PNG/);
});

test('PNG dimensions must use the requested rounded scaling before reaching the agent', async () => {
  const { executor } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'capture') {
      response.result.scaledHeight = 127;
      response.result.image = image(256, 127);
    }
    return response;
  } } });
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /capture scaling mismatch/);
});

test('aggregate capture budget refuses excess bytes before progress or successor input', async () => {
  const progress = [];
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping },
    responseBudgetFactory: () => new ResponseBudget({ maxBytes: 2000 }) });
  await assert.rejects(executor.execute([{ action: 'screenshot' }, { action: 'screenshot' },
    { action: 'key_tap', key: 'enter' }], { onResponse: response => progress.push(response) }), error => {
    assert.match(error.message, /response exceeds byte limit/);
    assert.equal(error.responses.length, 1);
    assert.equal(Object.hasOwn(error.responses[0].result, 'image'), false);
    return true;
  });
  assert.equal(progress.length, 1);
  assert.equal(Object.hasOwn(progress[0].result, 'image'), false);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('several complete screenshots remain available when the shared batch budget admits them', async () => {
  const { executor } = await fixture({ responseBudgetFactory: () => new ResponseBudget({ maxBytes: 10000 }) });
  try {
    const results = await executor.execute([{ action: 'screenshot' }, { action: 'screenshot' }]);
    assert.equal(results.length, 2);
    assert.equal(results[0].result.image, image());
    assert.equal(results[1].result.image, image());
  } finally { await executor.close(); }
});

test('oversized action count is rejected without acquiring activity or issuing input', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    await assert.rejects(executor.execute(Array.from({ length: 257 }, () => ({ action: 'wait' }))), /Invalid.*batch/);
    assert.deepEqual(vnc.calls, []);
    assert.deepEqual(host.requests.map(request => request.action), ['health']);
  } finally { await executor.close(); }
});

test('raw VNC-derived OCR/diff/crop actions fail explicitly with helper capture configured', async () => {
  const { executor, vnc } = await fixture();
  await assert.rejects(executor.execute([{ action: 'detect_elements' }]), /Action unavailable/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
});

test('default wait remains compatible without introducing a raw pixel path', async () => {
  const { executor, vnc } = await fixture();
  try {
    await executor.execute([{ action: 'wait' }]);
    assert.deepEqual(vnc.calls, [{ action: 'wait' }]);
  } finally { await executor.close(); }
});

test('release receipt mismatch rejects clean release after the observed command has completed', async () => {
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'release_activity') response.result.instance_id = 'different-app';
    return response;
  } } });
  const [observation] = await executor.execute([{ action: 'screenshot' }]);
  assert.equal(observation.result.image, image());
  await assert.rejects(executor.release(), /release receipt mismatch/);
  assert.equal(vnc.closes.length, 1);
});

test('one activity lease and heartbeat persist between calls until explicit ownership release', async () => {
  const { executor, vnc, host } = await fixture();
  try {
    await executor.execute([{ action: 'screenshot' }]);
    const firstOwner = host.state().session_id;
    const renewals = host.requests.filter(request => request.action === 'renew_activity').length;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(host.state().overlay_ready, true);
    assert.equal(host.state().session_id, firstOwner);
    assert.ok(host.requests.filter(request => request.action === 'renew_activity').length > renewals);
    await executor.execute([{ action: 'screenshot' }]);
    assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
    assert.equal(host.requests.filter(request => request.action === 'release_activity').length, 0);
    await executor.release();
    assert.equal(host.requests.filter(request => request.action === 'release_activity').length, 1);
    assert.equal(host.state().overlay_ready, false);
    assert.equal(vnc.closes.length, 0);
  } finally { await executor.close(); }
});

test('idle heartbeat loss closes the owner and refuses future calls without reacquisition', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'renew_activity' && request.params.sequence >= 3) return null;
    return response;
  } } });
  await executor.execute([{ action: 'screenshot' }]);
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.ok(executor.failed);
  assert.equal(vnc.closes.length, 1);
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /deadline|permit expired/);
  assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
  assert.equal(host.requests.filter(request => request.action === 'capture').length, 1);
});

test('human stop during a thinking gap revokes the owner before another input', async () => {
  let stopped = false;
  const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping },
    helperOptions: { alter(request, response) {
      if (request.action === 'renew_activity' && stopped) {
        response.result.ready = false;
        response.result.activity_eligible = false;
        response.result.human_stop_latched = true;
      }
      return response;
    } } });
  await executor.execute([{ action: 'screenshot' }]);
  stopped = true;
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.match(executor.failed.message, /receipt mismatch/);
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /receipt mismatch/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
  assert.equal(host.launches.length, 1);
});

test('native error acknowledgements terminate ownership and never authorize a successor action', async () => {
  const { executor, vnc, host } = await fixture({ nativeOptions: { run() {
    return [{ id: 'failed-native', error: { code: -32000, message: 'fixture refusal' } }];
  } } });
  await assert.rejects(executor.execute([{ action: 'wait' }, { action: 'wait' }]), error => {
    assert.match(error.message, /Native operation failed/);
    assert.equal(error.responses.length, 1);
    assert.equal(error.responses[0].error.code, -32000);
    return true;
  });
  await assert.rejects(executor.execute([{ action: 'wait' }]), /Native operation failed/);
  assert.equal(vnc.calls.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.equal(host.requests.filter(request => request.action === 'begin_activity').length, 1);
});

test('lost helper transport invalidates all future input without reconnect or replay', async () => {
  const { executor, vnc, host } = await fixture({ config: { ...configuration(), mapping } });
  host.child.emit('error', new Error('fixture transport disappeared'));
  await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }]), /transport failed/);
  assert.deepEqual(vnc.calls, []);
  assert.equal(vnc.closes.length, 1);
  assert.equal(host.launches.length, 1);
});

test('500ms renewal deadline cancels an in-flight native command on helper stall', async () => {
  const config = { ...configuration(), mapping };
  const { executor, vnc, host } = await fixture({ config, helperOptions: {
    alter(request, response) {
      // The pre-input renewal succeeds; the periodic renewal stalls.
      if (request.action === 'renew_activity' && request.params.sequence >= 3) return null;
      return response;
    } }, nativeOptions: { run(actions, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('native cancelled')), { once: true });
      });
    } } });
  const started = performance.now();
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 2, y: 2 }]), /native cancelled|receipt deadline|permit expired/);
  assert.ok(performance.now() - started < 1800);
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
  assert.deepEqual(host.child.kills, ['SIGTERM']);
});

test('an otherwise timely renewal cannot revive a permit that expired during a long input action', async () => {
  let clock = 0;
  let markStarted;
  const inputStarted = new Promise(resolve => { markStarted = resolve; });
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, now: () => clock,
    helperOptions: { alter(request, response) {
      // Renewal send at950ms, ack at1050ms: RTT100ms is valid, but the
      // previous challenge's absolute1000ms input permit has expired.
      if (request.action === 'renew_activity' && request.params.sequence >= 3) clock += 100;
      return response;
    } }, nativeOptions: { run(actions, { signal }) {
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('native cancelled')), { once: true });
      });
    } } });
  const result = executor.execute([{ action: 'mouse_click', x: 2, y: 2 }]);
  await inputStarted;
  clock = 950;
  await assert.rejects(result, /permit expired|native cancelled/);
  assert.match(executor.failed.message, /permit expired/);
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
});

test('a native reply after broker suspension does not authorize the next input', async () => {
  let clock = 0;
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, now: () => clock,
    nativeOptions: { run() {
      clock = 1001;
      return [{ id: 'native-input', result: { detail: 'input result after suspension' } }];
    } } });
  await assert.rejects(executor.execute([{ action: 'mouse_click', x: 2, y: 2 },
    { action: 'key_tap', key: 'enter' }]), /permit expired/);
  assert.equal(vnc.calls.filter(action => action.action === 'mouse_click').length, 1);
  assert.equal(vnc.calls.filter(action => action.action === 'key_tap').length, 0);
  assert.equal(vnc.closes.length, 1);
});

test('caller cancellation terminates owned input and does not replay an uncertain click', async () => {
  let markStarted;
  const inputStarted = new Promise(resolve => { markStarted = resolve; });
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    run(actions, { signal }) {
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('native cancelled')), { once: true });
      });
    } } });
  const controller = new AbortController();
  const action = { action: 'mouse_click', x: 2, y: 2 };
  const result = executor.execute([action], { signal: controller.signal });
  await inputStarted;
  controller.abort();
  await assert.rejects(result, /native cancelled|cancelled/);
  await assert.rejects(executor.execute([action]), /cancelled/);
  assert.equal(vnc.calls.filter(input => input.action === 'mouse_click').length, 1);
  assert.equal(vnc.closes.length, 1);
});

test('queued deadline returns promptly without killing the current owner or sending cancelled input', async () => {
  let markStarted, release;
  const inputStarted = new Promise(resolve => { markStarted = resolve; });
  const { executor, vnc } = await fixture({ config: { ...configuration(), mapping }, nativeOptions: {
    run() {
      markStarted();
      return new Promise(resolve => { release = () => resolve([{ id: 'native-input', result: { detail: 'done' } }]); });
    } } });
  try {
    const first = executor.execute([{ action: 'mouse_click', x: 2, y: 2 }]);
    await inputStarted;
    const started = performance.now();
    await assert.rejects(executor.execute([{ action: 'key_tap', key: 'enter' }], { timeoutMs: 10 }), /deadline exceeded/);
    assert.ok(performance.now() - started < 200);
    assert.equal(vnc.closes.length, 0);
    release();
    await first;
    await executor.tail;
    assert.equal(vnc.calls.filter(action => action.action === 'key_tap').length, 0);
  } finally { await executor.close(); }
});

test('invalid bootstrap command is refused before any SSH or GUI process starts', async () => {
  const vnc = native(); const host = helper();
  await assert.rejects(createHostHelperExecutor({ nativeExecutor: vnc,
    hostHelper: { ...configuration(), command: ['/usr/bin/open', '/Applications/FruitctlHost.app'] },
    spawnImpl: host.spawnImpl }), /configuration/);
  assert.equal(host.launches.length, 0);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
});

test('an arbitrary executable cannot be disguised as a host attachment with --stdio', async () => {
  const vnc = native(); const host = helper();
  await assert.rejects(createHostHelperExecutor({ nativeExecutor: vnc,
    hostHelper: { ...configuration(), command: ['/usr/bin/open', '--stdio'] },
    spawnImpl: host.spawnImpl }), /configuration/);
  assert.equal(host.launches.length, 0);
  assert.equal(vnc.closes.length, 1);
});

test('clean release requires native acknowledgement and confirms the resident overlay is clear', async () => {
  const { executor, vnc, host } = await fixture();
  await executor.execute([{ action: 'screenshot' }]);
  await executor.release();
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 0);
  assert.equal(host.requests.at(-1).action, 'health');
  assert.deepEqual(host.child.kills, ['SIGTERM']);
  await assert.rejects(executor.execute([{ action: 'screenshot' }]), /releasing/);
  await executor.release();
  assert.equal(vnc.releases.length, 1);
});

test('ownership indication renews while native clean shutdown is pending and clears only afterwards', async () => {
  let finishShutdown;
  const shutdown = new Promise(resolve => { finishShutdown = resolve; });
  const { executor, vnc, host } = await fixture({ nativeOptions: { releaseRun: () => shutdown } });
  await executor.execute([{ action: 'screenshot' }]);
  const renewals = host.requests.filter(request => request.action === 'renew_activity').length;
  const released = executor.release();
  try {
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(vnc.releases.length, 1);
    assert.equal(host.state().overlay_ready, true);
    assert.ok(host.requests.filter(request => request.action === 'renew_activity').length > renewals);
    assert.equal(host.requests.filter(request => request.action === 'release_activity').length, 0);
    finishShutdown();
    await released;
    assert.equal(host.state().overlay_ready, false);
    assert.equal(executor.released, true);
  } finally { finishShutdown(); await executor.close(); }
});

for (const event of ['concurrent close', 'lost readiness']) {
  test(`${event} during native shutdown cannot become a clean ownership-release claim`, async () => {
    let revoke = false;
    const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
      if (revoke && request.action === 'renew_activity') response.result.ready = false;
      return response;
    } }, nativeOptions: { releaseRun({ signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    } } });
    await executor.execute([{ action: 'screenshot' }]);
    const released = assert.rejects(executor.release(), /closed|receipt mismatch/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(vnc.releases.length, 1);
    if (event === 'concurrent close') await executor.close();
    else revoke = true;
    await released;
    assert.equal(executor.released, undefined);
    assert.equal(vnc.closes.length, 1);
    await assert.rejects(executor.execute([{ action: 'screenshot' }]), /releasing/);
  });
}

test('native clean-release failure is propagated rather than relabeled as clean ownership release', async () => {
  const { executor, vnc } = await fixture({ nativeOptions: {
    releaseError: new Error('Native shutdown acknowledgement unavailable') } });
  await assert.rejects(executor.release(), /shutdown acknowledgement unavailable/);
  assert.equal(vnc.releases.length, 1);
  assert.deepEqual(vnc.closes, [{ graceful: false }]);
  assert.equal(executor.released, undefined);
});

test('an uncleared or changed resident overlay prevents a clean-release claim', async () => {
  let healthCount = 0;
  const { executor, vnc } = await fixture({ helperOptions: { alter(request, response) {
    if (request.action === 'health' && ++healthCount > 1) response.result.overlay_ready = true;
    return response;
  } } });
  await assert.rejects(executor.release(), /overlay release unconfirmed/);
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.equal(executor.released, undefined);
});

test('clean release awaits confirmed close of its owned SSH child and escalates a refused TERM', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { ignoreTerm: true } });
  const result = executor.release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(executor.released, undefined);
  await result;
  assert.equal(vnc.releases.length, 1);
  assert.deepEqual(host.child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(executor.released, true);
});

test('unconfirmed owned SSH close fails clean release and remains failed', async () => {
  const { executor, vnc, host } = await fixture({ helperOptions: { ignoreTerm: true, ignoreKill: true } });
  await assert.rejects(executor.release(), /owned SSH exit unconfirmed/);
  assert.equal(executor.released, undefined);
  assert.equal(vnc.releases.length, 1);
  assert.equal(vnc.closes.length, 1);
  assert.deepEqual(host.child.kills, ['SIGTERM', 'SIGKILL']);
  await assert.rejects(executor.close(), /owned SSH exit unconfirmed/);
});
