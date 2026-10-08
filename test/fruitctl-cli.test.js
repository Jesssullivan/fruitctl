// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBroker } from '../lib/broker/server.mjs';

const run = promisify(execFile);
const cliPath = fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url));
const installScript = fileURLToPath(new URL('../scripts/install.sh', import.meta.url));
const uninstallScript = fileURLToPath(new URL('../scripts/uninstall.sh', import.meta.url));
const quoteShell = value => `'${value.replaceAll("'", "'\"'\"'")}'`;

async function ownedDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-cli-root-'));
  await fs.chmod(directory, 0o700);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function absent(file) {
  await assert.rejects(fs.lstat(file), { code: 'ENOENT' });
}

function childEnvironment(extra = {}) {
  // Do not relocate HOME or CODEX_HOME. All fixture mutations use owned paths.
  return { ...process.env, ...extra };
}

async function bootstrapFixture(t, { packageCapability, apiCapability } = {}) {
  const directory = await ownedDirectory(t);
  const bundle = path.join(directory, 'bundle');
  const shims = path.join(directory, 'shims');
  const temporary = path.join(directory, 'temporary');
  const project = path.join(directory, 'project');
  const storage = path.join(directory, "storage root '紫'");
  const trace = path.join(directory, 'install.json');
  const imported = path.join(directory, 'imported');
  const downloads = path.join(directory, 'downloads.json');
  await Promise.all([path.join(bundle, 'bin'), path.join(bundle, 'lib/install'), shims,
    temporary, project].map(item => fs.mkdir(item, { recursive: true })));
  await fs.writeFile(path.join(bundle, 'bin/node'),
    `#!/bin/sh\nexec ${quoteShell(process.execPath)} "$@"\n`, { mode: 0o755 });
  const metadata = { type: 'module' };
  if (packageCapability !== undefined) metadata.fruitctlInstallerCapabilities = { installRoot: packageCapability };
  await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify(metadata));
  const capabilityExport = apiCapability === undefined ? '' :
    `export const installerCapabilities = ${JSON.stringify({ installRoot: apiCapability })};\n`;
  await fs.writeFile(path.join(bundle, 'lib/install/index.mjs'),
    `import fs from 'node:fs/promises';\n${capabilityExport}` +
    `await fs.writeFile(process.env.FRUITCTL_TEST_IMPORTED, 'imported');\n` +
    `export async function install(options) {\n` +
    `  await fs.writeFile(process.env.FRUITCTL_TEST_INSTALL_TRACE, JSON.stringify({options, home:process.env.HOME, codexHome:process.env.CODEX_HOME}));\n` +
    `  return {status:'fixture-installed'};\n}\n`);
  const version = 'v9.8.7-fixture';
  const asset = `fruitctl-${version}-${process.platform}-${process.arch}.tar.gz`;
  const archive = path.join(directory, asset);
  await run('tar', ['-czf', archive, '-C', bundle, '.'], { timeout: 10000 });
  const hash = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const checksums = path.join(directory, 'SHA256SUMS');
  await fs.writeFile(checksums, `${hash}  ${asset}\n`);
  const curl = path.join(shims, 'curl');
  const curlFixture = path.join(directory, 'curl-fixture.mjs');
  await fs.writeFile(curlFixture,
    `import fs from 'node:fs/promises';\n` +
    `const args=process.argv.slice(2), url=args.find(arg=>arg.startsWith('https://')), output=args[args.indexOf('-o')+1];\n` +
    `const base=${JSON.stringify(`https://github.com/xoxd-ai/fruitctl/releases/download/${version}/`)};\n` +
    `const sources={${JSON.stringify(`${version}/SHA256SUMS`)}:${JSON.stringify(checksums)},${JSON.stringify(`${version}/${asset}`)}:${JSON.stringify(archive)}};\n` +
    `if(!url?.startsWith(base)||!output) throw Error('Unexpected fixture download');\n` +
    `const key=${JSON.stringify(`${version}/`)}+url.slice(base.length), source=sources[key];\n` +
    `if(!source) throw Error('Unexpected fixture asset');\n` +
    `let prior=[];try{prior=JSON.parse(await fs.readFile(${JSON.stringify(downloads)},'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}\n` +
    `await fs.writeFile(${JSON.stringify(downloads)},JSON.stringify([...prior,url]));\n` +
    `await fs.copyFile(source,output);\n`);
  await fs.writeFile(curl, `#!/bin/sh\nexec ${quoteShell(process.execPath)} ${quoteShell(curlFixture)} "$@"\n`, { mode: 0o755 });
  return { directory, project, storage, trace, imported, downloads, version,
    args: ['--agent', 'junie', '--version', version, '--target', 'fixture'],
    options: { cwd: project, timeout: 10000, env: childEnvironment({
      PATH: `${shims}${path.delimiter}${process.env.PATH || ''}`, TMPDIR: temporary,
      FRUITCTL_TEST_IMPORTED: imported, FRUITCTL_TEST_INSTALL_TRACE: trace,
    }) },
  };
}

test('CLI MCP initialization reports the package version and preserves real tool names', { timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-cli-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 's');
  let broker;
  const client = new Client({ name: 'fruitctl-cli-version-fixture', version: '1' });
  t.after(async () => {
    try { await client.close(); }
    finally {
      try { await broker?.close(); }
      finally { await fs.rm(directory, { recursive: true, force: true }); }
    }
  });
  let nativeStarts = 0;
  broker = await createBroker({
    socketPath, config: { targets: { fixture: {} } },
    factory: async () => {
      nativeStarts++;
      throw new Error('Metadata discovery must not start a native controller');
    },
  });
  const metadata = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url)),
      'mcp', '--target', 'fixture', '--socket', socketPath],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  assert.deepEqual(client.getServerVersion(), { name: 'fruitctl', version: metadata.version });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name),
    ['vnc_command', 'action_queue', 'task_complete', 'task_failed']);
  assert.equal(nativeStarts, 0);
  assert.equal(stderr, '');
});

test('CLI rejects install-root on non-lifecycle verbs before starting a service', async t => {
  const directory = await ownedDirectory(t);
  const socket = path.join(directory, 'never-created');
  for (const command of ['mcp', 'broker', 'relay', 'attach', 'unknown']) {
    await assert.rejects(run(process.execPath, [cliPath, command, '--install-root', directory,
      '--socket', socket], { timeout: 5000 }), error => {
      assert.match(error.stderr, /--install-root is supported only by install, doctor, rollback and uninstall/);
      return true;
    });
  }
  await absent(socket);
});

test('CLI explicit-root install requires explicit registration scope before installer import', async t => {
  const directory = await ownedDirectory(t);
  for (const scope of [[], ['--scope', 'invalid']]) {
    await assert.rejects(run(process.execPath, [cliPath, 'install', '--install-root', directory,
      '--agent', 'junie', '--version', 'v9.8.7-fixture', ...scope], { timeout: 5000 }), error => {
      assert.match(error.stderr, /requires explicit --scope user\|project/);
      return true;
    });
  }
  assert.deepEqual(await fs.readdir(directory), []);
});

test('CLI forwards selected root and registration paths to all four lifecycle APIs', async t => {
  const directory = await ownedDirectory(t);
  const fixtureCli = path.join(directory, 'bin/fruitctl.mjs');
  await fs.mkdir(path.dirname(fixtureCli), { recursive: true });
  await fs.mkdir(path.join(directory, 'lib/broker'), { recursive: true });
  await fs.mkdir(path.join(directory, 'lib/install'), { recursive: true });
  await fs.copyFile(cliPath, fixtureCli);
  await fs.copyFile(fileURLToPath(new URL('../lib/broker/paths.mjs', import.meta.url)),
    path.join(directory, 'lib/broker/paths.mjs'));
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '9.8.7-fixture' }));
  await fs.writeFile(path.join(directory, 'lib/install/index.mjs'),
    `export async function install(options){return {command:'install',options};}\n` +
    `export async function doctor(options){return {command:'doctor',options};}\n` +
    `export async function rollback(options){return {command:'rollback',options};}\n` +
    `export async function uninstall(options){return {command:'uninstall',options};}\n`);
  const storage = path.join(directory, "runtime 'root' 紫");
  const project = path.join(directory, "registered project '紫'");
  for (const command of ['install', 'doctor', 'rollback', 'uninstall']) {
    const { stdout } = await run(process.execPath, [fixtureCli, command, '--install-root', storage,
      '--agent', 'junie', '--scope', 'project', '--project-dir', project,
      '--version', 'v9.8.7-fixture', '--target', 'fixture', '--dry-run'], { timeout: 5000 });
    assert.deepEqual(JSON.parse(stdout), { command, options: {
      agent: 'junie', scope: 'project', version: 'v9.8.7-fixture', target: 'fixture',
      dryRun: true, projectDir: project, installRoot: storage,
      ...(process.env.FRUITCTL_CONFIG_PATH !== undefined ? { configPath: process.env.FRUITCTL_CONFIG_PATH } : {}),
    } });
  }
  const { stdout } = await run(process.execPath, [fixtureCli, 'install', '--agent', 'junie'], { timeout: 5000 });
  const legacy = JSON.parse(stdout).options;
  assert.equal(Object.hasOwn(legacy, 'installRoot'), false);
  assert.equal(Object.hasOwn(legacy, 'scope'), false);
});

test('bootstrap rejects incapable package metadata before importing an old installer', async t => {
  for (const packageCapability of [undefined, '1', 2]) {
    await t.test(`package installRoot=${JSON.stringify(packageCapability)}`, async t => {
      const fixture = await bootstrapFixture(t, { packageCapability, apiCapability: 1 });
      await assert.rejects(run('/bin/sh', [installScript, ...fixture.args, '--scope', 'project',
        '--install-root', fixture.storage], fixture.options), error => {
        assert.match(error.stderr, /Release package does not support --install-root/);
        return true;
      });
      await absent(fixture.trace);
      await absent(fixture.imported);
      await absent(fixture.storage);
      assert.equal(JSON.parse(await fs.readFile(fixture.downloads, 'utf8')).length, 2);
    });
  }
});

test('bootstrap rejects an incapable exported API even when the package advertises installRoot', async t => {
  for (const apiCapability of [undefined, '1', 2]) {
    await t.test(`API installRoot=${JSON.stringify(apiCapability)}`, async t => {
      const fixture = await bootstrapFixture(t, { packageCapability: 1, apiCapability });
      await assert.rejects(run('/bin/sh', [installScript, ...fixture.args, '--scope', 'project',
        '--install-root', fixture.storage], fixture.options), error => {
        assert.match(error.stderr, /Release installer API does not support --install-root/);
        return true;
      });
      assert.equal(await fs.readFile(fixture.imported, 'utf8'), 'imported');
      await absent(fixture.trace);
      await absent(fixture.storage);
    });
  }
});

test('bootstrap preserves quoted root/project paths and the caller home environment', async t => {
  const fixture = await bootstrapFixture(t, { packageCapability: 1, apiCapability: 1 });
  const project = path.join(fixture.directory, "project 'with spaces' 紫");
  await fs.mkdir(project);
  const { stdout } = await run('/bin/sh', [installScript, ...fixture.args, '--scope', 'project',
    `--install-root=${fixture.storage}`, '--project-dir', project], fixture.options);
  assert.equal(JSON.parse(stdout).status, 'fixture-installed');
  const record = JSON.parse(await fs.readFile(fixture.trace, 'utf8'));
  assert.deepEqual(record.options, { version: fixture.version, agent: 'junie', scope: 'project',
    target: 'fixture', projectDir: project, installRoot: fixture.storage });
  assert.equal(record.home, process.env.HOME);
  assert.equal(record.codexHome, process.env.CODEX_HOME);
  assert.deepEqual(await fs.readdir(fixture.options.env.TMPDIR), []);
});

test('bootstrap keeps the legacy default scope and supports project-dir without root capability', async t => {
  const fixture = await bootstrapFixture(t);
  const project = path.join(fixture.directory, 'other project');
  await run('/bin/sh', [installScript, ...fixture.args, `--project-dir=${project}`], fixture.options);
  const record = JSON.parse(await fs.readFile(fixture.trace, 'utf8'));
  assert.deepEqual(record.options, { version: fixture.version, agent: 'junie', scope: 'user',
    target: 'fixture', projectDir: project });
  assert.equal(record.home, process.env.HOME);
  assert.equal(record.codexHome, process.env.CODEX_HOME);
});

test('bootstrap refuses unsafe or underspecified roots before any download', async t => {
  const fixture = await bootstrapFixture(t);
  for (const args of [
    ['--install-root', fixture.storage],
    ['--scope', 'project', '--install-root', 'relative'],
    ['--scope', 'project', '--install-root='],
    ['--scope', 'project', '--install-root'],
  ]) {
    await assert.rejects(run('/bin/sh', [installScript, ...fixture.args, ...args], fixture.options),
      error => {
        assert.match(error.stderr, /requires explicit --scope|nonempty absolute directory|Missing value/);
        return true;
      });
  }
  await absent(fixture.downloads);
  await absent(fixture.trace);
});

test('uninstall selects only the requested root launcher and preserves original arguments', async t => {
  const directory = await ownedDirectory(t);
  const storage = path.join(directory, "root 'with spaces' 紫");
  const launcher = path.join(storage, 'bin/fruitctl');
  const alternate = path.join(directory, 'explicit executable');
  const trace = path.join(directory, 'exec.json');
  const recorder = path.join(directory, 'record-exec.mjs');
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  await Promise.all([launcher, alternate].map(file => fs.writeFile(file, '#!/bin/sh\nexit 99\n', { mode: 0o755 })));
  await fs.writeFile(recorder, `import fs from 'node:fs/promises';\n` +
    `await fs.writeFile(${JSON.stringify(trace)},JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,codexHome:process.env.CODEX_HOME}));\n`);
  // Source the real POSIX script under Bash, replacing only exec with an owned
  // recorder. A broken selection cannot execute a real normal-home launcher.
  const source = `exec() { ${quoteShell(process.execPath)} ${quoteShell(recorder)} "$@"; }\n. ${quoteShell(uninstallScript)}`;
  const invoke = (args, executable = '') => run('bash', ['-c', source, 'uninstall-fixture', ...args],
    { timeout: 5000, env: childEnvironment({ FRUITCTL_EXECUTABLE: executable }) });
  for (const rootArgs of [['--install-root', storage], [`--install-root=${storage}`]]) {
    const args = ['--agent', 'junie', '--scope', 'project', '--project-dir',
      path.join(directory, "project '紫'"), ...rootArgs];
    await invoke(args);
    const record = JSON.parse(await fs.readFile(trace, 'utf8'));
    assert.deepEqual(record.args, [launcher, 'uninstall', ...args]);
    assert.equal(record.home, process.env.HOME);
    assert.equal(record.codexHome, process.env.CODEX_HOME);
  }
  const args = ['--install-root', path.join(directory, 'missing root'), '--agent', 'junie'];
  await invoke(args, alternate);
  assert.deepEqual(JSON.parse(await fs.readFile(trace, 'utf8')).args, [alternate, 'uninstall', ...args]);
  await fs.unlink(trace);
  for (const args of [
    ['--install-root', path.join(directory, 'missing root')],
    ['--install-root'], ['--install-root='], ['--install-root', 'relative'],
  ]) {
    await assert.rejects(invoke(args), error => {
      assert.match(error.stderr, /installed launcher missing|Missing value|nonempty absolute directory/);
      return true;
    });
    await absent(trace);
  }
});
