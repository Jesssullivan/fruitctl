import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { install, doctor, uninstall, rollback } from '../lib/install/index.mjs';
import { renderIntegration, resolveAdapter } from '../lib/install/adapters.mjs';
import { parseJsonc, patchJsonEntry, jsonEntry } from '../lib/install/config.mjs';
import { sha256, resolveRelease } from '../lib/install/release.mjs';

const run = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-test-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), projectDir = path.join(root, 'project');
  await fs.mkdir(home); await fs.mkdir(projectDir);
  return { root, home, projectDir, agent: 'claude', scope: 'project', version: 'v0.1.0-alpha.1', target: 'lab-desktop', platform: 'linux', arch: 'x64', env: {} };
}

async function releaseFixture(f, version = f.version, { symlink = false } = {}) {
  const root = path.join(f.root, version); const bundle = path.join(root, 'bundle');
  const files = ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'lib/broker/runtime-marker.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md'];
  for (const file of files) {
    const dest = path.join(bundle, file); await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, `${file} fixture for ${version}\n`, { mode: file === 'bin/fruitctl' || file === 'bin/node' ? 0o755 : 0o600 });
  }
  if (symlink) await fs.symlink('/etc/passwd', path.join(bundle, 'external'));
  const archivePath = path.join(root, 'runtime.tar.gz');
  await run('tar', ['-czf', archivePath, '-C', bundle, '.']);
  const name = `fruitctl-${version}-${f.platform}-${f.arch}.tar.gz`;
  const manifest = { schema: 'fruitctl.release.v1', repository: 'xoxd-ai/fruitctl', version, assets: [{ kind: 'runtime', os: f.platform, arch: f.arch, name, url: `https://github.com/xoxd-ai/fruitctl/releases/download/${version}/${name}`, sha256: sha256(await fs.readFile(archivePath)) }] };
  const manifestPath = path.join(root, 'fruitctl-release.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { manifest, offline: { manifestPath, archivePath, manifestSha256: sha256(await fs.readFile(manifestPath)) } };
}

test('all seven adapters render their actual native schemas without launching agents', async t => {
  const f = await fixture(t);
  for (const agent of ['claude', 'codex', 'pi', 'junie', 'opencode', 'vscode', 'kimi']) {
    const result = await install({ ...f, agent, dryRun: true });
    assert.equal(result.status, 'planned');
    assert.match(result.snippet, /fruitctl/);
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

test('Junie mutable enabled state survives upgrades and rollback; no instruction override is created', async t => {
  const f = { ...await fixture(t), agent: 'junie' }, v1 = await releaseFixture(f);
  await install({ ...f, offline: v1.offline });
  const configPath = path.join(f.projectDir, '.junie/mcp/mcp.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.mcpServers.fruitctl.enabled = false;
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
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

test('aggregate doctor audits receipts and rejects missing/unknown agent identities without recursion', async t => {
  const f = await fixture(t);
  assert.equal((await doctor({ home: f.home, env: {} })).status, 'not-installed');
  const release = await releaseFixture(f), result = await install({ ...f, offline: release.offline });
  const aggregate = await doctor({ home: f.home, env: {} });
  assert.equal(aggregate.status, 'configured');
  assert.equal(aggregate.installations.length, 1);
  assert.match(aggregate.qualification, /runtime and target behavior unverified/);
  const receipt = JSON.parse(await fs.readFile(result.receiptPath, 'utf8'));
  delete receipt.agent;
  await fs.writeFile(result.receiptPath, JSON.stringify(receipt));
  await assert.rejects(doctor({ home: f.home, env: {} }), /Invalid install receipt/);
  receipt.agent = 'constructor';
  await fs.writeFile(result.receiptPath, JSON.stringify(receipt));
  await assert.rejects(doctor({ home: f.home, env: {} }), /Invalid install receipt/);
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

test('shell bootstrap installs a verified fixture end to end without a preinstalled product or agent launch', async t => {
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
