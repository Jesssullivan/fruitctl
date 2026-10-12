import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { auditRuntimeFiles } from '../lib/install/integrity.mjs';
import { install, doctor, rollback } from '../lib/install/index.mjs';
import { sha256 } from '../lib/install/release.mjs';
import { timedInstallerCommand, measureInstallerStage } from '../lib/install/timings.mjs';

const run = promisify(execFile);

async function directory(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-integrity-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

async function payloads(t) {
  const prefix = await directory(t), files = {}, modes = {};
  for (const relative of ['second.txt', 'first.txt', 'last.txt']) {
    const bytes = Buffer.from(`independent ${relative} bytes\n`), file = path.join(prefix, relative);
    await fs.writeFile(file, bytes); await fs.chmod(file, 0o644);
    files[relative] = sha256(bytes); modes[relative] = 0o644;
  }
  return { prefix, files, modes };
}

test('doctor audit immediately reports all drift and later successes in expected inventory order', async t => {
  const f = await payloads(t), checks = [];
  await fs.appendFile(path.join(f.prefix, 'second.txt'), 'changed');
  await fs.chmod(path.join(f.prefix, 'first.txt'), 0o600);
  await auditRuntimeFiles({ ...f, policy: 'doctor', onCheck: check => checks.push(check) });
  assert.deepEqual(checks, [
    { name: 'second.txt', ok: false }, { name: 'first.txt', ok: false }, { name: 'last.txt', ok: true }
  ]);
});

test('doctor retains prior drift checks when a later read rejects with its original error', async t => {
  const f = await payloads(t), checks = [], original = fs.readFile;
  await fs.appendFile(path.join(f.prefix, 'second.txt'), 'changed');
  const denied = Object.assign(new Error('fixture later read denied'), { code: 'EACCES' });
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === path.join(f.prefix, 'first.txt')) throw denied;
    return original(file, ...args);
  });
  await assert.rejects(auditRuntimeFiles({ ...f, policy: 'doctor', onCheck: check => checks.push(check) }), error => error === denied);
  assert.deepEqual(checks, [{ name: 'second.txt', ok: false }]);
});

test('rollback and cache stop at the first inventory mismatch without accessing later files', async t => {
  for (const policy of ['rollback', 'cache']) await t.test(policy, async t => {
    const f = await payloads(t), original = fs.lstat, later = [];
    await fs.appendFile(path.join(f.prefix, 'second.txt'), 'changed');
    await fs.appendFile(path.join(f.prefix, 'first.txt'), 'also changed');
    t.mock.method(fs, 'lstat', async (file, ...args) => {
      if ([path.join(f.prefix, 'first.txt'), path.join(f.prefix, 'last.txt')].includes(file)) later.push(file);
      return original(file, ...args);
    });
    const expected = policy === 'rollback'
      ? 'Previous runtime file is missing or changed: second.txt; refusing rollback'
      : 'Cached runtime file changed: second.txt';
    await assert.rejects(auditRuntimeFiles({ ...f, policy }), error => error.message === expected);
    assert.deepEqual(later, []);
  });
});

test('missing files retain doctor collection, rollback refusal and cache filesystem errors', async t => {
  const f = await payloads(t), checks = [];
  await fs.unlink(path.join(f.prefix, 'second.txt'));
  await auditRuntimeFiles({ ...f, policy: 'doctor', onCheck: check => checks.push(check) });
  assert.deepEqual(checks.map(check => check.ok), [false, true, true]);
  await assert.rejects(auditRuntimeFiles({ ...f, policy: 'rollback' }), /Previous runtime file is missing or changed: second\.txt; refusing rollback/);
  const absent = Object.assign(new Error('fixture cache lstat absent'), { code: 'ENOENT' }), original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (file === path.join(f.prefix, 'second.txt')) throw absent;
    return original(file, ...args);
  });
  await assert.rejects(auditRuntimeFiles({ ...f, policy: 'cache' }), error => error === absent);
});

test('invalid doctor and rollback entries refuse before guard or descendant reads', async t => {
  const prefix = await directory(t), visited = [];
  const guard = async file => { visited.push(file); };
  for (const files of [{ '../outside': 'a'.repeat(64) }, { 'normalized.txt': 'invalid-digest' }]) {
    await assert.rejects(auditRuntimeFiles({ prefix, files, policy: 'doctor', beforeFile: guard, onCheck: () => assert.fail('invalid entry emitted') }), /Invalid runtime file inventory/);
  }
  await assert.rejects(auditRuntimeFiles({ prefix, files: { '../outside': 'a'.repeat(64) }, policy: 'rollback', beforeFile: guard }), /Invalid runtime receipt path/);
  assert.deepEqual(visited, []);
});

test('known symlink, directory and mode mismatches never read their payload bytes', async t => {
  for (const kind of ['symlink', 'directory', 'mode']) await t.test(kind, async t => {
    const f = await payloads(t), file = path.join(f.prefix, 'second.txt');
    if (kind === 'mode') await fs.chmod(file, 0o600);
    else {
      const retained = path.join(f.prefix, 'retained-copy'); await fs.rename(file, retained);
      if (kind === 'symlink') await fs.symlink(retained, file);
      else await fs.mkdir(file, { mode: 0o700 });
    }
    const original = fs.readFile, reads = [];
    t.mock.method(fs, 'readFile', async (target, ...args) => {
      if (target === file) reads.push(target);
      return original(target, ...args);
    });
    const checks = [];
    await auditRuntimeFiles({ ...f, policy: 'doctor', onCheck: check => checks.push(check) });
    assert.deepEqual(checks.map(check => check.ok), [false, true, true]);
    await assert.rejects(auditRuntimeFiles({ ...f, policy: 'rollback' }), /Previous runtime file is missing or changed/);
    await assert.rejects(auditRuntimeFiles({ ...f, policy: 'cache' }), /Cached runtime file changed/);
    assert.deepEqual(reads, []);
  });
});

test('guard refusals propagate unchanged before file access for every new leaf', async t => {
  const f = await payloads(t), original = fs.lstat, accessed = [];
  const refusal = new Error('fixture ancestor replacement'), checks = [];
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (file === path.join(f.prefix, 'first.txt')) accessed.push(file);
    return original(file, ...args);
  });
  await assert.rejects(auditRuntimeFiles({ ...f, policy: 'doctor',
    beforeFile: async file => { if (file === path.join(f.prefix, 'first.txt')) throw refusal; },
    onCheck: check => checks.push(check) }), error => error === refusal);
  assert.deepEqual(accessed, []);
  assert.deepEqual(checks, [{ name: 'second.txt', ok: true }]);
});

test('hash-only legacy audits omit modes while cache verification retains its mode contract', async t => {
  const f = await payloads(t), checks = [];
  await fs.chmod(path.join(f.prefix, 'second.txt'), 0o600);
  await auditRuntimeFiles({ prefix: f.prefix, files: f.files, policy: 'doctor', onCheck: check => checks.push(check) });
  assert.ok(checks.every(check => check.ok));
  await auditRuntimeFiles({ prefix: f.prefix, files: f.files, policy: 'rollback' });
  await assert.rejects(auditRuntimeFiles({ ...f, policy: 'cache' }), /Cached runtime file changed: second\.txt/);
});

test('audit timing counts attempted entries without per-file clock reads or default result changes', async t => {
  const f = await payloads(t), checks = []; let reads = 0;
  const operation = async () => {
    await measureInstallerStage('cacheFileAudit', () => auditRuntimeFiles({ ...f, policy: 'doctor', onCheck: check => checks.push(check) }));
    return { status: 'verified' };
  };
  const plain = await timedInstallerCommand({}, { get timingClock() { reads++; throw new Error('disabled clock'); } }, operation);
  assert.deepEqual(plain, { status: 'verified' }); assert.equal(reads, 0);
  let ns = 2n ** 60n;
  const measured = await timedInstallerCommand({ timings: true }, { timingClock: () => { reads++; ns += 1_000_000n; return ns; } }, operation);
  assert.equal(reads, 4);
  assert.deepEqual(measured.timings.stages.cacheFileAudit, { calls: 1, failures: 0, fileChecks: 3, totalMs: 1 });
  assert.equal(measured.timings.measurementComplete, true);
  assert.equal(JSON.stringify(measured.timings).includes(f.prefix), false);
});

async function fixture(t, { explicit = true, alias = false } = {}) {
  const base = await directory(t), home = path.join(base, 'home'), projectDir = path.join(base, 'project');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(projectDir, { mode: 0o700 });
  const physicalRoot = path.join(base, 'owned root');
  let installRoot = explicit ? physicalRoot : undefined;
  if (alias) {
    await fs.mkdir(physicalRoot, { mode: 0o700 }); installRoot = path.join(base, 'selected root alias');
    await fs.symlink(physicalRoot, installRoot);
  }
  const original = Buffer.from('{"unrelated":"private fixture sentinel","mcpServers":{"preserved":{"command":"never-executed"}}}\n');
  await fs.writeFile(path.join(projectDir, '.mcp.json'), original); await fs.chmod(path.join(projectDir, '.mcp.json'), 0o640);
  return { base, home, projectDir, installRoot, physicalRoot, original, agent: 'claude', scope: 'project', version: 'v0.0.1', target: 'synthetic', platform: 'linux', arch: 'x64', env: {} };
}

async function release(f, version = f.version) {
  const directory = path.join(f.base, version), bundle = path.join(directory, 'bundle');
  for (const relative of ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md']) {
    const file = path.join(bundle, relative), mode = ['bin/node', 'bin/fruitctl'].includes(relative) ? 0o755 : 0o644;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, `${relative} ${version} synthetic bytes, never executed\n`); await fs.chmod(file, mode);
  }
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({ version: version.slice(1), fruitctlInstallerCapabilities: { installRoot: 1 } }));
  await fs.chmod(path.join(bundle, 'package.json'), 0o644);
  const archivePath = path.join(directory, 'runtime.tar.gz');
  await run('tar', ['-czf', archivePath, '-C', bundle, '.'], { timeout: 10_000 });
  const name = `fruitctl-${version}-linux-x64.tar.gz`;
  const manifest = { schema: 'fruitctl.release.v1', repository: 'xoxd-ai/fruitctl', version,
    assets: [{ kind: 'runtime', os: 'linux', arch: 'x64', name, url: `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/${name}`, sha256: sha256(await fs.readFile(archivePath)) }] };
  const manifestPath = path.join(directory, 'fruitctl-release.json'), bytes = JSON.stringify(manifest);
  await fs.writeFile(manifestPath, bytes);
  return { manifestPath, archivePath, manifestSha256: sha256(bytes) };
}

async function registrationState(installed, operationalRoot) {
  const receipt = JSON.parse(await fs.readFile(installed.receiptPath, 'utf8'));
  return { config: await fs.readFile(installed.configPath), mode: (await fs.lstat(installed.configPath)).mode & 0o777,
    skill: await fs.readlink(installed.skillPath), launcher: await fs.readlink(operationalRoot ? path.join(operationalRoot, 'bin/fruitctl') : receipt.launcher.path),
    receipt: await fs.readFile(installed.receiptPath) };
}

test('public doctor retains all ordered checks and default JSON when two payloads drift', async t => {
  const f = await fixture(t), installed = await install({ ...f, offline: await release(f) });
  const before = await registrationState(installed, f.physicalRoot), baseline = await doctor(f);
  const receipt = JSON.parse(before.receipt), names = Object.keys(receipt.runtime.files), damaged = names.filter(name => name !== 'package.json').slice(0, 2);
  for (const name of damaged) await fs.appendFile(path.join(installed.prefix, name), 'changed');
  const actual = await doctor(f);
  assert.equal(actual.status, 'drift'); assert.equal(Object.hasOwn(actual, 'timings'), false);
  assert.deepEqual(actual.checks.map(check => check.name), baseline.checks.map(check => check.name));
  for (const name of names) assert.equal(actual.checks.find(check => check.name === name).ok, !damaged.includes(name));
  assert.deepEqual(await registrationState(installed, f.physicalRoot), before);
});

test('public doctor preserves earlier checks when a later filesystem read fails', async t => {
  const f = await fixture(t), installed = await install({ ...f, offline: await release(f) });
  const before = await registrationState(installed, f.physicalRoot), receipt = JSON.parse(before.receipt);
  const names = Object.keys(receipt.runtime.files).filter(name => name !== 'package.json'), original = fs.readFile;
  await fs.appendFile(path.join(installed.prefix, names[0]), 'changed');
  const denied = Object.assign(new Error('deterministic later audit denial'), { code: 'EACCES' });
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === path.join(installed.prefix, names[1])) throw denied;
    return original(file, ...args);
  });
  const result = await doctor(f);
  assert.equal(result.status, 'drift');
  assert.equal(result.checks.find(check => check.name === names[0]).ok, false);
  assert.equal(result.checks.some(check => check.name === names[1]), false);
  assert.deepEqual(result.checks.at(-1), { name: 'pinned runtime identity', ok: false, detail: denied.message });
  assert.deepEqual(await registrationState(installed, f.physicalRoot), before);
});

test('public rollback and cache reuse refuse corruption before registration writes', async t => {
  for (const policy of ['rollback', 'cache']) await t.test(policy, async t => {
    const f = await fixture(t), offline = await release(f), initial = await install({ ...f, offline });
    const current = policy === 'rollback' ? await install({ ...f, version: 'v0.0.2', offline: await release(f, 'v0.0.2') }) : initial;
    const before = await registrationState(current, f.physicalRoot);
    // The first installation result pins its own prefix even after its receipt is advanced.
    const runtime = JSON.parse(await fs.readFile(path.join(initial.prefix, '.fruitctl-runtime.json'), 'utf8'));
    const damaged = Object.keys(runtime.files).filter(name => name !== 'package.json').slice(0, 2);
    for (const name of damaged) await fs.appendFile(path.join(initial.prefix, name), 'changed');
    const expected = policy === 'rollback'
      ? `Previous runtime file is missing or changed: ${damaged[0]}; refusing rollback`
      : `Cached runtime file changed: ${damaged[0]}`;
    await assert.rejects(policy === 'rollback' ? rollback(f) : install({ ...f, offline }), error => error.message === expected);
    assert.deepEqual(await registrationState(current, f.physicalRoot), before);
  });
});

test('public rollback propagates its original read refusal without changing registration', async t => {
  const f = await fixture(t), initial = await install({ ...f, offline: await release(f) });
  const current = await install({ ...f, version: 'v0.0.2', offline: await release(f, 'v0.0.2') });
  const before = await registrationState(current, f.physicalRoot), runtime = JSON.parse(await fs.readFile(path.join(initial.prefix, '.fruitctl-runtime.json'), 'utf8'));
  const first = Object.keys(runtime.files).find(name => name !== 'package.json'), original = fs.readFile;
  const denied = Object.assign(new Error('deterministic previous runtime read denial'), { code: 'EACCES' });
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === path.join(initial.prefix, first)) throw denied;
    return original(file, ...args);
  });
  await assert.rejects(rollback(f), error => error === denied);
  assert.deepEqual(await registrationState(current, f.physicalRoot), before);
});

test('a later file changed during a public audit is freshly checked before recovery writes', async t => {
  for (const operation of ['doctor', 'rollback']) for (const kind of ['bytes', 'mode']) await t.test(`${operation}: ${kind}`, async t => {
    const f = await fixture(t), initial = await install({ ...f, offline: await release(f) });
    const current = operation === 'rollback' ? await install({ ...f, version: 'v0.0.2', offline: await release(f, 'v0.0.2') }) : initial;
    const before = await registrationState(current, f.physicalRoot), runtime = JSON.parse(await fs.readFile(path.join(initial.prefix, '.fruitctl-runtime.json'), 'utf8'));
    const names = Object.keys(runtime.files).filter(name => name !== 'package.json'), original = fs.readFile; let changed = false;
    t.mock.method(fs, 'readFile', async (file, ...args) => {
      const bytes = await original(file, ...args);
      if (!changed && file === path.join(initial.prefix, names[0])) {
        changed = true;
        if (kind === 'bytes') await fs.appendFile(path.join(initial.prefix, names[1]), 'late changed bytes');
        else await fs.chmod(path.join(initial.prefix, names[1]), 0o600);
      }
      return bytes;
    });
    if (operation === 'doctor') {
      const result = await doctor(f); assert.equal(result.status, 'drift');
      assert.equal(result.checks.find(check => check.name === names[1]).ok, false);
    } else await assert.rejects(rollback(f), error => error.message === `Previous runtime file is missing or changed: ${names[1]}; refusing rollback`);
    assert.equal(changed, true);
    assert.deepEqual(await registrationState(current, f.physicalRoot), before);
  });
});

test('public doctor root-alias replacement between leaves refuses before foreign reads', async t => {
  const f = await fixture(t, { alias: true }), installed = await install({ ...f, offline: await release(f) });
  const before = await registrationState(installed, f.physicalRoot), runtime = JSON.parse(await fs.readFile(path.join(installed.prefix, '.fruitctl-runtime.json'), 'utf8'));
  const first = Object.keys(runtime.files).find(name => name !== 'package.json'), foreign = path.join(f.base, 'foreign fixture');
  await fs.mkdir(foreign, { mode: 0o700 });
  const original = fs.readFile, foreignReads = []; let changed = false;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (typeof file === 'string' && file.startsWith(foreign + path.sep)) foreignReads.push(file);
    const bytes = await original(file, ...args);
    if (!changed && file === path.join(installed.prefix, first)) {
      changed = true; await fs.unlink(f.installRoot); await fs.symlink(foreign, f.installRoot);
    }
    return bytes;
  });
  const result = await doctor(f);
  assert.equal(changed, true); assert.equal(result.status, 'drift');
  assert.equal(result.checks.find(check => check.name === first).ok, true);
  assert.match(result.checks.at(-1).detail, /Install root path changed during transaction/);
  assert.deepEqual(foreignReads, []);
  assert.deepEqual(await fs.readdir(foreign), []);
  assert.deepEqual(await registrationState(installed, f.physicalRoot), before);
});

test('capability success never skips a later fresh package hash audit', async t => {
  const f = await fixture(t), installed = await install({ ...f, offline: await release(f) });
  const before = await registrationState(installed, f.physicalRoot), runtime = JSON.parse(await fs.readFile(path.join(installed.prefix, '.fruitctl-runtime.json'), 'utf8'));
  const first = Object.keys(runtime.files).find(name => name !== 'package.json'), packagePath = path.join(installed.prefix, 'package.json'), original = fs.readFile;
  let changed = false, packageReads = 0;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === packagePath) packageReads++;
    const bytes = await original(file, ...args);
    if (!changed && file === path.join(installed.prefix, first)) { changed = true; await fs.appendFile(packagePath, ' '); }
    return bytes;
  });
  const result = await doctor(f);
  assert.equal(changed, true); assert.equal(result.status, 'drift');
  assert.equal(result.checks.find(check => check.name === 'package.json').ok, false);
  assert.equal(packageReads, 3, 'both caller capability reads and the later full-file read remain');
  assert.deepEqual(await registrationState(installed, f.physicalRoot), before);
});

test('public hash-only legacy rollback remains usable without inventing modes', async t => {
  const f = await fixture(t, { explicit: false }), initial = await install({ ...f, offline: await release(f) });
  const receipt = JSON.parse(await fs.readFile(initial.receiptPath, 'utf8')); delete receipt.runtime.modes;
  await fs.writeFile(initial.receiptPath, JSON.stringify(receipt));
  await fs.chmod(path.join(initial.prefix, 'skills/fruitctl/SKILL.md'), 0o600);
  assert.equal((await doctor(f)).status, 'configured');
  await install({ ...f, version: 'v0.0.2', offline: await release(f, 'v0.0.2') });
  assert.equal((await rollback(f)).to, f.version);
  const restored = JSON.parse(await fs.readFile(initial.receiptPath, 'utf8'));
  assert.equal(Object.hasOwn(restored.runtime, 'modes'), false);
  assert.equal((await doctor(f)).status, 'configured');
});
