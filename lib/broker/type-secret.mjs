// SPDX-License-Identifier: MIT
// D16 type_secret on the Darwin broker. A request names a ref; the target's
// `secrets` allowlist maps it to a provider. The value exists only between
// resolution and the native `type_secret` request on the daemon's private
// stdin pipe. The daemon types it as keystrokes through the ordinary input
// path, with the input-settle gate, and never through the clipboard (D29).
import { preAdmissionRefusal } from '../mcp/capabilities.js';
import { lengthClass, resolveSecret, secretRefs, SecretError, SECRET_REF } from './secrets.mjs';

const REQUEST_FIELDS = new Set(['action', 'ref', 'x', 'y']);
const coordinate = value => Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,63}$/;

export const SECRET_REQUEST_MESSAGE = 'type_secret takes {ref, x?, y?}; a secret value never travels in a request';

/** A type_secret request names a ref and an optional point, nothing else.
 * The broker and the Linux relay both apply this check. */
export function secretRequestShape(action) {
  return !Object.keys(action).some(key => !REQUEST_FIELDS.has(key)) && typeof action.ref === 'string' &&
    SECRET_REF.test(action.ref) && (action.x === undefined) === (action.y === undefined) &&
    (action.x === undefined || (coordinate(action.x) && coordinate(action.y)));
}

function refusal(message, code) {
  const error = preAdmissionRefusal(message);
  error.code = code;
  return error;
}

/** Check every type_secret step before anything is queued or resolved.
 * Returns null for a batch without type_secret. A request that carries a
 * value, or a ref this target does not allowlist, is a typed refusal. */
export function planSecretBatch(profile, actions) {
  if (!Array.isArray(actions)) return null;
  const steps = new Map();
  let refs;
  actions.forEach((action, index) => {
    if (action?.action !== 'type_secret') return;
    if (!secretRequestShape(action)) throw refusal(SECRET_REQUEST_MESSAGE, 'invalid_secret_request');
    refs ??= secretRefs(profile);
    const spec = refs.get(action.ref);
    if (!spec) throw refusal(`Secret ref ${action.ref} is not allowlisted for this target`, 'secret_ref_not_allowed');
    steps.set(index, { ref: action.ref, spec });
  });
  if (!steps.size) return null;
  const annotate = (fields = () => ({})) => actions.map((action, index) => {
    const step = steps.get(index);
    return step ? { ...action, provider: step.spec.provider, ...fields(index) } : action;
  });
  return {
    steps,
    indexes: new Set(steps.keys()),
    // Journal intent before resolution: ref and provider kind only.
    journalled: annotate(),
    journal: values => annotate(index => ({ length_class: lengthClass(values.get(index)) })),
    // The only object that carries a value; handed straight to the executor.
    native: values => actions.map((action, index) => steps.has(index)
      ? { action: 'type_secret', secret: values.get(index),
        ...(action.x === undefined ? {} : { x: action.x, y: action.y }) }
      : action),
  };
}

/** Resolve each distinct ref once under one deadline. A failure is a typed
 * pre-admission refusal: no input was sent and the lease is retained. */
export async function resolveSecretBatch(plan, { signal, timeoutMs, ...options } = {}) {
  const deadline = performance.now() + timeoutMs;
  const byRef = new Map();
  const values = new Map();
  for (const [index, { ref, spec }] of plan.steps) {
    if (!byRef.has(ref)) {
      try {
        byRef.set(ref, await resolveSecret(spec, { ...options, signal,
          timeoutMs: Math.max(1, deadline - performance.now()) }));
      } catch (error) {
        const reason = error instanceof SecretError ? error.reason : 'spawn_failed';
        const failure = refusal(`Secret ref ${ref} is unavailable: ${spec.provider} provider ${reason}`,
          'secret_unavailable');
        failure.data = { reason, ref, provider: spec.provider };
        throw failure;
      }
    }
    values.set(index, byRef.get(ref));
  }
  return values;
}

/** The only shape a type_secret step returns to a client, journal or model:
 * OK, or a typed failure with a fixed message. Native text is never echoed,
 * so a refused character of the secret cannot leak through an error. */
export function secretResponse(response) {
  if (!response || typeof response !== 'object') return response;
  const id = response.id;
  if (!response.error) return { ...(id === undefined ? {} : { id }), result: { detail: 'OK' } };
  const { code, data } = response.error;
  const kept = {};
  if (typeof data?.reason === 'string' && SAFE_REASON.test(data.reason)) kept.reason = data.reason;
  if (Number.isSafeInteger(data?.remaining_ms) && data.remaining_ms >= 0) kept.remaining_ms = data.remaining_ms;
  // -32011 and -32013 are refusals written before any event.
  const before = code === -32011 || code === -32013;
  return { ...(id === undefined ? {} : { id }), error: {
    code: Number.isInteger(code) ? code : -32000,
    message: before ? 'type_secret was refused before any key was sent'
      : 'type_secret did not complete; the field may hold part of the secret',
    ...(Object.keys(kept).length ? { data: kept } : {}) } };
}

/** D8/D16: every value this target allowlists, for checking a clipboard_read
 * before it leaves the broker. A provider failure is a typed pre-admission
 * refusal: an unverifiable clipboard is never returned. */
export async function resolveAllowlistedSecrets(profile, { signal, timeoutMs, ...options } = {}) {
  const deadline = performance.now() + timeoutMs;
  const values = [];
  for (const [ref, spec] of secretRefs(profile)) {
    try {
      values.push(await resolveSecret(spec, { ...options, signal,
        timeoutMs: Math.max(1, deadline - performance.now()) }));
    } catch (error) {
      const reason = error instanceof SecretError ? error.reason : 'spawn_failed';
      const failure = refusal(`clipboard_read cannot check secret ref ${ref}: ${spec.provider} provider ${reason}`,
        'secret_unavailable');
      failure.data = { reason, ref, provider: spec.provider };
      throw failure;
    }
  }
  return values;
}
