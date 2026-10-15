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
// Same character set as the host-helper sshHost validator (bracketed IPv6
// allowed), plus the relay's leading underscore. A leading '-' is refused, and
// the destination is passed after `--` as one argv entry, never through a shell.
const SSH_DESTINATION = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,255}$/;
// macOS short account names; anything else (spaces, quotes, leading '-') is
// not passed to the target and its privileges are reported unknown.
const ACCOUNT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

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
  'remote_management_marker', 'remote_management_prefs', 'vnc_naprivs', 'ioreg_console',
  'secure_input_process', 'pmset_assertions', 'pmset_settings', 'displays', 'host_app', 'tcc'];

export function usableAccountName(value) {
  return typeof value === 'string' && ACCOUNT_NAME.test(value) ? value : undefined;
}

const PROBE_BODY = String.raw`PATH=/usr/bin:/bin:/usr/sbin:/sbin; export PATH; LC_ALL=C; export LC_ALL
case "$vnc_user" in ''|-*|*[!A-Za-z0-9._-]*) vnc_user= ;; esac
begin() { printf '\n@@fruitctl-probe %s@@\n' "$1"; }
end() { printf '\n@@fruitctl-status %s %s@@\n' "$1" "$2"; }
begin sw_vers; sw_vers 2>/dev/null; end sw_vers $?
begin arch; uname -m 2>/dev/null; end arch $?
console_user=$(stat -f%Su /dev/console 2>/dev/null)
case "$console_user" in ''|-*|*[!A-Za-z0-9._-]*) console_user= ;; esac
begin console; printf '%s\n' "$console_user"; end console 0
console_home=
case "$console_user" in ''|root) ;; *) console_home=$(dscl . -read "/Users/$console_user" NFSHomeDirectory 2>/dev/null | sed -n 's/^NFSHomeDirectory: //p' | head -n 1) ;; esac
case "$console_home" in /*) ;; *) console_home= ;; esac
begin screensharing_override
if disabled_services=$(launchctl print-disabled system 2>/dev/null); then
  printf 'read=ok\n'; printf '%s\n' "$disabled_services" | grep -F '"com.apple.screensharing"'
else printf 'read=failed\n'; fi
end screensharing_override 0
begin screensharing_service; launchctl print system/com.apple.screensharing 2>/dev/null | grep -E "^$(printf '\t')(state|runs|last exit code) = "; end screensharing_service $?
begin remote_management_marker
marker="/Library/Application Support/Apple/Remote Desktop/RemoteManagement.launchd"
if [ ! -e "$marker" ]; then printf 'absent\n'
elif marker_value=$(head -c 64 "$marker" 2>/dev/null); then printf 'value=%s\n' "$marker_value"
else printf 'unreadable\n'; fi
end remote_management_marker 0
begin remote_management_prefs
for key in ARD_AllLocalUsers ARD_AllLocalUsersPrivs VNCLegacyConnectionsEnabled ScreenSharingReqPermEnabled; do
  value=$(defaults read /Library/Preferences/com.apple.RemoteManagement "$key" 2>/dev/null) && printf '%s=%s\n' "$key" "$value"
done
end remote_management_prefs 0
begin vnc_naprivs
if [ -z "$vnc_user" ]; then printf 'user=unset\n'
elif record=$(dscl . -read "/Users/$vnc_user" naprivs 2>/dev/null) && [ -n "$record" ]; then printf '%s\n' "$record"
else printf 'naprivs=unreadable\n'; fi
end vnc_naprivs 0
console_ioreg=$(ioreg -w 0 -d 1 -k IOConsoleUsers 2>/dev/null | grep -E '"IOConsole(Users|Locked)" = ')
begin ioreg_console; printf '%s\n' "$console_ioreg"; end ioreg_console 0
begin secure_input_process
printf '%s\n' "$console_ioreg" | grep -o '"kCGSSessionSecureInputPID"=[0-9][0-9]*' | sed 's/.*=//' | head -n 8 | while read -r pid; do
  printf 'pid=%s|%s\n' "$pid" "$(ps -o comm= -p "$pid" 2>/dev/null)"
done
end secure_input_process 0
begin pmset_assertions; pmset -g assertions 2>/dev/null; end pmset_assertions $?
begin pmset_settings; pmset -g 2>/dev/null; end pmset_settings $?
begin displays
system_profiler -detailLevel mini SPDisplaysDataType 2>/dev/null | sed -n 's/^        \([^ ].*\):$/display=\1/p; s/^ *Online: /online=/p; s/^ *Virtual Device: /virtual=/p'
end displays $?
begin host_app
for scope in user system; do
  if [ "$scope" = system ]; then app=/Applications/FruitctlHost.app; parent=/Applications
  elif [ -n "$console_home" ]; then app="$console_home/Applications/FruitctlHost.app"; parent="$console_home/Applications"
  else printf 'user|unknown\n'; continue; fi
  if [ -d "$app" ]; then
    printf '%s|present|%s|%s\n' "$scope" "$(defaults read "$app/Contents/Info" CFBundleIdentifier 2>/dev/null)" "$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
  elif [ -e "$parent" ] && [ ! -x "$parent" ]; then printf '%s|unknown\n' "$scope"
  elif [ "$scope" = user ] && [ ! -x "$console_home" ]; then printf 'user|unknown\n'
  else printf '%s|absent\n' "$scope"; fi
done
end host_app 0
begin tcc
if rows=$(sqlite3 -readonly "/Library/Application Support/com.apple.TCC/TCC.db" "select service, auth_value from access where client = '${HOST_BUNDLE_ID}' and service in ('kTCCServiceScreenCapture', 'kTCCServiceAccessibility')" 2>/dev/null); then
  printf 'system|readable\n'
  printf '%s\n' "$rows" | sed -n 's/^\(kTCCService[A-Za-z]*\)|\(-\{0,1\}[0-9][0-9]*\)$/system|row|\1|\2/p'
else printf 'system|unreadable\n'; fi
end tcc 0
`;

/** The fixed script sent on the SSH session's stdin to `/bin/sh -s`. The only
 * variable input is a VNC account name that matched ACCOUNT_NAME; it is
 * single-quoted (the pattern admits no quote) and re-filtered remotely. */
export function probeScript({ vncUser } = {}) {
  const name = usableAccountName(vncUser) ?? '';
  return `vnc_user='${name}'\n${PROBE_BODY}`;
}
export const PROBE_SCRIPT = probeScript();

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

/** `launchctl print-disabled system` line for com.apple.screensharing. After a
 * successful read, an absent override leaves the shipped default, disabled.
 * A failed or missing read is unknown, never "disabled". */
export function parseScreenSharingOverride(text) {
  const value = String(text || '');
  if (!/^read=ok$/m.test(value)) return 'unknown';
  const match = /"com\.apple\.screensharing"\s*=>\s*(enabled|disabled|true|false)\b/.exec(value);
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

/** kickstart -activate writes `enabled` to RemoteManagement.launchd. Only an
 * explicit `disabled` value means off; an absent, unreadable or unrecognized
 * marker is unknown (whether Settings rewrites it is unverified). */
export function parseRemoteManagementMarker(section) {
  const value = section?.status === 0 ? section.output.trim() : '';
  if (value === 'value=enabled') return { state: 'on' };
  if (value === 'value=disabled') return { state: 'off' };
  return { state: 'unknown', reason: value === 'absent' ? 'absent' : value === 'unreadable' ? 'unreadable'
    : value.startsWith('value=') ? 'unrecognized' : 'not_probed' };
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

/** `dscl . -read /Users/<vnc user> naprivs` for the configured VNC account. */
export function parseNaprivs(text) {
  const value = String(text || '');
  if (/^user=unset$/m.test(value)) return { state: 'unset' };
  const match = /^naprivs:\s*(-?[0-9]{1,10})\s*$/m.exec(value);
  const privileges = match ? int32(match[1]) : undefined;
  return privileges === undefined ? { state: 'unreadable' } : { state: 'read', privileges };
}

/** Observe-only comes from Remote Management privileges. Input is governed by
 * the VNC authentication account, so per-user privileges are read for that
 * account only. Readable privileges are judged unless Remote Management is
 * explicitly off; under plain Screen Sharing the viewer chooses. */
export function evaluateObserveOnly({ remoteManagement, prefs, vncPrivileges }) {
  if (remoteManagement === 'off') return { observeOnly: 'unknown', reason: 'viewer_choice' };
  const privileges = prefs.ARD_AllLocalUsers === true ? prefs.ARD_AllLocalUsersPrivs
    : vncPrivileges?.state === 'read' ? vncPrivileges.privileges : undefined;
  if (privileges === undefined) {
    return { observeOnly: 'unknown', reason: prefs.ARD_AllLocalUsers === true ? 'unreadable'
      : vncPrivileges?.state === 'unset' ? 'vnc_user_unknown' : 'unreadable' };
  }
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

/** `pid=<n>|<ps -o comm=>` lines for every SecureInput PID in IOConsoleUsers.
 * `comm` is the executable path without arguments; only a bounded basename is
 * kept. The caller picks the on-console session's own PID. */
export function parseSecureInputProcesses(text) {
  const names = new Map();
  for (const line of String(text || '').split('\n')) {
    const match = /^pid=([0-9]{1,10})\|(.{0,1024})$/.exec(line.trim());
    if (!match) continue;
    const name = match[2].split('/').filter(Boolean).at(-1)?.slice(0, 64);
    names.set(Number(match[1]), name || undefined);
  }
  return names;
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

/** `<scope>|present|<bundle>|<version>`, `<scope>|absent` or `<scope>|unknown`
 * for the console user's ~/Applications and /Applications. */
export function parseHostApp(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const present = /^(user|system)\|present\|([A-Za-z0-9.-]{0,128})\|([A-Za-z0-9.+-]{0,64})$/.exec(line);
    if (present) { rows.push({ location: present[1], state: 'present', bundleId: present[2] || undefined, version: present[3] || undefined }); continue; }
    const other = /^(user|system)\|(absent|unknown)$/.exec(line);
    if (other) rows.push({ location: other[1], state: other[2] });
  }
  const host = rows.find(row => row.state === 'present' && row.bundleId === HOST_BUNDLE_ID);
  if (host) return { installed: true, location: host.location, ...(host.version ? { version: host.version } : {}) };
  const foreign = rows.some(row => row.state === 'present');
  // Both locations must have been checked before "not installed" is claimed.
  const checked = ['user', 'system'].every(location => rows.some(row => row.location === location && row.state !== 'unknown'));
  if (!checked) return { installed: 'unknown', ...(foreign ? { foreignBundle: true } : {}) };
  return { installed: false, ...(foreign ? { foreignBundle: true } : {}) };
}

const TCC_SERVICES = { kTCCServiceScreenCapture: 'screenRecording', kTCCServiceAccessibility: 'accessibility' };

/** Host rows from the system TCC.db, which owns Screen Capture and
 * Accessibility; per-user databases do not decide these services and are not
 * read. Reading needs Full Disk Access for the SSH session; an unreadable
 * database is unknown, never "not granted". */
export function parseTcc(text) {
  let readable = false;
  const grants = {};
  for (const line of String(text || '').split('\n')) {
    if (line === 'system|readable') readable = true;
    const row = /^system\|row\|(kTCCService[A-Za-z]+)\|(-?[0-9]{1,3})$/.exec(line);
    if (row && TCC_SERVICES[row[1]]) {
      const value = row[2] === '2' ? 'granted' : row[2] === '0' ? 'denied' : 'limited';
      // Any denial in the authoritative database wins over another row.
      if (grants[TCC_SERVICES[row[1]]] !== 'denied') grants[TCC_SERVICES[row[1]]] = value;
    }
  }
  const result = { source: readable ? 'tcc' : 'unreadable' };
  for (const name of Object.values(TCC_SERVICES)) {
    result[name] = readable ? grants[name] ?? 'not_recorded' : 'unknown';
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
  const marker = parseRemoteManagementMarker(sections.get('remote_management_marker'));
  const remoteManagement = marker.state;
  const prefs = parseRemoteManagementPrefs(sectionText(sections, 'remote_management_prefs'));
  const mode = service === 'disabled' ? 'off' : service === 'unknown' ? 'unknown'
    : remoteManagement === 'on' ? 'remote_management'
      : remoteManagement === 'off' ? 'screen_sharing' : 'unknown';
  if (mode === 'off') {
    failures.push(finding('screen_sharing_disabled',
      'Neither Screen Sharing nor Remote Management is enabled (com.apple.screensharing is disabled)'));
  }
  if (service === 'unknown') {
    unknowns.push(finding('screen_sharing_unverified', 'The Screen Sharing launchd override could not be read'));
  } else if (mode === 'unknown') {
    unknowns.push(finding('remote_management_unverified',
      `The Remote Management activation marker is ${marker.reason}; Remote Management versus plain Screen Sharing is unknown`));
  }
  const observe = evaluateObserveOnly({ remoteManagement, prefs,
    vncPrivileges: parseNaprivs(sectionText(sections, 'vnc_naprivs')) });
  if (observe.failure) failures.push(observe.failure);
  if (observe.observeOnly === 'unknown') {
    unknowns.push(finding('observe_only_unverified', {
      viewer_choice: 'Plain Screen Sharing leaves observe or control to the viewer; verify with an input probe',
      vnc_user_unknown: 'The VNC account is not known or not a plain short name, so its Remote Management privileges were not read',
      unreadable: 'Remote Management privileges for the VNC account were not readable',
    }[observe.reason]));
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
  // Without a parsed IOConsoleUsers list neither the lock nor Secure Input is
  // known; that is recorded, never treated as a pass.
  const locked = consoleSessions.locked === true || onConsole?.screenLocked === true
    ? true : consoleSessions.known && consoleSessions.locked !== undefined ? false : 'unknown';
  if (locked === true) failures.push(finding('screen_locked', 'The console session screen is locked'));
  if (!consoleSessions.known) {
    unknowns.push(finding('console_session_unverified',
      'IOConsoleUsers was missing or unparseable; screen lock and Secure Input are unknown'));
  } else if (locked === 'unknown') {
    unknowns.push(finding('screen_lock_unverified', 'IOConsoleLocked was not reported; screen lock is unknown'));
  }
  const additionalSessions = consoleSessions.sessions.filter(session => session.onConsole === false).length;
  if (additionalSessions) {
    warnings.push(finding('additional_gui_sessions',
      `${additionalSessions} GUI session(s) are off console (fast user switching or a virtual Screen Sharing session)`));
  }
  const secureNames = parseSecureInputProcesses(sectionText(sections, 'secure_input_process'));
  const securePid = onConsole?.secureInputPid;
  const secureInput = !consoleSessions.known ? 'unknown'
    : securePid === undefined ? { held: false }
      : { held: true, ...(secureNames.get(securePid) ? { process: secureNames.get(securePid) } : {}) };
  if (secureInput.held) {
    warnings.push(finding('secure_input_held',
      `Secure keyboard entry is held by ${secureInput.process || `pid ${securePid}`}; typed input may be refused`));
  }
  const assertions = parsePmsetAssertions(sectionText(sections, 'pmset_assertions'));
  const { displaySleepMinutes } = parsePmsetSettings(sectionText(sections, 'pmset_settings'));
  if (assertions.screenSharingActivity) {
    warnings.push(finding('screen_sharing_input_recent',
      'A Screen Sharing client sent input recently. It may be Fruitctl\'s own session; otherwise confirm no other input owner is active on this Mac'));
  }
  if (displaySleepMinutes > 0 && assertions.displaySleepPrevented !== true) {
    warnings.push(finding('display_sleep_enabled',
      `The display sleeps after ${displaySleepMinutes} minute(s); captures may go black`));
  }

  const host = parseHostApp(sectionText(sections, 'host_app'));
  const grants = parseTcc(sectionText(sections, 'tcc'));
  if (host.installed === 'unknown') {
    unknowns.push(finding('host_install_unverified',
      "The console user's Applications folder could not be checked; Host installation is unknown"));
  } else if (!host.installed) {
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
      secureInput,
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
export function runProbe(destination, { vncUser, spawnImpl = spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const args = sshProbeArguments(destination);
  const script = probeScript({ vncUser });
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
    child.stdin.end(script);
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
  // The VNC authentication account governs input; its name is never secret.
  const vncUser = typeof profile?.vnc?.username === 'string' && profile.vnc.username ? profile.vnc.username : undefined;
  return { destination: validateSshDestination(destination), route, ...(vncUser ? { vncUser } : {}) };
}

export async function macosPreflight({ destination, route = 'unknown', vncUser, probe = runProbe } = {}) {
  let output;
  try { output = await probe(destination, { vncUser }); }
  catch (error) {
    const failure = finding(error.code || 'preflight_unreachable', error.message || 'Target preflight failed');
    return { schema: PREFLIGHT_SCHEMA, status: 'fail', route, failures: [failure], warnings: [], unknowns: [],
      qualification: 'No target facts were collected' };
  }
  return evaluatePreflight(parseProbeOutput(output), { route });
}
