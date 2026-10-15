// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Offline checks for the attended freshness probe runner (TIN-5509). A fake
// controller speaks the native NDJSON protocol, reads the credential frame on
// descriptor 3 and writes [RFB-WIRE] lines. No VNC server, native binary or
// desktop is involved, and every schedule is shortened (non-qualifying).
const probe = new URL('./fruitctl-freshness-probe.py', import.meta.url).pathname;
const SECRET = 'offline-probe-secret-0f3c';
const USERNAME = 'offline-probe-user';

const fakeDaemon = String.raw`#!/usr/bin/env python3
import base64, hashlib, json, os, struct, sys
argv = sys.argv[1:]
if argv[-2:] != ["--password-fd", "3"] or "--rfb-wire-ledger" not in argv or "VNC_PASSWORD" in os.environ:
    sys.exit(4)
mode = argv[argv.index("--rfb-request-mode") + 1]
length = struct.unpack("!I", os.read(3, 4))[0]
if hashlib.sha256(os.read(3, length)).hexdigest() != os.environ["FAKE_CREDENTIAL_SHA256"]:
    sys.exit(3)
scene = os.environ.get("FAKE_SCENE", "static")
def out(message):
    sys.stdout.write(json.dumps(message) + "\n"); sys.stdout.flush()
def wire(incremental, origin):
    sys.stderr.write("[RFB-WIRE] ms=1 dir=c2s type=3 incremental=%d length=10 origin=%s\n" % (incremental, origin))
    sys.stderr.flush()
wire(0, "libvnc-init")
out({"method": "vnc_state", "params": {"state": "connected (96x53)"}})
out({"method": "ready", "params": {"scaledWidth": 96, "scaledHeight": 53}})
count = 0
for line in sys.stdin:
    request = json.loads(line)
    if request["method"] == "health":
        out({"id": request["id"], "result": {"detail": "connected (96x53)", "connectionGeneration": 1, "allocation": 1}})
        continue
    if request["method"] != "screenshot":
        sys.exit(9)  # Observation only: anything else is a runner defect.
    count += 1
    wire(0, "bridge")
    if scene == "stale":
        out({"id": request["id"], "error": {"code": -32010,
             "message": "No fresh complete framebuffer update within 5 seconds",
             "data": {"reason": "server_silent", "diagnostics": {"request_gate_leaks": 0, "unanswered_full_requests": 1}}}})
        continue
    if mode == "stream":
        wire(1, "libvnc-rearm")
    if scene == "leak":
        sys.stderr.write("[VNC t] Request gate reopened by the server; closed again\n"); sys.stderr.flush()
    body = b"\x89PNG\r\n\x1a\n" + (b"frame%d" % count if scene == "changing" else b"static")
    out({"id": request["id"], "result": {"image": base64.b64encode(body).decode(), "scaledWidth": 96,
         "scaledHeight": 53, "connectionGeneration": 1, "allocation": 1,
         "provenance": {"source": "in_session", "request_mode": mode,
                        "requests": {"full": 1, "incremental": 1 if mode == "stream" else 0}}}})
`;

const SHORT = ['--gap-seconds', '0', '--idle-seconds', '0', '--long-idle-seconds', '0',
  '--warm-captures', '2', '--idle-captures', '1', '--long-idle-captures', '1',
  '--ctl-captures', '2', '--eq-captures', '2', '--eq-gap-seconds', '0'];

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fp-'));
  const daemon = path.join(dir, 'claude-kvm-daemon');
  writeFileSync(daemon, fakeDaemon, { mode: 0o755 });
  const bytes = readFileSync(daemon);
  const receipt = path.join(dir, 'build-receipt.json');
  writeFileSync(receipt, JSON.stringify({ status: 'passed', sourceRevision: 'a'.repeat(40),
    unstrippedUnsignedArtifacts: { 'claude-kvm-daemon': {
      sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length } } }));
  return { dir, daemon, receipt };
}

function runProbe(args, { env = {}, input = '' } = {}) {
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || tmpdir(),
    VNC_HOST: '127.0.0.1', VNC_PORT: '15900', VNC_USERNAME: USERNAME, VNC_PASSWORD: SECRET,
    FAKE_CREDENTIAL_SHA256: createHash('sha256').update(SECRET).digest('hex'), ...env };
  const result = spawnSync('python3', ['-I', '-B', probe, ...args], {
    env: environment, input, encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20 });
  assert.equal(result.error, undefined);
  return result;
}

function outputFiles(dir) {
  return readdirSync(dir).map(name => readFileSync(path.join(dir, name), 'utf8'));
}

function receiptOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'freshness-probe-receipt.json'), 'utf8'));
}

test('dry run prints schedule and argv, verifies the build receipt and never prints the credential', () => {
  const w = workspace();
  try {
    const result = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--build-receipt', w.receipt, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /build receipt verified; sourceRevision a{40}/);
    assert.match(result.stdout, /--rfb-request-mode on-demand --rfb-wire-ledger --no-reconnect -v --password-fd 3$/m);
    assert.match(result.stdout, /schedule \(17 captures, at least 1890 s of waiting\)/);
    assert.equal((result.stdout.match(/ warm /g) || []).length, 10);
    assert.equal((result.stdout.match(/ idle /g) || []).length, 5);
    assert.equal((result.stdout.match(/ long-idle /g) || []).length, 2);
    assert.match(result.stdout, /credential: <redacted>/);
    assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
    const p0 = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--dry-run']);
    assert.match(p0.stdout, /--rfb-request-mode stream /);
    assert.match(p0.stdout, /schedule \(15 captures, at least 690 s of waiting\)/);
    const ctl = runProbe(['--probe', 'P-ctl', '--daemon', w.daemon, '--dry-run']);
    assert.equal(ctl.status, 2);
    assert.match(ctl.stderr, /needs --mode/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('artifact and credential refusals happen before any connection', () => {
  const w = workspace();
  try {
    writeFileSync(w.receipt, JSON.stringify({ status: 'passed', unstrippedUnsignedArtifacts: {
      'claude-kvm-daemon': { sha256: '0'.repeat(64), bytes: 1 } } }));
    const mismatch = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--build-receipt', w.receipt, '--dry-run']);
    assert.equal(mismatch.status, 2);
    assert.match(mismatch.stderr, /REFUSED: daemon does not match the build receipt/);

    chmodSync(w.daemon, 0o644);
    const out = path.join(w.dir, 'out');
    const noExec = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--output-dir', out, ...SHORT]);
    assert.equal(noExec.status, 2);
    assert.match(noExec.stderr, /upload-artifact drops the exec bit.*chmod 0755/);
    assert.throws(() => readdirSync(out), /ENOENT/);
    chmodSync(w.daemon, 0o755);

    const secret = path.join(w.dir, 'credential');
    writeFileSync(secret, `${SECRET}\n`, { mode: 0o644 });
    const config = path.join(w.dir, 'config.json');
    writeFileSync(config, JSON.stringify({ schema: 'fruitctl.config.v1', targets: { pzm: {
      vnc: { host: '127.0.0.1', port: 15900, username: USERNAME, requestMode: 'stream' }, credentialFile: secret } } }));
    const env = { VNC_PASSWORD: '' };
    const open = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--profile', 'pzm', '--config', config, '--dry-run'], { env });
    assert.equal(open.status, 2);
    assert.match(open.stderr, /private file/);
    chmodSync(secret, 0o600);
    const profile = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--profile', 'pzm', '--config', config, '--dry-run'], { env });
    assert.equal(profile.status, 0, profile.stderr);
    assert.match(profile.stdout, /target from profile:pzm/);
    assert.match(profile.stdout, /profile requestMode 'stream' is overridden/);
    assert.ok(!profile.stdout.includes(SECRET));

    const missing = runProbe(['--probe', 'P0', '--daemon', w.daemon, '--dry-run'], { env: { VNC_PASSWORD: undefined } });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no credential/);
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('P0 and P1 pass against a fresh fake controller and keep only hashes', () => {
  const w = workspace();
  try {
    for (const [arm, mode] of [['P0', 'stream'], ['P1', 'on-demand']]) {
      const out = path.join(w.dir, arm);
      const result = runProbe(['--probe', arm, '--daemon', w.daemon, '--build-receipt', w.receipt,
        '--output-dir', out, ...SHORT]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const receipt = receiptOf(out);
      assert.equal(receipt.mode, mode);
      assert.deepEqual(receipt.verdict, { result: 'PASS', reasons: [], qualifying: false });
      assert.equal(receipt.sourceRevision, 'a'.repeat(40));
      assert.equal(receipt.captures.length, arm === 'P0' ? 3 : 4);
      for (const capture of receipt.captures) {
        assert.equal(capture.ok, true);
        assert.match(capture.sha256, /^[0-9a-f]{64}$/);
        assert.equal(capture.ledger.fullRequests, 1);
        assert.equal(capture.provenance.request_mode, mode);
        assert.ok(capture.latency_ms < 5000);
      }
      assert.equal(receipt.sessions[0].exitCode, 0);
      assert.equal(receipt.sessions[0].ledger.inputLines, 0);
      assert.ok(receipt.argv.includes('<redacted>'));
      assert.ok(readdirSync(out).includes('rfb-wire-ledger.s0.txt'));
      assert.ok(!readdirSync(out).some(name => name.endsWith('.png')), 'no image without --save-images');
      for (const text of outputFiles(out)) assert.ok(!text.includes(SECRET) && !text.includes(USERNAME));
    }
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('typed stale_screen and gate leaks are probe failures, not crashes', () => {
  const w = workspace();
  try {
    const stale = path.join(w.dir, 'stale');
    const result = runProbe(['--probe', 'P1', '--daemon', w.daemon, '--output-dir', stale, ...SHORT],
      { env: { FAKE_SCENE: 'stale' } });
    assert.equal(result.status, 1, result.stderr);
    const receipt = receiptOf(stale);
    assert.equal(receipt.verdict.result, 'FAIL');
    assert.ok(receipt.captures.every(c => !c.ok && c.reason === 'stale_screen:server_silent'));
    assert.equal(receipt.captures[0].errorCode, -32010);
    assert.equal(receipt.captures[0].diagnostics.request_gate_leaks, 0);
    assert.equal(receipt.sessions[0].exitCode, 0);

    const leak = path.join(w.dir, 'leak');
    runProbe(['--probe', 'P1', '--daemon', w.daemon, '--output-dir', leak, ...SHORT], { env: { FAKE_SCENE: 'leak' } });
    assert.ok(receiptOf(leak).verdict.reasons.includes('request_gate_leaks == 4, expected 0'));
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

test('P-ctl needs each capture to change; P-eq compares against a new connection', () => {
  const w = workspace();
  try {
    const changing = path.join(w.dir, 'ctl-changing');
    const pass = runProbe(['--probe', 'P-ctl', '--mode', 'on-demand', '--daemon', w.daemon, '--output-dir', changing,
      ...SHORT], { env: { FAKE_SCENE: 'changing' }, input: '\n\n' });
    assert.equal(pass.status, 0, pass.stdout);
    assert.equal((pass.stdout.match(/Change the screen by hand/g) || []).length, 2);
    const still = path.join(w.dir, 'ctl-static');
    const fail = runProbe(['--probe', 'P-ctl', '--mode', 'stream', '--daemon', w.daemon, '--output-dir', still,
      ...SHORT], { input: '\n\n' });
    assert.equal(fail.status, 1);
    assert.match(receiptOf(still).verdict.reasons[0], /byte-identical/);
    const closed = path.join(w.dir, 'ctl-closed');
    const eof = runProbe(['--probe', 'P-ctl', '--mode', 'stream', '--daemon', w.daemon, '--output-dir', closed, ...SHORT]);
    assert.equal(eof.status, 1);
    assert.ok(receiptOf(closed).verdict.reasons.some(reason => reason.includes('operator prompt closed')));

    const eq = path.join(w.dir, 'eq');
    const same = runProbe(['--probe', 'P-eq', '--mode', 'on-demand', '--daemon', w.daemon, '--output-dir', eq,
      '--save-images', ...SHORT]);
    assert.equal(same.status, 0, same.stdout);
    const receipt = receiptOf(eq);
    assert.deepEqual(receipt.captures.map(c => c.session), [0, 0, 1]);
    assert.equal(receipt.sessions.length, 2);
    assert.equal(readdirSync(eq).filter(name => name.endsWith('.png')).length, 3);
    const moving = path.join(w.dir, 'eq-moving');
    runProbe(['--probe', 'P-eq', '--mode', 'stream', '--daemon', w.daemon, '--output-dir', moving, ...SHORT],
      { env: { FAKE_SCENE: 'changing' } });
    assert.ok(receiptOf(moving).verdict.reasons.some(reason => reason.includes('not static')));
  } finally {
    rmSync(w.dir, { recursive: true, force: true });
  }
});

// Unit-level verdict rules and the observation-only method gate.
const verdicts = String.raw`
import importlib.util, json, pathlib, sys, types
spec = importlib.util.spec_from_file_location('owned_freshness_probe', pathlib.Path(sys.argv[1]))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
def capture(step, **fields):
    record = {"step": step, "phase": "warm", "session": 0, "ok": True, "latency_ms": 100.0, "sha256": "a" * 64,
              "reason": None, "connectionGeneration": 1, "healthBefore": {"state": "connected", "connectionGeneration": 1},
              "provenance": {"requests": {"full": 1}}, "ledger": {"fullRequests": 1}}
    record.update(fields)
    return record
session = {"index": 0, "ledger": {"inputLines": 0}, "gateLeaks": {"max": 0}, "failure": None}
results = {}
results["clean"] = probe.evaluate("P0", "stream", [capture(0), capture(1)], [session])
results["slow"] = probe.evaluate("P0", "stream", [capture(0, latency_ms=5000.0)], [session])
results["twoFull"] = probe.evaluate("P0", "stream", [capture(0, ledger={"fullRequests": 2})], [session])
results["provenance"] = probe.evaluate("P0", "stream", [capture(0, provenance={"requests": {"full": 2}})], [session])
results["input"] = probe.evaluate("P0", "stream", [capture(0)], [dict(session, ledger={"inputLines": 1})])
results["reconnected"] = probe.evaluate("P1", "on-demand", [capture(0), capture(1, connectionGeneration=2)], [session])
results["incremental"] = probe.evaluate("P1", "on-demand", [capture(0)],
                                        [dict(session, ledger={"inputLines": 0, "incrementalRearm": 1})])
try:
    probe.DaemonSession.rpc(types.SimpleNamespace(broken=None), "key_tap", 1)
    results["gate"] = "sent"
except AssertionError as error:
    results["gate"] = str(error)
print(json.dumps(results))
`;

test('verdict rules and the method gate', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', verdicts, probe], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.deepEqual(r.clean, ['PASS', []]);
  assert.match(r.slow[1][0], /took 5000.0 ms/);
  assert.match(r.twoFull[1][0], /wire ledger shows 2 full requests/);
  assert.match(r.provenance[1][0], /provenance shows 2 full requests/);
  assert.match(r.input[1][0], /input appeared on the wire ledger/);
  assert.match(r.reconnected[1][0], /connection did not survive: generations/);
  assert.match(r.incremental[1][0], /on-demand mode wrote 1 incremental requests/);
  assert.match(r.gate, /observation-only runner refused to send 'key_tap'/);
});
