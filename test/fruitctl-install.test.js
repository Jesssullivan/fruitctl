import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { install, doctor, uninstall, rollback } from '../lib/install/index.mjs';
import * as installer from '../lib/install/index.mjs';
import { renderIntegration, resolveAdapter } from '../lib/install/adapters.mjs';
import { parseJsonc, patchJsonEntry, jsonEntry, patchTomlEntry, tomlEntry, ownedFieldsMatch } from '../lib/install/config.mjs';
import { sha256, resolveRelease } from '../lib/install/release.mjs';

const run = promisify(execFile);
async function fixture(t) {
  // TMPDIR may itself be a symlink. Most fixtures need physical registration
  // paths; deliberate alias cases below keep their requested path separately.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-test-install-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), projectDir = path.join(root, 'project');
  await fs.mkdir(home); await fs.mkdir(projectDir);
  return { root, home, projectDir, agent: 'claude', scope: 'project', version: 'v0.1.0-alpha.1', target: 'lab-desktop', platform: 'linux', arch: 'x64', env: {} };
}

async function releaseFixture(f, version = f.version, { symlink = false, nativeExecutables = {}, packageJson } = {}) {
  const root = path.join(f.root, version); const bundle = path.join(root, 'bundle');
  const files = ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'lib/broker/runtime-marker.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md', ...Object.keys(nativeExecutables)];
  for (const file of files) {
    const dest = path.join(bundle, file); await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, `${file} fixture for ${version}\n`, { mode: nativeExecutables[file] ?? (file === 'bin/fruitctl' || file === 'bin/node' ? 0o755 : 0o600) });
  }
  if (packageJson !== undefined) await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify(packageJson), { mode: 0o600 });
  if (symlink) await fs.symlink('/etc/passwd', path.join(bundle, 'external'));
  const archivePath = path.join(root, 'runtime.tar.gz');
  await run('tar', ['-czf', archivePath, '-C', bundle, '.'], { timeout: 10000 });
  const name = `fruitctl-${version}-${f.platform}-${f.arch}.tar.gz`;
  const manifest = { schema: 'fruitctl.release.v1', repository: 'xoxd-ai/fruitctl', version, assets: [{ kind: 'runtime', os: f.platform, arch: f.arch, name, url: `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/${name}`, sha256: sha256(await fs.readFile(archivePath)) }] };
  const manifestPath = path.join(root, 'fruitctl-release.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { manifest, offline: { manifestPath, archivePath, manifestSha256: sha256(await fs.readFile(manifestPath)) } };
}

// These are storage/registration tests. Synthetic archives never execute their
// fixture launchers or agent/native binaries; a capability marker is a checked
// archive claim, not evidence about an arbitrary executable's behavior.
const capablePackage = version => ({ name: 'fruitctl', version: version.replace(/^v/, ''), fruitctlInstallerCapabilities: { installRoot: 1 } });
const capableRelease = (f, version = f.version) => releaseFixture(f, version, { packageJson: capablePackage(version) });

async function treeSnapshot(directory) {
  const rows = [];
  async function visit(file, relative) {
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const row = { path: relative, mode: stat.mode & 0o777, uid: stat.uid };
    if (stat.isSymbolicLink()) rows.push({ ...row, type: 'link', target: await fs.readlink(file) });
    else if (stat.isFile()) rows.push({ ...row, type: 'file', bytes: (await fs.readFile(file)).toString('base64') });
    else if (stat.isDirectory()) {
      rows.push({ ...row, type: 'directory' });
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), relative === '.' ? name : `${relative}/${name}`);
    } else throw new Error(`Unexpected fixture node: ${file}`);
  }
  await visit(directory, '.');
  return rows;
}

async function installationSnapshot(f) {
  return { home: await treeSnapshot(f.home), project: await treeSnapshot(f.projectDir), operational: await treeSnapshot(f.installRoot) };
}

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function exists(file) { return fs.lstat(file).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)); }
async function writeConfig(f, text = '{\n "mcpServers":{"other":{"command":"operator"}},\n "keep":true\n}\n', mode = 0o640) {
  const adapter = resolveAdapter(f);
  await fs.mkdir(path.dirname(adapter.configPath), { recursive: true });
  await fs.writeFile(adapter.configPath, text, { mode });
  await fs.chmod(adapter.configPath, mode);
  return { file: adapter.configPath, text, mode };
}

test('all seven adapters render their actual native schemas without launching agents', async t => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex', 'pi', 'junie', 'opencode', 'vscode', 'kimi']) {
    const result = await install({ ...f, agent, dryRun: true });
    assert.equal(result.status, 'planned');
    assert.match(result.snippet, /fruitctl/);
    if (agent === 'junie') assert.equal(result.ideSettingsSnippet, result.snippet);
    else assert.equal(result.ideSettingsSnippet, undefined);
  }
  const open = JSON.parse(renderIntegration({ agent: 'opencode', executable: '/p/bin/fruitctl', target: 'desktop' }));
  assert.deepEqual(open.mcp.fruitctl.command, ['/p/bin/fruitctl', 'mcp', '--target', 'desktop']);
  assert.equal(open.mcp.servers, undefined);
  const vs = JSON.parse(renderIntegration({ agent: 'vscode', executable: '/p/bin/fruitctl', target: 'desktop' }));
  assert.equal(vs.mcpServers.fruitctl.type, 'stdio');
  assert.equal(await fs.readdir(f.home).then(entries => entries.length), 0, 'dry run has no filesystem side effects');
  assert.throws(() => renderIntegration({ agent: 'claude', executable: '/p', target: 'host:5900' }), /configured profile/);
});

test('JSONC edits preserve unrelated comments, settings and trailing commas', () => {
  const original = '{\n // retained top comment\n "mcpServers": {\n  "other": {"command":"other"}, // retained other\n },\n "editor": [1,2,],\n}\n';
  const modified = patchJsonEntry(original, ['mcpServers'], { command: '/fruitctl', args: ['mcp'] });
  assert.match(modified, /\/\/ retained top comment/);
  assert.match(modified, /"other": \{"command":"other"\}, \/\/ retained other/);
  assert.match(modified, /"editor": \[1,2,\],/);
  assert.equal(jsonEntry(modified, ['mcpServers']).command, '/fruitctl');
  assert.equal(jsonEntry(patchJsonEntry(modified, ['mcpServers'], undefined), ['mcpServers']), undefined);
  assert.throws(() => parseJsonc('{"mcpServers":{},"mcpServers":{}}'), /Duplicate/);
});

test('JSONC equal entries preserve exact bytes, comments and reordered object keys', () => {
  const original = `{
 // retain top comment
 "mcpServers": {
  "fruitctl": {
   /* retain owned comment */ "type": "stdio",
   "unknown": {"nested": [{"second": null, "first": false}], "label": "keep"},
   "env": {"SECOND": "two", "FIRST": "one"},
   "args": ["mcp", "--target", "desktop",],
   "command": "/fruitctl",
  },
  "other": {"command":"operator"},
 },
 "editor": {"unknown": [1,2,]},
}\n`;
  const expected = { command: '/fruitctl', args: ['mcp', '--target', 'desktop'],
    env: { FIRST: 'one', SECOND: 'two' }, unknown: { label: 'keep', nested: [{ first: false, second: null }] }, type: 'stdio' };
  assert.equal(Object.getPrototypeOf(jsonEntry(original, ['mcpServers'])), null);
  assert.equal(patchJsonEntry(original, ['mcpServers'], expected), original);
});

test('JSONC real changes apply while array order and array/object types stay distinct', () => {
  const original = '{\n // retain outside\n "mcpServers":{"fruitctl":{"command":"/old","args":["mcp","desktop"],"state":{}}},\n "unknown":{"keep":true}\n}\n';
  for (const value of [
    { command: '/new', args: ['mcp', 'desktop'], state: {} },
    { command: '/old', args: ['desktop', 'mcp'], state: {} },
    { command: '/old', args: ['mcp', 'desktop'], state: [] },
    { command: '/old', args: ['mcp', 'desktop'], state: { added: null } },
  ]) {
    const modified = patchJsonEntry(original, ['mcpServers'], value);
    assert.notEqual(modified, original);
    assert.deepEqual(JSON.parse(JSON.stringify(jsonEntry(modified, ['mcpServers']))), value);
    assert.match(modified, /\/\/ retain outside/);
    assert.match(modified, /"unknown":\{"keep":true\}/);
    assert.equal(patchJsonEntry(modified, ['mcpServers'], value), modified);
  }
  const array = '{"mcpServers":{"fruitctl":[]}}\n';
  assert.deepEqual(JSON.parse(JSON.stringify(jsonEntry(patchJsonEntry(array, ['mcpServers'], {}), ['mcpServers']))), {});
});

test('Claude repeat installs preserve config bytes and existing runtime links in both scopes', async t => {
  for (const scope of ['user', 'project']) await t.test(scope, async t => {
    const f = { ...await fixture(t), scope }, v1 = await releaseFixture(f);
    const adapter = resolveAdapter(f);
    const original = '{\n "mcpServers":{"other":{"command":"operator"}},\n "unknown":{"values":[1,2]}\n}\n';
    await fs.writeFile(adapter.configPath, original);
    const first = await install({ ...f, offline: v1.offline });
    const snapshot = async () => ({ config: await fs.readFile(first.configPath, 'utf8'),
      launcher: await fs.readlink(first.launcherPath), skill: await fs.readlink(first.skillPath),
      nodeInode: (await fs.stat(path.join(first.prefix, 'bin/node'))).ino });
    const before = await snapshot();
    assert.equal((await install({ ...f, offline: v1.offline })).status, 'installed');
    assert.deepEqual(await snapshot(), before);
    const entry = jsonEntry(before.config, ['mcpServers']);
    const reordered = Object.entries(entry).reverse().map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(',\n      ');
    const formatted = `{\n "mcpServers": {\n  "other": {"command":"operator"},\n  "fruitctl": {\n      ${reordered}\n  }\n },\n "unknown":{"values":[1,2]}\n}\n`;
    await fs.writeFile(first.configPath, formatted);
    const reformatted = await snapshot();
    await install({ ...f, offline: v1.offline });
    assert.deepEqual(await snapshot(), reformatted);
    assert.equal((await doctor(f)).status, 'configured');
    const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
    const upgraded = await install({ ...f, version: v2.manifest.version, offline: v2.offline });
    const changed = await fs.readFile(first.configPath, 'utf8');
    assert.notEqual(changed, formatted);
    assert.equal(jsonEntry(changed, ['mcpServers']).command, path.join(upgraded.prefix, 'bin/fruitctl'));
    assert.match(changed, /"other": \{"command":"operator"\}/);
    assert.match(changed, /"unknown":\{"values":\[1,2\]\}/);
    assert.equal((await doctor(f)).status, 'configured');
  });
});

test('verified install, upgrade, doctor, rollback and uninstall preserve unrelated edits', async t => {
  const f = { ...await fixture(t), agent: 'vscode' }, v1 = await releaseFixture(f);
  const configPath = path.join(f.projectDir, '.mcp.json');
  const original = '{\n // keep this comment\n "mcpServers":{"other":{"command":"other"}},\n "feature":false\n}\n';
  await fs.writeFile(configPath, original);
  const installed = await install({ ...f, offline: v1.offline });
  assert.equal(installed.status, 'installed');
  assert.equal((await doctor(f)).status, 'configured');
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  let config = await fs.readFile(configPath, 'utf8');
  config = config.replace('"feature":false', '"feature":true');
  await fs.writeFile(configPath, config);
  assert.equal((await rollback(f)).to, f.version);
  assert.match(await fs.readFile(configPath, 'utf8'), /"feature":true/);
  assert.equal((await doctor(f)).status, 'configured');
  await uninstall(f);
  config = await fs.readFile(configPath, 'utf8');
  assert.match(config, /\/\/ keep this comment/);
  assert.match(config, /"feature":true/);
  assert.equal(jsonEntry(config, ['mcpServers']), undefined);
  assert.equal(JSON.parse(JSON.stringify(parseJsonc(config).value)).mcpServers.other.command, 'other');
  await assert.rejects(fs.lstat(path.join(f.projectDir, '.agents/skills/fruitctl')), { code: 'ENOENT' });
  assert.equal((await doctor(f)).status, 'not-installed');
});

test('uninstall after an upgrade restores the exact original TOML and removes owned links', async t => {
  const f = { ...await fixture(t), agent: 'codex' }, v1 = await releaseFixture(f);
  const configPath = path.join(f.projectDir, '.codex/config.toml');
  const original = '# keep\nmodel = "test"\n\n[mcp_servers.other]\ncommand = "other"\n';
  await fs.mkdir(path.dirname(configPath)); await fs.writeFile(configPath, original);
  await install({ ...f, offline: v1.offline });
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  await uninstall(f);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  await assert.rejects(fs.lstat(path.join(f.home, '.local/bin/fruitctl')), { code: 'ENOENT' });
});

test('TOML repeats, changes and removals preserve LF/CRLF table separators and foreign sections', () => {
  for (const newline of ['\n', '\r\n']) {
    const prefix = '# retain operator comment\nmodel = "test"\n\n[mcp_servers.other]\ncommand = "operator"\n\n\n'.replaceAll('\n', newline);
    const owned = '[mcp_servers.fruitctl]\ncommand = "/old"\nargs = ["mcp"]\n'.replaceAll('\n', newline);
    const suffix = '\n \t\n[unrelated]\n# retain foreign comment\nunknown = true\n'.replaceAll('\n', newline);
    const original = prefix + owned + suffix;
    assert.equal(tomlEntry(original), owned);
    assert.equal(patchTomlEntry(original, owned), original);
    assert.equal(patchTomlEntry(original, owned.trim()), original);
    const updated = owned.replace('/old', '/new');
    const changed = patchTomlEntry(original, updated);
    assert.equal(changed, prefix + updated + suffix);
    assert.equal(patchTomlEntry(changed, updated), changed);
    assert.equal(patchTomlEntry(original, undefined), prefix + suffix);
    assert.equal(patchTomlEntry(prefix + suffix, undefined), prefix + suffix);
    assert.equal(ownedFieldsMatch(owned, updated, 'codex'), false);
    assert.equal(ownedFieldsMatch(owned, owned + 'unknown = true' + newline, 'codex'), false);
    const nested = '[mcp_servers.fruitctl.env]\nKEY = "value"\n'.replaceAll('\n', newline);
    const multiple = prefix + owned + suffix + newline + nested + newline + '[last]\nvalue = 1\n'.replaceAll('\n', newline);
    assert.equal(patchTomlEntry(multiple, tomlEntry(multiple)), multiple);
    assert.equal(patchTomlEntry(multiple, undefined), multiple.replace(owned, '').replace(nested, ''));
    assert.equal(patchTomlEntry(multiple, updated), multiple.replace(owned, updated).replace(nested, ''));
  }
  assert.throws(() => patchTomlEntry('mcp_servers.fruitctl = {command="operator"}\n', 'replacement'), /manual merge/);
});

test('Codex user and project lifecycles retain exact TOML bytes on repeat and apply real upgrades', async t => {
  for (const scope of ['user', 'project']) await t.test(scope, async t => {
    const f = { ...await fixture(t), agent: 'codex', scope, version: 'v0.1.0-alpha.2' };
    const v1 = await releaseFixture(f, 'v0.1.0-alpha.2'), adapter = resolveAdapter(f);
    const original = '# retain operator comment\nmodel = "test"\n\n[mcp_servers.other]\ncommand = "operator"\n\n';
    await fs.mkdir(path.dirname(adapter.configPath), { recursive: true });
    await fs.writeFile(adapter.configPath, original);
    const first = await install({ ...f, offline: v1.offline });
    const snapshot = async (prefix = first.prefix) => ({ config: await fs.readFile(first.configPath, 'utf8'),
      launcher: await fs.readlink(first.launcherPath), skill: await fs.readlink(first.skillPath),
      nodeInode: (await fs.stat(path.join(prefix, 'bin/node'))).ino });
    const before = await snapshot();
    await install({ ...f, offline: v1.offline });
    assert.deepEqual(await snapshot(), before);
    assert.equal((await doctor(f)).status, 'configured');
    const tampered = before.config.replace(tomlEntry(before.config), tomlEntry(before.config) + 'unknown = true\n');
    await fs.writeFile(first.configPath, tampered);
    assert.equal((await doctor(f)).status, 'drift');
    await assert.rejects(uninstall(f), /MCP entry changed/);
    assert.equal(await fs.readFile(first.configPath, 'utf8'), tampered);
    await fs.writeFile(first.configPath, before.config);
    const v2 = await releaseFixture(f, 'v0.1.0-alpha.3');
    const upgraded = await install({ ...f, version: v2.manifest.version, offline: v2.offline });
    const updated = renderIntegration({ agent: 'codex', executable: path.join(upgraded.prefix, 'bin/fruitctl'), target: f.target });
    const changed = await fs.readFile(first.configPath, 'utf8');
    assert.equal(changed, before.config.replace(tomlEntry(before.config), updated));
    assert.equal((await rollback(f)).to, f.version);
    assert.equal(await fs.readFile(first.configPath, 'utf8'), before.config);
    assert.equal((await doctor(f)).status, 'configured');
    await install({ ...f, version: v2.manifest.version, offline: v2.offline });
    const afterReinstall = await snapshot(upgraded.prefix);
    await install({ ...f, version: v2.manifest.version, offline: v2.offline });
    assert.deepEqual(await snapshot(upgraded.prefix), afterReinstall);
    assert.equal((await doctor(f)).status, 'configured');
    await uninstall(f);
    assert.equal(await fs.readFile(first.configPath, 'utf8'), original);
    assert.equal((await uninstall(f)).status, 'not-installed');
  });
});

test('Junie mutable enabled state survives upgrades and rollback; no instruction override is created', async t => {
  const f = { ...await fixture(t), agent: 'junie' }, v1 = await releaseFixture(f);
  await install({ ...f, offline: v1.offline });
  const configPath = path.join(f.projectDir, '.junie/mcp/mcp.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.mcpServers.fruitctl.enabled = false;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const preview = await install({ ...f, dryRun: true });
  assert.equal(preview.status, 'planned');
  assert.equal(JSON.parse(preview.ideSettingsSnippet).mcpServers.fruitctl.enabled, false);
  assert.equal(await fs.readFile(configPath, 'utf8'), JSON.stringify(config, null, 2));
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  const result = await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  assert.ok(result.ideSettingsSnippet);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.fruitctl.enabled, false);
  await rollback(f);
  assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.fruitctl.enabled, false);
  await assert.rejects(fs.lstat(path.join(f.projectDir, '.junie/AGENTS.md')), { code: 'ENOENT' });
});

test('managed config remains untouched and returns a declarative fragment without downloading', async t => {
  const f = await fixture(t), managed = path.join(f.root, 'managed.json'), configPath = path.join(f.projectDir, '.mcp.json');
  const original = '{"mcpServers":{"other":{"command":"managed"}}}\n';
  await fs.writeFile(managed, original); await fs.symlink(managed, configPath);
  const result = await install(f, { fetchImpl: () => { throw new Error('must not download'); } });
  assert.equal(result.status, 'declarative-required');
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  assert.equal(await fs.readlink(configPath), managed);
  assert.equal((await fs.readdir(f.home)).length, 0);
});

test('unowned MCP entry and changed owned skill stop updates/removal before any config write', async t => {
  const f = await fixture(t), v1 = await releaseFixture(f), configPath = path.join(f.projectDir, '.mcp.json');
  const original = '{"mcpServers":{"fruitctl":{"command":"user-tool"}}}';
  await fs.writeFile(configPath, original);
  await assert.rejects(install({ ...f, dryRun: true }), /user-owned or changed/);
  assert.equal(await fs.readFile(configPath, 'utf8'), original);
  await fs.unlink(configPath);
  await install({ ...f, offline: v1.offline });
  const installed = await fs.readFile(configPath, 'utf8'), skill = path.join(f.projectDir, '.claude/skills/fruitctl');
  await fs.unlink(skill); await fs.symlink('/different/skill', skill);
  await assert.rejects(uninstall(f), /changed/);
  assert.equal(await fs.readFile(configPath, 'utf8'), installed);
});

test('manifest/artifact tampering and archive links fail before agent config changes', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  await fs.appendFile(release.offline.archivePath, 'tampered');
  await assert.rejects(install({ ...f, offline: release.offline }), /archive SHA-256 mismatch/);
  await assert.rejects(fs.lstat(path.join(f.projectDir, '.mcp.json')), { code: 'ENOENT' });
  const link = await releaseFixture(f, 'v0.1.0-alpha.2', { symlink: true });
  await assert.rejects(install({ ...f, version: link.manifest.version, offline: link.offline }), /regular files\/directories/);
  await assert.rejects(fs.lstat(path.join(f.projectDir, '.mcp.json')), { code: 'ENOENT' });
});

test('GitHub manifest digest is mandatory and source-only/missing releases cannot fake success', async () => {
  const request = { version: 'v0.1.0-alpha.1', platform: 'linux', arch: 'x64' };
  await assert.rejects(resolveRelease(request, { fetchImpl: async () => new Response('not found', { status: 404 }) }), /not have published qualified assets/);
  await assert.rejects(resolveRelease(request, { fetchImpl: async () => Response.json({ tag_name: request.version, assets: [] }) }), /source-only tags/);
  await assert.rejects(resolveRelease(request, { fetchImpl: async () => Response.json({ tag_name: request.version, assets: [{ name: 'fruitctl-release.json', digest: null }] }) }), /did not provide/);
});

test('shared config/skill ownership transfers so one harness uninstall keeps another working', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  await install({ ...f, agent: 'pi', offline: release.offline });
  await install({ ...f, agent: 'kimi', offline: release.offline });
  await uninstall({ ...f, agent: 'pi' });
  assert.equal((await doctor({ ...f, agent: 'kimi' })).status, 'configured');
  await uninstall({ ...f, agent: 'kimi' });
  await assert.rejects(fs.lstat(path.join(f.projectDir, '.agents/skills/fruitctl')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(f.home, '.local/bin/fruitctl')), { code: 'ENOENT' });
});

test('existing OpenCode JSONC and user config overrides resolve without opening applications', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.projectDir, 'opencode.jsonc'), '{}');
  assert.equal(resolveAdapter({ ...f, agent: 'opencode' }).configPath, path.join(f.projectDir, 'opencode.jsonc'));
  assert.equal(resolveAdapter({ ...f, agent: 'kimi', scope: 'user', env: { KIMI_CODE_HOME: path.join(f.root, 'kimi-state') } }).configPath, path.join(f.root, 'kimi-state/mcp.json'));
});

test('VS Code Copilot home selects only the user portable config and keeps values literal', async t => {
  const f = { ...await fixture(t), agent: 'vscode' };
  const copilotHome = path.join(f.root, 'copilot account with spaces');
  const env = { COPILOT_HOME: copilotHome };
  const user = resolveAdapter({ ...f, scope: 'user', env });
  assert.equal(user.configPath, path.join(copilotHome, 'mcp-config.json'));
  assert.equal(user.skillPath, path.join(f.home, '.agents/skills/fruitctl'));
  assert.equal(resolveAdapter({ ...f, scope: 'user' }).configPath, path.join(f.home, '.copilot/mcp-config.json'));
  assert.equal(resolveAdapter({ ...f, env }).configPath, path.join(f.projectDir, '.mcp.json'));
  const literalHome = path.join(f.root, '${ACCOUNT_DIR}', '~');
  assert.equal(resolveAdapter({ ...f, scope: 'user', env: { COPILOT_HOME: literalHome, ACCOUNT_DIR: 'never-expand' } }).configPath, path.join(literalHome, 'mcp-config.json'));
  const planned = await install({ ...f, scope: 'user', env, dryRun: true });
  assert.equal(planned.configPath, user.configPath);
  assert.equal(JSON.parse(planned.snippet).mcpServers.fruitctl.env, undefined);
  assert.deepEqual(await fs.readdir(f.home), []);
});

test('custom Copilot install, doctor, rollback and idempotent uninstall preserve both user and project settings', async t => {
  const f = { ...await fixture(t), agent: 'vscode', scope: 'user' };
  const copilotHome = path.join(f.root, 'copilot account with spaces'), env = { COPILOT_HOME: copilotHome };
  const config = path.join(copilotHome, 'mcp-config.json'), defaultConfig = path.join(f.home, '.copilot/mcp-config.json');
  const settings = path.join(copilotHome, 'config.json'), projectConfig = path.join(f.projectDir, '.mcp.json');
  const original = '{\n // retain account comment\n "mcpServers":{"other":{"command":"other"}},\n "feature":false,\n}\n';
  const defaultOriginal = '{"mcpServers":{"fruitctl":{"command":"user-owned-default"}}}\n';
  const settingsOriginal = '{"fixtureSetting":"retain"}\n', projectOriginal = '{"fixtureProject":"retain"}\n';
  await fs.mkdir(copilotHome); await fs.mkdir(path.dirname(defaultConfig));
  await fs.writeFile(config, original, { mode: 0o640 });
  await fs.writeFile(defaultConfig, defaultOriginal); await fs.writeFile(settings, settingsOriginal);
  await fs.writeFile(projectConfig, projectOriginal);
  const v1 = await releaseFixture(f), first = await install({ ...f, env, offline: v1.offline });
  assert.equal(first.configPath, config);
  const receipt = JSON.parse(await fs.readFile(first.receiptPath, 'utf8'));
  assert.equal(receipt.config.path, config); assert.equal(receipt.config.owned, true);
  assert.equal(receipt.config.baseExisted, true); assert.equal(receipt.skill.owned, true);
  assert.equal(receipt.config.expectedEntry.env, undefined);
  assert.equal((await fs.stat(config)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(first.receiptPath)).mode & 0o777, 0o600);
  const project = { ...f, scope: 'project', env };
  await install({ ...project, offline: v1.offline });
  assert.equal((await doctor({ home: f.home, platform: f.platform, arch: f.arch, env: {} })).status, 'configured');
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, env, version: v2.manifest.version, offline: v2.offline });
  assert.equal((await rollback({ ...f, env: {} })).to, f.version);
  assert.equal((await doctor({ ...f, env: {} })).status, 'configured');
  assert.equal((await uninstall({ ...f, env: {} })).status, 'removed');
  assert.equal(await fs.readFile(config, 'utf8'), original);
  assert.equal((await uninstall({ ...f, env })).status, 'not-installed');
  assert.equal((await doctor(project)).status, 'configured');
  await uninstall(project);
  assert.equal(await fs.readFile(projectConfig, 'utf8'), projectOriginal);
  assert.equal(await fs.readFile(defaultConfig, 'utf8'), defaultOriginal);
  assert.equal(await fs.readFile(settings, 'utf8'), settingsOriginal);
  assert.equal((await doctor({ home: f.home, platform: f.platform, arch: f.arch, env })).status, 'not-installed');
});

test('changed install destinations cannot detach receipts and backups from their owned files', async t => {
  for (const agent of ['vscode', 'codex']) await t.test(agent, async t => {
    const f = { ...await fixture(t), agent, scope: 'user' }, release = await releaseFixture(f);
    const installed = await install({ ...f, offline: release.offline });
    const configBefore = await fs.readFile(installed.configPath, 'utf8');
    const receiptBefore = await fs.readFile(installed.receiptPath, 'utf8');
    const env = { [agent === 'vscode' ? 'COPILOT_HOME' : 'CODEX_HOME']: path.join(f.root, 'other account') };
    const result = await install({ ...f, env }, { fetchImpl: () => { throw new Error('must not download'); } });
    assert.equal(result.status, 'declarative-required');
    assert.match(result.reasons.join(' '), /different MCP or skill destination/);
    assert.equal(await fs.readFile(installed.configPath, 'utf8'), configBefore);
    assert.equal(await fs.readFile(installed.receiptPath, 'utf8'), receiptBefore);
    await assert.rejects(fs.lstat(result.configPath), { code: 'ENOENT' });
    assert.equal((await doctor({ ...f, env })).status, 'configured');
    assert.equal((await uninstall({ ...f, env })).status, 'removed');
    assert.equal((await uninstall({ ...f, env })).status, 'not-installed');
    await assert.rejects(fs.lstat(installed.configPath), { code: 'ENOENT' });
  });
});

test('same-agent project path aliases cannot create duplicate receipts or detach recovery', async t => {
  for (const initial of ['physical', 'alias']) await t.test(initial, async t => {
    const f = { ...await fixture(t), agent: 'junie' }, release = await releaseFixture(f);
    const physical = await fs.realpath(f.projectDir), alias = path.join(f.root, 'project alias with spaces');
    await fs.symlink(physical, alias, 'dir');
    const recorded = { ...f, projectDir: initial === 'physical' ? physical : alias };
    const alternate = { ...f, projectDir: initial === 'physical' ? alias : physical };
    const configPath = resolveAdapter(recorded).configPath;
    const original = '{\n "mcpServers":{"other":{"command":"operator"}},\n "keep":"original"\n}\n';
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, original, { mode: 0o640 });
    const first = await install({ ...recorded, offline: release.offline });
    const snapshot = async directory => {
      const entries = [];
      const visit = async (file, relative) => {
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) entries.push([relative, 'link', await fs.readlink(file)]);
        else if (stat.isDirectory()) {
          entries.push([relative, 'directory', stat.mode & 0o777]);
          for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
        } else entries.push([relative, 'file', stat.mode & 0o777, (await fs.readFile(file)).toString('base64')]);
      };
      await visit(directory, '.');
      return entries;
    };
    const before = { home: await snapshot(f.home), project: await snapshot(physical) };
    const rejectedPath = error => {
      assert.match(error.message, /recorded project path/i);
      assert.ok(error.message.includes(recorded.projectDir), 'the error must name the existing recorded path');
      return true;
    };
    await assert.rejects(install({ ...alternate, offline: release.offline }), rejectedPath);
    let downloads = 0;
    const noDownload = { fetchImpl: () => { downloads++; throw new Error('must not download through an alias'); } };
    await assert.rejects(install(alternate, noDownload), rejectedPath);
    await assert.rejects(install({ ...alternate, dryRun: true }, noDownload), rejectedPath);
    for (const operation of [doctor, rollback, uninstall]) await assert.rejects(operation(alternate), rejectedPath);
    assert.equal(downloads, 0);
    assert.deepEqual({ home: await snapshot(f.home), project: await snapshot(physical) }, before);
    assert.deepEqual(await fs.readdir(path.dirname(first.receiptPath)), [path.basename(first.receiptPath)]);
    assert.equal((await doctor(recorded)).status, 'configured');
    assert.equal((await uninstall(recorded)).status, 'removed');
    assert.equal(await fs.readFile(configPath, 'utf8'), original);
    assert.equal((await fs.stat(configPath)).mode & 0o777, 0o640);
    assert.equal((await doctor(alternate)).status, 'not-installed');
    assert.equal((await uninstall(recorded)).status, 'not-installed');
  });
});

test('project path alias guard preserves missing-project and different-agent behavior', async t => {
  const f = { ...await fixture(t), agent: 'junie' }, release = await releaseFixture(f);
  const missing = { ...f, projectDir: path.join(f.root, 'nonexistent project') };
  assert.equal((await install({ ...missing, dryRun: true })).status, 'planned');
  assert.equal((await doctor(missing)).status, 'not-installed');
  assert.equal((await uninstall(missing)).status, 'not-installed');
  assert.equal((await rollback(missing)).status, 'no-previous-install');
  await assert.rejects(fs.lstat(missing.projectDir), { code: 'ENOENT' });
  const first = await install({ ...f, offline: release.offline });
  const alias = path.join(f.root, 'different agent project alias');
  await fs.symlink(await fs.realpath(f.projectDir), alias, 'dir');
  const other = { ...f, agent: 'pi', projectDir: alias };
  assert.equal((await install({ ...other, offline: release.offline })).status, 'installed');
  assert.equal((await doctor(f)).status, 'configured');
  assert.equal((await doctor(other)).status, 'configured');
  await uninstall(other);
  assert.equal((await doctor(f)).status, 'configured');
  assert.ok(await fs.lstat(first.launcherPath));
  await uninstall(f);
});

test('managed and unowned custom Copilot configurations retain their owning surface', async t => {
  const f = { ...await fixture(t), agent: 'vscode', scope: 'user' };
  const copilotHome = path.join(f.root, 'copilot custom'), config = path.join(copilotHome, 'mcp-config.json');
  const managed = path.join(f.root, 'managed-copilot.json'), original = '{"mcpServers":{"fruitctl":{"command":"operator-tool"}}}\n';
  await fs.mkdir(copilotHome); await fs.writeFile(managed, original); await fs.symlink(managed, config);
  const options = { ...f, env: { COPILOT_HOME: copilotHome } };
  assert.equal((await install(options)).status, 'declarative-required');
  assert.equal(await fs.readlink(config), managed);
  await fs.unlink(config); await fs.writeFile(config, original);
  await assert.rejects(install({ ...options, dryRun: true }), /user-owned or changed/);
  assert.equal(await fs.readFile(config, 'utf8'), original);
  assert.deepEqual(await fs.readdir(f.home), []);
});

test('bootstrap dry run requires no Node install and rejects invalid versions without network', async t => {
  const f = await fixture(t), script = new URL('../scripts/install.sh', import.meta.url);
  const result = await run('sh', [script.pathname, '--agent', 'claude', '--version', f.version, '--target', f.target, '--dry-run'], { cwd: f.projectDir, env: { ...process.env, HOME: f.home } });
  assert.match(result.stdout, /No release download/);
  await assert.rejects(run('sh', [script.pathname, '--agent', 'claude', '--version', 'latest', '--target', f.target, '--dry-run']), /exact release tag/);
});

test('doctor reports runtime tampering instead of qualifying a modified installation', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const result = await install({ ...f, offline: release.offline });
  await fs.appendFile(path.join(result.prefix, 'bin/fruitctl.mjs'), '// altered');
  assert.equal((await doctor(f)).status, 'drift');
  await assert.rejects(install({ ...f, offline: release.offline }), /Cached runtime file changed/);
});

test('embedded native executables preserve their modes and nonexecutable archives stop before config changes', async t => {
  const executables = ['bin/claude-kvm-daemon', 'libexec/FruitctlHost.app/Contents/MacOS/FruitctlHost'];
  for (const relative of executables) await t.test(relative, async t => {
    const f = { ...await fixture(t), platform: 'darwin', arch: 'arm64' };
    const config = path.join(f.projectDir, '.mcp.json'), original = '{"fixture":"retained"}\n';
    await fs.writeFile(config, original);
    for (const mode of [0o644, 0o641]) {
      // Root can execute a file with any execute bit; 0641 is inaccessible to its ordinary owner.
      if (mode === 0o641 && process.getuid?.() === 0) continue;
      const version = mode === 0o644 ? f.version : 'v0.1.0-alpha.3';
      const bad = await releaseFixture(f, version, { nativeExecutables: { [relative]: mode } });
      await assert.rejects(install({ ...f, version, offline: bad.offline }), /Runtime bundle has nonexecutable/, `${relative} mode ${mode.toString(8)} must be executable by the installing user`);
      assert.equal(await fs.readFile(config, 'utf8'), original);
    }
    const good = await releaseFixture(f, 'v0.1.0-alpha.2', { nativeExecutables: { [relative]: 0o755 } });
    const installed = await install({ ...f, version: good.manifest.version, offline: good.offline });
    const receipt = JSON.parse(await fs.readFile(installed.receiptPath, 'utf8'));
    assert.equal(receipt.runtime.modes[relative], 0o755);
    assert.equal((await fs.lstat(path.join(installed.prefix, relative))).mode & 0o777, 0o755);
    assert.equal(await fs.readFile(path.join(installed.prefix, relative), 'utf8'), `${relative} fixture for ${good.manifest.version}\n`);
    assert.equal((await doctor(f)).status, 'configured');
  });
});

test('permission drift is reported by doctor and prevents cache reuse without changing configuration', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const installed = await install({ ...f, offline: release.offline });
  const receipt = JSON.parse(await fs.readFile(installed.receiptPath, 'utf8'));
  assert.deepEqual(Object.keys(receipt.runtime.modes).sort(), Object.keys(receipt.runtime.files).sort());
  assert.equal(receipt.runtime.modes['bin/node'], 0o755);
  const config = path.join(f.projectDir, '.mcp.json'), original = await fs.readFile(config, 'utf8');
  await fs.chmod(path.join(installed.prefix, 'bin/node'), 0o644);
  const inspected = await doctor(f);
  assert.equal(inspected.status, 'drift');
  assert.equal(inspected.checks.find(check => check.name === 'bin/node').ok, false);
  await assert.rejects(install({ ...f, offline: release.offline }), /Cached runtime file changed: bin\/node/);
  assert.equal(await fs.readFile(config, 'utf8'), original);
  await fs.chmod(path.join(installed.prefix, 'bin/node'), 0o755);
  assert.equal((await doctor(f)).status, 'configured');
});

test('cache reuse rejects a file replaced by a symlink even when its content is identical', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const installed = await install({ ...f, offline: release.offline });
  const native = path.join(installed.prefix, 'bin/node'), copied = path.join(f.root, 'identical-node');
  await fs.rename(native, copied); await fs.symlink(copied, native);
  assert.equal((await doctor(f)).checks.find(check => check.name === 'bin/node').ok, false);
  await assert.rejects(install({ ...f, offline: release.offline }), /Cached runtime file changed: bin\/node/);
});

test('mode inventories must match every file while legacy hash-only receipts remain usable', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const installed = await install({ ...f, offline: release.offline });
  const receipt = JSON.parse(await fs.readFile(installed.receiptPath, 'utf8'));
  const invalid = [null, [], { ...receipt.runtime.modes, extra: 0o600 },
    { ...receipt.runtime.modes, 'bin/node': 0o1000 }, { ...receipt.runtime.modes, 'bin/node': -1 },
    { ...receipt.runtime.modes, 'bin/node': 1.5 }, { ...receipt.runtime.modes, 'bin/node': '0755' }];
  const missing = { ...receipt.runtime.modes }; delete missing['bin/node']; invalid.push(missing);
  for (const modes of invalid) {
    await fs.writeFile(installed.receiptPath, JSON.stringify({ ...receipt, runtime: { ...receipt.runtime, modes } }));
    await assert.rejects(doctor(f), /Invalid runtime mode inventory/);
  }
  delete receipt.runtime.modes;
  await fs.writeFile(installed.receiptPath, JSON.stringify(receipt));
  assert.equal((await doctor(f)).status, 'configured');
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  assert.equal((await rollback(f)).to, f.version);
  assert.equal((await doctor(f)).status, 'configured');
  assert.equal((await uninstall(f)).status, 'removed');
});

test('rollback refuses a prior runtime with altered permissions before changing the current configuration', async t => {
  const f = await fixture(t), v1 = await releaseFixture(f);
  const first = await install({ ...f, offline: v1.offline });
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  const config = path.join(f.projectDir, '.mcp.json'), original = await fs.readFile(config, 'utf8');
  await fs.chmod(path.join(first.prefix, 'bin/fruitctl'), 0o644);
  await assert.rejects(rollback(f), /Previous runtime file is missing or changed: bin\/fruitctl/);
  assert.equal(await fs.readFile(config, 'utf8'), original);
  assert.equal((await doctor(f)).version, v2.manifest.version);
});

test('aggregate doctor audits receipts and rejects missing/unknown agent identities without recursion', async t => {
  const f = await fixture(t);
  const aggregateContext = { home: f.home, platform: f.platform, arch: f.arch, env: {} };
  assert.equal((await doctor(aggregateContext)).status, 'not-installed');
  const release = await releaseFixture(f), result = await install({ ...f, offline: release.offline });
  const aggregate = await doctor(aggregateContext);
  assert.equal(aggregate.status, 'configured');
  assert.equal(aggregate.installations.length, 1);
  assert.match(aggregate.qualification, /runtime and target behavior unverified/);
  await assert.rejects(doctor({ ...aggregateContext, platform: 'darwin', arch: 'arm64' }), /runtime identity mismatch/);
  const receipt = JSON.parse(await fs.readFile(result.receiptPath, 'utf8'));
  delete receipt.agent;
  await fs.writeFile(result.receiptPath, JSON.stringify(receipt));
  await assert.rejects(doctor(aggregateContext), /Invalid install receipt/);
  receipt.agent = 'constructor';
  await fs.writeFile(result.receiptPath, JSON.stringify(receipt));
  await assert.rejects(doctor(aggregateContext), /Invalid install receipt/);
});

test('strict JSON and ambiguous TOML declarations are rejected before any write', async t => {
  const f = await fixture(t), claude = path.join(f.projectDir, '.mcp.json');
  await fs.writeFile(claude, '{ // not valid Claude JSON\n "mcpServers":{} }');
  await assert.rejects(install({ ...f, dryRun: true }), SyntaxError);
  const codex = path.join(f.projectDir, '.codex/config.toml');
  await fs.mkdir(path.dirname(codex));
  const original = '[mcp_servers]\nfruitctl = { command = "manual" }\n';
  await fs.writeFile(codex, original);
  await assert.rejects(install({ ...f, agent: 'codex', dryRun: true }), /declarative\/manual merge/);
  assert.equal(await fs.readFile(codex, 'utf8'), original);
});

test('pre-upgrade unrelated edits survive final uninstall', async t => {
  const f = { ...await fixture(t), agent: 'vscode' }, v1 = await releaseFixture(f), configPath = path.join(f.projectDir, '.mcp.json');
  await fs.writeFile(configPath, '{"feature":false}');
  await install({ ...f, offline: v1.offline });
  await fs.writeFile(configPath, (await fs.readFile(configPath, 'utf8')).replace('"feature":false', '"feature":true'));
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  await uninstall(f);
  assert.equal(parseJsonc(await fs.readFile(configPath, 'utf8')).value.feature, true);
});

test('shared Claude/VS Code portable entry is removed only after its final owner', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  await install({ ...f, offline: release.offline });
  await install({ ...f, agent: 'vscode', offline: release.offline });
  await uninstall(f);
  assert.equal((await doctor({ ...f, agent: 'vscode' })).status, 'configured');
  await uninstall({ ...f, agent: 'vscode' });
  await assert.rejects(fs.lstat(path.join(f.projectDir, '.mcp.json')), { code: 'ENOENT' });
});

test('GitHub digest, manifest identity and artifact checksum form a verified download path', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const manifestBytes = await fs.readFile(release.offline.manifestPath);
  const metadata = { tag_name: f.version, assets: [{ name: 'fruitctl-release.json', digest: `sha256:${sha256(manifestBytes)}`, browser_download_url: `https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/fruitctl-release.json` }] };
  const fetchImpl = async url => url.startsWith('https://api.github.com/') ? Response.json(metadata) : url.endsWith('/fruitctl-release.json') ? new Response(manifestBytes) : new Response(await fs.readFile(release.offline.archivePath));
  assert.equal((await resolveRelease(f, { fetchImpl })).asset.sha256, release.manifest.assets[0].sha256);
  metadata.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(resolveRelease(f, { fetchImpl }), /manifest SHA-256 mismatch/);
});

test('legacy VS Code ownership and custom Claude account destinations return declarative fragments', async t => {
  const f = await fixture(t), legacy = path.join(f.projectDir, '.vscode/mcp.json');
  await fs.mkdir(path.dirname(legacy)); await fs.writeFile(legacy, '{"servers":{"fruitctl":{"command":"legacy"}}}');
  assert.equal((await install({ ...f, agent: 'vscode', dryRun: true })).status, 'declarative-required');
  assert.equal((await install({ ...f, scope: 'user', env: { CLAUDE_CONFIG_DIR: path.join(f.root, 'claude-work') } })).status, 'declarative-required');
  assert.equal(resolveAdapter({ ...f, agent: 'codex', scope: 'user', env: { CODEX_HOME: path.join(f.root, 'codex-state') } }).configPath, path.join(f.root, 'codex-state/config.toml'));
  assert.equal(resolveAdapter({ ...f, agent: 'pi', scope: 'user', env: { PI_CODING_AGENT_DIR: path.join(f.root, 'pi-state') } }).configPath, path.join(f.root, 'pi-state/mcp.json'));
});

test('bootstrap rejects a checksum mismatch before extracting or running the runtime', async t => {
  const f = await fixture(t), fakeBin = path.join(f.root, 'fake-bin'); await fs.mkdir(fakeBin);
  const asset = `fruitctl-${f.version}-${process.platform}-${process.arch}.tar.gz`;
  await fs.writeFile(path.join(fakeBin, 'curl'), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; *) url=$1; shift;; esac; done\ncase "$url" in */SHA256SUMS) printf '%s  %s\\n' '${'0'.repeat(64)}' '${asset}' > "$out";; *) printf 'tampered' > "$out";; esac\n`, { mode: 0o755 });
  const temp = path.join(f.root, 'bootstrap-temp'); await fs.mkdir(temp);
  await assert.rejects(run('sh', [new URL('../scripts/install.sh', import.meta.url).pathname, '--agent', 'claude', '--version', f.version, '--target', f.target], { cwd: f.projectDir, env: { ...process.env, HOME: f.home, TMPDIR: temp, PATH: `${fakeBin}:${process.env.PATH}` } }), /archive SHA-256 mismatch/);
  assert.deepEqual(await fs.readdir(temp), []);
  assert.deepEqual(await fs.readdir(f.home), []);
});

async function bootstrapFixture(t) {
  const f = { ...await fixture(t), platform: process.platform, arch: process.arch };
  const release = await releaseFixture(f), bundle = path.join(f.root, f.version, 'bundle');
  await fs.cp(new URL('../lib/', import.meta.url), path.join(bundle, 'lib'), { recursive: true });
  await fs.copyFile(new URL('../bin/fruitctl', import.meta.url), path.join(bundle, 'bin/fruitctl'));
  await fs.copyFile(new URL('../bin/fruitctl.mjs', import.meta.url), path.join(bundle, 'bin/fruitctl.mjs'));
  await fs.copyFile(new URL('../integrations/agents.json', import.meta.url), path.join(bundle, 'integrations/agents.json'));
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({ version: f.version }));
  const mock = path.join(f.root, 'mock-github.mjs');
  await fs.writeFile(mock, `import fs from 'node:fs/promises';\nimport { createHash } from 'node:crypto';\nconst bytes=await fs.readFile(${JSON.stringify(release.offline.manifestPath)});\nconst digest=createHash('sha256').update(bytes).digest('hex');\nglobalThis.fetch=async url => {\n if(url.startsWith('https://api.github.com/')) return Response.json({tag_name:${JSON.stringify(f.version)},assets:[{name:'fruitctl-release.json',digest:'sha256:'+digest,browser_download_url:${JSON.stringify(`https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/fruitctl-release.json`)}}]});\n if(url.endsWith('/fruitctl-release.json')) return new Response(bytes);\n throw new Error('Unexpected network request '+url);\n};\n`);
  const quote = text => `'${text.replace(/'/g, "'\\''")}'`;
  await fs.writeFile(path.join(bundle, 'bin/node'), `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(mock)} "$@"\n`, { mode: 0o755 });
  await run('tar', ['-czf', release.offline.archivePath, '-C', bundle, '.']);
  release.manifest.assets[0].sha256 = sha256(await fs.readFile(release.offline.archivePath));
  await fs.writeFile(release.offline.manifestPath, JSON.stringify(release.manifest));
  const sums = path.join(f.root, 'SHA256SUMS');
  await fs.writeFile(sums, `${release.manifest.assets[0].sha256}  ${release.manifest.assets[0].name}\n`);
  const fakeBin = path.join(f.root, 'fake-bin'); await fs.mkdir(fakeBin);
  await fs.writeFile(path.join(fakeBin, 'curl'), `#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in -o) out=$2; shift 2;; *) url=$1; shift;; esac; done\ncase "$url" in */SHA256SUMS) cp ${quote(sums)} "$out";; *) cp ${quote(release.offline.archivePath)} "$out";; esac\n`, { mode: 0o755 });
  const temp = path.join(f.root, 'bootstrap-temp'); await fs.mkdir(temp);
  // Harness-specific env is intentionally empty: this fixture owns a fresh home.
  const env = { PATH: `${fakeBin}:${process.env.PATH}`, HOME: f.home, TMPDIR: temp };
  return { f, release, sums, fakeBin, temp, env };
}

test('shell bootstrap installs a verified fixture end to end without a preinstalled product or agent launch', async t => {
  const { f, temp, env } = await bootstrapFixture(t);
  const result = await run('sh', [new URL('../scripts/install.sh', import.meta.url).pathname, '--agent', 'claude', '--scope', 'project', '--version', f.version, '--target', f.target], { cwd: f.projectDir, env });
  assert.equal(JSON.parse(result.stdout).status, 'installed');
  assert.equal((await doctor(f)).status, 'configured');
  assert.deepEqual(await fs.readdir(temp), []);
  assert.match(JSON.parse(result.stdout).qualification, /acceptance has not been run/);
  const launcher = path.join(f.home, '.local/bin/fruitctl');
  const help = await run(launcher, ['--help'], { cwd: f.projectDir, env });
  assert.match(help.stdout, /Commands: mcp, broker, relay/);
  const inspected = await run(launcher, ['doctor', '--agent', 'claude', '--scope', 'project'], { cwd: f.projectDir, env });
  assert.equal(JSON.parse(inspected.stdout).status, 'configured');
});

test('shell bootstrap ignores curlrc-added transfers and retains bounded download arguments', async t => {
  let curl;
  try {
    curl = (await run('sh', ['-c', 'command -v curl'], { env: { PATH: process.env.PATH } })).stdout.trim();
  } catch (error) {
    if (error.code === 1 || error.code === 127) return t.skip('Real curl is unavailable; parser poisoning coverage requires the bootstrap utility');
    throw error;
  }
  const { f, release, sums, fakeBin, temp, env } = await bootstrapFixture(t);
  curl = await fs.realpath(curl);
  env.CURL_HOME = f.home;
  const version = await run(curl, ['--disable', '--version'], { env, timeout: 5000 });
  assert.match(version.stdout, /^curl /);
  t.diagnostic(`Offline parser coverage: ${version.stdout.split('\n')[0]}`);

  const foreign = path.join(f.home, 'operator-owned.txt'), foreignBytes = 'retain operator home bytes\n';
  const project = path.join(f.projectDir, 'operator-owned.txt');
  const poison = path.join(f.root, 'curlrc-transfer.txt'), poisonBytes = 'injected curlrc transfer\n';
  await fs.writeFile(foreign, foreignBytes, { mode: 0o640 });
  await fs.writeFile(project, 'retain operator project bytes\n', { mode: 0o600 });
  await fs.writeFile(poison, poisonBytes);
  const curlrc = path.join(f.home, '.curlrc');
  await fs.writeFile(curlrc, `url = ${JSON.stringify(pathToFileURL(poison).href)}\noutput = ${JSON.stringify(foreign)}\nconnect-timeout = 0\nmax-time = 0\n`, { mode: 0o600 });

  // Real curl reads this config before parsing later options. Both controls
  // transfer local files only and prove that a late --disable is insufficient.
  for (const flags of [[], ['--disable']]) {
    const output = path.join(f.root, `curlrc-control-${flags.length}.sums`);
    await run(curl, ['--silent', ...flags, '--show-error', '--proto', '=file', pathToFileURL(sums).href, '-o', output], { env, timeout: 5000 });
    assert.equal(await fs.readFile(foreign, 'utf8'), poisonBytes);
    assert.deepEqual(await fs.readFile(output), await fs.readFile(sums));
    await fs.writeFile(foreign, foreignBytes);
  }
  const retained = await Promise.all([foreign, project, curlrc, poison, sums, release.offline.archivePath, release.offline.manifestPath].map(async file =>
    ({ file, bytes: await fs.readFile(file), mode: (await fs.stat(file)).mode & 0o777 })));
  const calls = path.join(f.root, 'curl-calls.jsonl');
  // Keep the bootstrap argv intact for the real option/config parser, replacing
  // its two known release URLs with fixture files. The final protocol options
  // allow file only, so this regression cannot contact a release or provider.
  const assets = { [`https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/SHA256SUMS`]: pathToFileURL(sums).href,
    [release.manifest.assets[0].url]: pathToFileURL(release.offline.archivePath).href };
  await fs.writeFile(path.join(fakeBin, 'curl'), `#!${process.execPath}\nimport fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst args=process.argv.slice(2), assets=${JSON.stringify(assets)};\nconst urls=args.filter(arg => arg.startsWith('https:'));\nif(urls.length!==1 || !Object.hasOwn(assets,urls[0])) throw new Error('Unexpected fixture download');\nfs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');\nconst result=spawnSync(${JSON.stringify(curl)},[...args.map(arg => assets[arg] ?? arg),'--proto','=file','--proto-redir','=file'],{env:process.env,stdio:'inherit'});\nif(result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 });

  const result = await run('sh', [new URL('../scripts/install.sh', import.meta.url).pathname, '--agent', 'claude', '--scope', 'project', '--version', f.version, '--target', f.target], { cwd: f.projectDir, env, timeout: 15000 });
  assert.equal(JSON.parse(result.stdout).status, 'installed');
  assert.equal((await doctor(f)).status, 'configured');
  assert.deepEqual(await fs.readdir(temp), []);
  const downloads = (await fs.readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(downloads.length, 2);
  for (const args of downloads) {
    assert.equal(args[args.indexOf('--connect-timeout') + 1], '15', 'each transfer retains its connection budget');
    assert.equal(args[args.indexOf('--max-time') + 1], '120', 'each transfer retains its total budget');
    assert.equal(args[args.indexOf('--proto') + 1], '=https');
    assert.equal(args[args.indexOf('--proto-redir') + 1], '=https');
  }
  for (const { file, bytes, mode } of retained) {
    assert.deepEqual(await fs.readFile(file), bytes, `bootstrap retained ${path.basename(file)} bytes`);
    assert.equal((await fs.stat(file)).mode & 0o777, mode);
  }
});

test('rollback rejects a damaged prior runtime before changing the current configuration', async t => {
  const f = await fixture(t), v1 = await releaseFixture(f);
  const first = await install({ ...f, offline: v1.offline });
  const v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, version: v2.manifest.version, offline: v2.offline });
  const configPath = path.join(f.projectDir, '.mcp.json'), config = await fs.readFile(configPath, 'utf8');
  await fs.unlink(path.join(first.prefix, 'bin/node'));
  await assert.rejects(rollback(f), /Previous runtime file is missing or changed/);
  assert.equal(await fs.readFile(configPath, 'utf8'), config);
  assert.equal((await doctor(f)).version, v2.manifest.version);
});

test('different harness versions share the convenience launcher without losing pinned config or final removal', async t => {
  const f = await fixture(t), v1 = await releaseFixture(f), v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, offline: v1.offline });
  await install({ ...f, agent: 'junie', version: v2.manifest.version, offline: v2.offline });
  assert.equal((await doctor(f)).status, 'configured');
  await uninstall({ ...f, agent: 'junie' });
  assert.equal((await doctor(f)).status, 'configured');
  assert.equal((await doctor(f)).version, f.version);
  await uninstall(f);
  await assert.rejects(fs.lstat(path.join(f.home, '.local/bin/fruitctl')), { code: 'ENOENT' });
});

test('shared portable config cannot silently switch another harness to a different release', async t => {
  const f = await fixture(t), v1 = await releaseFixture(f), v2 = await releaseFixture(f, 'v0.1.0-alpha.2');
  await install({ ...f, offline: v1.offline });
  await install({ ...f, agent: 'vscode', offline: v1.offline });
  const configPath = path.join(f.projectDir, '.mcp.json'), before = await fs.readFile(configPath, 'utf8');
  const result = await install({ ...f, version: v2.manifest.version, dryRun: true });
  assert.equal(result.status, 'declarative-required');
  assert.match(result.reasons.join(' '), /Another harness shares/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

test('uninstall restores earlier mutations if an owned link cannot be removed', async t => {
  if (process.getuid?.() === 0) return t.skip('Permission-failure fixture requires an unprivileged user');
  const f = await fixture(t), release = await releaseFixture(f);
  const result = await install({ ...f, offline: release.offline });
  const configPath = path.join(f.projectDir, '.mcp.json'), before = await fs.readFile(configPath, 'utf8'), parent = path.join(f.projectDir, '.claude/skills');
  await fs.chmod(parent, 0o500);
  try { await assert.rejects(uninstall(f), /EACCES/); }
  finally { await fs.chmod(parent, 0o700); }
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
  assert.ok(await fs.stat(result.receiptPath));
  assert.equal((await doctor(f)).status, 'configured');
});

test('receipt path tampering cannot redirect recovery to an outside backup', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const configPath = path.join(f.projectDir, '.mcp.json'); await fs.writeFile(configPath, '{}');
  const result = await install({ ...f, offline: release.offline }), before = await fs.readFile(configPath, 'utf8');
  const receipt = JSON.parse(await fs.readFile(result.receiptPath, 'utf8'));
  receipt.config.baseBackupPath = path.join(f.root, 'outside-backup');
  await fs.writeFile(result.receiptPath, JSON.stringify(receipt));
  await assert.rejects(uninstall(f), /Invalid install receipt configuration/);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
});

test('runtime integrity includes broker and dependency files beyond the required bootstrap files', async t => {
  const f = await fixture(t), release = await releaseFixture(f), result = await install({ ...f, offline: release.offline });
  await fs.appendFile(path.join(result.prefix, 'lib/broker/runtime-marker.mjs'), 'altered');
  const status = await doctor(f);
  assert.equal(status.status, 'drift');
  assert.equal(status.checks.find(check => check.name === 'lib/broker/runtime-marker.mjs').ok, false);
  await assert.rejects(install({ ...f, offline: release.offline }), /Cached runtime file changed/);
});

test('duplicate archive paths and a runtime name outside the bootstrap contract are rejected', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  await run('python3', ['-c', 'import io,sys,tarfile\nwith tarfile.open(sys.argv[1],"w:gz") as t:\n for name in ["bin/node","./bin/node"]:\n  i=tarfile.TarInfo(name); i.size=3; i.mode=0o755; t.addfile(i,io.BytesIO(b"abc"))', release.offline.archivePath]);
  release.manifest.assets[0].sha256 = sha256(await fs.readFile(release.offline.archivePath));
  await fs.writeFile(release.offline.manifestPath, JSON.stringify(release.manifest));
  release.offline.manifestSha256 = sha256(await fs.readFile(release.offline.manifestPath));
  await assert.rejects(install({ ...f, offline: release.offline }), /Duplicate runtime archive path/);
  release.manifest.assets[0].name = 'another-runtime.tar.gz';
  release.manifest.assets[0].url = `https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/another-runtime.tar.gz`;
  await fs.writeFile(release.offline.manifestPath, JSON.stringify(release.manifest));
  release.offline.manifestSha256 = sha256(await fs.readFile(release.offline.manifestPath));
  await assert.rejects(install({ ...f, offline: release.offline }), /Invalid pinned runtime asset name/);
});

test('a config becoming managed during download stays linked even when its contents are unchanged', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const config = path.join(f.projectDir, '.mcp.json'), managed = path.join(f.root, 'managed-during-download.json');
  const original = '{"mcpServers":{"other":{"command":"retain"}}}';
  await fs.writeFile(config, original);
  const manifestBytes = await fs.readFile(release.offline.manifestPath);
  const manifestUrl = `https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/fruitctl-release.json`;
  const fetchImpl = async url => {
    if (url.startsWith('https://api.github.com/')) return Response.json({ tag_name: f.version, assets: [{ name: 'fruitctl-release.json', digest: `sha256:${sha256(manifestBytes)}`, browser_download_url: manifestUrl }] });
    if (url === manifestUrl) return new Response(manifestBytes);
    await fs.rename(config, managed); await fs.symlink(managed, config);
    return new Response(await fs.readFile(release.offline.archivePath));
  };
  await assert.rejects(install(f, { fetchImpl }), /managed|changed during release download/);
  assert.equal(await fs.readlink(config), managed);
  assert.equal(await fs.readFile(managed, 'utf8'), original);
});

test('install root contract: legacy API home keeps v1 paths, identities and recovery', async t => {
  for (const scope of ['user', 'project']) await t.test(scope, async t => {
    const f = { ...await fixture(t), scope }, original = await writeConfig(f);
    const release = await releaseFixture(f), first = await install({ ...f, offline: release.offline });
    const receipt = await readJson(first.receiptPath);
    assert.equal(receipt.schema, 'fruitctl.install.v1');
    assert.equal(receipt.id, `${f.agent}-${scope}-${sha256(scope === 'project' ? f.projectDir : f.home).slice(0, 16)}`);
    assert.equal(first.prefix, path.join(f.home, '.local/share/fruitctl/releases', f.version, 'linux-x64'));
    assert.equal(first.launcherPath, path.join(f.home, '.local/bin/fruitctl'));
    assert.equal(first.receiptPath, path.join(f.home, '.local/state/fruitctl/install/receipts', `${receipt.id}.json`));
    assert.equal(receipt.operationalRoot, undefined);
    assert.equal(first.rootSelection, undefined);
    const next = await releaseFixture(f, 'v0.1.0-alpha.2');
    const upgraded = await install({ ...f, version: next.manifest.version, offline: next.offline });
    const history = (await readJson(upgraded.receiptPath)).previousReceipt;
    assert.equal((await readJson(history)).schema, 'fruitctl.install.v1');
    assert.equal((await rollback(f)).to, f.version);
    assert.equal((await uninstall(f)).status, 'removed');
    assert.equal(await fs.readFile(original.file, 'utf8'), original.text);
    assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
    assert.equal(await exists(first.prefix), true);
    assert.equal(await exists(history), true);
    assert.equal((await uninstall(f)).status, 'not-installed');
  });
});

test('install root contract: omitted legacy scope defaults to user while missing selected roots stay read-only', async t => {
  const f = await fixture(t), release = await releaseFixture(f);
  const installed = await install({ ...f, scope: undefined, offline: release.offline });
  assert.equal(installed.scope, 'user');
  assert.equal(installed.configPath, path.join(f.home, '.claude.json'));
  assert.equal((await readJson(installed.receiptPath)).schema, 'fruitctl.install.v1');
  const installRoot = path.join(f.root, 'uncreated ancestor/storage'), beforeHome = await treeSnapshot(f.home), beforeProject = await treeSnapshot(f.projectDir);
  const absent = await doctor({ ...f, installRoot, agent: undefined });
  assert.equal(absent.status, 'not-installed');
  assert.deepEqual(absent.rootSelection, { requestedRoot: installRoot, effectiveRoot: installRoot, layoutVersion: 1 });
  assert.equal((await uninstall({ ...f, installRoot })).status, 'not-installed');
  assert.equal((await rollback({ ...f, installRoot })).status, 'no-previous-install');
  assert.equal(await exists(path.join(f.root, 'uncreated ancestor')), false);
  assert.deepEqual(await treeSnapshot(f.home), beforeHome);
  assert.deepEqual(await treeSnapshot(f.projectDir), beforeProject);
});

test('install root contract: project storage leaves normal home untouched and records private v2 state', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'portable storage Ω');
  await fs.mkdir(path.join(f.home, '.codex'), { recursive: true });
  await fs.writeFile(path.join(f.home, '.codex/config.toml'), '# untouched normal profile\n', { mode: 0o640 });
  const normalBefore = await treeSnapshot(f.home), environmentBefore = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  const env = { CODEX_HOME: path.join(f.root, 'unused codex override') }, envBefore = { ...env };
  const release = await capableRelease(f), preview = await install({ ...f, env, dryRun: true });
  assert.equal(preview.status, 'planned');
  assert.deepEqual(preview.rootSelection, { requestedRoot: f.installRoot, effectiveRoot: f.installRoot, layoutVersion: 1 });
  assert.equal(await exists(f.installRoot), false, 'dry run must not adopt a root');
  const installed = await install({ ...f, env, offline: release.offline });
  assert.equal(installed.status, 'installed');
  assert.equal(installed.prefix, path.join(f.installRoot, 'releases', f.version, 'linux-x64'));
  assert.equal(installed.launcherPath, path.join(f.installRoot, 'bin/fruitctl'));
  assert.equal(installed.configPath, path.join(f.projectDir, '.mcp.json'));
  assert.equal(installed.skillPath, path.join(f.projectDir, '.claude/skills/fruitctl'));
  assert.deepEqual(await treeSnapshot(f.home), normalBefore);
  assert.deepEqual(env, envBefore);
  assert.deepEqual({ HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME }, environmentBefore);
  const descriptorPath = path.join(f.installRoot, 'state/install/root.json'), descriptor = await readJson(descriptorPath), receipt = await readJson(installed.receiptPath);
  assert.equal(receipt.schema, 'fruitctl.install.v2');
  assert.deepEqual(receipt.operationalRoot, descriptor);
  assert.deepEqual(descriptor, { schema: 'fruitctl.install-root.v1', effectiveRoot: f.installRoot, layoutVersion: 1, ownerUid: process.getuid() });
  for (const [key, expected] of Object.entries({ home: f.home, projectDir: f.projectDir, configPath: installed.configPath, skillPath: installed.skillPath })) assert.equal(receipt.registration[key], expected);
  for (const file of [descriptorPath, installed.receiptPath, path.join(installed.prefix, '.fruitctl-runtime.json')]) assert.equal((await fs.stat(file)).mode & 0o777, 0o600, file);
  for (const directory of ['state', 'state/install', 'state/install/receipts']) assert.equal((await fs.stat(path.join(f.installRoot, directory))).mode & 0o777, 0o700, directory);
  assert.equal((await fs.stat(path.join(installed.prefix, 'bin/node'))).mode & 0o777, 0o755);
  assert.equal((await fs.stat(path.join(installed.prefix, 'lib/install/index.mjs'))).mode & 0o777, 0o600);
  assert.equal((await doctor({ ...f, env })).status, 'configured');
  assert.equal((await uninstall({ ...f, env })).status, 'removed');
  assert.deepEqual(await treeSnapshot(f.home), normalBefore);
});

test('install root contract: user home and adapter override are independent from storage and recorded for recovery', async t => {
  const f = { ...await fixture(t), agent: 'vscode', scope: 'user' }; f.installRoot = path.join(f.root, 'user runtime');
  const custom = path.join(f.root, 'selected copilot profile'), unused = path.join(f.root, 'different current profile'), env = { COPILOT_HOME: custom };
  const original = await writeConfig({ ...f, env });
  await fs.writeFile(path.join(f.home, 'operator-note'), 'retain user home bytes\n', { mode: 0o640 });
  const homeBefore = await treeSnapshot(f.home), release = await capableRelease(f), installed = await install({ ...f, env, offline: release.offline });
  assert.equal(installed.configPath, path.join(custom, 'mcp-config.json'));
  assert.equal(installed.launcherPath, path.join(f.installRoot, 'bin/fruitctl'));
  assert.equal((await readJson(installed.receiptPath)).registration.home, f.home);
  assert.equal(await exists(path.join(f.home, '.local')), false);
  const afterInstall = await installationSnapshot(f), customBefore = await treeSnapshot(custom), changed = { ...f, env: { COPILOT_HOME: unused } };
  assert.equal((await install({ ...changed, dryRun: true })).status, 'declarative-required');
  assert.deepEqual(await installationSnapshot(f), afterInstall);
  assert.deepEqual(await treeSnapshot(custom), customBefore);
  assert.equal(await exists(unused), false);
  assert.equal((await doctor({ ...changed, agent: undefined })).status, 'configured', 'aggregate uses recorded registration destinations');
  assert.equal((await doctor(changed)).status, 'configured');
  assert.equal((await uninstall(changed)).status, 'removed');
  assert.equal(await fs.readFile(original.file, 'utf8'), original.text);
  assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
  assert.equal(await exists(unused), false);
  assert.deepEqual((await treeSnapshot(f.home)).filter(row => !row.path.startsWith('.agents')), homeBefore);
});

test('install root contract: invalid UTF8 unrelated config bytes refuse before adoption and remain byte exact', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'invalid encoding root');
  const original = Buffer.concat([Buffer.from('{"mcpServers":{"other":{"command":"operator"}},"unrelated":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  const configPath = path.join(f.projectDir, '.mcp.json'); await fs.writeFile(configPath, original, { mode: 0o640 });
  const release = await capableRelease(f), before = await installationSnapshot(f);
  for (const dryRun of [true, false]) {
    await assert.rejects(install({ ...f, dryRun, offline: release.offline }), /UTF.?8|encoding|encoded|decode/i);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.deepEqual(await fs.readFile(configPath), original);
    assert.equal(await exists(f.installRoot), false);
  }
  // Legacy v1 planning retains its existing decoding contract. This does not
  // qualify a lossy legacy install or rewrite the operator's original bytes.
  assert.equal((await install({ ...f, installRoot: undefined, dryRun: true })).status, 'planned');
  assert.deepEqual(await installationSnapshot(f), before);
  assert.deepEqual(await fs.readFile(configPath), original);
});

test('install root contract: valid UTF8 JSONC keeps its BOM, Unicode and exact pristine bytes through recovery', async t => {
  const f = { ...await fixture(t), agent: 'vscode' }; f.installRoot = path.join(f.root, 'valid encoding root');
  const text = '\uFEFF{\n // retained Ω comment\n "mcpServers":{"other":{"command":"operator"}},\n "unrelated":"café 日本",\n}\n';
  const original = await writeConfig(f, text), originalBytes = Buffer.from(text), release = await capableRelease(f);
  const installed = await install({ ...f, offline: release.offline });
  const configured = await fs.readFile(installed.configPath);
  assert.deepEqual(configured.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'strict decoding must not silently strip the BOM');
  assert.equal(configured.toString('utf8').includes('café 日本'), true);
  await install({ ...f, offline: release.offline });
  assert.deepEqual(await fs.readFile(installed.configPath), configured);
  assert.equal((await doctor(f)).status, 'configured');
  assert.equal((await uninstall(f)).status, 'removed');
  assert.deepEqual(await fs.readFile(original.file), originalBytes);
  assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
});

test('install root contract: isolated umask 0077 preserves original config and archive modes across the lifecycle', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'restrictive umask root');
  const original = await writeConfig(f), release = await capableRelease(f), next = await capableRelease(f, 'v0.1.0-alpha.2');
  const archivedFiles = {};
  for (const version of [f.version, next.manifest.version]) archivedFiles[version] = Object.fromEntries((await treeSnapshot(path.join(f.root, version, 'bundle')))
    .filter(row => row.type === 'file').map(row => [row.path, { mode: row.mode, sha256: sha256(Buffer.from(row.bytes, 'base64')) }]));
  assert.equal(archivedFiles[f.version]['bin/node'].mode, 0o755, 'the fixture archive has an independently known executable mode');
  const parentUmask = process.umask(), source = new URL('../lib/install/index.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createHash } from 'node:crypto';
    import { install, doctor, rollback, uninstall } from ${JSON.stringify(source)};
    const options = ${JSON.stringify(f)}, firstOffline = ${JSON.stringify(release.offline)}, nextOffline = ${JSON.stringify(next.offline)};
    const archivedFiles = ${JSON.stringify(archivedFiles)};
    const original = Buffer.from(${JSON.stringify(Buffer.from(original.text).toString('base64'))}, 'base64');
    process.umask(0o077);
    assert.equal(process.umask(), 0o077);
    const stages = [], privateFiles = new Set();
    const check = async (stage, installed) => {
      assert.equal((await fs.stat(installed.configPath)).mode & 0o777, 0o640, stage + ' original config mode');
      const receipt = JSON.parse(await fs.readFile(installed.receiptPath, 'utf8'));
      for (const file of [installed.receiptPath, receipt.config.baseBackupPath, receipt.previousReceipt, path.join(options.installRoot, 'state/install/root.json')].filter(Boolean)) {
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600, stage + ' private evidence'); privateFiles.add(file);
      }
      const expectedFiles = archivedFiles[receipt.version];
      assert.deepEqual(Object.keys(receipt.runtime.files).sort(), Object.keys(expectedFiles).sort(), stage + ' archived file inventory');
      for (const [relative, expected] of Object.entries(expectedFiles)) {
        const file = path.join(receipt.prefix, relative);
        assert.equal((await fs.stat(file)).mode & 0o777, expected.mode, stage + ' original archived payload mode ' + relative);
        assert.equal(receipt.runtime.modes[relative], expected.mode, stage + ' mode inventory must describe the archive input');
        assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), expected.sha256, stage + ' original archived payload bytes ' + relative);
      }
      assert.equal((await fs.stat(path.join(receipt.prefix, '.fruitctl-runtime.json'))).mode & 0o777, 0o600);
      assert.equal((await doctor(options)).status, 'configured'); stages.push(stage);
    };
    const first = await install({ ...options, offline: firstOffline }); await check('install', first);
    await check('reinstall', await install({ ...options, offline: firstOffline }));
    const upgraded = await install({ ...options, version: ${JSON.stringify(next.manifest.version)}, offline: nextOffline }); await check('upgrade', upgraded);
    assert.equal((await rollback(options)).to, options.version); await check('rollback', first);
    assert.equal((await uninstall(options)).status, 'removed');
    assert.deepEqual(await fs.readFile(first.configPath), original);
    assert.equal((await fs.stat(first.configPath)).mode & 0o777, 0o640);
    for (const file of privateFiles) {
      if (file === first.receiptPath) continue;
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'retained private evidence');
    }
    for (const [version, expectedFiles] of Object.entries(archivedFiles)) {
      const prefix = path.join(options.installRoot, 'releases', version, options.platform + '-' + options.arch);
      for (const [relative, expected] of Object.entries(expectedFiles)) {
        const file = path.join(prefix, relative);
        assert.equal((await fs.stat(file)).mode & 0o777, expected.mode, 'retained original archive mode ' + relative);
        assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), expected.sha256, 'retained original archive bytes ' + relative);
      }
      assert.equal((await fs.stat(path.join(prefix, '.fruitctl-runtime.json'))).mode & 0o777, 0o600);
    }
    stages.push('uninstall');
    process.stdout.write(JSON.stringify({ umask: process.umask(), configMode: (await fs.stat(first.configPath)).mode & 0o777, stages, privateFileCount: privateFiles.size }));
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '--eval', script], { cwd: f.projectDir, timeout: 20000, maxBuffer: 65536 });
  const result = JSON.parse(stdout);
  assert.equal(result.umask, 0o077);
  assert.equal(result.configMode, 0o640);
  assert.deepEqual(result.stages, ['install', 'reinstall', 'upgrade', 'rollback', 'uninstall']);
  assert.equal(result.privateFileCount >= 4, true);
  assert.equal(process.umask(), parentUmask, 'the shared runner umask remains untouched');
  assert.deepEqual(await fs.readFile(original.file), Buffer.from(original.text));
});

test('install root contract: recorded OpenCode custom routing survives ambiguous unused defaults during recovery', async t => {
  const f = { ...await fixture(t), agent: 'opencode', scope: 'user' }; f.installRoot = path.join(f.root, 'recorded route root');
  const custom = path.join(f.root, 'custom OpenCode profile/connection.jsonc'), env = { OPENCODE_CONFIG: custom };
  const original = await writeConfig({ ...f, env }, '{\n // retained custom comment\n "mcp":{"other":{"type":"local","command":["operator"]}},\n "unrelated":"retain",\n}\n');
  const release = await capableRelease(f), first = await install({ ...f, env, offline: release.offline });
  const next = await capableRelease(f, 'v0.1.0-alpha.2'); await install({ ...f, env, version: next.manifest.version, offline: next.offline });
  const defaults = path.join(f.home, '.config/opencode'); await fs.mkdir(defaults, { recursive: true });
  await fs.writeFile(path.join(defaults, 'opencode.json'), '{"unrelated":"unused JSON"}\n', { mode: 0o640 });
  await fs.writeFile(path.join(defaults, 'opencode.jsonc'), '{\n // unused JSONC\n "unrelated":"untouched",\n}\n', { mode: 0o600 });
  const defaultsBefore = await treeSnapshot(defaults), changed = { ...f, env: {} };
  assert.equal((await doctor(changed)).status, 'configured');
  assert.equal((await doctor({ ...changed, agent: undefined })).status, 'configured');
  assert.deepEqual(await treeSnapshot(defaults), defaultsBefore);
  assert.equal((await rollback(changed)).to, f.version);
  assert.equal(jsonEntry(await fs.readFile(custom, 'utf8'), ['mcp']).command[0], path.join(first.prefix, 'bin/fruitctl'));
  assert.deepEqual(await treeSnapshot(defaults), defaultsBefore);
  assert.equal((await uninstall(changed)).status, 'removed');
  assert.deepEqual(await fs.readFile(original.file), Buffer.from(original.text));
  assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
  assert.deepEqual(await treeSnapshot(defaults), defaultsBefore);
  assert.equal(await exists(path.join(f.home, '.local')), false, 'recorded recovery never falls back to legacy storage');
});

test('install root contract: spaces, Unicode and canonical root aliases use one namespace', async t => {
  const f = await fixture(t), physical = path.join(f.root, 'storage Ω with spaces'), alias = path.join(f.root, 'storage alias 日本');
  await fs.mkdir(physical); await fs.symlink(physical, alias);
  const release = await capableRelease(f), installed = await install({ ...f, installRoot: alias, offline: release.offline });
  assert.deepEqual(installed.rootSelection, { requestedRoot: alias, effectiveRoot: physical, layoutVersion: 1 });
  assert.equal(installed.prefix, path.join(physical, 'releases', f.version, 'linux-x64'));
  assert.equal(jsonEntry(await fs.readFile(installed.configPath, 'utf8'), ['mcpServers']).command, path.join(installed.prefix, 'bin/fruitctl'));
  const payloadBefore = await treeSnapshot(installed.prefix), projectBefore = await treeSnapshot(f.projectDir);
  const repeated = await install({ ...f, installRoot: physical, offline: release.offline });
  assert.equal(repeated.receiptPath, installed.receiptPath);
  assert.equal((await fs.readdir(path.dirname(installed.receiptPath))).length, 1);
  assert.deepEqual(await treeSnapshot(installed.prefix), payloadBefore);
  assert.deepEqual(await treeSnapshot(f.projectDir), projectBefore);
  assert.equal((await doctor({ ...f, installRoot: alias })).status, 'configured');
  assert.equal((await uninstall({ ...f, installRoot: physical })).status, 'removed');
});

test('install root contract: symlinked parent with an absent suffix records requested and physical roots separately', async t => {
  const f = await fixture(t), parent = path.join(f.root, 'physical parent Ω'), alias = path.join(f.root, 'parent alias 日本');
  await fs.mkdir(parent, { mode: 0o700 }); await fs.symlink(parent, alias);
  const installRoot = path.join(alias, 'new ancestor/storage with spaces'), effectiveRoot = path.join(parent, 'new ancestor/storage with spaces');
  const options = { ...f, installRoot }, release = await capableRelease(f), homeBefore = await treeSnapshot(f.home);
  const preview = await install({ ...options, dryRun: true });
  assert.deepEqual(preview.rootSelection, { requestedRoot: installRoot, effectiveRoot, layoutVersion: 1 });
  assert.equal(await exists(effectiveRoot), false);
  const installed = await install({ ...options, offline: release.offline });
  assert.deepEqual(installed.rootSelection, preview.rootSelection);
  assert.equal(installed.prefix, path.join(effectiveRoot, 'releases', f.version, 'linux-x64'));
  assert.equal(installed.launcherPath, path.join(effectiveRoot, 'bin/fruitctl'));
  assert.equal((await readJson(installed.receiptPath)).operationalRoot.effectiveRoot, effectiveRoot);
  assert.equal((await readJson(path.join(effectiveRoot, 'state/install/root.json'))).effectiveRoot, effectiveRoot);
  const payloadBefore = await treeSnapshot(installed.prefix), projectBefore = await treeSnapshot(f.projectDir);
  const repeated = await install({ ...f, installRoot: effectiveRoot, offline: release.offline });
  assert.equal(repeated.receiptPath, installed.receiptPath);
  assert.equal((await fs.readdir(path.dirname(installed.receiptPath))).length, 1);
  assert.deepEqual(await treeSnapshot(installed.prefix), payloadBefore);
  assert.deepEqual(await treeSnapshot(f.projectDir), projectBefore);
  assert.equal((await doctor(options)).status, 'configured');
  assert.equal((await doctor({ ...f, installRoot: effectiveRoot })).status, 'configured');
  assert.equal((await uninstall(options)).status, 'removed');
  const retainedBefore = await treeSnapshot(effectiveRoot);
  assert.equal((await uninstall({ ...f, installRoot: effectiveRoot })).status, 'not-installed');
  assert.deepEqual(await treeSnapshot(effectiveRoot), retainedBefore);
  assert.deepEqual(await treeSnapshot(f.home), homeBefore);
});

test('install root contract: invalid, read-only and unmarked roots refuse without adoption or registration writes', async t => {
  const f = await fixture(t), release = await capableRelease(f); await writeConfig(f);
  const beforeHome = await treeSnapshot(f.home), beforeProject = await treeSnapshot(f.projectDir);
  for (const installRoot of ['', 'relative root', f.home, path.parse(f.home).root, '/nix/store/fruitctl-unowned-fixture']) {
    await assert.rejects(install({ ...f, installRoot, dryRun: true }), /root|absolute|managed|immutable/i, JSON.stringify(installRoot));
    assert.deepEqual(await treeSnapshot(f.home), beforeHome);
    assert.deepEqual(await treeSnapshot(f.projectDir), beforeProject);
  }
  await assert.rejects(install({ ...f, scope: undefined, installRoot: path.join(f.root, 'scope missing'), dryRun: true }), /scope/i);
  for (const kind of ['nonempty', 'file', 'readonly']) await t.test(kind, async () => {
    const installRoot = path.join(f.root, `rejected ${kind}`);
    if (kind === 'file') await fs.writeFile(installRoot, 'operator data\n', { mode: 0o640 });
    else { await fs.mkdir(installRoot); if (kind === 'nonempty') await fs.writeFile(path.join(installRoot, 'operator data'), 'untouched\n', { mode: 0o640 }); else await fs.chmod(installRoot, 0o500); }
    const beforeRoot = await treeSnapshot(installRoot);
    try {
      await assert.rejects(install({ ...f, installRoot, offline: release.offline }), /root|directory|empty|writ|read.only/i);
      assert.deepEqual(await treeSnapshot(installRoot), beforeRoot);
      assert.deepEqual(await treeSnapshot(f.home), beforeHome);
      assert.deepEqual(await treeSnapshot(f.projectDir), beforeProject);
    } finally { if (kind === 'readonly') await fs.chmod(installRoot, 0o700); }
  });
  let foreignRoot;
  for (const candidate of ['/usr', '/etc', '/proc']) {
    let stat;
    try { stat = await fs.lstat(candidate); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid === process.getuid()) continue;
    let physical;
    try { physical = await fs.realpath(candidate); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (physical === '/nix/store' || physical.startsWith('/nix/store/')) continue;
    foreignRoot = candidate; break;
  }
  if (foreignRoot) await assert.rejects(install({ ...f, installRoot: foreignRoot, dryRun: true }), /owned by another user|foreign|owner/i);
  else t.diagnostic('No existing foreign-owned non-store directory is available; foreign ownership was not exercised in this environment');
  assert.deepEqual(await treeSnapshot(f.home), beforeHome);
  assert.deepEqual(await treeSnapshot(f.projectDir), beforeProject);
});

test('install root contract: root alias swap during download blocks cache and registration commit', async t => {
  const f = await fixture(t), physical = path.join(f.root, 'first root'), replacement = path.join(f.root, 'replacement root'), alias = path.join(f.root, 'selected alias');
  await fs.mkdir(physical); await fs.mkdir(replacement); await fs.symlink(physical, alias);
  const release = await capableRelease(f), homeBefore = await treeSnapshot(f.home), projectBefore = await treeSnapshot(f.projectDir), replacementBefore = await treeSnapshot(replacement);
  const manifestBytes = await fs.readFile(release.offline.manifestPath), manifestUrl = `https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/fruitctl-release.json`;
  let archiveRequests = 0, lockBefore;
  const fetchImpl = async url => {
    if (url.startsWith('https://api.github.com/')) return Response.json({ tag_name: f.version, assets: [{ name: 'fruitctl-release.json', digest: `sha256:${sha256(manifestBytes)}`, browser_download_url: manifestUrl }] });
    if (url === manifestUrl) return new Response(manifestBytes);
    archiveRequests++; lockBefore = await treeSnapshot(path.join(physical, 'state/install/transaction.lock'));
    await fs.unlink(alias); await fs.symlink(replacement, alias);
    return new Response(await fs.readFile(release.offline.archivePath));
  };
  await assert.rejects(install({ ...f, installRoot: alias }, { fetchImpl }), /root|identity|changed|alias/i);
  assert.equal(archiveRequests, 1);
  assert.deepEqual(await treeSnapshot(f.home), homeBefore);
  assert.deepEqual(await treeSnapshot(f.projectDir), projectBefore);
  assert.deepEqual(await treeSnapshot(replacement), replacementBefore);
  assert.equal(await exists(path.join(physical, 'releases', f.version, 'linux-x64')), false);
  // A changed requested alias no longer authorizes cleanup through that path.
  // Retain inspectable owned state instead of purging by a stale physical path.
  const descriptorPath = path.join(physical, 'state/install/root.json');
  assert.equal((await readJson(descriptorPath)).effectiveRoot, physical);
  assert.equal((await fs.stat(descriptorPath)).mode & 0o777, 0o600);
  assert.deepEqual(await treeSnapshot(path.join(physical, 'state/install/transaction.lock')), lockBefore, 'a lost root alias retains the exact lock evidence');
  assert.deepEqual((await treeSnapshot(path.join(physical, 'state/install/receipts'))).filter(row => row.type === 'file'), []);
});

test('install root contract: moving a project during download clears its safe storage lock and permits independent reuse', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'unchanged storage root');
  const movedProject = path.join(f.root, 'moved during download'), independentProject = path.join(f.root, 'independent project');
  await fs.mkdir(independentProject); await writeConfig(f); await writeConfig({ ...f, projectDir: independentProject });
  const release = await capableRelease(f), homeBefore = await treeSnapshot(f.home), projectBefore = await treeSnapshot(f.projectDir), independentBefore = await treeSnapshot(independentProject);
  const projectInode = (await fs.stat(f.projectDir)).ino, manifestBytes = await fs.readFile(release.offline.manifestPath);
  const manifestUrl = `https://github.com/xoxd-ai/fruitctl/releases/download/${f.version}/fruitctl-release.json`;
  const lockPath = path.join(f.installRoot, 'state/install/transaction.lock'); let archiveRequests = 0;
  const fetchImpl = async url => {
    if (url.startsWith('https://api.github.com/')) return Response.json({ tag_name: f.version, assets: [{ name: 'fruitctl-release.json', digest: `sha256:${sha256(manifestBytes)}`, browser_download_url: manifestUrl }] });
    if (url === manifestUrl) return new Response(manifestBytes);
    archiveRequests++;
    assert.equal((await fs.lstat(lockPath)).uid, process.getuid(), 'the controlled transaction owns the live lock');
    await fs.rename(f.projectDir, movedProject);
    return new Response(await fs.readFile(release.offline.archivePath));
  };
  await assert.rejects(install(f, { fetchImpl }), /project|registration|identity|moved|missing/i);
  assert.equal(archiveRequests, 1);
  assert.equal(await exists(f.projectDir), false, 'the installer must not recreate or adopt the old project path');
  assert.equal((await fs.stat(movedProject)).ino, projectInode);
  assert.deepEqual(await treeSnapshot(movedProject), projectBefore, 'the moved registration remains byte/mode exact');
  assert.deepEqual(await treeSnapshot(independentProject), independentBefore);
  assert.deepEqual(await treeSnapshot(f.home), homeBefore);
  assert.equal(await exists(path.join(f.installRoot, 'releases', f.version, 'linux-x64')), false);
  assert.equal(await exists(lockPath), false, 'a registration move cannot strand the lock on an unchanged owned storage root');
  assert.deepEqual((await treeSnapshot(path.join(f.installRoot, 'state/install/receipts'))).filter(row => row.type === 'file'), []);
  const installed = await install({ ...f, projectDir: independentProject, offline: release.offline });
  assert.equal(installed.status, 'installed', 'a later independent project can use the same selected root');
  assert.equal((await doctor({ ...f, projectDir: independentProject })).status, 'configured');
  assert.equal(await exists(lockPath), false);
  assert.deepEqual(await treeSnapshot(movedProject), projectBefore);
  assert.deepEqual(await treeSnapshot(f.home), homeBefore);
  assert.equal(await exists(f.projectDir), false);
});

test('install root contract: managed registration or an unowned skill refuses before root adoption', async t => {
  for (const kind of ['symlinked config', 'readonly config', 'unowned skill']) await t.test(kind, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'never adopted root');
    const original = await writeConfig(f), adapter = resolveAdapter(f);
    if (kind === 'symlinked config') {
      const target = path.join(f.root, 'managed registration bytes'); await fs.rename(original.file, target); await fs.symlink(target, original.file);
    } else if (kind === 'readonly config') await fs.chmod(original.file, 0o400);
    else { await fs.mkdir(adapter.skillPath, { recursive: true }); await fs.writeFile(path.join(adapter.skillPath, 'operator-note'), 'do not adopt\n', { mode: 0o640 }); }
    const before = await installationSnapshot(f); let requests = 0;
    const result = await install(f, { fetchImpl: async () => { requests++; throw new Error('managed preflight must not fetch'); } });
    assert.equal(result.status, 'declarative-required');
    assert.equal(requests, 0);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.equal(await exists(f.installRoot), false);
  });
});

test('install root contract: repeated installs preserve payload, registration and descriptor exactly', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'reinstall root');
  const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline });
  const before = await installationSnapshot(f), nodeInode = (await fs.stat(path.join(installed.prefix, 'bin/node'))).ino;
  await install({ ...f, offline: release.offline });
  const after = await installationSnapshot(f), bookkeeping = row => /^state\/install\/(?:backups|history|receipts)(?:\/|$)/.test(row.path);
  assert.deepEqual(after.home, before.home);
  assert.deepEqual(after.project, before.project);
  assert.deepEqual(after.operational.filter(row => !bookkeeping(row)), before.operational.filter(row => !bookkeeping(row)));
  assert.equal((await fs.stat(path.join(installed.prefix, 'bin/node'))).ino, nodeInode);
  assert.equal((await fs.readdir(path.dirname(installed.receiptPath))).length, 1);
  assert.equal((await readJson(installed.receiptPath)).schema, 'fruitctl.install.v2');
  assert.equal((await doctor(f)).status, 'configured');
});

test('install root contract: foreign-root entries and same-agent project aliases cannot become a new baseline', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'first owned root');
  const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline });
  const before = await installationSnapshot(f), secondRoot = path.join(f.root, 'second root'); let requests = 0;
  await assert.rejects(install({ ...f, installRoot: secondRoot }, { fetchImpl: async () => { requests++; throw new Error('download must not happen'); } }), /owned|changed|foreign|root|refus/i);
  assert.equal(requests, 0);
  assert.equal(await exists(secondRoot), false);
  assert.deepEqual(await installationSnapshot(f), before);
  const projectAlias = path.join(f.root, 'project alias'); await fs.symlink(f.projectDir, projectAlias);
  for (const operation of [
    () => install({ ...f, projectDir: projectAlias, offline: release.offline }),
    () => doctor({ ...f, projectDir: projectAlias }),
    () => rollback({ ...f, projectDir: projectAlias }),
    () => uninstall({ ...f, projectDir: projectAlias }),
  ]) {
    await assert.rejects(operation(), /alias|recorded project/i);
    assert.deepEqual(await installationSnapshot(f), before);
  }
  assert.equal((await fs.readdir(path.dirname(installed.receiptPath))).length, 1);
});

test('install root contract: shared registrations and separate projects audit and transfer within one root', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'shared root');
  const original = await writeConfig(f), release = await capableRelease(f), first = await install({ ...f, offline: release.offline });
  const second = await install({ ...f, agent: 'vscode', offline: release.offline });
  await install({ ...f, agent: 'pi', offline: release.offline });
  const otherProject = path.join(f.root, 'independent project'); await fs.mkdir(otherProject);
  const third = await install({ ...f, projectDir: otherProject, offline: release.offline }), independentBefore = await treeSnapshot(otherProject);
  const aggregate = await doctor({ installRoot: f.installRoot, home: path.join(f.root, 'unused invoking home'), platform: 'linux', arch: 'x64', env: {} });
  assert.equal(aggregate.status, 'configured');
  assert.equal(aggregate.installations.length, 4);
  assert.equal((await uninstall(f)).status, 'removed');
  assert.equal((await doctor({ ...f, agent: 'vscode' })).status, 'configured');
  assert.deepEqual(await treeSnapshot(otherProject), independentBefore);
  assert.equal((await uninstall({ ...f, agent: 'vscode' })).status, 'removed');
  assert.equal(await fs.readFile(original.file, 'utf8'), original.text);
  assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
  assert.equal(await exists(second.skillPath), true, 'shared skill ownership transfers to Pi');
  assert.equal((await doctor({ ...f, agent: 'pi' })).status, 'configured');
  assert.equal((await uninstall({ ...f, agent: 'pi' })).status, 'removed');
  assert.equal(await exists(second.skillPath), false);
  assert.equal(await exists(first.skillPath), false);
  assert.equal((await doctor({ ...f, projectDir: otherProject })).status, 'configured');
  assert.equal(await exists(third.launcherPath), true, 'one root launcher remains while a different project owns it');
  assert.equal((await uninstall({ ...f, projectDir: otherProject })).status, 'removed');
  assert.equal(await exists(third.launcherPath), false);
  assert.equal((await doctor({ installRoot: f.installRoot, platform: 'linux', arch: 'x64', env: {} })).status, 'not-installed');
});

test('install root contract: incapable and malformed archive markers refuse explicit storage without legacy fallback', async t => {
  assert.deepEqual(installer.installerCapabilities, { installRoot: 1 });
  assert.equal(Object.isFrozen(installer.installerCapabilities), true);
  for (const [label, packageJson] of [
    ['alpha4-like package without marker', { name: 'fruitctl', version: '0.1.0-alpha.1' }],
    ['string version', { fruitctlInstallerCapabilities: { installRoot: '1' } }],
    ['unsupported version', { fruitctlInstallerCapabilities: { installRoot: 2 } }],
    ['array marker', { fruitctlInstallerCapabilities: [{ installRoot: 1 }] }],
    ['missing root feature', { fruitctlInstallerCapabilities: { unrelated: 1 } }],
  ]) await t.test(label, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'unsupported target root');
    const release = await releaseFixture(f, f.version, { packageJson }), homeBefore = await treeSnapshot(f.home), projectBefore = await treeSnapshot(f.projectDir);
    await assert.rejects(install({ ...f, offline: release.offline }), /capabilit|installRoot/i);
    assert.deepEqual(await treeSnapshot(f.home), homeBefore);
    assert.deepEqual(await treeSnapshot(f.projectDir), projectBefore);
    assert.equal(await exists(path.join(f.installRoot, 'releases', f.version, 'linux-x64')), false);
    assert.equal(await exists(path.join(f.installRoot, 'state/install/root.json')), false);
    const legacy = await install({ ...f, installRoot: undefined, offline: release.offline });
    assert.equal(legacy.status, 'installed', 'an older target still supports the legacy storage route');
    assert.equal((await readJson(legacy.receiptPath)).schema, 'fruitctl.install.v1');
    assert.equal(legacy.prefix, path.join(f.home, '.local/share/fruitctl/releases', f.version, 'linux-x64'));
  });
});

test('install root contract: v2 recovery metadata cannot redirect or downgrade ownership checks', async t => {
  const mutations = [
    ['legacy schema in explicit namespace', receipt => { receipt.schema = 'fruitctl.install.v1'; }],
    ['different operational root', (receipt, f) => { receipt.operationalRoot.effectiveRoot = path.join(f.root, 'foreign root'); }],
    ['unknown layout', receipt => { receipt.operationalRoot.layoutVersion = 2; }],
    ['foreign registration home', (receipt, f) => { receipt.registration.home = path.join(f.root, 'foreign home'); }],
    ['foreign config destination', (receipt, f) => { receipt.registration.configPath = path.join(f.root, 'foreign config'); }],
    ['foreign skill destination', (receipt, f) => { receipt.registration.skillPath = path.join(f.root, 'foreign skill'); }],
    ['coordinated config and registration redirect', async (receipt, f) => {
      const file = path.join(f.root, 'unrelated destination/config.json'); await fs.mkdir(path.dirname(file));
      await fs.copyFile(receipt.config.path, file); await fs.chmod(file, 0o600);
      receipt.registration.configPath = receipt.config.path = file;
    }],
    ['coordinated skill and registration redirect', async (receipt, f) => {
      const file = path.join(f.root, 'unrelated destination/fruitctl'); await fs.mkdir(path.dirname(file));
      await fs.symlink(receipt.skill.target, file);
      receipt.registration.skillPath = receipt.skill.path = file;
    }],
    ['foreign runtime prefix', (receipt, f) => { receipt.prefix = path.join(f.root, 'foreign runtime'); }],
    ['foreign launcher path', (receipt, f) => { receipt.launcher.path = path.join(f.home, '.local/bin/fruitctl'); }],
    ['foreign launcher target', (receipt, f) => { receipt.launcher.target = path.join(f.root, 'foreign/bin/fruitctl'); }],
    ['foreign backup path', (receipt, f) => { receipt.config.baseBackupPath = path.join(f.root, 'foreign backup'); }],
    ['foreign history path', (receipt, f) => { receipt.previousReceipt = path.join(f.root, 'foreign history'); }],
    ['stripped mode inventory', receipt => { delete receipt.runtime.modes; }],
  ];
  for (const [label, mutate] of mutations) await t.test(label, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'metadata root'); await writeConfig(f);
    const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline }), receipt = await readJson(installed.receiptPath);
    await mutate(receipt, f); await fs.writeFile(installed.receiptPath, JSON.stringify(receipt));
    const before = await installationSnapshot(f), outsideBefore = await treeSnapshot(path.join(f.root, 'unrelated destination'));
    await assert.rejects(uninstall(f), /receipt|root|registration|identity|mode|layout|configuration|launcher|history/i);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.deepEqual(await treeSnapshot(path.join(f.root, 'unrelated destination')), outsideBefore);
    await assert.rejects(rollback(f), /receipt|root|registration|identity|mode|layout|configuration|launcher|history/i);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.deepEqual(await treeSnapshot(path.join(f.root, 'unrelated destination')), outsideBefore);
  });
});

test('install root contract: descriptor tampering and stale transaction locks preserve registration', async t => {
  for (const kind of ['effectiveRoot', 'ownerUid', 'mode', 'symlink', 'lock']) await t.test(kind, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'descriptor root');
    const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline }), file = path.join(f.installRoot, 'state/install/root.json');
    if (kind === 'mode') await fs.chmod(file, 0o644);
    else if (kind === 'symlink') {
      const outside = path.join(f.root, 'copied descriptor'); await fs.copyFile(file, outside);
      await fs.unlink(file); await fs.symlink(outside, file);
    } else if (kind === 'lock') await fs.mkdir(path.join(f.installRoot, 'state/install/transaction.lock'));
    else { const descriptor = await readJson(file); descriptor[kind] = kind === 'ownerUid' ? process.getuid() + 1 : path.join(f.root, 'other'); await fs.writeFile(file, JSON.stringify(descriptor)); }
    const before = await installationSnapshot(f);
    await assert.rejects(uninstall(f), /root|descriptor|owner|mode|lock|transaction/i);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.equal(await exists(installed.receiptPath), true);
  });
});

test('install root contract: private receipt and backup tamper refuses recovery with original state preserved', async t => {
  for (const kind of ['receipt mode', 'receipt symlink', 'backup bytes', 'backup mode', 'backup symlink']) await t.test(kind, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'private recovery root'); await writeConfig(f);
    const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline }), receipt = await readJson(installed.receiptPath);
    const selected = kind.startsWith('receipt') ? installed.receiptPath : receipt.config.baseBackupPath;
    if (kind.endsWith('mode')) await fs.chmod(selected, 0o644);
    else if (kind.endsWith('bytes')) await fs.appendFile(selected, 'unowned backup bytes\n');
    else {
      const copied = path.join(f.root, 'unrelated recovery bytes'); await fs.copyFile(selected, copied);
      await fs.unlink(selected); await fs.symlink(copied, selected);
    }
    const before = await installationSnapshot(f), outsideBefore = await treeSnapshot(path.join(f.root, 'unrelated recovery bytes'));
    await assert.rejects(uninstall(f), /receipt|regular|mode|backup|changed|ELOOP|symbolic/i);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.deepEqual(await treeSnapshot(path.join(f.root, 'unrelated recovery bytes')), outsideBefore);
  });
});

test('install root contract: previous cache byte, mode and capability drift blocks rollback without mutation', async t => {
  for (const kind of ['bytes', 'mode', 'capability']) await t.test(kind, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'rollback root');
    const firstRelease = await capableRelease(f), first = await install({ ...f, offline: firstRelease.offline });
    const next = await capableRelease(f, 'v0.1.0-alpha.2'), current = await install({ ...f, version: next.manifest.version, offline: next.offline });
    if (kind === 'mode') await fs.chmod(path.join(first.prefix, 'bin/node'), 0o644);
    else if (kind === 'bytes') await fs.appendFile(path.join(first.prefix, 'lib/broker/runtime-marker.mjs'), 'tampered\n');
    else await fs.writeFile(path.join(first.prefix, 'package.json'), JSON.stringify({ name: 'fruitctl' }));
    const before = await installationSnapshot(f);
    await assert.rejects(rollback(f), /runtime|changed|capabilit|installRoot/i);
    assert.deepEqual(await installationSnapshot(f), before);
    assert.equal((await readJson(current.receiptPath)).version, next.manifest.version);
    await assert.rejects(install({ ...f, offline: firstRelease.offline }), /runtime|changed|cache|capabilit/i);
    assert.deepEqual(await installationSnapshot(f), before);
  });
});

test('install root contract: current cache drift is diagnosed without rewriting state', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'doctor root');
  const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline });
  await fs.chmod(path.join(installed.prefix, 'bin/node'), 0o644);
  const before = await installationSnapshot(f), result = await doctor(f);
  assert.equal(result.status, 'drift');
  assert.equal(result.checks.some(check => !check.ok && /bin\/node/.test(check.name)), true);
  assert.deepEqual(await installationSnapshot(f), before);
});

test('install root contract: physical root moves, copied roots and project relocation cannot be adopted', async t => {
  for (const kind of ['moved root', 'copied root', 'moved project', 'replaced project']) await t.test(kind, async t => {
    const f = await fixture(t); f.installRoot = path.join(f.root, 'original root');
    const release = await capableRelease(f), installed = await install({ ...f, offline: release.offline });
    let relocated;
    if (kind === 'moved project' || kind === 'replaced project') {
      const movedProject = path.join(f.root, 'moved project'); await fs.rename(f.projectDir, movedProject);
      if (kind === 'replaced project') { await fs.cp(movedProject, f.projectDir, { recursive: true, dereference: false, verbatimSymlinks: true }); relocated = f; }
      else relocated = { ...f, projectDir: movedProject };
    } else {
      const movedRoot = path.join(f.root, kind);
      if (kind === 'moved root') await fs.rename(f.installRoot, movedRoot);
      else await fs.cp(f.installRoot, movedRoot, { recursive: true, dereference: false, verbatimSymlinks: true });
      relocated = { ...f, installRoot: movedRoot };
    }
    const before = await installationSnapshot(relocated), originalRootBefore = await treeSnapshot(f.installRoot);
    const diagnosis = await doctor(relocated).then(value => value, error => ({ refused: error.message }));
    assert.notEqual(diagnosis.status, 'configured');
    for (const operation of [
      () => install({ ...relocated, offline: release.offline }),
      () => uninstall(relocated),
      () => rollback(relocated),
    ]) {
      await assert.rejects(operation(), /root|identity|recorded|project|owned|changed|receipt|refus/i);
      assert.deepEqual(await installationSnapshot(relocated), before);
      assert.deepEqual(await treeSnapshot(f.installRoot), originalRootBefore);
    }
    assert.equal(await fs.readlink(installed.launcherPath).catch(error => error.code === 'ENOENT' ? undefined : Promise.reject(error)), kind === 'moved root' ? undefined : path.join(installed.prefix, 'bin/fruitctl'));
  });
});

test('install root contract: uninstall then new root restores bytes/modes and retains old cache/history', async t => {
  const f = await fixture(t); f.installRoot = path.join(f.root, 'old storage');
  const original = await writeConfig(f), release = await capableRelease(f), first = await install({ ...f, offline: release.offline });
  const next = await capableRelease(f, 'v0.1.0-alpha.2'), latest = await install({ ...f, version: next.manifest.version, offline: next.offline });
  const historyPath = (await readJson(latest.receiptPath)).previousReceipt, payloadBefore = await treeSnapshot(path.join(f.installRoot, 'releases'));
  const descriptorBefore = await fs.readFile(path.join(f.installRoot, 'state/install/root.json')), historyBefore = await fs.readFile(historyPath);
  await fs.chmod(latest.configPath, 0o600);
  assert.equal((await uninstall(f)).status, 'removed');
  assert.equal(await fs.readFile(original.file, 'utf8'), original.text);
  assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
  assert.deepEqual(await treeSnapshot(path.join(f.installRoot, 'releases')), payloadBefore);
  assert.deepEqual(await fs.readFile(path.join(f.installRoot, 'state/install/root.json')), descriptorBefore);
  assert.deepEqual(await fs.readFile(historyPath), historyBefore);
  assert.equal(await exists(latest.receiptPath), false);
  assert.equal(await exists(first.skillPath), false);
  assert.equal(await exists(first.launcherPath), false);
  const oldAfterRemoval = await treeSnapshot(f.installRoot);
  assert.equal((await uninstall(f)).status, 'not-installed');
  assert.deepEqual(await treeSnapshot(f.installRoot), oldAfterRemoval);
  const moved = { ...f, installRoot: path.join(f.root, 'new independently owned storage') }, second = await install({ ...moved, offline: release.offline });
  assert.notEqual(second.prefix, first.prefix);
  assert.equal(jsonEntry(await fs.readFile(second.configPath, 'utf8'), ['mcpServers']).command, path.join(second.prefix, 'bin/fruitctl'));
  assert.deepEqual(await treeSnapshot(f.installRoot), oldAfterRemoval);
  assert.equal((await uninstall(moved)).status, 'removed');
  assert.equal(await fs.readFile(original.file, 'utf8'), original.text);
  assert.equal((await fs.stat(original.file)).mode & 0o777, original.mode);
  assert.deepEqual(await treeSnapshot(f.installRoot), oldAfterRemoval);
});
