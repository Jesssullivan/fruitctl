// SPDX-License-Identifier: MIT
const unknown = Object.freeze({ known: false, actions: Object.freeze([]) });
const refusals = new WeakSet();

// Missing metadata belongs to older native releases. It is unknown, never an
// empty supported-action set or permission to claim a newer backend feature.
export function nativeCapabilities(actions) {
  if (actions === undefined) return unknown;
  if (!Array.isArray(actions) || actions.length > 64 ||
      actions.some(action => typeof action !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(action)) ||
      new Set(actions).size !== actions.length) {
    throw new Error('Invalid native capability metadata');
  }
  return Object.freeze({ known: true, actions: Object.freeze([...actions]) });
}

// Capability metadata as a result or executor reports it ({known, actions},
// optionally with backend detail). Malformed metadata is not evidence of
// support: it yields undefined so callers keep treating support as unobserved.
export function advertisedCapabilities(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.known === false) return unknown;
  if (value.known !== true) return undefined;
  try { return nativeCapabilities(value.actions); }
  catch { return undefined; }
}

// `unsupported_on_route` names an action this route deliberately does not
// serve; `unsupported_action` names one the backend does not offer at all.
export function preAdmissionRefusal(message, code = 'unsupported_action') {
  const error = new Error(message);
  error.code = code;
  error.responses = [];
  refusals.add(error);
  return error;
}

// A serialized code/message, mutable Error property or remote response cannot
// bypass cleanup. Only a refusal constructed before admission has this brand.
export function isPreAdmissionRefusal(error) { return refusals.has(error); }

// Actions that exist only on the Host route. The raw VNC route refuses them
// before admission with a typed code; they are never forwarded to the daemon.
export const HOST_ROUTE_ACTIONS = Object.freeze(['ax_snapshot']);

// Refusal codes an MCP result may carry from a thrown error. Every other
// thrown failure keeps the message-only shape.
export const TYPED_REFUSAL_CODES = Object.freeze(['unsupported_on_route', 'accessibility_permission_required',
  // D16 type_secret refusals, all before any input.
  'invalid_secret_request', 'secret_ref_not_allowed', 'secret_unavailable', 'human_stop_latched']);

export function routeRefusal(action) {
  const error = preAdmissionRefusal(`${action} is unsupported on the raw VNC route; configure hostHelper`);
  error.code = 'unsupported_on_route';
  return error;
}

export function requireNativeActions(actions, capabilities) {
  const hostOnly = actions.find(action => HOST_ROUTE_ACTIONS.includes(action.action));
  if (hostOnly) throw routeRefusal(hostOnly.action);
  if (capabilities.known && actions.some(action => !capabilities.actions.includes(action.action))) {
    throw preAdmissionRefusal('Action unavailable on native backend');
  }
}

// D7 route labels. The raw VNC route never carries the target-side indicator.
// The Host route reports `present` only while its validated activity receipt
// confirms the overlay; otherwise `unknown`. An executor that declares no
// route (an older broker) is labelled unknown rather than guessed.
const ROUTES = new Set(['host', 'raw']);
const INDICATORS = new Set(['present', 'absent', 'unknown']);
export const RAW_PRESENTATION = Object.freeze({ route: 'raw', indicator: 'absent' });

export function presentationLabels(value) {
  const route = ROUTES.has(value?.route) ? value.route : 'unknown';
  if (route === 'raw') return RAW_PRESENTATION;
  const indicator = INDICATORS.has(value?.indicator) && (route === 'host' || value.indicator !== 'present')
    ? value.indicator : 'unknown';
  return Object.freeze({ route, indicator });
}

// A failed, cancelled or timed-out call cannot attest a live overlay. Keep the
// route (raw stays absent) but never carry `present` across a failure.
export function unattestedLabels(value) {
  const labels = presentationLabels(value);
  return labels.indicator === 'present' ? Object.freeze({ route: labels.route, indicator: 'unknown' }) : labels;
}
