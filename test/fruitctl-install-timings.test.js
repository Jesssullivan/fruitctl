import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { install, doctor, rollback, uninstall, timingsForError } from '../lib/install/index.mjs';
import { sha256 } from '../lib/install/release.mjs';
import { timedInstallerCommand, measureInstallerStage, recordInstallerFileCheck, timingStages } from '../lib/install/timings.mjs';

const run = promisify(execFile);
const stepClock = () => { let ns = 0n; return () => { const value = ns; ns += 1_000_000n; return value; }; };
function boundedReport(report) {
  assert.equal(report.schema, 'fruitctl.installer.timings.v1');
  assert.equal(report.unit, 'milliseconds');
  assert.equal(report.inclusiveStages, true);
  assert.deepEqual(Object.keys(report.stages), [...timingStages]);
  assert.ok(Number.isFinite(report.commandElapsedMs) && report.commandElapsedMs >= 0 && report.commandElapsedMs <= 86_400_000);
  for (const row of Object.values(report.stages)) {
    assert.deepEqual(Object.keys(row), ['calls', 'failures', 'fileChecks', 'totalMs']);
    for (const key of ['calls', 'failures', 'fileChecks']) assert.ok(Number.isInteger(row[key]) && row[key] >= 0 && row[key] <= 1_000_000);
    assert.ok(Number.isFinite(row.totalMs) && row.totalMs >= 0 && row.totalMs <= 86_400_000);
  }
  assert.ok(JSON.stringify(report).length < 1800);
}

test('disabled timing reads no clock and preserves success and the original error', async () => {
  let reads = 0;
  const dependencies = { get timingClock() { reads++; throw new Error('must not read disabled clock'); } };
  const expected = { status: 'unchanged' };
  const value = await timedInstallerCommand({}, dependencies, () => measureInstallerStage('registration', () => expected));
  assert.equal(value, expected);
  const error = new Error('original refusal');
  await assert.rejects(timedInstallerCommand({ timings: false }, dependencies, () => { throw error; }), actual => actual === error);
  await assert.rejects(timedInstallerCommand(null, dependencies, () => { throw error; }), actual => actual === error);
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn(error, 'timings'), false);
  assert.equal(timingsForError(error), undefined);
});

test('controlled bigint clock reports inclusive nested totals separately from command elapsed', async () => {
  const origin = 2n ** 60n; // Absolute clock readings need not fit a Number.
  const times = [0n, 1_000_000n, 2_000_000n, 5_000_000n, 8_000_000n, 10_000_000n].map(ns => origin + ns);
  const result = await timedInstallerCommand({ timings: true }, { timingClock: () => times.shift() }, async () => {
    await measureInstallerStage('rootGuards', () => measureInstallerStage('descriptorGuards', async () => {}));
    return { status: 'ok' };
  });
  boundedReport(result.timings);
  assert.equal(result.timings.commandElapsedMs, 10);
  assert.deepEqual(result.timings.stages.rootGuards, { calls: 1, failures: 0, fileChecks: 0, totalMs: 7 });
  assert.deepEqual(result.timings.stages.descriptorGuards, { calls: 1, failures: 0, fileChecks: 0, totalMs: 3 });
  assert.equal(result.timings.measurementComplete, true);
  assert.equal(times.length, 0);
});

test('stage refusal retains the same error and adds only a bounded provenance report', async () => {
  const error = new Error('refusal /private/operator/config');
  error.privateBody = 'provider-secret-fixture';
  await assert.rejects(timedInstallerCommand({ timings: true }, { timingClock: stepClock() }, () =>
    measureInstallerStage('archiveFetch', () => { throw error; })), actual => actual === error);
  const report = timingsForError(error);
  boundedReport(report);
  assert.equal(error.timings, report);
  assert.equal(Object.keys(error).includes('timings'), false);
  assert.deepEqual(report.stages.archiveFetch, { calls: 1, failures: 1, fileChecks: 0, totalMs: 1 });
  assert.equal(report.commandElapsedMs, 3);
  assert.ok(!JSON.stringify(report).includes('private') && !JSON.stringify(report).includes('provider'));
});

test('frozen and foreign error timing properties never mask errors or leak through the accessor', async () => {
  const foreign = new Error('foreign');
  foreign.timings = { secret: 'never print this' };
  assert.equal(timingsForError(foreign), undefined);
  for (const error of [Object.freeze(new Error('frozen')), Object.preventExtensions(new Error('nonextensible')), foreign]) {
    await assert.rejects(timedInstallerCommand({ timings: true }, { timingClock: stepClock() }, () => { throw error; }), actual => actual === error);
    boundedReport(timingsForError(error));
  }
  assert.deepEqual(foreign.timings, { secret: 'never print this' });
  assert.ok(!JSON.stringify(timingsForError(foreign)).includes('secret'));
  const getter = new Error('getter');
  Object.defineProperty(getter, 'timings', { get() { throw new Error('foreign getter must not execute'); } });
  await assert.rejects(timedInstallerCommand({ timings: true }, { timingClock: stepClock() }, () => { throw getter; }), actual => actual === getter);
  boundedReport(timingsForError(getter));
  assert.equal(timingsForError('untrusted primitive'), undefined);
});

test('failed malformed and backwards timing clocks leave product outcomes and errors intact', async () => {
  const backwards = [5n, 4n, 6n, 7n];
  const clocks = [() => { throw new Error('clock failure'); }, () => 123, () => backwards.shift()];
  for (const timingClock of clocks) {
    const result = await timedInstallerCommand({ timings: true }, { timingClock }, async () => {
      await measureInstallerStage('registration', async () => {}); return { status: 'ok' };
    });
    assert.equal(result.status, 'ok');
    boundedReport(result.timings);
    assert.equal(result.timings.measurementComplete, false);
  }
  const dependency = { get timingClock() { throw new Error('clock dependency read failed'); } };
  const refusal = Object.freeze(new Error('original product error'));
  await assert.rejects(timedInstallerCommand({ timings: true }, dependency, () => { throw refusal; }), error => error === refusal);
  assert.equal(timingsForError(refusal).measurementComplete, false);
});

test('fixed counters saturate and unknown labels cannot expand the bounded report', async () => {
  const times = [0n, 86_400_000_000_001n];
  const result = await timedInstallerCommand({ timings: true }, { timingClock: () => times.shift() }, async () => {
    for (let i = 0; i < 1_000_002; i++) recordInstallerFileCheck('cacheFileAudit');
    recordInstallerFileCheck('__proto__');
    await measureInstallerStage('operator-secret-stage', async () => {});
    return {};
  });
  boundedReport(result.timings);
  assert.equal(result.timings.stages.cacheFileAudit.fileChecks, 1_000_000);
  assert.equal(result.timings.commandElapsedMs, 86_400_000);
  assert.equal(result.timings.saturated, true);
  assert.equal(result.timings.measurementComplete, false);
  assert.ok(!JSON.stringify(result.timings).includes('secret'));
});

test('overlapping commands have isolated aggregate records', async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const first = timedInstallerCommand({ timings: true }, { timingClock: stepClock() }, async () => {
    await measureInstallerStage('metadataManifest', () => gate); return { id: 'first' };
  });
  const second = await timedInstallerCommand({ timings: true }, { timingClock: stepClock() }, async () => {
    await measureInstallerStage('archiveFetch', async () => {}); return { id: 'second' };
  });
  resume();
  const initial = await first;
  assert.equal(initial.timings.stages.metadataManifest.calls, 1);
  assert.equal(initial.timings.stages.archiveFetch.calls, 0);
  assert.equal(second.timings.stages.metadataManifest.calls, 0);
  assert.equal(second.timings.stages.archiveFetch.calls, 1);
});

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-timing-test-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), projectDir = path.join(base, 'project');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(projectDir, { mode: 0o700 });
  return { base, home, projectDir, installRoot: path.join(base, 'owned-install'), agent: 'claude', scope: 'project', version: 'v0.0.1', target: 'synthetic', platform: 'linux', arch: 'x64', env: {} };
}

async function release(f, version = f.version) {
  const directory = path.join(f.base, version), bundle = path.join(directory, 'bundle');
  const files = ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md'];
  for (const file of files) {
    const target = path.join(bundle, file);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, `${file}: ${version} fixture, never executed\n`, { mode: file === 'bin/node' || file === 'bin/fruitctl' ? 0o755 : 0o644 });
  }
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({ version: version.slice(1), fruitctlInstallerCapabilities: { installRoot: 1 } }), { mode: 0o644 });
  const archivePath = path.join(directory, 'runtime.tar.gz');
  await run('tar', ['-czf', archivePath, '-C', bundle, '.'], { timeout: 10_000 });
  const name = `fruitctl-${version}-linux-x64.tar.gz`;
  const manifest = { schema: 'fruitctl.release.v1', repository: 'xoxd-ai/fruitctl', version, assets: [{ kind: 'runtime', os: 'linux', arch: 'x64', name, url: `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/${name}`, sha256: sha256(await fs.readFile(archivePath)) }] };
  const manifestPath = path.join(directory, 'fruitctl-release.json');
  const manifestBytes = JSON.stringify(manifest); await fs.writeFile(manifestPath, manifestBytes);
  return { manifestPath, archivePath, manifestSha256: sha256(manifestBytes) };
}

test('controlled-clock real fixture lifecycle measures fresh/cache audits and restoration without optimizing', async t => {
  const f = await fixture(t), original = '{"mcpServers":{"other":{"command":"never-executed"}},"private":"provider-value-fixture"}\n';
  await fs.writeFile(path.join(f.projectDir, '.mcp.json'), original, { mode: 0o640 });
  const offline = await release(f), options = { ...f, offline, timings: true }, dependencies = { timingClock: stepClock() };
  const initial = await install(options, dependencies);
  assert.equal(initial.status, 'installed'); boundedReport(initial.timings);
  assert.equal(initial.timings.stages.metadataManifest.calls, 1);
  assert.equal(initial.timings.stages.archiveFetch.calls, 1);
  assert.equal(initial.timings.stages.archiveExtraction.calls, 1);
  assert.equal(initial.timings.stages.freshFileAudit.fileChecks, 7);
  assert.ok(initial.timings.stages.rootGuards.calls > 0 && initial.timings.stages.descriptorGuards.calls > 0 && initial.timings.stages.registration.calls > 0);
  const repeat = await install(options, dependencies);
  assert.equal(repeat.status, 'installed');
  assert.equal(repeat.timings.stages.archiveFetch.calls, 1, 'reinstall still reads the archive');
  assert.equal(repeat.timings.stages.freshFileAudit.fileChecks, 7, 'reinstall still performs fresh extraction audit');
  assert.equal(repeat.timings.stages.cacheFileAudit.fileChecks, 7, 'existing complete cache audit retained');
  const checked = await doctor(options, dependencies);
  assert.equal(checked.status, 'configured');
  assert.equal(checked.timings.stages.cacheFileAudit.fileChecks, 7);
  assert.equal(checked.timings.stages.freshFileAudit.calls, 0);
  const nextVersion = 'v0.0.2';
  await install({ ...options, version: nextVersion, offline: await release(f, nextVersion) }, dependencies);
  const previous = await rollback(options, dependencies);
  assert.deepEqual([previous.status, previous.from, previous.to], ['rolled-back', nextVersion, f.version]);
  assert.equal(previous.timings.stages.cacheFileAudit.fileChecks, 7);
  assert.ok(previous.timings.stages.restoration.calls > 0);
  const removed = await uninstall(options, dependencies);
  assert.equal(removed.status, 'removed'); assert.ok(removed.timings.stages.restoration.calls > 0);
  assert.equal(await fs.readFile(path.join(f.projectDir, '.mcp.json'), 'utf8'), original);
  assert.equal((await fs.stat(path.join(f.projectDir, '.mcp.json'))).mode & 0o777, 0o640);
  for (const value of [initial, repeat, checked, previous, removed]) {
    boundedReport(value.timings);
    assert.equal(value.timings.measurementComplete, true);
    assert.ok(!JSON.stringify(value.timings).includes(f.base) && !JSON.stringify(value.timings).includes('provider-value'));
  }
});

test('default real fixture doctor JSON is unchanged and reads no disabled clock', async t => {
  const f = await fixture(t); await install({ ...f, offline: await release(f) });
  const baseline = await doctor(f);
  let reads = 0;
  const untimed = await doctor({ ...f, timings: false }, { timingClock: () => { reads++; throw new Error('disabled'); } });
  assert.equal(JSON.stringify(untimed), JSON.stringify(baseline));
  assert.equal(reads, 0);
  assert.equal(Object.hasOwn(baseline, 'timings'), false);
});

test('real manifest refusal keeps original error and records a failed metadata stage', async t => {
  const f = await fixture(t), offline = await release(f);
  await assert.rejects(install({ ...f, offline: { ...offline, manifestSha256: '0'.repeat(64) }, timings: true }, { timingClock: stepClock() }), error => {
    assert.equal(error.message, 'Release manifest SHA-256 mismatch');
    const report = timingsForError(error); boundedReport(report);
    assert.equal(report.stages.metadataManifest.failures, 1);
    assert.equal(report.stages.archiveFetch.calls, 0);
    assert.equal(report.stages.registration.failures, 0);
    return true;
  });
  assert.deepEqual(await fs.readdir(f.projectDir), []);
});

test('real doctor mode drift retains checks and rollback refuses unchanged corruption', async t => {
  const f = await fixture(t), options = { ...f, offline: await release(f), timings: true };
  await install(options, { timingClock: stepClock() });
  const second = 'v0.0.2'; await install({ ...options, version: second, offline: await release(f, second) }, { timingClock: stepClock() });
  const firstFile = path.join(f.installRoot, 'releases', f.version, 'linux-x64/skills/fruitctl/SKILL.md');
  await fs.chmod(firstFile, 0o600);
  await assert.rejects(rollback(options, { timingClock: stepClock() }), error => {
    assert.match(error.message, /Previous runtime file is missing or changed: skills\/fruitctl\/SKILL.md; refusing rollback/);
    assert.equal(timingsForError(error).stages.cacheFileAudit.failures, 1); return true;
  });
  const liveFile = path.join(f.installRoot, 'releases', second, 'linux-x64/skills/fruitctl/SKILL.md');
  await fs.chmod(liveFile, 0o600);
  const result = await doctor(options, { timingClock: stepClock() });
  assert.equal(result.status, 'drift');
  assert.equal(result.checks.find(row => row.name === 'skills/fruitctl/SKILL.md').ok, false);
  assert.equal(result.timings.stages.cacheFileAudit.fileChecks, 7);
});

test('aggregate doctor shares one report while keeping per-installation reports bounded away', async t => {
  const f = await fixture(t), offline = await release(f);
  await install({ ...f, offline });
  const other = path.join(f.base, 'second-project'); await fs.mkdir(other, { mode: 0o700 });
  await install({ ...f, projectDir: other, offline });
  const result = await doctor({ home: f.home, installRoot: f.installRoot, platform: 'linux', arch: 'x64', env: {}, timings: true }, { timingClock: stepClock() });
  assert.equal(result.status, 'configured');
  assert.equal(result.installations.length, 2);
  assert.ok(result.installations.every(value => !Object.hasOwn(value, 'timings')));
  assert.equal(result.timings.stages.cacheFileAudit.calls, 2);
  assert.equal(result.timings.stages.cacheFileAudit.fileChecks, 14);
});
