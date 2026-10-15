// SPDX-License-Identifier: MIT
// Read-only macOS target preflight for `fruitctl doctor --macos`.
//
// One fixed POSIX script runs over SSH on the Darwin target and prints
// delimited sections. Every section is interpreted by a pure parser below, so
// fixtures cover the policy offline. The script reads only named keys and
// filtered service state: no environment, credentials, TCC prompts, GUI
// launches, service changes or Apple log scans.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { loadConfig } from '../broker/paths.mjs';

export const PREFLIGHT_SCHEMA = 'fruitctl.macos-preflight.v1';
export const HOST_BUNDLE_ID = 'com.xoxd.fruitctl.host';
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 30000;
const SSH_DESTINATION = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,255}$/;

// D9: macOS 26 and 27 only. CVE-2026-65400 (screensharingd SRP pre-auth
// bypass, CISA KEV) bypasses every Screen Sharing authentication mode.
const SCREEN_SHARING_ADVISORY = 'CVE-2026-65400';
export const SUPPORTED_MACOS = Object.freeze({
  26: Object.freeze({ floor: '26.6.1', source: 'https://support.apple.com/en-us/148170' }),
  27: Object.freeze({ floor: '27.0', source: 'https://support.apple.com/en-us/149035' }),
});

// From the kickstart privilege table shipped on macOS 26.7.1.
export const ARD_PRIVILEGES = Object.freeze({ controlObserve: 0x2, observeOnly: 0x100 });

const SECTIONS = ['sw_vers', 'arch', 'console', 'screensharing_override', 'screensharing_service',
  'remote_management_marker', 'remote_management_prefs', 'console_naprivs', 'ioreg_console',
  'secure_input_process', 'pmset_assertions', 'pmset_settings', 'displays', 'host_app', 'tcc'];

/** Fixed script sent on the SSH session's stdin to `/bin/sh -s`. It takes no
 * caller-controlled text, so no argument can reach the remote shell. */
export const PROBE_SCRIPT = String.raw`PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; LC_ALL=C; export LC_ALL
begin() { printf '\n@@fruitctl-probe %s@@\n' "$1"; }
end() { printf '\n@@fruitctl-status %s %s@@\n' "$1" "$2"; }
begin sw_vers; sw_vers 2>/dev/null; end sw_vers $?
begin arch; uname -m 2>/dev/null; end arch $?
console_user=$(stat -f%Su /dev/console 2>/dev/null)
begin console; printf '%s\n' "$console_user"; end console 0
begin screensharing_override; launchctl print-disabled system 2>/dev/null | grep -F '"com.apple.screensharing"'; end screensharing_override $?
begin screensharing_service; launchctl print system/com.apple.screensharing 2>/dev/null | grep -E "^$(printf '\t')(state|runs|last exit code) = "; end screensharing_service $?
begin remote_management_marker; head -c 64 "/Library/Application Support/Apple/Remote Desktop/RemoteManagement.launchd" 2>/dev/null; end remote_management_marker $?
begin remote_management_prefs
for key in ARD_AllLocalUsers ARD_AllLocalUsersPrivs VNCLegacyConnectionsEnabled ScreenSharingReqPermEnabled; do
  value=$(defaults read /Library/Preferences/com.apple.RemoteManagement "$key" 2>/dev/null) && printf '%s=%s\n' "$key" "$value"
done
end remote_management_prefs 0
begin console_naprivs
case "$console_user" in ''|root|*[!A-Za-z0-9._-]*) ;; *) dscl . -read "/Users/$console_user" naprivs 2>/dev/null ;; esac
end console_naprivs $?
console_ioreg=$(ioreg -w 0 -d 1 -k IOConsoleUsers 2>/dev/null | grep -E '"IOConsole(Users|Locked)" = ')
begin ioreg_console; printf '%s\n' "$console_ioreg"; end ioreg_console 0
begin secure_input_process
secure_pid=$(printf '%s\n' "$console_ioreg" | sed -n 's/.*"kCGSSessionSecureInputPID"=\([0-9][0-9]*\).*/\1/p' | head -n 1)
if [ -n "$secure_pid" ]; then printf 'pid=%s\n' "$secure_pid"; ps -o comm= -p "$secure_pid" 2>/dev/null; fi
end secure_input_process 0
begin pmset_assertions; pmset -g assertions 2>/dev/null; end pmset_assertions $?
begin pmset_settings; pmset -g 2>/dev/null; end pmset_settings $?
begin displays
system_profiler -detailLevel mini SPDisplaysDataType 2>/dev/null | sed -n 's/^        \([^ ].*\):$/display=\1/p; s/^ *Online: /online=/p; s/^ *Virtual Device: /virtual=/p'
end displays $?
begin host_app
for scope in user system; do
  if [ "$scope" = user ]; then app="$HOME/Applications/FruitctlHost.app"; else app=/Applications/FruitctlHost.app; fi
  if [ -d "$app" ]; then
    printf '%s|%s|%s\n' "$scope" "$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)" "$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
  fi
done
end host_app 0
begin tcc
for scope in system user; do
  if [ "$scope" = system ]; then db="/Library/Application Support/com.apple.TCC/TCC.db"; else db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"; fi
  if rows=$(sqlite3 -readonly "$db" "select service, auth_value from access where client = '${HOST_BUNDLE_ID}' and service in ('kTCCServiceScreenCapture', 'kTCCServiceAccessibility')" 2>/dev/null); then
    printf '%s|readable\n' "$scope"
    printf '%s\n' "$rows" | sed -n "s/^\(kTCCService[A-Za-z]*\)|\(-\{0,1\}[0-9][0-9]*\)$/$scope|row|\1|\2/p"
  else
    printf '%s|unreadable\n' "$scope"
  fi
done
end tcc 0
`;

const finding = (code, message) => Object.freeze({ code, message });

/** Split probe stdout into named sections. A marker counts only on its own
 * line; unknown section names and malformed status values are ignored. */
export function parseProbeOutput(text) {
  const sections = new Map();
  if (typeof text !== 'string') return sections;
  let current = null;
  let lines = [];
  for (const line of text.split('\n')) {
    const begin = /^@@fruitctl-probe ([a-z_]+)@@$/.exec(line);
    const end = /^@@fruitctl-status ([a-z_]+) ([0-9]{1,3})@@$/.exec(line);
    if (begin && SECTIONS.includes(begin[1])) { current = begin[1]; lines = []; continue; }
    if (end && current === end[1]) {
      while (lines.length && lines.at(-1) === '') lines.pop();
      while (lines.length && lines[0] === '') lines.shift();
      sections.set(current, { output: lines.join('\n'), status: Number(end[2]) });
      current = null;
      continue;
    }
    if (current) lines.push(line);
  }
  return sections;
}

function parseVersion(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

/** `sw_vers` output: ProductName, ProductVersion, optional ProductVersionExtra
 * (Rapid Security Response) and BuildVersion. Malformed output returns null. */
export function parseSwVers(text) {
  if (typeof text !== 'string') return null;
  const fields = {};
  for (const line of text.split('\n')) {
    const match = /^(ProductName|ProductVersion|ProductVersionExtra|BuildVersion):\s*(.*?)\s*$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  const version = parseVersion(fields.ProductVersion);
  if (!fields.ProductName || !version || !/^[0-9A-Za-z]{1,16}$/.test(fields.BuildVersion || '')) return null;
  return { productName: fields.ProductName, productVersion: fields.ProductVersion,
    ...(fields.ProductVersionExtra ? { productVersionExtra: fields.ProductVersionExtra } : {}),
    buildVersion: fields.BuildVersion, version };
}

/** D9 policy: 26 at or above 26.6.1, or any 27 release. */
export function evaluateMacosVersion(parsed) {
  if (!parsed) {
    return { supported: false, failure: finding('macos_version_unknown',
      'sw_vers output was missing or malformed; the macOS 26/27 floor cannot be verified') };
  }
  const [major] = parsed.version;
  const policy = parsed.productName === 'macOS' ? SUPPORTED_MACOS[major] : undefined;
  const os = { productName: parsed.productName, version: parsed.productVersion, build: parsed.buildVersion,
    ...(parsed.productVersionExtra ? { versionExtra: parsed.productVersionExtra } : {}), major };
  if (!policy) {
    return { ...os, supported: false, failure: finding('macos_unsupported',
      `macOS ${parsed.productVersion} is unsupported; Fruitctl supports macOS 26 and 27 only`) };
  }
  const floor = { version: policy.floor, advisory: SCREEN_SHARING_ADVISORY, source: policy.source };
  if (compareVersions(parsed.version, parseVersion(policy.floor)) < 0) {
    return { ...os, supported: false, floor, failure: finding('macos_below_patch_floor',
      `macOS ${parsed.productVersion} is below ${policy.floor}, which fixes ${SCREEN_SHARING_ADVISORY} (Screen Sharing pre-authentication bypass)`) };
  }
  return { ...os, supported: true, floor };
}

/** `launchctl print-disabled system` line for com.apple.screensharing. An
 * absent override leaves the service at its shipped default, disabled. */
export function parseScreenSharingOverride(text) {
  const match = /"com\.apple\.screensharing"\s*=>\s*(enabled|disabled|true|false)\b/.exec(text || '');
  if (!match) return 'disabled';
  return match[1] === 'enabled' || match[1] === 'false' ? 'enabled' : 'disabled';
}

export function parseLaunchdService(text) {
  const result = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^\t(state|runs|last exit code) = (.{1,64})$/.exec(line);
    if (match) result[match[1] === 'last exit code' ? 'lastExit' : match[1]] = match[2].trim();
  }
  if (result.runs !== undefined) result.runs = /^[0-9]+$/.test(result.runs) ? Number(result.runs) : undefined;
  return result;
}

/** kickstart -activate writes `enabled` to RemoteManagement.launchd. */
export function parseRemoteManagementMarker(section) {
  if (!section || section.status !== 0) return 'off';
  const value = section.output.trim();
  if (value === 'enabled') return 'on';
  if (value === 'disabled' || value === '') return 'off';
  return 'unknown';
}

function int32(value) {
  if (typeof value !== 'string' || !/^-?[0-9]{1,10}$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  if (number < -2147483648 || number > 4294967295) return undefined;
  return number >>> 0;
}

/** `key=value` lines from per-key `defaults read`; values are 0/1 or integers. */
export function parseRemoteManagementPrefs(text) {
  const prefs = {};
  for (const line of String(text || '').split('\n')) {
    const match = /^(ARD_AllLocalUsers|ARD_AllLocalUsersPrivs|VNCLegacyConnectionsEnabled|ScreenSharingReqPermEnabled)=(.*)$/.exec(line);
    if (!match) continue;
    const value = int32(match[2]);
    if (value === undefined) continue;
    prefs[match[1]] = match[1] === 'ARD_AllLocalUsersPrivs' ? value : value !== 0;
  }
  return prefs;
}

export function parseNaprivs(text) {
  const match = /^naprivs:\s*(-?[0-9]{1,10})\s*$/m.exec(text || '');
  return match ? int32(match[1]) : undefined;
}

/** Observe-only applies to Remote Management privileges. Plain Screen Sharing
 * leaves observe or control to the viewer, so a passive probe cannot know it. */
export function evaluateObserveOnly({ remoteManagement, prefs, naprivs }) {
  if (remoteManagement !== 'on') return { observeOnly: 'unknown' };
  const privileges = prefs.ARD_AllLocalUsers === true ? prefs.ARD_AllLocalUsersPrivs : naprivs;
  if (privileges === undefined) return { observeOnly: 'unknown' };
  if (!(privileges & ARD_PRIVILEGES.controlObserve)) {
    return { observeOnly: true, failure: finding('remote_control_not_permitted',
      'Remote Management grants no Control and Observe privilege to the target user') };
  }
  if (privileges & ARD_PRIVILEGES.observeOnly) {
    return { observeOnly: true, failure: finding('observe_only',
      'Remote Management restricts the target user to Observe only; input would be dropped') };
  }
  return { observeOnly: false };
}

function ioregBool(text, key) {
  const match = new RegExp(`"${key}"=(Yes|No)\\b`).exec(text);
  return match ? match[1] === 'Yes' : undefined;
}

/** Root IORegistry IOConsoleUsers and IOConsoleLocked properties. */
export function parseConsoleSessions(text) {
  const value = String(text || '');
  const locked = /"IOConsoleLocked" = (Yes|No)\b/.exec(value);
  const users = /"IOConsoleUsers" = \((.*)\)\s*$/m.exec(value);
  const sessions = [];
  if (users) {
    for (const entry of users[1].match(/\{[^{}]*\}/g) || []) {
      const pid = /"kCGSSessionSecureInputPID"=([0-9]{1,10})\b/.exec(entry);
      sessions.push({ onConsole: ioregBool(entry, 'kCGSSessionOnConsoleKey'),
        loginDone: ioregBool(entry, 'kCGSessionLoginDoneKey'),
        screenLocked: ioregBool(entry, 'CGSSessionScreenIsLocked'),
        ...(pid ? { secureInputPid: Number(pid[1]) } : {}) });
    }
  }
  return { known: Boolean(users), locked: locked ? locked[1] === 'Yes' : undefined, sessions };
}

export function parseSecureInputProcess(text) {
  const lines = String(text || '').split('\n').map(line => line.trim()).filter(Boolean);
  const pid = /^pid=([0-9]{1,10})$/.exec(lines[0] || '');
  if (!pid) return { held: false };
  const command = lines[1] || '';
  // `ps -o comm=` is the executable path without arguments; keep a bounded
  // basename only, never the full path.
  const name = command.split('/').filter(Boolean).at(-1)?.slice(0, 64);
  return { held: true, pid: Number(pid[1]), ...(name ? { process: name } : {}) };
}

/** `pmset -g assertions`: system-wide counters plus owning-process names. */
export function parsePmsetAssertions(text) {
  const counters = {};
  let screenSharingActivity = false;
  for (const line of String(text || '').split('\n')) {
    const counter = /^ {3}([A-Za-z]+)\s+([0-9]+)\s*$/.exec(line);
    if (counter) counters[counter[1]] = Number(counter[2]);
    const owner = /^ {3}pid [0-9]+\(([^)]{1,64})\): \[/.exec(line);
    // Remote input reaches WindowServer as an IOHID tickle naming the
    // Screen Sharing agent; the daemons may also own assertions directly.
    if (owner && (/^(screensharingd|ScreensharingAgent)$/.test(owner[1]) ||
        /\bprocess:(ScreensharingAgent|screensharingd)\b/.test(line))) screenSharingActivity = true;
  }
  const known = Object.keys(counters).length > 0;
  return { known,
    displaySleepPrevented: known ? (counters.PreventUserIdleDisplaySleep || 0) + (counters.InternalPreventDisplaySleep || 0) > 0 : undefined,
    screenSharingActivity: known ? screenSharingActivity : undefined };
}

/** `pmset -g` live settings; `displaysleep 0` means never. */
export function parsePmsetSettings(text) {
  const match = /^ displaysleep\s+([0-9]+)\b/m.exec(text || '');
  return { displaySleepMinutes: match ? Number(match[1]) : undefined };
}

/** Filtered `system_profiler SPDisplaysDataType` lines. High Performance
 * sessions replace physical displays with "Screen Sharing Virtual Display". */
export function parseDisplays(section) {
  if (!section || section.status !== 0) return { known: false };
  const displays = [];
  for (const line of section.output.split('\n')) {
    const name = /^display=(.{1,128})$/.exec(line);
    if (name) { displays.push({ name: name[1], online: undefined, virtual: false }); continue; }
    const last = displays.at(-1);
    if (!last) continue;
    if (line === 'online=Yes' || line === 'online=No') last.online = line === 'online=Yes';
    if (line === 'virtual=Yes') last.virtual = true;
  }
  return { known: true, count: displays.length,
    online: displays.filter(display => display.online !== false).length,
    screenSharingVirtual: displays.some(display => /Screen Sharing Virtual Display/i.test(display.name)) };
}

export function parseHostApp(text) {
  const installs = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^(user|system)\|([A-Za-z0-9.-]{0,128})\|([A-Za-z0-9.+-]{0,64})$/.exec(line);
    if (match) installs.push({ location: match[1], bundleId: match[2] || undefined, version: match[3] || undefined });
  }
  const host = installs.find(install => install.bundleId === HOST_BUNDLE_ID);
  if (host) return { installed: true, location: host.location, ...(host.version ? { version: host.version } : {}) };
  if (installs.length) return { installed: false, foreignBundle: true };
  return { installed: false };
}

const TCC_SERVICES = { kTCCServiceScreenCapture: 'screenRecording', kTCCServiceAccessibility: 'accessibility' };

/** TCC rows for the Host bundle. Reading TCC.db requires Full Disk Access for
 * the SSH session; an unreadable database is unknown, never "not granted". */
export function parseTcc(text) {
  const readable = new Set();
  const grants = {};
  for (const line of String(text || '').split('\n')) {
    const state = /^(system|user)\|(readable|unreadable)$/.exec(line);
    if (state && state[2] === 'readable') readable.add(state[1]);
    const row = /^(system|user)\|row\|(kTCCService[A-Za-z]+)\|(-?[0-9]{1,3})$/.exec(line);
    if (row && TCC_SERVICES[row[2]] && grants[TCC_SERVICES[row[2]]] !== 'granted') {
      grants[TCC_SERVICES[row[2]]] = row[3] === '2' ? 'granted' : row[3] === '0' ? 'denied' : 'limited';
    }
  }
  // The system database owns both services; the user database is a fallback.
  const source = readable.has('system') ? 'tcc' : readable.size ? 'tcc-user-only' : 'unreadable';
  const result = { source };
  for (const name of Object.values(TCC_SERVICES)) {
    result[name] = grants[name] ?? (readable.has('system') ? 'not_recorded' : 'unknown');
  }
  return result;
}

const sectionText = (sections, name) => sections.get(name)?.output ?? '';

/** Pure policy over parsed sections. `route` is the configured profile route
 * when known ('host' | 'raw'), otherwise 'unknown'. */
export function evaluatePreflight(sections, { route = 'unknown' } = {}) {
  const failures = [];
  const warnings = [];
  const unknowns = [];

  const os = evaluateMacosVersion(sections.get('sw_vers')?.status === 0
    ? parseSwVers(sectionText(sections, 'sw_vers')) : null);
  if (os.failure) failures.push(os.failure);
  const { failure: _osFailure, ...osResult } = os;
  const architecture = /^(arm64|x86_64)$/.exec(sectionText(sections, 'arch').trim())?.[1];

  // A missing section means the probe did not run, not that the service is off.
  const service = sections.has('screensharing_override')
    ? parseScreenSharingOverride(sectionText(sections, 'screensharing_override')) : 'unknown';
  const serviceState = parseLaunchdService(sectionText(sections, 'screensharing_service'));
  const remoteManagement = parseRemoteManagementMarker(sections.get('remote_management_marker'));
  const prefs = parseRemoteManagementPrefs(sectionText(sections, 'remote_management_prefs'));
  const mode = service === 'disabled' ? 'off' : service === 'unknown' ? 'unknown'
    : remoteManagement === 'on' ? 'remote_management'
      : remoteManagement === 'off' ? 'screen_sharing' : 'unknown';
  if (mode === 'off') {
    failures.push(finding('screen_sharing_disabled',
      'Neither Screen Sharing nor Remote Management is enabled (com.apple.screensharing is disabled)'));
  }
  if (mode === 'unknown') {
    unknowns.push(service === 'unknown'
      ? finding('screen_sharing_unverified', 'The Screen Sharing launchd override was not readable')
      : finding('remote_management_marker_unrecognized', 'RemoteManagement.launchd has unrecognized content'));
  }
  const observe = evaluateObserveOnly({ remoteManagement, prefs,
    naprivs: parseNaprivs(sectionText(sections, 'console_naprivs')) });
  if (observe.failure) failures.push(observe.failure);
  if (observe.observeOnly === 'unknown') {
    unknowns.push(finding('observe_only_unverified', mode === 'remote_management'
      ? 'Remote Management privileges for the console user were not readable'
      : 'Plain Screen Sharing leaves observe or control to the viewer; verify with an input probe'));
  }
  if (prefs.VNCLegacyConnectionsEnabled === true) {
    warnings.push(finding('legacy_vnc_password_enabled',
      'The legacy VNC password is enabled; disable it (CVE-2026-43760, CVE-2026-43665)'));
  }

  const displays = parseDisplays(sections.get('displays'));
  let highPerformance = 'unknown';
  if (displays.known) {
    highPerformance = displays.screenSharingVirtual ? true : 'not_detected';
    if (displays.screenSharingVirtual) {
      failures.push(finding('high_performance_session',
        'A High Performance Screen Sharing session is active (Screen Sharing Virtual Display present); Fruitctl does not support it'));
    }
    if (displays.online === 0) warnings.push(finding('no_online_display', 'No online display was reported'));
  } else unknowns.push(finding('displays_unverified', 'Display configuration was not readable'));
  unknowns.push(finding('curtain_unverified',
    'Curtain mode has no passive host-side signal; it is reported unknown'));

  const consoleUser = sectionText(sections, 'console').trim();
  const consoleState = !consoleUser ? 'unknown' : consoleUser === 'root' ? 'loginwindow' : 'user';
  if (consoleState === 'loginwindow') {
    failures.push(finding('no_console_session', 'The console is at the login window; no user session is on screen'));
  } else if (consoleState === 'unknown') unknowns.push(finding('console_unverified', 'The console owner was not readable'));
  const consoleSessions = parseConsoleSessions(sectionText(sections, 'ioreg_console'));
  const onConsole = consoleSessions.sessions.find(session => session.onConsole === true);
  const locked = consoleSessions.locked === true || onConsole?.screenLocked === true
    ? true : consoleSessions.known ? false : 'unknown';
  if (locked === true) failures.push(finding('screen_locked', 'The console session screen is locked'));
  const additionalSessions = consoleSessions.sessions.filter(session => session.onConsole === false).length;
  if (additionalSessions) {
    warnings.push(finding('additional_gui_sessions',
      `${additionalSessions} GUI session(s) are off console (fast user switching or a virtual Screen Sharing session)`));
  }
  const secureInput = parseSecureInputProcess(sectionText(sections, 'secure_input_process'));
  if (secureInput.held) {
    warnings.push(finding('secure_input_held',
      `Secure keyboard entry is held by ${secureInput.process || `pid ${secureInput.pid}`}; typed input may be refused`));
  }
  const assertions = parsePmsetAssertions(sectionText(sections, 'pmset_assertions'));
  const { displaySleepMinutes } = parsePmsetSettings(sectionText(sections, 'pmset_settings'));
  if (assertions.screenSharingActivity) {
    warnings.push(finding('screen_sharing_input_recent',
      'A Screen Sharing client sent input recently; confirm no other input owner is active on this Mac'));
  }
  if (displaySleepMinutes > 0 && assertions.displaySleepPrevented !== true) {
    warnings.push(finding('display_sleep_enabled',
      `The display sleeps after ${displaySleepMinutes} minute(s); captures may go black`));
  }

  const host = parseHostApp(sectionText(sections, 'host_app'));
  const grants = parseTcc(sectionText(sections, 'tcc'));
  if (!host.installed) {
    warnings.push(finding('host_not_installed',
      'FruitctlHost is not installed; only the raw VNC route is available, without the indicator or grants'));
  } else {
    if (route === 'raw') {
      warnings.push(finding('host_installed_raw_route',
        'FruitctlHost is installed but this profile uses the raw VNC route; configure hostHelper to make the Host route the default'));
    }
    for (const [name, label] of [['screenRecording', 'Screen Recording'], ['accessibility', 'Accessibility']]) {
      if (grants[name] === 'unknown') continue;
      if (grants[name] !== 'granted') {
        warnings.push(finding(`host_${name === 'screenRecording' ? 'screen_recording' : 'accessibility'}_not_granted`,
          `FruitctlHost has no ${label} grant (${grants[name]})`));
      }
    }
    if (grants.source !== 'tcc') {
      warnings.push(finding('host_grants_unverified',
        'Host grants could not be read: the SSH session lacks Full Disk Access to TCC.db'));
    }
  }

  const status = failures.length ? 'fail' : warnings.length ? 'warn' : 'pass';
  return { schema: PREFLIGHT_SCHEMA, status, route,
    os: { ...osResult, ...(architecture ? { architecture } : {}) },
    screenSharing: { service, ...(serviceState.state ? { serviceState: serviceState.state } : {}),
      remoteManagement, mode, observeOnly: observe.observeOnly, highPerformance, curtain: 'unknown',
      legacyVncPassword: prefs.VNCLegacyConnectionsEnabled ?? 'unknown' },
    session: { console: consoleState, locked, additionalSessions,
      secureInput: secureInput.held ? { held: true, ...(secureInput.process ? { process: secureInput.process } : {}) } : { held: false },
      displays: displays.known ? { count: displays.count, online: displays.online } : 'unknown',
      displaySleepMinutes: displaySleepMinutes ?? 'unknown',
      displaySleepPrevented: assertions.displaySleepPrevented ?? 'unknown',
      screenSharingActivity: assertions.screenSharingActivity ?? 'unknown' },
    host: { ...host, grants },
    failures, warnings, unknowns,
    qualification: 'Read-only SSH probes at one sample time; typed results describe that sample, not runtime capture or input behavior' };
}

export function validateSshDestination(destination) {
  if (typeof destination !== 'string' || !SSH_DESTINATION.test(destination)) {
    throw new Error('Target SSH destination must be an explicit host or user@host');
  }
  return destination;
}

export function sshProbeArguments(destination) {
  return ['-T', '-oBatchMode=yes', '-oConnectTimeout=10', '-oForwardAgent=no', '-oForwardX11=no',
    '-oClearAllForwardings=yes', '-oControlMaster=no', '-oControlPath=none', '-oControlPersist=no',
    '-oRequestTTY=no', '--', validateSshDestination(destination), '/bin/sh -s'];
}

/** Run the fixed script over SSH. Remote stderr is discarded; stdout is
 * bounded. A timeout or oversize output terminates only this owned child. */
export function runProbe(destination, { spawnImpl = spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const args = sshProbeArguments(destination);
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return new Promise((resolve, reject) => {
    const child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        if (child.exitCode == null && child.signalCode == null) { try { child.kill('SIGKILL'); } catch {} }
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('Target preflight timed out'),
      { code: 'preflight_timeout' })), timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(Object.assign(new Error('Target preflight output exceeded its limit'), { code: 'preflight_output_limit' }));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr?.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', () => finish(Object.assign(new Error('Target preflight SSH could not start'),
      { code: 'preflight_unreachable' })));
    child.once('close', code => {
      if (code === 255) {
        finish(Object.assign(new Error('Target preflight SSH connection failed'), { code: 'preflight_unreachable' }));
      } else finish(null, Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(PROBE_SCRIPT);
  });
}

/** Resolve the probe destination from an explicit flag or the operator's
 * target profile. Tool arguments never reach this; it is CLI-only. */
export async function resolvePreflightTarget({ targetSsh, configPath, target = 'default' } = {}) {
  let profile;
  if (configPath) {
    let present = true;
    try { await fs.access(configPath); } catch { present = false; }
    if (present) profile = (await loadConfig(configPath)).targets[target];
    if (present && !profile && !targetSsh) throw new Error(`Unknown target profile: ${target}`);
  }
  const route = profile ? (profile.hostHelper ? 'host' : 'raw') : 'unknown';
  const destination = targetSsh ?? profile?.hostHelper?.sshHost;
  if (!destination) {
    throw new Error('Target preflight needs --target-ssh USER@HOST, or a profile with hostHelper.sshHost');
  }
  return { destination: validateSshDestination(destination), route };
}

export async function macosPreflight({ destination, route = 'unknown', probe = runProbe } = {}) {
  let output;
  try { output = await probe(destination); }
  catch (error) {
    const failure = finding(error.code || 'preflight_unreachable', error.message || 'Target preflight failed');
    return { schema: PREFLIGHT_SCHEMA, status: 'fail', route, failures: [failure], warnings: [], unknowns: [],
      qualification: 'No target facts were collected' };
  }
  return evaluatePreflight(parseProbeOutput(output), { route });
}
