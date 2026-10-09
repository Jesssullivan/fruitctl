// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TargetLane } from '../lib/broker/server.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function bounded(promise, milliseconds = 2500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation retirement exceeded the fixture bound')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function closeLane(lane) {
  if (lane.cleanupFailure) await assert.rejects(lane.close(), /unconfirmed/);
  else await lane.close();
}

for (const phase of ['release', 'close']) {
  test(`a failed operation bounds uncooperative ${phase} by its finite cleanup grace`, { timeout: 5000 }, async t => {
    const retirementStarted = deferred(), finishRetirement = deferred();
    const dispatched = [], closes = [], releaseOptions = [];
    let starts = 0;
    const lane = new TargetLane({}, async () => {
      starts++;
      return {
        async execute(actions) {
          dispatched.push(actions[0].action);
          throw new Error('Synthetic uncertain operation');
        },
        async release(options) {
          releaseOptions.push(options);
          if (phase === 'release') {
            retirementStarted.resolve();
            await finishRetirement.promise;
          }
        },
        async close(options) {
          closes.push(options);
          if (phase === 'close' && options?.graceful !== false) {
            retirementStarted.resolve();
            await finishRetirement.promise;
          }
        },
      };
    });
    lane.acquire('first');
    t.after(async () => {
      finishRetirement.resolve();
      await lane.tail;
      await closeLane(lane);
    });
    const failed = lane.execute([{ action: 'failed-input' }], { timeoutMs: 40 });
    failed.catch(() => {});
    const queued = lane.execute([{ action: 'queued-input' }], { timeoutMs: 10000 });
    queued.catch(() => {});
    await retirementStarted.promise;
    assert.throws(() => lane.acquire('first'), /releasing/,
      'even the original owner cannot reacquire during pending cleanup');
    assert.equal(lane.cleanupFailure, undefined, 'pending cleanup alone is not an unconfirmed result');
    await assert.rejects(bounded(failed), error => error.code === 'release_unconfirmed');
    await assert.rejects(bounded(queued), /unconfirmed|revoked/);
    assert.equal(releaseOptions.length, 1);
    assert.ok(releaseOptions[0].timeoutMs > 0 && releaseOptions[0].timeoutMs <= 40,
      'retirement receives only the failed operation remaining budget');
    assert.deepEqual(dispatched, ['failed-input']);
    assert.equal(closes.filter(options => options?.graceful === false).length, 1,
      'only the recorded executor receives forced cleanup');
    const failure = lane.cleanupFailure;
    assert.throws(() => lane.acquire('successor'), error => error === failure);
    finishRetirement.resolve();
    await delay(0);
    assert.equal(lane.cleanupFailure, failure, 'late release/close cannot erase uncertainty');
    assert.notEqual(lane.executor, null, 'late cleanup cannot detach the blocked executor');
    assert.throws(() => lane.acquire('successor'), error => error === failure);
    assert.equal(starts, 1);
  });
}

test('cancellation cannot reset failed-operation retirement to a fresh default budget', { timeout: 5000 }, async t => {
  const entered = deferred(), releaseStarted = deferred(), finishRelease = deferred();
  const releaseOptions = [];
  let forcedCloses = 0;
  const lane = new TargetLane({}, async () => ({
    async execute(_actions, { signal }) {
      entered.resolve();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    async release(options) {
      releaseOptions.push(options);
      releaseStarted.resolve();
      await finishRelease.promise;
    },
    async close(options) { if (options?.graceful === false) forcedCloses++; },
  }));
  lane.acquire('first');
  t.after(async () => { finishRelease.resolve(); await lane.tail; await closeLane(lane); });
  const controller = new AbortController();
  const request = lane.execute([{ action: 'held-input' }], { signal: controller.signal, timeoutMs: 80 });
  request.catch(() => {});
  await entered.promise;
  controller.abort(new Error('Owned fixture cancellation'));
  await releaseStarted.promise;
  await assert.rejects(bounded(request), error => error.code === 'release_unconfirmed');
  assert.ok(releaseOptions[0].timeoutMs > 0 && releaseOptions[0].timeoutMs <= 80);
  assert.equal(forcedCloses, 1);
  assert.throws(() => lane.acquire('successor'), /unconfirmed/);
});

test('queue wait forwards only the original remaining release budget', { timeout: 5000 }, async t => {
  const priorStarted = deferred(), finishPrior = deferred();
  const releaseStarted = deferred();
  let now = 10000;
  let closes = 0;
  t.mock.method(performance, 'now', () => now);
  const releaseOptions = [], dispatched = [];
  const lane = new TargetLane({}, async () => ({
    async execute(actions) {
      dispatched.push(actions[0].action);
      if (actions[0].action === 'prior-action') {
        priorStarted.resolve();
        await finishPrior.promise;
        return [{ id: 'prior', result: { detail: 'completed' } }];
      }
      throw new Error('Synthetic uncertain operation');
    },
    async release(options) { releaseOptions.push(options); releaseStarted.resolve(); },
    async close() { closes++; },
  }));
  lane.acquire('first');
  t.after(async () => { finishPrior.resolve(); await lane.tail; await closeLane(lane); });
  const prior = lane.execute([{ action: 'prior-action' }], { timeoutMs: 10000 });
  await priorStarted.promise;
  const requestedAt = now;
  const failed = lane.execute([{ action: 'failed-input' }], { timeoutMs: 5000 });
  failed.catch(() => {});
  now += 4500;
  finishPrior.resolve();
  await prior;
  await releaseStarted.promise;
  assert.equal(releaseOptions[0].timeoutMs, 500);
  assert.equal(now + releaseOptions[0].timeoutMs, requestedAt + 5000,
    'queue wait does not grant a new operation-sized retirement deadline');
  await assert.rejects(failed, /Synthetic uncertain operation/);
  assert.deepEqual(dispatched, ['prior-action', 'failed-input']);
  assert.equal(closes, 1);
  assert.equal(lane.cleanupFailure, undefined, 'queue accounting does not require unconfirmed cleanup');
  assert.equal(lane.executor, null, 'promptly confirmed cleanup detaches the failed executor');
});

test('a late cancelled success is refused while promptly confirmed cleanup permits handoff', { timeout: 3000 }, async t => {
  const executing = deferred(), finishExecution = deferred();
  let releases = 0, forcedCloses = 0;
  const lane = new TargetLane({}, async () => ({
    async execute() { executing.resolve(); await finishExecution.promise; return [{ result: { detail: 'late' } }]; },
    async release() { releases++; },
    async close(options) { if (options?.graceful === false) forcedCloses++; },
  }));
  lane.acquire('first');
  t.after(async () => { finishExecution.resolve(); await lane.tail; await closeLane(lane); });
  const request = lane.execute([{ action: 'uncertain-input' }], { timeoutMs: 30 });
  request.catch(() => {});
  await executing.promise;
  await delay(60);
  finishExecution.resolve();
  await assert.rejects(bounded(request), /deadline|cancel/i);
  assert.equal(releases, 1, 'safety cleanup is still allowed after the operation deadline');
  assert.equal(forcedCloses, 0);
  assert.equal(lane.cleanupFailure, undefined, 'confirmed cleanup must not become sticky only because the operation expired');
  assert.equal(lane.executor, null);
  await lane.release('first');
  lane.acquire('successor');
  assert.equal(lane.owner, 'successor');
});

test('confirmed error cleanup permits a normal explicit ownership handoff', { timeout: 3000 }, async t => {
  let starts = 0;
  const events = [];
  const lane = new TargetLane({}, async () => {
    const number = ++starts;
    return {
      async execute() {
        events.push(`execute-${number}`);
        if (number === 1) throw new Error('Synthetic operation failure');
        return [{ id: 'success', result: { detail: 'completed' } }];
      },
      async release() { events.push(`release-${number}`); },
      async close() { events.push(`close-${number}`); },
    };
  });
  t.after(() => closeLane(lane));
  lane.acquire('first');
  await assert.rejects(lane.execute([{ action: 'failed-input' }], { timeoutMs: 500 }), /Synthetic operation failure/);
  assert.equal(lane.cleanupFailure, undefined);
  assert.equal(lane.executor, null);
  await lane.release('first');
  lane.acquire('successor');
  assert.deepEqual(await lane.execute([{ action: 'successor-input' }]), [{ id: 'success', result: { detail: 'completed' } }]);
  await lane.release('successor');
  assert.deepEqual(events, ['execute-1', 'release-1', 'close-1', 'execute-2', 'release-2', 'close-2']);
  assert.equal(starts, 2);
});
