// Value-only consumer of fruitctl.human-stop.v1. No transport or input authority.
const MAX_LEASE_MS = 3000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  /^[\x21-\x7e]+$/.test(value);
const uuid = value => typeof value === 'string' && value.length === 36 &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/**
 * Classify recorded health values against independently frozen episode bindings.
 * before/after must be health results from the same Host instance; the caller
 * supplies the sequence of the final acknowledged activity renewal. This does
 * not authenticate records, establish their transport timing, or perform Stop.
 * Missing diagnostics (including older Hosts) stay unqualified. All clocks here
 * are Host-instance milliseconds, never controlling-seat or wall-clock time.
 */
export function classifyHumanStop(input) {
  const { expected, before, after, lastAcceptedSequence } = record(input) ? input : {};
  const reasons = [];
  const check = (condition, reason) => { if (!condition) reasons.push(reason); };
  const finish = event => Object.freeze({
    protocolStopConfirmed: reasons.length === 0,
    reasons: Object.freeze(reasons),
    event: reasons.length ? null : Object.freeze(event),
    scope: 'same-lease human Stop protocol correlation only',
    physicalClearQualified: false,
    captureExclusionQualified: false,
    inputRevocationQualified: false,
  });
  if (!record(expected) || !token(expected.instanceId) ||
      !integer(expected.processId, 1, 0x7fffffff) ||
      !integer(expected.displayId, 1, 0xffffffff) ||
      !integer(expected.displayGeneration) || !token(expected.sessionId) ||
      !integer(lastAcceptedSequence, 1)) {
    reasons.push('invalid_episode_binding');
    return finish();
  }
  if (!record(before) || !record(after)) {
    reasons.push('health_evidence_unavailable');
    return finish();
  }
  const sameHost = health => health.instance_id === expected.instanceId &&
    health.display_id === expected.displayId && health.displayGeneration === expected.displayGeneration &&
    health.capture_backend === 'owned_sck' && health.raw_vnc_exclusion === false;
  check(sameHost(before) && sameHost(after), 'health_host_binding_mismatch');
  check(integer(before.observed_monotonic_ms) && integer(after.observed_monotonic_ms) &&
    before.observed_monotonic_ms <= after.observed_monotonic_ms, 'invalid_host_clock_bracket');
  check(before.human_stop_latched === false, 'initial_stop_latch_unqualified');
  check(after.human_stop_latched === true && after.lease_remaining_ms === 0 &&
    ['ready', 'capture_ready', 'overlay_ready', 'activity_eligible'].every(key => after[key] === false),
  'stop_revocation_state_unqualified');

  const previous = before.last_human_stop_event;
  const diagnostic = event => record(event) && event.schema === 'fruitctl.human-stop.v1' &&
    event.clock_basis === 'host_instance_milliseconds' && uuid(event.event_id) &&
    integer(event.event_number, 1) && integer(event.invoked_monotonic_ms);
  // Explicit null establishes no prior event; omission does not.
  const previousValid = Object.hasOwn(before, 'last_human_stop_event') && (previous === null || (diagnostic(previous) &&
    previous.instance_id === expected.instanceId && previous.process_id === expected.processId &&
    previous.invoked_monotonic_ms <= before.observed_monotonic_ms));
  check(previousValid, 'initial_stop_event_unqualified');
  const event = after.last_human_stop_event;
  if (!diagnostic(event)) {
    reasons.push('stop_event_unavailable_or_invalid');
    return finish();
  }
  if (previousValid && previous !== null) {
    check(event.event_id.toLowerCase() !== previous.event_id.toLowerCase() &&
      event.event_number > previous.event_number, 'stop_event_not_fresh');
  }
  check(event.instance_id === expected.instanceId && event.process_id === expected.processId &&
    event.display_id === expected.displayId && event.displayGeneration === expected.displayGeneration,
  'stop_event_host_binding_mismatch');
  check(integer(before.observed_monotonic_ms) && integer(after.observed_monotonic_ms) &&
    event.invoked_monotonic_ms >= before.observed_monotonic_ms &&
    event.invoked_monotonic_ms <= after.observed_monotonic_ms, 'stop_outside_host_clock_bracket');
  const activity = event.active_lease;
  check(event.active_lease_at_stop === true && record(activity), 'stop_did_not_end_active_lease');
  if (record(activity)) {
    check(activity.session_id === expected.sessionId &&
      activity.displayGeneration === expected.displayGeneration &&
      activity.sequence === lastAcceptedSequence, 'stop_lease_binding_mismatch');
    check(integer(activity.lease_remaining_ms, 1, MAX_LEASE_MS), 'stop_lease_remaining_unqualified');
  }
  return finish({
    eventId: event.event_id,
    eventNumber: event.event_number,
    instanceId: expected.instanceId,
    processId: expected.processId,
    displayId: expected.displayId,
    displayGeneration: expected.displayGeneration,
    sessionId: expected.sessionId,
    lastAcceptedSequence,
    invokedHostMilliseconds: event.invoked_monotonic_ms,
    beforeHostMilliseconds: before.observed_monotonic_ms,
    afterHostMilliseconds: after.observed_monotonic_ms,
  });
}
