// SPDX-License-Identifier: MIT
// Offline `doctor --macos` checks. Fixtures are redacted read-only samples
// from two macOS 26.7.1 hosts plus synthetic variants; no SSH is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  PROBE_SCRIPT, probeScript, usableAccountName, HOST_BUNDLE_ID, parseProbeOutput, parseSwVers, evaluateMacosVersion, evaluatePreflight,
  parseScreenSharingOverride, parseRemoteManagementPrefs, parseNaprivs, evaluateObserveOnly,
  parseRemoteManagementMarker, parseConsoleSessions, parseSecureInputProcesses, parsePmsetAssertions, parsePmsetSettings,
  parseDisplays, parseHostApp, parseTcc, sshProbeArguments, validateSshDestination, runProbe,
  resolvePreflightTarget, macosPreflight,
} from '../lib/install/macos-preflight.mjs';
import { doctor } from '../lib/install/index.mjs';

const run = promisify(execFile);
const fixtures = new URL('./fixtures/macos-preflight/', import.meta.url);
const fixture = name => fs.readFile(new URL(name, fixtures), 'utf8');
const cliPath = fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url));
const codes = list => list.map(item => item.code);

function render(sections) {
  return Object.entries(sections).map(([name, { output, status = 0 }]) =>
    `@@fruitctl-probe ${name}@@\n${output}\n@@fruitctl-status ${name} ${status}@@\n`).join('\n');
}

async function baseSections() {
  return Object.fromEntries(parseProbeOutput(await fixture('laptop-26.7.1-tcc-readable.txt')));
}

async function evaluateWith(overrides, options) {
  const sections = { ...await baseSections(), ...overrides };
  return evaluatePreflight(parseProbeOutput(render(sections)), options);
}

const swVers = version => ({ output: `ProductName:\t\tmacOS\nProductVersion:\t\t${version}\nBuildVersion:\t\t25A100` });

test('sw_vers samples enforce macOS 26.6.1+ and every 27 release', () => {
  const cases = [
    ['26.5', 'macos_below_patch_floor'], ['26.6', 'macos_below_patch_floor'], ['26.6.1', null],
    ['26.7.1', null], ['27', null], ['27.0.1', null], ['27.1', null],
    ['15.7', 'macos_unsupported'], ['15.7.9', 'macos_unsupported'], ['14.8.9', 'macos_unsupported'],
    ['25.0', 'macos_unsupported'], ['28.0', 'macos_unsupported'],
  ];
  for (const [version, failure] of cases) {
    const result = evaluateMacosVersion(parseSwVers(swVers(version).output));
    assert.equal(result.failure?.code ?? null, failure, version);
    assert.equal(result.supported, failure === null, version);
  }
  const floor = evaluateMacosVersion(parseSwVers(swVers('26.6.1').output)).floor;
  assert.deepEqual(floor, { version: '26.6.1', advisory: 'CVE-2026-65400', source: 'https://support.apple.com/en-us/148170' });
  assert.equal(evaluateMacosVersion(parseSwVers(swVers('27.1').output)).floor.source, 'https://support.apple.com/en-us/149035');
});

test('malformed, legacy-named and Rapid Security Response sw_vers output stay typed', () => {
  for (const text of ['', 'ProductName: macOS\n', 'ProductName: macOS\nProductVersion: twenty-six\nBuildVersion: 25A1',
    'ProductName: macOS\nProductVersion: 26.6.1\nBuildVersion: 25A1; rm -rf', 'garbage\n\u0000']) {
    assert.equal(parseSwVers(text), null, JSON.stringify(text));
    assert.equal(evaluateMacosVersion(parseSwVers(text)).failure.code, 'macos_version_unknown');
  }
  const legacy = parseSwVers('ProductName:\tMac OS X\nProductVersion:\t10.15.7\nBuildVersion:\t19H15');
  assert.equal(evaluateMacosVersion(legacy).failure.code, 'macos_unsupported');
  const rsr = parseSwVers('ProductName:\tmacOS\nProductVersion:\t26.6\nProductVersionExtra:\t(a)\nBuildVersion:\t25G5a');
  const result = evaluateMacosVersion(rsr);
  assert.equal(result.versionExtra, '(a)');
  // A Rapid Security Response does not name the fixed CVE; the floor stands.
  assert.equal(result.failure.code, 'macos_below_patch_floor');
});

test('redacted Remote Management bench sample reports warnings, not failures', async () => {
  const result = evaluatePreflight(parseProbeOutput(await fixture('bench-26.7.1-remote-management.txt')), { route: 'raw' });
  assert.equal(result.status, 'warn');
  assert.deepEqual(result.failures, []);
  assert.deepEqual(codes(result.warnings), ['legacy_vnc_password_enabled', 'secure_input_held', 'host_not_installed']);
  assert.deepEqual(result.os, { productName: 'macOS', version: '26.7.1', build: '25G313', major: 26, supported: true,
    floor: { version: '26.6.1', advisory: 'CVE-2026-65400', source: 'https://support.apple.com/en-us/148170' }, architecture: 'arm64' });
  assert.deepEqual(result.screenSharing, { service: 'enabled', serviceState: 'not running', remoteManagement: 'on',
    mode: 'remote_management', observeOnly: false, highPerformance: 'not_detected', curtain: 'unknown', legacyVncPassword: true });
  assert.deepEqual(result.session.secureInput, { held: true, process: 'Example Secure App' });
  assert.deepEqual(result.host, { installed: false, grants: { source: 'unreadable', screenRecording: 'unknown', accessibility: 'unknown' } });
  assert.deepEqual(codes(result.unknowns), ['curtain_unverified']);
});

test('redacted laptop sample reads TCC and leaves the VNC account privileges unknown', async () => {
  const result = evaluatePreflight(parseProbeOutput(await fixture('laptop-26.7.1-tcc-readable.txt')));
  assert.equal(result.status, 'warn');
  assert.deepEqual(codes(result.warnings), ['host_not_installed']);
  assert.equal(result.screenSharing.observeOnly, 'unknown');
  assert.match(result.unknowns[0].message, /VNC account were not readable/);
  assert.equal(result.screenSharing.legacyVncPassword, 'unknown');
  assert.equal(result.session.displaySleepPrevented, false);
  assert.equal(result.session.displaySleepMinutes, 0);
  assert.equal(result.session.screenSharingActivity, false);
  assert.deepEqual(result.session.secureInput, { held: false });
  assert.deepEqual(result.host.grants, { source: 'tcc', screenRecording: 'not_recorded', accessibility: 'not_recorded' });
  assert.deepEqual(codes(result.unknowns), ['observe_only_unverified', 'curtain_unverified']);
});

test('live Screen Sharing input sample warns and says it may be Fruitctl itself', async () => {
  const sample = await fixture('pmset-assertions-screensharing-input.txt');
  assert.equal(parsePmsetAssertions(sample).screenSharingActivity, true);
  const result = await evaluateWith({ pmset_assertions: { output: sample } });
  const warning = result.warnings.find(item => item.code === 'screen_sharing_input_recent');
  assert.match(warning.message, /may be Fruitctl's own session/);
});

test('Apple remote modes fail typed: disabled, observe only, no control and High Performance', async () => {
  assert.equal(parseScreenSharingOverride('read=ok'), 'disabled');
  assert.equal(parseScreenSharingOverride('read=ok\n\t"com.apple.screensharing" => false'), 'enabled');
  assert.equal(parseScreenSharingOverride('read=ok\n\t"com.apple.screensharing" => disabled'), 'disabled');
  const disabled = await evaluateWith({ screensharing_override: { output: 'read=ok\n\t\t"com.apple.screensharing" => disabled' } });
  assert.equal(disabled.screenSharing.mode, 'off');
  assert.deepEqual(codes(disabled.failures), ['screen_sharing_disabled']);
  const plain = await evaluateWith({ remote_management_marker: { output: 'value=disabled' } });
  assert.equal(plain.screenSharing.mode, 'screen_sharing');
  assert.equal(plain.screenSharing.observeOnly, 'unknown');
  assert.match(plain.unknowns[0].message, /input probe/);

  const allUsers = privileges => ({ remote_management_prefs: { output: `ARD_AllLocalUsers=1\nARD_AllLocalUsersPrivs=${privileges}` } });
  assert.deepEqual(codes((await evaluateWith(allUsers(0x400001ff))).failures), ['observe_only']);
  assert.deepEqual(codes((await evaluateWith(allUsers(0x40000001))).failures), ['remote_control_not_permitted']);
  // kickstart writes signed values; 0xC00000FF is full control with access.
  assert.equal((await evaluateWith(allUsers(-1073741569))).screenSharing.observeOnly, false);
  assert.deepEqual(parseNaprivs('naprivs: -1073741569'), { state: 'read', privileges: 0xC00000FF });
  assert.deepEqual(parseNaprivs('naprivs=unreadable'), { state: 'unreadable' });
  assert.deepEqual(parseNaprivs(''), { state: 'unreadable' });
  assert.deepEqual(parseNaprivs('user=unset'), { state: 'unset' });
  assert.deepEqual(parseRemoteManagementPrefs('ARD_AllLocalUsers=yes\nVNCLegacyConnectionsEnabled=0\nOther=1'),
    { VNCLegacyConnectionsEnabled: false });

  const hp = await evaluateWith({ displays: { output: 'display=Screen Sharing Virtual Display\nonline=Yes\nvirtual=Yes' } });
  assert.equal(hp.screenSharing.highPerformance, true);
  assert.deepEqual(codes(hp.failures), ['high_performance_session']);
  const unreadable = await evaluateWith({ displays: { output: '', status: 1 } });
  assert.equal(unreadable.screenSharing.highPerformance, 'unknown');
  assert.ok(codes(unreadable.unknowns).includes('displays_unverified'));
  assert.deepEqual(parseDisplays({ status: 0, output: 'display=Panel\nonline=No' }),
    { known: true, count: 1, online: 0, screenSharingVirtual: false });
});

test('regression: a failed print-disabled read is unverified, not disabled', async () => {
  for (const output of ['read=failed', '']) {
    assert.equal(parseScreenSharingOverride(output), 'unknown');
    const result = await evaluateWith({ screensharing_override: { output } });
    assert.equal(result.screenSharing.mode, 'unknown');
    assert.ok(!codes(result.failures).includes('screen_sharing_disabled'));
    assert.ok(codes(result.unknowns).includes('screen_sharing_unverified'));
  }
});

test('regression: an absent or unreadable marker is unknown and readable privileges are still judged', async () => {
  for (const [output, reason] of [['absent', 'absent'], ['unreadable', 'unreadable'], ['value=maybe', 'unrecognized']]) {
    assert.deepEqual(parseRemoteManagementMarker({ status: 0, output }), { state: 'unknown', reason });
    const result = await evaluateWith({ remote_management_marker: { output },
      remote_management_prefs: { output: `ARD_AllLocalUsers=1\nARD_AllLocalUsersPrivs=${0x40000102}` } });
    assert.equal(result.screenSharing.remoteManagement, 'unknown');
    assert.equal(result.screenSharing.mode, 'unknown');
    assert.ok(codes(result.unknowns).includes('remote_management_unverified'));
    assert.deepEqual(codes(result.failures), ['observe_only'], output);
  }
  assert.deepEqual(parseRemoteManagementMarker(undefined), { state: 'unknown', reason: 'not_probed' });
  // Only an explicit off marker defers observe-only to the viewer.
  assert.deepEqual(evaluateObserveOnly({ remoteManagement: 'off',
    prefs: { ARD_AllLocalUsers: true, ARD_AllLocalUsersPrivs: 0x102 } }), { observeOnly: 'unknown', reason: 'viewer_choice' });
});

test('regression: per-user observe-only is judged for the configured VNC account only', async () => {
  const perUser = await evaluateWith({ vnc_naprivs: { output: 'naprivs: 258' } });
  assert.deepEqual(codes(perUser.failures), ['observe_only']);
  const unset = await evaluateWith({ vnc_naprivs: { output: 'user=unset' } });
  assert.equal(unset.screenSharing.observeOnly, 'unknown');
  assert.match(unset.unknowns.find(item => item.code === 'observe_only_unverified').message, /VNC account is not known/);
  // The console user's privileges are no longer read at all.
  assert.doesNotMatch(PROBE_SCRIPT, /console_naprivs|"\/Users\/\$console_user" naprivs/);
  assert.equal(probeScript({ vncUser: 'operator' }).split('\n')[0], "vnc_user='operator'");
  for (const unsafe of ["x'; id; '", 'Jess Sullivan', '-oops', '$(id)', '', undefined, 7, 'a'.repeat(65)]) {
    assert.equal(probeScript({ vncUser: unsafe }).split('\n')[0], "vnc_user=''", String(unsafe));
    assert.equal(usableAccountName(unsafe), undefined);
  }
  // The remote side re-filters the name before dscl sees it.
  const shell = spawnSync('/bin/sh', ['-c', "vnc_user='-x'; case \"$vnc_user\" in ''|-*|*[!A-Za-z0-9._-]*) vnc_user= ;; esac; printf '%s' \"$vnc_user\""]);
  assert.equal(shell.stdout.toString(), '');
});

test('session state: login window and lock fail; extra sessions, secure input and sleep warn', async () => {
  const login = await evaluateWith({ console: { output: 'root' } });
  assert.deepEqual(codes(login.failures), ['no_console_session']);
  const lockedText = '      "IOConsoleLocked" = Yes\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes})';
  assert.deepEqual(codes((await evaluateWith({ ioreg_console: { output: lockedText } })).failures), ['screen_locked']);
  const two = '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=77},{"kCGSSessionOnConsoleKey"=No,"CGSSessionScreenIsLocked"=Yes})';
  const sessions = parseConsoleSessions(two);
  assert.deepEqual(sessions, { known: true, locked: false, sessions: [
    { onConsole: true, loginDone: undefined, screenLocked: undefined, secureInputPid: 77 },
    { onConsole: false, loginDone: undefined, screenLocked: true }] });
  const extra = await evaluateWith({ ioreg_console: { output: two }, secure_input_process: { output: 'pid=77|/usr/bin/held' } });
  assert.deepEqual(codes(extra.failures), []);
  assert.ok(codes(extra.warnings).includes('additional_gui_sessions'));
  assert.equal(extra.session.locked, false);
  assert.deepEqual(extra.session.secureInput, { held: true, process: 'held' });

  assert.deepEqual([...parseSecureInputProcesses('pid=12|/Applications/A b.app/Contents/MacOS/A b\npid=13|\npid=x|name')],
    [[12, 'A b'], [13, undefined]]);
  const sleepy = await evaluateWith({ pmset_settings: { output: ' displaysleep         10' },
    pmset_assertions: { output: 'Assertion status system-wide:\n   PreventUserIdleDisplaySleep    0' } });
  assert.ok(codes(sleepy.warnings).includes('display_sleep_enabled'));
  assert.equal(parsePmsetSettings(' displaysleep         0').displaySleepMinutes, 0);
  const daemon = parsePmsetAssertions('Assertion status system-wide:\n   UserIsActive 1\nListed by owning process:\n   pid 9(screensharingd): [0x1] 00:00:01 UserIsActive named: "remote"');
  assert.equal(daemon.screenSharingActivity, true);
  assert.deepEqual(parsePmsetAssertions(''), { known: false, displaySleepPrevented: undefined, screenSharingActivity: undefined });
});

test('regression: missing or unparseable IOConsoleUsers is recorded unknown, never a pass', async () => {
  for (const output of ['', 'garbage', '      "IOConsoleLocked" = No']) {
    const result = await evaluateWith({ ioreg_console: { output } });
    assert.equal(result.session.locked, 'unknown', output);
    assert.equal(result.session.secureInput, 'unknown', output);
    assert.ok(codes(result.unknowns).includes('console_session_unverified'), output);
    assert.ok(!codes(result.warnings).includes('secure_input_held'));
  }
  const noLock = await evaluateWith({ ioreg_console: { output: '      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes})' } });
  assert.equal(noLock.session.locked, 'unknown');
  assert.ok(codes(noLock.unknowns).includes('screen_lock_unverified'));
  assert.deepEqual(noLock.session.secureInput, { held: false });
});

test('regression: Secure Input uses the console session PID, not the last one listed', async () => {
  const ioreg = '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionSecureInputPID"=11},{"kCGSSessionOnConsoleKey"=No,"kCGSSessionSecureInputPID"=22})';
  const result = await evaluateWith({ ioreg_console: { output: ioreg },
    secure_input_process: { output: 'pid=11|/usr/bin/console-app\npid=22|/usr/bin/background-app' } });
  assert.deepEqual(result.session.secureInput, { held: true, process: 'console-app' });
  const background = '      "IOConsoleLocked" = No\n      "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes},{"kCGSSessionOnConsoleKey"=No,"kCGSSessionSecureInputPID"=22})';
  const other = await evaluateWith({ ioreg_console: { output: background }, secure_input_process: { output: 'pid=22|/usr/bin/background-app' } });
  assert.deepEqual(other.session.secureInput, { held: false });
  assert.match(PROBE_SCRIPT, /grep -o '"kCGSSessionSecureInputPID"=\[0-9\]\[0-9\]\*'/);
});

test('Host install, D7 default route and D10 grants produce the documented warnings', async () => {
  const installed = { host_app: { output: `user|present|${HOST_BUNDLE_ID}|0.1.0\nsystem|absent` } };
  const granted = { tcc: { output: 'system|readable\nsystem|row|kTCCServiceScreenCapture|2\nsystem|row|kTCCServiceAccessibility|2' } };
  const clean = await evaluateWith({ ...installed, ...granted }, { route: 'host' });
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.status, 'pass');
  assert.deepEqual(clean.host, { installed: true, location: 'user', version: '0.1.0',
    grants: { source: 'tcc', screenRecording: 'granted', accessibility: 'granted' } });
  assert.deepEqual(codes((await evaluateWith({ ...installed, ...granted }, { route: 'raw' })).warnings), ['host_installed_raw_route']);
  const denied = await evaluateWith({ ...installed, tcc: { output: 'system|readable\nsystem|row|kTCCServiceAccessibility|0' } }, { route: 'host' });
  assert.deepEqual(codes(denied.warnings), ['host_screen_recording_not_granted', 'host_accessibility_not_granted']);
  const unreadable = await evaluateWith({ ...installed, tcc: { output: 'system|unreadable' } }, { route: 'host' });
  assert.deepEqual(codes(unreadable.warnings), ['host_grants_unverified']);
  assert.deepEqual(parseHostApp('user|present|com.example.other|1.0\nsystem|absent'), { installed: false, foreignBundle: true });
  assert.deepEqual(parseHostApp('user|absent\nsystem|present|com.xoxd.fruitctl.host|'), { installed: true, location: 'system' });
});

test('regression: the system TCC database wins and user databases are not consulted', async () => {
  assert.deepEqual(parseTcc('system|readable\nsystem|row|kTCCServiceScreenCapture|0\nuser|row|kTCCServiceScreenCapture|2'),
    { source: 'tcc', screenRecording: 'denied', accessibility: 'not_recorded' });
  assert.deepEqual(parseTcc('system|readable\nsystem|row|kTCCServiceScreenCapture|2\nsystem|row|kTCCServiceScreenCapture|0'),
    { source: 'tcc', screenRecording: 'denied', accessibility: 'not_recorded' });
  // A user-database grant cannot stand in for an unreadable system database.
  assert.deepEqual(parseTcc('system|unreadable\nuser|readable\nuser|row|kTCCServiceScreenCapture|2'),
    { source: 'unreadable', screenRecording: 'unknown', accessibility: 'unknown' });
  assert.doesNotMatch(PROBE_SCRIPT, /Library\/Application Support\/com\.apple\.TCC\/TCC\.db.*\$HOME|\$HOME\/Library/);
});

test("regression: Host lookup uses the console user's home and reports unknown when it cannot", async () => {
  assert.match(PROBE_SCRIPT, /dscl \. -read "\/Users\/\$console_user" NFSHomeDirectory/);
  assert.doesNotMatch(PROBE_SCRIPT, /\$HOME\/Applications/);
  for (const output of ['user|unknown\nsystem|absent', 'system|absent', '']) {
    assert.equal(parseHostApp(output).installed, 'unknown', output);
    const result = await evaluateWith({ host_app: { output } });
    assert.ok(codes(result.unknowns).includes('host_install_unverified'));
    assert.ok(!codes(result.warnings).includes('host_not_installed'));
  }
  assert.deepEqual(parseHostApp('user|absent\nsystem|absent'), { installed: false });
});

test('section framing ignores inline, unknown, unterminated and missing sections', async () => {
  const sections = parseProbeOutput('x @@fruitctl-probe sw_vers@@\n@@fruitctl-probe secret@@\nvalue\n@@fruitctl-status secret 0@@\n' +
    '@@fruitctl-probe arch@@\narm64\n@@fruitctl-status arch 0@@\n@@fruitctl-probe console@@\noperator\n');
  assert.deepEqual([...sections.keys()], ['arch']);
  assert.equal(parseProbeOutput(undefined).size, 0);
  const empty = evaluatePreflight(new Map());
  assert.equal(empty.status, 'fail');
  assert.deepEqual(codes(empty.failures), ['macos_version_unknown']);
  assert.equal(empty.screenSharing.mode, 'unknown');
  for (const code of ['screen_sharing_unverified', 'console_unverified', 'console_session_unverified', 'host_install_unverified']) {
    assert.ok(codes(empty.unknowns).includes(code), code);
  }
  assert.equal(empty.session.locked, 'unknown');
  assert.equal(empty.session.secureInput, 'unknown');
});

test('the fixed probe script parses and stays read-only', () => {
  const syntax = spawnSync('/bin/sh', ['-n'], { input: PROBE_SCRIPT });
  assert.equal(syntax.status, 0, syntax.stderr?.toString());
  for (const forbidden of [/\bkickstart\b/, /\bosascript\b/, /\btccutil\b/, /\bopen\s/, /\blog (show|stream)\b/,
    /\bdefaults (write|delete)\b/, /\bsudo\b/, /\blaunchctl (load|unload|bootstrap|bootout|kickstart|enable|disable|kill)\b/,
    /\bpmset -a\b/, /\brm\b/, /\bkill\b/, /\benv\b/, /\bprintenv\b/]) {
    assert.doesNotMatch(PROBE_SCRIPT, forbidden);
  }
  // Every launchd service dump is filtered on the target before it is sent.
  for (const line of PROBE_SCRIPT.split('\n').filter(line => /launchctl print /.test(line))) {
    assert.match(line, /launchctl print [^|]+\| grep /);
  }
  assert.ok(PROBE_SCRIPT.includes(`client = '${HOST_BUNDLE_ID}'`));
});

test('SSH destinations are explicit and options disable forwarding, TTY and multiplexing', () => {
  for (const bad of ['', '-oProxyCommand=sh', 'a b', 'host;id', 'x'.repeat(300), undefined]) {
    assert.throws(() => validateSshDestination(bad), /explicit host/);
  }
  // Bracketed IPv6 matches the host-helper validator; it is one argv entry.
  for (const good of ['target.example', 'operator@target.example', 'operator@[fd7a:115c::1]', '_svc@10.0.0.2']) {
    assert.equal(validateSshDestination(good), good);
  }
  const args = sshProbeArguments('operator@target.example');
  assert.deepEqual(args.slice(-3), ['--', 'operator@target.example', '/bin/sh -s']);
  for (const option of ['-oBatchMode=yes', '-oForwardAgent=no', '-oClearAllForwardings=yes', '-oControlMaster=no',
    '-oControlPath=none', '-oRequestTTY=no', '-T']) assert.ok(args.includes(option), option);
});

function fakeSpawn({ stdout = '', code = 0, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); child.signalCode = signal; setImmediate(() => child.emit('close', null)); };
    let input = '';
    child.stdin.on('data', chunk => { input += chunk; });
    child.stdin.on('finish', () => {
      calls.push({ command, args, options, input, child });
      if (hang) return;
      child.stderr.write('remote private diagnostic');
      child.stdout.end(stdout);
      child.exitCode = code;
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('probe runner sends the script on stdin with a minimal environment and bounded output', async t => {
  process.env.FRUITCTL_TEST_PRIVATE = 'must-not-pass';
  t.after(() => { delete process.env.FRUITCTL_TEST_PRIVATE; });
  const ok = fakeSpawn({ stdout: 'facts' });
  assert.equal(await runProbe('target.example', { spawnImpl: ok.spawnImpl }), 'facts');
  assert.equal(ok.calls[0].command, 'ssh');
  assert.equal(ok.calls[0].input, PROBE_SCRIPT);
  const named = fakeSpawn({ stdout: 'facts' });
  await runProbe('target.example', { spawnImpl: named.spawnImpl, vncUser: 'operator' });
  assert.equal(named.calls[0].input, probeScript({ vncUser: 'operator' }));
  assert.equal(ok.calls[0].options.env.FRUITCTL_TEST_PRIVATE, undefined);
  assert.ok(Object.keys(ok.calls[0].options.env).every(key => ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK'].includes(key)));

  await assert.rejects(runProbe('target.example', { spawnImpl: fakeSpawn({ code: 255 }).spawnImpl }),
    error => error.code === 'preflight_unreachable');
  await assert.rejects(runProbe('target.example', { spawnImpl: fakeSpawn({ stdout: 'x'.repeat(1024 * 1024 + 1) }).spawnImpl }),
    error => error.code === 'preflight_output_limit');
  const hung = fakeSpawn({ hang: true });
  await assert.rejects(runProbe('target.example', { spawnImpl: hung.spawnImpl, timeoutMs: 20 }),
    error => error.code === 'preflight_timeout');
  assert.deepEqual(hung.calls[0].child.kills, ['SIGKILL']);
  assert.throws(() => runProbe('-oProxyCommand=sh', { spawnImpl: ok.spawnImpl }), /explicit host/);

  const failed = await macosPreflight({ destination: 'target.example', route: 'raw',
    probe: async () => { throw Object.assign(new Error('Target preflight timed out'), { code: 'preflight_timeout' }); } });
  assert.equal(failed.status, 'fail');
  assert.deepEqual(codes(failed.failures), ['preflight_timeout']);
});

test('target resolution uses the operator profile or an explicit flag, never tool arguments', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-preflight-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  await fs.writeFile(configPath, JSON.stringify({ schema: 'fruitctl.config.v1', targets: {
    host: { hostHelper: { sshHost: 'operator@target.example' } },
    raw: { vnc: { host: '127.0.0.1', port: 5900, username: 'operator' } } } }));
  assert.deepEqual(await resolvePreflightTarget({ configPath, target: 'host' }),
    { destination: 'operator@target.example', route: 'host' });
  await assert.rejects(resolvePreflightTarget({ configPath, target: 'raw' }), /--target-ssh/);
  assert.deepEqual(await resolvePreflightTarget({ configPath, target: 'raw', targetSsh: 'target.example' }),
    { destination: 'target.example', route: 'raw', vncUser: 'operator' });
  await assert.rejects(resolvePreflightTarget({ configPath, target: 'missing' }), /Unknown target profile/);
  assert.deepEqual(await resolvePreflightTarget({ configPath: path.join(directory, 'absent.json'), targetSsh: 'target.example' }),
    { destination: 'target.example', route: 'unknown' });
  await assert.rejects(resolvePreflightTarget({ configPath, target: 'raw', targetSsh: 'a b' }), /explicit host/);
});

test('doctor attaches the preflight once and keeps installer results unchanged', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-preflight-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let probes = 0;
  const sample = await fixture('bench-26.7.1-remote-management.txt');
  const result = await doctor({ home, macos: { destination: 'target.example', route: 'raw', vncUser: 'operator' } },
    { preflightProbe: async (destination, options) => {
      probes++; assert.equal(destination, 'target.example'); assert.equal(options.vncUser, 'operator'); return sample;
    } });
  assert.equal(probes, 1);
  assert.equal(result.status, 'not-installed');
  assert.equal(result.targetPreflight.status, 'warn');
  assert.equal(result.targetPreflight.route, 'raw');
  const plain = await doctor({ home });
  assert.equal(plain.targetPreflight, undefined);
});

test('CLI scopes --macos to doctor and validates the destination before any SSH', async () => {
  await assert.rejects(run(process.execPath, [cliPath, 'install', '--macos']), error => /--macos is supported only by doctor/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cliPath, 'doctor', '--target-ssh', 'target.example']), error => /requires doctor --macos/.test(error.stderr));
  await assert.rejects(run(process.execPath, [cliPath, 'doctor', '--macos', '--target-ssh=-oProxyCommand=sh',
    '--config', '/nonexistent/fruitctl.json']), error => error.code === 1 && /explicit host/.test(error.stderr));
  const { stdout } = await run(process.execPath, [cliPath, '--help']);
  assert.match(stdout, /doctor --macos/);
});
