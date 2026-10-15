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

export function preAdmissionRefusal(message) {
  const error = new Error(message);
  error.code = 'unsupported_action';
  error.responses = [];
  refusals.add(error);
  return error;
}

// A serialized code/message, mutable Error property or remote response cannot
// bypass cleanup. Only a refusal constructed before admission has this brand.
export function isPreAdmissionRefusal(error) { return refusals.has(error); }

export function requireNativeActions(actions, capabilities) {
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
