// SPDX-License-Identifier: MIT
// D8/D12 desktop-state sentinel (TIN-5509). macOS can put UI in front of an
// agent that it cannot act through: a consent or authorization dialog, the
// lock screen or login window, an asleep display. Before a batch with input,
// the broker reads that state with one fixed, read-only script over the
// target's SSH path and refuses the batch, typed, before any event is sent.
// The script never sends input, never clicks a dialog (D16) and reads no
// pixels or window titles. An unknown state never refuses anything.
import { runProbe, parseProbeOutput, consoleLockState, parseRemoteInputProcesses,
  parseAssertionHolders, parsePmsetAssertions, evaluateRemoteInputOwners, validateSshDestination,
  PROBE_PRELUDE, PROBE_CONSOLE, PROBE_SESSION, PROBE_ASSERTIONS, PROBE_REMOTE_INPUT } from '../install/macos-preflight.mjs';
import { preAdmissionRefusal, HUMAN_CONSENT_REQUIRED_CODE, TARGET_LOCKED_CODE } from '../mcp/capabilities.js';
import { DISPLAY_ASLEEP } from './wake.mjs';

const TTL_MS = 2000;
const FAILURE_TTL_MS = 10000;
const PROBE_TIMEOUT_MS = 4000;
// A window smaller than this is a status item or an ordered-in remnant, not a
// dialog a human must answer.
const MIN_DIALOG_SIDE = 40;

// Processes that draw macOS consent, authorization and system dialogs. Only an
// on-screen window owned by one counts: CoreServicesUIAgent and
// SoftwareUpdateNotificationManager run all session long, and
// UserNotificationCenter was observed running with no window on PZM.
export const DIALOG_OWNERS = Object.freeze([
  // CFUserNotification alerts, including tccd's privacy prompts such as
  // "<app> would like to access data from other apps".
  { process: 'UserNotificationCenter', kind: 'system_alert' },
  // "<app> would like to control this computer using accessibility features".
  { process: 'universalAccessAuthWarn', kind: 'accessibility_consent' },
  // Administrator and keychain authorization.
  { process: 'SecurityAgent', kind: 'authorization' },
  // Gatekeeper and quarantine ("downloaded from the Internet") prompts.
  { process: 'CoreServicesUIAgent', kind: 'gatekeeper' },
  // Software Update install and restart countdowns.
  { process: 'SoftwareUpdateNotificationManager', kind: 'software_update' },
].map(Object.freeze));
const SCREEN_SAVERS = Object.freeze(['ScreenSaverEngine', 'legacyScreenSaver']);
const WATCHED = [...DIALOG_OWNERS.map(entry => entry.process), ...SCREEN_SAVERS];

// JXA run in the console user's session. Prints online displays with their
// sleep state, and the on-screen windows of the PIDs passed as arguments:
// owner PID, layer, size and alpha only. No window titles, no pixels.
const WINDOW_SCRIPT = [
  'function run(argv) {',
  '  ObjC.import("CoreGraphics");',
  '  var out = [], want = {};',
  '  argv.forEach(function (pid) { want[pid] = true; });',
  '  var ids = Ref(), count = Ref();',
  '  if ($.CGGetOnlineDisplayList(16, ids, count) === 0) {',
  '    out.push("displays=ok");',
  '    for (var i = 0; i < count[0] && i < 16; i++) {',
  '      out.push(["display", ids[i], $.CGDisplayIsAsleep(ids[i]) ? 1 : 0, $.CGDisplayIsMain(ids[i]) ? 1 : 0].join("|"));',
  '    }',
  '  } else out.push("displays=failed");',
  '  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(',
  '    $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0)));',
  '  if (!Array.isArray(list)) out.push("windows=failed");',
  '  else {',
  '    out.push("windows=ok");',
  '    list.filter(function (w) { return want[String(w.kCGWindowOwnerPID)]; }).slice(0, 64).forEach(function (w) {',
  '      var b = w.kCGWindowBounds || {};',
  '      out.push(["window", w.kCGWindowOwnerPID, w.kCGWindowLayer, Math.round(b.Width || 0), Math.round(b.Height || 0),',
  '        w.kCGWindowAlpha === undefined ? 1 : w.kCGWindowAlpha].join("|"));',
  '    });',
  '  }',
  '  return out.join("\\n");',
  '}',
].join('\n');

const SENTINEL_BODY = String.raw`begin dialog_owners
if owners=$(ps -axww -o pid=,comm= 2>/dev/null); then
  printf 'read=ok\n'
  owners=$(printf '%s\n' "$owners" | grep -E '/(${WATCHED.join('|')})$' | head -n 32)
  printf '%s\n' "$owners"
else printf 'read=failed\n'; owners=; fi
end dialog_owners 0
begin desktop_windows
if [ -z "$console_user" ] || [ "$console_user" = root ]; then printf 'scope=no_console_user\n'
elif [ "$console_user" != "$ssh_user" ]; then printf 'scope=other_user\n'
else
  printf 'scope=console_user\n'
  osascript -l JavaScript -e '${WINDOW_SCRIPT}' $(printf '%s\n' "$owners" | awk '{print $1}') 2>/dev/null </dev/null
fi
end desktop_windows $?
`;

/** The fixed script sent to `/bin/sh -s`. It has no variable input. */
export const DESKTOP_STATE_SCRIPT = `${PROBE_PRELUDE}${PROBE_CONSOLE}${PROBE_SESSION}${PROBE_ASSERTIONS}` +
  `${PROBE_REMOTE_INPUT}${SENTINEL_BODY}`;
export const DESKTOP_STATE_SECTIONS = Object.freeze(['console', 'ioreg_console', 'secure_input_process',
  'pmset_assertions', 'remote_input_processes', 'dialog_owners', 'desktop_windows']);

/** `<pid> <executable path>` lines for watched owners; exact basenames only. */
export function parseDialogOwners(section) {
  const lines = section?.status === 0 ? section.output.split('\n') : [];
  if (lines[0] !== 'read=ok') return { known: false, pids: new Map() };
  const pids = new Map();
  for (const line of lines.slice(1)) {
    const match = /^\s*([0-9]{1,10}) (\/.{0,1023})$/.exec(line);
    const name = match?.[2].split('/').at(-1);
    if (match && WATCHED.includes(name)) pids.set(Number(match[1]), name);
  }
  return { known: true, pids };
}

/** The JXA output: display sleep state and the watched owners' windows. Each
 * part is unknown unless the SSH account is the console user and it was read. */
export function parseDesktopWindows(section) {
  const lines = section?.output.split('\n') ?? [];
  const scope = /^scope=(console_user|other_user|no_console_user)$/.exec(lines[0] || '')?.[1] ?? 'unknown';
  let displays = 'unknown';
  let windows = 'unknown';
  if (scope === 'console_user' && section.status === 0) {
    if (lines.includes('displays=ok')) displays = [];
    if (lines.includes('windows=ok')) windows = [];
    for (const line of lines.slice(1)) {
      const display = /^display\|([0-9]{1,10})\|([01])\|([01])$/.exec(line);
      if (display && Array.isArray(displays)) {
        displays.push({ id: Number(display[1]), asleep: display[2] === '1', main: display[3] === '1' });
      }
      const window = /^window\|([0-9]{1,10})\|(-?[0-9]{1,11})\|([0-9]{1,6})\|([0-9]{1,6})\|([0-9.]{1,8})$/.exec(line);
      if (window && Array.isArray(windows)) {
        windows.push({ pid: Number(window[1]), layer: Number(window[2]), width: Number(window[3]),
          height: Number(window[4]), alpha: Number(window[5]) });
      }
    }
  }
  return { scope, displays, windows };
}

const UNKNOWN_FIELDS = Object.freeze({ console: 'unknown', locked: 'unknown', display_asleep: 'unknown',
  consent_dialog: 'unknown', screen_saver: 'unknown', secure_input_holder: 'unknown', other_input_owner: 'unknown' });

/** The state when nothing could be read: every field unknown, with why. */
export function unknownDesktopState(reason) {
  return { sentinel: 'unknown', reason, ...UNKNOWN_FIELDS };
}

const EVIDENCE_RANK = ['input', 'assertion', 'process'];

/** Pure policy over the sentinel's parsed sections. */
export function evaluateDesktopState(sections) {
  const { consoleState, locked, secureInput } = consoleLockState(sections);
  const owners = parseDialogOwners(sections.get('dialog_owners'));
  const { displays, windows } = parseDesktopWindows(sections.get('desktop_windows'));
  const visible = owners.known && Array.isArray(windows)
    ? windows.filter(window => owners.pids.has(window.pid) && window.alpha > 0 &&
      window.width >= MIN_DIALOG_SIDE && window.height >= MIN_DIALOG_SIDE).map(window => owners.pids.get(window.pid))
    : 'unknown';
  const dialog = Array.isArray(visible) ? DIALOG_OWNERS.find(entry => visible.includes(entry.process)) : undefined;
  const main = Array.isArray(displays) ? displays.find(display => display.main) : undefined;
  const asleep = main ? main.asleep
    : Array.isArray(displays) && displays.length ? displays.every(display => display.asleep) : 'unknown';
  const assertions = sectionText(sections, 'pmset_assertions');
  const remote = evaluateRemoteInputOwners({
    processes: parseRemoteInputProcesses(sections.get('remote_input_processes')),
    holders: parseAssertionHolders(assertions), assertionsKnown: parsePmsetAssertions(assertions).known });
  const other = Array.isArray(remote.owners)
    ? [...remote.owners].sort((a, b) => rank(a) - rank(b))[0] ?? null : 'unknown';
  return {
    sentinel: 'ok',
    console: consoleState,
    // The login window has no user session to act in; it blocks like a lock.
    locked: consoleState === 'loginwindow' ? true : locked,
    display_asleep: asleep,
    consent_dialog: visible === 'unknown' ? 'unknown' : dialog ? { owner: dialog.process, kind: dialog.kind } : null,
    screen_saver: visible === 'unknown' ? 'unknown' : visible.some(name => SCREEN_SAVERS.includes(name)),
    secure_input_holder: secureInput === 'unknown' ? 'unknown'
      : secureInput.held ? secureInput.process ?? 'unknown_process' : null,
    other_input_owner: other && other !== 'unknown' ? { owner: other.owner, evidence: other.evidence } : other,
  };
}

function rank(row) {
  return Math.min(...row.evidence.map(kind => EVIDENCE_RANK.indexOf(kind)));
}

function sectionText(sections, name) { return sections.get(name)?.output ?? ''; }

function refusal(message, code, data) {
  const error = preAdmissionRefusal(message);
  error.code = code;
  error.data = data;
  return error;
}

/** The typed refusal for a batch with input, or null. Only a known blocking
 * state refuses: lock or login window, then an asleep display, then a
 * consent dialog. Secure Input, screen saver and other input owners are
 * reported, not refused. */
export function desktopRefusal(state) {
  if (state?.sentinel !== 'ok') return null;
  if (state.locked === true) {
    return state.console === 'loginwindow'
      ? refusal('Target is at the login window; no user session is on screen', TARGET_LOCKED_CODE,
        { reason: 'target_locked', console: 'loginwindow' })
      : refusal('Target screen is locked', TARGET_LOCKED_CODE, { reason: 'target_locked', console: 'locked' });
  }
  if (state.display_asleep === true) {
    return refusal('Target display is asleep; no input was sent', DISPLAY_ASLEEP, { reason: DISPLAY_ASLEEP });
  }
  const dialog = state.consent_dialog;
  if (dialog && typeof dialog === 'object') {
    return refusal(`A ${dialog.kind} dialog from ${dialog.owner} is on screen; a human must answer it`,
      HUMAN_CONSENT_REQUIRED_CODE, { reason: 'human_consent_required', owner: dialog.owner, kind: dialog.kind });
  }
  return null;
}

/** `targets.<name>.desktopState`. The destination defaults to the profile's
 * wake SSH destination, then its Host helper SSH alias. `enabled: false` or
 * no destination turns the sentinel off. Only an explicit invalid value
 * throws; a fallback that is not a plain destination leaves it off. */
export function desktopStateOptions(profile) {
  const config = profile?.desktopState;
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.enabled !== undefined && typeof config.enabled !== 'boolean'))) {
    throw new Error('Invalid desktopState profile');
  }
  if (config?.enabled === false) return null;
  if (config?.ssh !== undefined) {
    try { return { ssh: validateSshDestination(config.ssh) }; }
    catch { throw new Error('desktopState requires ssh as an explicit user@host destination'); }
  }
  for (const candidate of [profile?.wake?.ssh, profile?.hostHelper?.sshHost]) {
    try { if (candidate !== undefined) return { ssh: validateSshDestination(candidate) }; }
    catch { /* not a usable destination; try the next one */ }
  }
  return null;
}

/** One target's sentinel: one probe in flight at a time, cached ~2 s (10 s
 * after a failure, so an unreachable target is not re-probed per action). */
export class DesktopSentinel {
  constructor({ ssh, probe = runProbe, now = () => performance.now(), ttlMs = TTL_MS,
    failureTtlMs = FAILURE_TTL_MS, timeoutMs = PROBE_TIMEOUT_MS, log = () => {} }) {
    this.destination = ssh;
    this.probe = probe;
    this.now = now;
    this.ttlMs = ttlMs;
    this.failureTtlMs = failureTtlMs;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.record = null;
    this.observedAt = -Infinity;
    this.inflight = null;
  }

  fresh() {
    return this.record !== null &&
      this.now() - this.observedAt < (this.record.sentinel === 'ok' ? this.ttlMs : this.failureTtlMs);
  }

  /** Start a probe unless the cache is fresh or one is running. Never rejects. */
  refresh() {
    if (this.fresh()) return Promise.resolve(this.snapshot());
    if (!this.inflight) {
      const startedAt = this.now();
      this.inflight = Promise.resolve()
        .then(() => this.probe(this.destination, { script: DESKTOP_STATE_SCRIPT, timeoutMs: this.timeoutMs,
          connectTimeoutSeconds: Math.max(1, Math.ceil(this.timeoutMs / 1000)) }))
        .then(output => evaluateDesktopState(parseProbeOutput(output, DESKTOP_STATE_SECTIONS)), error => {
          const reason = error?.code === 'preflight_timeout' ? 'probe_timeout' : 'probe_failed';
          if (this.record?.reason !== reason) {
            this.log(`Fruitctl desktop-state probe for ${this.destination} failed: ${String(error?.message || reason).slice(0, 256)}`);
          }
          return unknownDesktopState(reason);
        })
        .then(record => {
          // The sample is as old as the probe's start.
          this.record = record;
          this.observedAt = startedAt;
          this.inflight = null;
          return this.snapshot();
        });
    }
    return this.inflight;
  }

  /** The current state, waiting at most `timeoutMs` for a probe. A slow probe
   * reads as unknown for this caller and keeps running for the next one. */
  read({ timeoutMs = this.timeoutMs, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('Operation cancelled'));
    if (this.fresh()) return Promise.resolve(this.snapshot());
    let timer;
    let abort;
    return Promise.race([this.refresh(), new Promise((resolve, reject) => {
      timer = setTimeout(() => resolve(unknownDesktopState('probe_timeout')), Math.max(0, timeoutMs));
      abort = () => reject(signal.reason || new Error('Operation cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
    })]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  }

  /** The last state with its age; `pending` before the first probe answers. */
  snapshot() {
    if (!this.record) return unknownDesktopState('pending');
    return { ...this.record, observed_ms_ago: Math.max(0, Math.round(this.now() - this.observedAt)) };
  }

  /** What an observation may report as current: the cached sample while it
   * is fresh, otherwise unknown (`stale`), never an old sample as if new. */
  current() {
    return this.fresh() ? this.snapshot() : unknownDesktopState(this.record ? 'stale' : 'pending');
  }

  status() {
    const { sentinel, reason, observed_ms_ago: age } = this.snapshot();
    return { configured: true, sentinel, ...(reason ? { reason } : {}), ...(age === undefined ? {} : { observed_ms_ago: age }) };
  }
}

export const DESKTOP_STATE_NOT_CONFIGURED = Object.freeze(unknownDesktopState('not_configured'));
const OBSERVED = new Set(['health', 'screenshot']);

/** Health and screenshot results carry the lane's desktop state. */
export function withDesktopState(actions, responses, state) {
  if (!Array.isArray(responses)) return responses;
  return responses.map((response, index) => OBSERVED.has(actions[index]?.action) &&
    response?.result && typeof response.result === 'object' && !Array.isArray(response.result)
    ? { ...response, result: { ...response.result, desktop_state: state } } : response);
}

export function observesDesktop(actions) {
  return actions.some(action => OBSERVED.has(action?.action));
}
