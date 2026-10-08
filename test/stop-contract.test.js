import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHumanStop } from './qualification/stop.mjs';

const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function episode() {
  const expected = { instanceId: 'instance-A', processId: 321, displayId: 1,
    displayGeneration: 7, sessionId: 'session-A' };
  const common = { instance_id: expected.instanceId, display_id: 1, displayGeneration: 7,
    capture_backend: 'owned_sck', raw_vnc_exclusion: false };
  return { expected, lastAcceptedSequence: 12,
    before: { ...common, observed_monotonic_ms: 100, human_stop_latched: false, last_human_stop_event: null },
    after: { ...common, observed_monotonic_ms: 220, human_stop_latched: true,
      lease_remaining_ms: 0, ready: false, capture_ready: false, overlay_ready: false, activity_eligible: false,
      last_human_stop_event: { schema: 'fruitctl.human-stop.v1', event_id: firstId, event_number: 1,
        instance_id: expected.instanceId, process_id: 321, display_id: 1, displayGeneration: 7,
        clock_basis: 'host_instance_milliseconds', invoked_monotonic_ms: 200,
        active_lease_at_stop: true, active_lease: { session_id: 'session-A', displayGeneration: 7,
          sequence: 12, lease_remaining_ms: 2750 } } } };
}
function refused(input, reason) {
  const result = classifyHumanStop(input);
  assert.equal(result.protocolStopConfirmed, false);
  assert.ok(result.reasons.includes(reason), JSON.stringify(result));
  assert.equal(result.event, null);
  return result;
}

test('fresh active same-lease Stop confirms protocol scope without qualifying physical or input behavior', () => {
  const input = episode(), original = structuredClone(input), result = classifyHumanStop(input);
  assert.equal(result.protocolStopConfirmed, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.event.lastAcceptedSequence, 12);
  assert.equal(result.event.invokedHostMilliseconds, 200);
  assert.equal(result.physicalClearQualified, false);
  assert.equal(result.captureExclusionQualified, false);
  assert.equal(result.inputRevocationQualified, false);
  assert.deepEqual(input, original);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.event) && Object.isFrozen(result.reasons));
  assert.ok(!JSON.stringify(result).includes('challenge'));
});

test('same Host observation brackets include their millisecond boundaries', () => {
  for (const invoked of [100, 220]) {
    const input = episode(); input.after.last_human_stop_event.invoked_monotonic_ms = invoked;
    assert.equal(classifyHumanStop(input).protocolStopConfirmed, true);
  }
});

test('a retained event after Allow requires a different ID and increased counter for the next Stop', () => {
  const input = episode();
  input.before.last_human_stop_event = { ...input.after.last_human_stop_event, invoked_monotonic_ms: 50 };
  input.after.last_human_stop_event.event_id = secondId;
  input.after.last_human_stop_event.event_number = 2;
  assert.equal(classifyHumanStop(input).protocolStopConfirmed, true);
});

for (const name of ['expiry', 'ordinary release', 'late Stop']) {
  test(`${name} cannot substitute for Stop during an active lease`, () => {
    const input = episode();
    input.after.last_human_stop_event.active_lease_at_stop = false;
    input.after.last_human_stop_event.active_lease = null;
    refused(input, 'stop_did_not_end_active_lease');
  });
}

test('ordinary release without a human event remains unqualified even with idle readiness', () => {
  const input = episode(); input.after.last_human_stop_event = null; input.after.human_stop_latched = false;
  refused(input, 'stop_event_unavailable_or_invalid');
});

test('a stale event cannot become fresh by changing UUID spelling or only its counter', () => {
  for (const change of [event => { event.event_id = firstId.toUpperCase(); event.event_number = 2; },
    event => { event.event_id = secondId; }]) {
    const input = episode();
    input.before.last_human_stop_event = { ...input.after.last_human_stop_event, invoked_monotonic_ms: 50 };
    change(input.after.last_human_stop_event);
    refused(input, 'stop_event_not_fresh');
  }
});

test('an event retained after Allow is not a currently latched Stop', () => {
  const input = episode(); input.after.human_stop_latched = false;
  refused(input, 'stop_revocation_state_unqualified');
});

for (const [key, value] of [['instance_id', 'instance-B'], ['process_id', 322],
  ['display_id', 2], ['displayGeneration', 8]]) {
  test(`event ${key} must match the frozen running Host`, () => {
    const input = episode(); input.after.last_human_stop_event[key] = value;
    refused(input, 'stop_event_host_binding_mismatch');
  });
}

for (const [key, value] of [['session_id', 'session-B'], ['displayGeneration', 8], ['sequence', 11], ['sequence', 13]]) {
  test(`ended lease ${key}=${value} refuses a different or unacknowledged lease`, () => {
    const input = episode(); input.after.last_human_stop_event.active_lease[key] = value;
    refused(input, 'stop_lease_binding_mismatch');
  });
}

for (const remaining of [0, -1, 3001, 0.5, '1000', Number.MAX_SAFE_INTEGER + 1]) {
  test(`remaining lease ${remaining} cannot establish active bounded Stop`, () => {
    const input = episode(); input.after.last_human_stop_event.active_lease.lease_remaining_ms = remaining;
    refused(input, 'stop_lease_remaining_unqualified');
  });
}

test('invocation outside either same-Host observation bracket refuses late or unrelated timing', () => {
  for (const invoked of [99, 221]) {
    const input = episode(); input.after.last_human_stop_event.invoked_monotonic_ms = invoked;
    refused(input, 'stop_outside_host_clock_bracket');
  }
});

test('reversed, fractional, unsafe, missing or controlling-seat clocks stay unqualified', () => {
  for (const change of [input => { input.after.observed_monotonic_ms = 99; },
    input => { input.before.observed_monotonic_ms = 99.5; },
    input => { input.after.observed_monotonic_ms = Number.MAX_SAFE_INTEGER + 1; },
    input => { delete input.before.observed_monotonic_ms; },
    input => { input.after.last_human_stop_event.clock_basis = 'seat_monotonic_ms'; }]) {
    const input = episode(); change(input);
    assert.equal(classifyHumanStop(input).protocolStopConfirmed, false);
  }
});

test('both health observations must preserve the independently frozen Host/display/backend', () => {
  for (const stage of ['before', 'after']) {
    for (const [key, value] of [['instance_id', 'instance-B'], ['displayGeneration', 8],
      ['display_id', 2], ['capture_backend', 'raw_vnc'], ['raw_vnc_exclusion', true]]) {
      const input = episode(); input[stage][key] = value;
      refused(input, 'health_host_binding_mismatch');
    }
  }
});

test('missing older-Host diagnostics and missing initial event cannot imply absence', () => {
  for (const stage of ['before', 'after']) {
    const input = episode(); delete input[stage].last_human_stop_event;
    assert.equal(classifyHumanStop(input).protocolStopConfirmed, false);
  }
  const input = episode(); input.after = null;
  refused(input, 'health_evidence_unavailable');
});

test('malformed initial event or a pre-existing Stop latch cannot qualify a new episode', () => {
  const input = episode(); input.before.last_human_stop_event = { event_id: firstId };
  refused(input, 'initial_stop_event_unqualified');
  input.before.last_human_stop_event = null; input.before.human_stop_latched = true;
  refused(input, 'initial_stop_latch_unqualified');
});

test('revocation requires exact false readiness values and zero lease', () => {
  for (const key of ['ready', 'capture_ready', 'overlay_ready', 'activity_eligible']) {
    for (const value of [true, 0, undefined]) {
      const input = episode(); input.after[key] = value;
      refused(input, 'stop_revocation_state_unqualified');
    }
  }
  const input = episode(); input.after.lease_remaining_ms = 1;
  refused(input, 'stop_revocation_state_unqualified');
});

test('invalid schema, UUID, counter or invocation values fail closed', () => {
  for (const [key, value] of [['schema', 'fruitctl.human-stop.v2'], ['event_id', 'not-an-event'],
    ['event_number', 0], ['event_number', '1'], ['invoked_monotonic_ms', -1], ['invoked_monotonic_ms', 200.5]]) {
    const input = episode(); input.after.last_human_stop_event[key] = value;
    refused(input, 'stop_event_unavailable_or_invalid');
  }
});

test('invalid expected custody and unconfirmed renewal sequence never infer a binding from the event', () => {
  for (const change of [input => { input.expected.processId = 0; }, input => { input.expected.instanceId = ''; },
    input => { input.expected.sessionId = 'two words'; }, input => { input.expected.displayGeneration = '7'; },
    input => { input.lastAcceptedSequence = undefined; }, input => { input.lastAcceptedSequence = 0; }]) {
    const input = episode(); change(input);
    refused(input, 'invalid_episode_binding');
  }
  for (const input of [undefined, null, [], true, 'unavailable']) refused(input, 'invalid_episode_binding');
});
