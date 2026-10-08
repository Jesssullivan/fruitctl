import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agentManifest, resolveAdapter, serverEntry, renderIntegration } from './adapters.mjs';
import { jsonEntry, patchJsonEntry, tomlEntry, patchTomlEntry, ownedFieldsMatch } from './config.mjs';
import { validateVersion, validateRuntimeModes, validateInstallerCapabilities, resolveRelease, extractRuntime, sha256 } from './release.mjs';
import { resolveInstallLayout, assertRootIdentity, readRootDescriptor, ensureInstallRoot, recoverNewInstallRoot, readPrivateJson, registrationIdentity, assertRegistrationIdentity, registrationPathGuards, assertRegistrationPaths, assertStoragePath } from './roots.mjs';

export { renderIntegration };
export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const installerCapabilities = Object.freeze({ installRoot: 1 });

async function statMaybe(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function readMaybe(file, ctx) {
  try {
    const bytes = await fs.readFile(file);
    if (!ctx?.layout.explicit) return bytes.toString('utf8');
    // Fatal decoding prevents a pristine backup from replacing invalid input
    // bytes with U+FFFD. Keep BOM handling identical to Buffer's UTF8 decode.
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error(`Agent configuration is not valid UTF-8; refusing to change its bytes: ${file}`); }
  } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}
async function jsonMaybe(file) { const text = await readMaybe(file); return text === undefined ? undefined : JSON.parse(text); }
async function linkMaybe(file) { const stat = await statMaybe(file); return stat?.isSymbolicLink() ? path.resolve(path.dirname(file), await fs.readlink(file)) : undefined; }

async function assertInstallIdentity(ctx, file) {
  if (!ctx?.layout.explicit) return;
  await assertRootIdentity(ctx.layout);
  await readRootDescriptor(ctx.layout);
  await assertRegistrationIdentity(ctx.registration);
  await assertRegistrationPaths(ctx.registrationGuards);
  if (file) await assertStoragePath(file, ctx.layout);
}
async function unlinkOwned(file, ctx) { await assertInstallIdentity(ctx, file); await fs.unlink(file); }
async function receiptJson(file, ctx) { return ctx.layout.explicit ? readPrivateJson(file, ctx.layout) : jsonMaybe(file); }
function rootResult(ctx) { return ctx.layout.explicit ? { rootSelection: ctx.layout.rootSelection } : {}; }

async function atomicWrite(file, data, mode = 0o600, ctx) {
  await assertInstallIdentity(ctx, file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertInstallIdentity(ctx, file);
  const temp = `${file}.fruitctl-${randomBytes(8).toString('hex')}`;
  try {
    if (ctx?.layout.explicit) {
      const handle = await fs.open(temp, 'wx', mode);
      try {
        await handle.writeFile(data);
        await assertInstallIdentity(ctx, temp);
        // Creation applies the caller's umask. Restore the requested mode on
        // this exclusively opened inode before it replaces the owned file.
        await handle.chmod(mode);
      } finally { await handle.close(); }
    } else await fs.writeFile(temp, data, { mode, flag: 'wx' });
    await assertInstallIdentity(ctx, file);
    await fs.rename(temp, file);
  }
  finally { await assertInstallIdentity(ctx, temp); await fs.rm(temp, { force: true }); }
}

async function atomicLink(file, target, ctx) {
  await assertInstallIdentity(ctx, file);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await assertInstallIdentity(ctx, file);
  const temp = `${file}.fruitctl-${randomBytes(8).toString('hex')}`;
  try { await fs.symlink(target, temp); await assertInstallIdentity(ctx, file); await fs.rename(temp, file); }
  finally { await assertInstallIdentity(ctx, temp); await fs.rm(temp, { force: true }); }
}

async function recoverableChange(files, change, ctx) {
  await assertInstallIdentity(ctx);
  const snapshots = [];
  for (const file of new Set(files)) {
    const stat = await statMaybe(file);
    if (!stat) snapshots.push({ file });
    else if (stat.isSymbolicLink()) snapshots.push({ file, target: await fs.readlink(file) });
    else if (stat.isFile()) snapshots.push({ file, data: await fs.readFile(file), mode: stat.mode & 0o777 });
    else throw new Error(`Recovery path is not a regular file or link: ${file}`);
  }
  try { return await change(); }
  catch (error) {
    for (const snapshot of snapshots.reverse()) {
      try {
        const current = await statMaybe(snapshot.file);
        if (snapshot.target !== undefined) {
          if (!current?.isSymbolicLink() || await fs.readlink(snapshot.file) !== snapshot.target) await atomicLink(snapshot.file, snapshot.target, ctx);
        }
        else if (snapshot.data !== undefined) {
          if (!current?.isFile() || (current.mode & 0o777) !== snapshot.mode || !(await fs.readFile(snapshot.file)).equals(snapshot.data)) await atomicWrite(snapshot.file, snapshot.data, snapshot.mode, ctx);
        }
        else { await assertInstallIdentity(ctx, snapshot.file); await fs.rm(snapshot.file, { force: true }); }
      } catch (restoreError) { error.message += `; recovery could not restore ${snapshot.file}: ${restoreError.message}`; }
    }
    throw error;
  }
}

async function managedReason(file) {
  const stat = await statMaybe(file);
  if (stat?.isSymbolicLink()) {
    const target = await linkMaybe(file);
    if (target?.startsWith('/nix/store/')) return `Home Manager/store-managed symlink: ${file}`;
    return `Symlinked config requires a declarative merge: ${file}`;
  }
  if (stat && !stat.isFile()) return `Configuration is not a regular file: ${file}`;
  if (stat && process.getuid && stat.uid !== process.getuid()) return `Configuration is owned by another user: ${file}`;
  for (let ancestor = path.dirname(file); ancestor !== path.dirname(ancestor); ancestor = path.dirname(ancestor)) {
    try { if ((await fs.realpath(ancestor)).startsWith('/nix/store/')) return `Immutable managed parent: ${ancestor}`; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  if (stat && !(stat.mode & 0o200)) return `Read-only managed config: ${file}`;
  return undefined;
}

async function context(options = {}, needsVersion = false) {
  if (needsVersion && options.installRoot !== undefined && !['user', 'project'].includes(options.scope)) throw new Error('Explicit install root requires an explicit user or project scope');
  const home = path.resolve(options.home || os.homedir());
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const scope = options.scope || 'user';
  const env = options.env || process.env;
  const layout = await resolveInstallLayout({ installRoot: options.installRoot, home });
  const { stateRoot, releasesRoot, launcherPath } = layout;
  const platform = options.platform || process.platform, arch = options.arch || process.arch;
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported controller ${platform}/${arch}; v1 uses Linux SSH bridge or Darwin`);
  const id = `${options.agent}-${scope}-${sha256(scope === 'project' ? projectDir : home).slice(0, 16)}`;
  const receiptPath = path.join(stateRoot, 'receipts', `${id}.json`);
  // Recovery routes belong to the selected receipt. Resolve them before an
  // unrelated invoking override/default can trigger ambiguity or redirect work.
  const recorded = layout.explicit && !needsVersion ? await readPrivateJson(receiptPath, layout) : undefined;
  let adapter;
  if (recorded) {
    if (recorded.schema !== 'fruitctl.install.v2' || recorded.id !== id || recorded.agent !== options.agent || recorded.scope !== scope || recorded.registration?.home !== home || recorded.registration?.projectDir !== recorded.projectDir || scope === 'project' && recorded.projectDir !== projectDir) throw new Error('Install receipt registration identity mismatch');
    validateRegistrationRouting(recorded.registration, options.agent, scope);
    adapter = resolveAdapter({ agent: options.agent, scope, home, projectDir, env: recorded.registration.routing.env });
  } else if (layout.explicit && !needsVersion) {
    const definition = Object.hasOwn(agentManifest.agents, options.agent || '') ? agentManifest.agents[options.agent] : undefined;
    if (!definition || !['user', 'project'].includes(scope)) return resolveAdapter({ agent: options.agent, scope, home, projectDir, env });
    const base = scope === 'user' ? home : projectDir;
    adapter = { ...definition, agent: options.agent, scope, configPath: path.resolve(base, definition.config[scope]), skillPath: path.resolve(base, definition.skill[scope]) };
  } else adapter = resolveAdapter({ agent: options.agent, scope, home, projectDir, env });
  let version = options.version;
  if (needsVersion && !version) version = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  if (version) validateVersion(version);
  const prefix = version ? path.join(releasesRoot, version, `${platform}-${arch}`) : undefined;
  const registration = layout.explicit ? recorded?.registration || { home, projectDir, configPath: adapter.configPath, skillPath: adapter.skillPath, routing: registrationRouting(options.agent, scope, env), ...(scope === 'project' ? { projectIdentity: await registrationIdentity(projectDir) } : {}) } : undefined;
  if (layout.explicit && (needsVersion || recorded)) {
    const recordedAdapter = resolveAdapter({ agent: options.agent, scope, home, projectDir, env: registration.routing.env });
    if (!path.isAbsolute(adapter.configPath) || !path.isAbsolute(adapter.skillPath) || recordedAdapter.configPath !== adapter.configPath || recordedAdapter.skillPath !== adapter.skillPath) throw new Error('Explicit root registration paths must resolve through supported absolute adapter routing');
  }
  const ctx = { ...options, env, home, projectDir, scope, adapter, layout, registration, installing: needsVersion, stateRoot, releasesRoot, platform, arch, id, version, prefix, receiptPath, executable: prefix ? path.join(prefix, 'bin/fruitctl') : undefined, launcherPath };
  if (recorded) { validateReceipt(recorded, ctx); await assertRegistrationIdentity(recorded.registration); }
  ctx.registrationGuards = layout.explicit ? await registrationPathGuards(registration) : undefined;
  return ctx;
}

const routingKeys = { claude: ['CLAUDE_CONFIG_DIR'], opencode: ['OPENCODE_CONFIG', 'XDG_CONFIG_HOME'], kimi: ['KIMI_CODE_HOME'], codex: ['CODEX_HOME'], pi: ['PI_CODING_AGENT_DIR'], vscode: ['COPILOT_HOME'] };
function registrationRouting(agent, scope, env) {
  const selected = {};
  for (const key of scope === 'user' ? routingKeys[agent] || [] : []) if (env[key]) selected[key] = path.resolve(env[key]);
  return { env: selected };
}
function validateRegistrationRouting(reg, agent, scope) {
  const normalized = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
  if (!reg?.routing || Object.keys(reg.routing).length !== 1 || !reg.routing.env || typeof reg.routing.env !== 'object' || Array.isArray(reg.routing.env) || Object.entries(reg.routing.env).some(([key, value]) => !(scope === 'user' ? routingKeys[agent] || [] : []).includes(key) || !normalized(value))) throw new Error('Invalid install receipt registration routing');
}

function readEntry(text, adapter) {
  if (adapter.config.format === 'json' && text !== undefined) JSON.parse(text);
  return adapter.config.format === 'toml' ? tomlEntry(text || '') : jsonEntry(text || '{}', adapter.config.container);
}
function patchEntry(text, adapter, entry) { return adapter.config.format === 'toml' ? patchTomlEntry(text || '', entry) : patchJsonEntry(text || '{}\n', adapter.config.container, entry); }
function desiredEntry(ctx, current) {
  return ctx.adapter.config.format === 'toml'
    ? renderIntegration({ agent: ctx.agent, executable: ctx.executable, target: ctx.target, configPath: ctx.configPath || ctx.env.FRUITCTL_CONFIG_PATH })
    : serverEntry({ agent: ctx.agent, executable: ctx.executable, target: ctx.target, existing: current, configPath: ctx.configPath || ctx.env.FRUITCTL_CONFIG_PATH });
}

async function receiptFor(ctx) {
  await assertInstallIdentity(ctx);
  const receipt = await receiptJson(ctx.receiptPath, ctx);
  if (receipt) {
    validateReceipt(receipt, ctx);
    if (ctx.layout.explicit) {
      await assertRegistrationIdentity(receipt.registration);
      if (!ctx.installing) {
        ctx.registration = receipt.registration;
        ctx.adapter = { ...ctx.adapter, configPath: receipt.config.path, skillPath: receipt.skill.path };
        ctx.registrationGuards = await registrationPathGuards(receipt.registration);
      }
    }
  }
  else if (ctx.scope === 'project') {
    const realpathMaybe = async directory => {
      try { return await fs.realpath(directory); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    };
    const project = await realpathMaybe(ctx.projectDir);
    if (project) for (const { receipt: other } of await activeReceipts(ctx)) {
      if (other.agent === ctx.agent && other.scope === 'project' &&
          await realpathMaybe(other.projectDir) === project) {
        // Keep legacy receipt identities and recovery paths unchanged. An alias
        // must not adopt installed bytes as a second installation's baseline.
        throw new Error(`Project aliases an existing ${ctx.agent} installation; use the recorded project path: ${other.projectDir}`);
      }
    }
  }
  else if (!receipt && ctx.layout.explicit) await activeReceipts(ctx);
  return receipt;
}

function validateReceipt(receipt, ctx) {
  if (!receipt || receipt.schema !== (ctx.layout.explicit ? 'fruitctl.install.v2' : 'fruitctl.install.v1') || receipt.id !== ctx.id || receipt.agent !== ctx.agent || receipt.scope !== ctx.scope || receipt.projectDir !== ctx.projectDir && ctx.scope === 'project') throw new Error('Install receipt identity mismatch');
  validateVersion(receipt.version);
  const normalized = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
  const under = (value, directory) => normalized(value) && value.startsWith(`${directory}${path.sep}`);
  if (ctx.layout.explicit) {
    if (!receipt.operationalRoot || Object.entries(ctx.layout.binding).some(([key, value]) => receipt.operationalRoot[key] !== value)) throw new Error('Install receipt operational root identity mismatch');
    const reg = receipt.registration;
    if (!reg || reg.home !== ctx.home || reg.projectDir !== receipt.projectDir || !normalized(reg.home) || !normalized(reg.projectDir) || !normalized(reg.configPath) || !normalized(reg.skillPath) || reg.configPath !== receipt.config?.path || reg.skillPath !== receipt.skill?.path || receipt.scope === 'project' && !reg.projectIdentity) throw new Error('Install receipt registration destination identity mismatch');
    validateRegistrationRouting(reg, receipt.agent, receipt.scope);
    const recordedAdapter = resolveAdapter({ agent: receipt.agent, scope: receipt.scope, home: reg.home, projectDir: reg.projectDir, env: reg.routing.env });
    if (recordedAdapter.configPath !== reg.configPath || recordedAdapter.skillPath !== reg.skillPath) throw new Error('Install receipt registration destinations do not match bound adapter routing');
    if (!receipt.runtime?.modes) throw new Error('Explicit root receipt requires runtime modes');
    if (receipt.runtime.schema !== 'fruitctl.runtime.v1' || receipt.runtime.platform !== ctx.platform || receipt.runtime.arch !== ctx.arch) throw new Error('Explicit root receipt runtime platform identity mismatch');
  }
  const prefix = path.join(ctx.releasesRoot, receipt.version, `${ctx.platform}-${ctx.arch}`);
  if (receipt.prefix !== prefix || !receipt.runtime || receipt.runtime.version !== receipt.version || !/^[a-f0-9]{64}$/.test(receipt.runtime.archiveSha256 || '') || !/^[a-f0-9]{64}$/.test(receipt.runtime.manifestSha256 || '')) throw new Error('Install receipt runtime identity mismatch');
  const required = ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md', ...(ctx.layout.explicit ? ['package.json'] : [])];
  if (!receipt.runtime.files || required.some(file => !Object.hasOwn(receipt.runtime.files, file)) || Object.entries(receipt.runtime.files).some(([file, digest]) => path.isAbsolute(file) || path.normalize(file) !== file || file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(digest || ''))) throw new Error('Invalid install receipt runtime inventory');
  validateRuntimeModes(receipt.runtime);
  if (!receipt.config || !normalized(receipt.config.path) || receipt.config.format !== ctx.adapter.config.format || typeof receipt.config.owned !== 'boolean' || typeof receipt.config.baseExisted !== 'boolean' || receipt.config.baseBackupPath && !under(receipt.config.baseBackupPath, path.join(ctx.stateRoot, 'backups'))) throw new Error('Invalid install receipt configuration');
  if (ctx.layout.explicit && (receipt.config.baseExisted ? !receipt.config.baseBackupPath || !Number.isInteger(receipt.config.baseMode) || receipt.config.baseMode < 0 || receipt.config.baseMode > 0o777 || !/^[a-f0-9]{64}$/.test(receipt.config.baseBackupSha256 || '') : receipt.config.baseMode !== null || receipt.config.baseBackupSha256 !== null || receipt.config.baseBackupPath !== null)) throw new Error('Invalid bound original configuration backup/mode');
  if (!receipt.skill || !normalized(receipt.skill.path) || receipt.skill.target !== path.join(prefix, 'skills/fruitctl') || typeof receipt.skill.owned !== 'boolean' || receipt.skill.originalTarget !== null && !normalized(receipt.skill.originalTarget)) throw new Error('Invalid install receipt skill');
  if (!receipt.launcher || receipt.launcher.path !== ctx.launcherPath || !under(receipt.launcher.target, ctx.releasesRoot) || !receipt.launcher.target.endsWith('/bin/fruitctl') || typeof receipt.launcher.owned !== 'boolean' || receipt.launcher.originalTarget !== null && !normalized(receipt.launcher.originalTarget)) throw new Error('Invalid install receipt launcher');
  if (ctx.layout.explicit) {
    const launcher = path.relative(ctx.releasesRoot, receipt.launcher.target).split(path.sep);
    if (launcher.length !== 4 || launcher[1] !== `${ctx.platform}-${ctx.arch}` || launcher[2] !== 'bin' || launcher[3] !== 'fruitctl') throw new Error('Invalid bound install receipt launcher target');
    validateVersion(launcher[0]);
    if (!/^[a-f0-9]{64}$/.test(receipt.config.afterHash || '') || typeof receipt.config.basePristine !== 'boolean') throw new Error('Invalid bound configuration recovery hash');
  }
  if (receipt.previousReceipt !== null && !under(receipt.previousReceipt, path.join(ctx.stateRoot, 'history'))) throw new Error('Invalid install receipt history path');
  return receipt;
}

async function activeReceipts(ctx) {
  await assertInstallIdentity(ctx);
  const directory = path.join(ctx.stateRoot, 'receipts');
  let files;
  try { files = await fs.readdir(directory); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return Promise.all(files.filter(file => file.endsWith('.json')).map(async file => {
    const receipt = await receiptJson(path.join(directory, file), ctx);
    if (!receipt || !Object.hasOwn(agentManifest.agents, receipt.agent || '') || !['user', 'project'].includes(receipt.scope) || typeof receipt.projectDir !== 'string' || file !== `${receipt.id}.json`) throw new Error('Invalid install receipt');
    const other = await context({ home: ctx.layout.explicit ? receipt.registration?.home : ctx.home, installRoot: ctx.layout.explicit ? ctx.layout.requestedRoot : undefined, projectDir: receipt.projectDir, agent: receipt.agent, scope: receipt.scope, env: ctx.layout.explicit ? receipt.registration?.routing?.env || {} : ctx.env, platform: ctx.platform, arch: ctx.arch });
    validateReceipt(receipt, other);
    if (ctx.layout.explicit) await assertRegistrationIdentity(receipt.registration);
    return { file: path.join(directory, file), receipt };
  }));
}

async function locked(ctx, fn) {
  await assertInstallIdentity(ctx);
  try { await ensureInstallRoot(ctx.layout); }
  catch (error) {
    try { await recoverNewInstallRoot(ctx.layout); }
    catch (cleanupError) { error.message += `; first-install recovery refused: ${cleanupError.message}`; }
    throw error;
  }
  await assertInstallIdentity(ctx);
  await fs.mkdir(ctx.stateRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(ctx.stateRoot, 'transaction.lock');
  let handle;
  try { await assertInstallIdentity(ctx, lock); handle = await fs.open(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another Fruitctl install transaction holds the lock; inspect its receipt before retrying'); throw e; }
  const lockIdentity = await handle.stat();
  let failure;
  try { await assertInstallIdentity(ctx, lock); await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n'); return await fn(); }
  catch (error) { failure = error; throw error; }
  finally {
    await handle.close();
    try {
      // The lock belongs to the storage transaction, independent of whether a
      // registration project still exists. A replaced root/alias cannot direct
      // this cleanup at another namespace or another transaction's lock.
      await assertRootIdentity(ctx.layout);
      await readRootDescriptor(ctx.layout);
      await assertStoragePath(lock, ctx.layout);
      const current = await statMaybe(lock);
      if (!current?.isFile() || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino || current.uid !== lockIdentity.uid) throw new Error('Owned transaction lock identity changed; cleanup refused');
      await fs.unlink(lock);
      if (failure) await recoverNewInstallRoot(ctx.layout);
    } catch (cleanupError) {
      if (!failure) throw cleanupError;
      failure.message += `; transaction cleanup refused: ${cleanupError.message}`;
    }
  }
}

async function planInstall(ctx) {
  const previous = await receiptFor(ctx);
  const text = await readMaybe(ctx.adapter.configPath, ctx);
  let managed = await managedReason(ctx.adapter.configPath);
  if (previous && (previous.config.path !== ctx.adapter.configPath || previous.skill.path !== ctx.adapter.skillPath)) managed ||= 'Recorded installation uses a different MCP or skill destination; uninstall that installation before selecting another path, or apply the fragment through its owning configuration surface';
  if (ctx.agent === 'claude' && ctx.scope === 'user' && ctx.env.CLAUDE_CONFIG_DIR) managed ||= 'Custom CLAUDE_CONFIG_DIR: apply the generated MCP fragment through that account\'s configuration surface or use project scope';
  if (ctx.agent === 'vscode' && ctx.scope === 'project') {
    const legacy = path.join(ctx.projectDir, '.vscode/mcp.json');
    const legacyText = await readMaybe(legacy, ctx);
    if (legacyText !== undefined && jsonEntry(legacyText, ['servers']) !== undefined) managed ||= `Existing VS Code legacy MCP entry requires its owning configuration surface: ${legacy}`;
  }
  const current = readEntry(text, ctx.adapter);
  const expected = desiredEntry(ctx, current);
  const configOwned = previous?.config.owned || current === undefined;
  if (!managed && current !== undefined && !ownedFieldsMatch(current, previous?.config.owned ? previous.config.expectedEntry : expected, ctx.agent)) throw new Error(`Existing fruitctl MCP entry is user-owned or changed: ${ctx.adapter.configPath}; refusing to replace it`);
  const skillTarget = path.join(ctx.prefix, 'skills/fruitctl');
  const skillStat = await statMaybe(ctx.adapter.skillPath), skillLink = await linkMaybe(ctx.adapter.skillPath);
  let skillManaged;
  if (skillStat && !(skillLink === skillTarget || previous?.skill.owned && skillLink === previous.skill.target)) skillManaged = `Existing skill requires a declarative merge: ${ctx.adapter.skillPath}`;
  const launcherStat = await statMaybe(ctx.launcherPath), launcherLink = await linkMaybe(ctx.launcherPath);
  const receipts = await activeReceipts(ctx);
  if (receipts.some(row => row.receipt.id !== ctx.id && row.receipt.config.path === ctx.adapter.configPath && !ownedFieldsMatch(row.receipt.config.expectedEntry, expected, ctx.agent))) managed ||= 'Another harness shares this MCP file and owns a different Fruitctl entry; update through the common configuration surface';
  const launcherOwner = receipts.find(row => row.receipt?.launcher?.path === ctx.launcherPath && row.receipt.launcher.owned && row.receipt.launcher.target === launcherLink);
  const launcherOwnedBefore = !!launcherOwner;
  let launcherManaged;
  if (launcherStat && !(launcherLink === ctx.executable || launcherOwnedBefore)) launcherManaged = `Existing executable requires a declarative merge: ${ctx.launcherPath}`;
  const snippet = renderIntegration({ agent: ctx.agent, executable: ctx.executable, target: ctx.target, existing: current, configPath: ctx.configPath || ctx.env.FRUITCTL_CONFIG_PATH });
  return { previous, text, current, expected, configOwned, skillTarget, skillStat, skillLink, launcherStat, launcherLink, launcherOwnedBefore, launcherOwner, managed: [managed, skillManaged, launcherManaged].filter(Boolean), snippet };
}

export async function install(options = {}, dependencies = {}) {
  const ctx = await context(options, true);
  const plan = await planInstall(ctx);
  const summary = { action: 'install', agent: ctx.agent, scope: ctx.scope, version: ctx.version, target: ctx.target, prefix: ctx.prefix, configPath: ctx.adapter.configPath, skillPath: ctx.adapter.skillPath, launcherPath: ctx.launcherPath, snippet: plan.snippet, ...rootResult(ctx), qualification: 'configuration only; MCP/image/input acceptance has not been run', ...(ctx.agent === 'junie' ? { ideSettingsSnippet: plan.snippet } : {}) };
  if (plan.managed.length) return { ...summary, status: 'declarative-required', dryRun: !!ctx.dryRun, reasons: plan.managed };
  if (ctx.dryRun) return { ...summary, status: 'planned', dryRun: true, releaseUrl: `https://github.com/xoxd-ai/fruitctl/releases/tag/${ctx.version}`, writes: [ctx.prefix, ctx.adapter.configPath, ctx.adapter.skillPath, ctx.launcherPath, ctx.receiptPath] };
  return locked(ctx, async () => {
    const currentPlan = await planInstall(ctx);
    if (currentPlan.managed.length) throw new Error(currentPlan.managed.join('; '));
    const release = await resolveRelease(ctx, dependencies);
    const guardCache = async () => {
      await assertInstallIdentity(ctx, path.join(ctx.prefix, '.fruitctl-runtime.json'));
      if (ctx.layout.explicit && await statMaybe(ctx.prefix)) await readPrivateJson(path.join(ctx.prefix, '.fruitctl-runtime.json'), ctx.layout);
    };
    await guardCache();
    const runtime = await extractRuntime(release, ctx.prefix, ctx.layout.explicit ? { requiredCapabilities: installerCapabilities, beforeMutation: guardCache } : undefined);
    await assertInstallIdentity(ctx, ctx.prefix);
    const transaction = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const backupPath = path.join(ctx.stateRoot, 'backups', `${ctx.id}-${transaction}.config`);
    const historyPath = path.join(ctx.stateRoot, 'history', `${ctx.id}-${transaction}.json`);
    const nowManaged = await managedReason(ctx.adapter.configPath);
    if (nowManaged) throw new Error(`Agent configuration became managed during release download: ${nowManaged}`);
    const configStat = await statMaybe(ctx.adapter.configPath);
    const configMode = configStat ? configStat.mode & 0o777 : 0o600;
    const nextText = currentPlan.configOwned ? patchEntry(currentPlan.text, ctx.adapter, currentPlan.expected) : currentPlan.text;
    if (await readMaybe(ctx.adapter.configPath, ctx) !== currentPlan.text || await linkMaybe(ctx.adapter.skillPath) !== currentPlan.skillLink || await linkMaybe(ctx.launcherPath) !== currentPlan.launcherLink) throw new Error('Agent configuration changed during release download; retry after reviewing that edit');
    if (currentPlan.text !== undefined) await atomicWrite(backupPath, currentPlan.text, 0o600, ctx);
    if (currentPlan.previous) await atomicWrite(historyPath, JSON.stringify(currentPlan.previous, null, 2) + '\n', 0o600, ctx);
    const undo = [];
    try {
      if (currentPlan.configOwned) {
        await atomicWrite(ctx.adapter.configPath, nextText, configMode, ctx);
        undo.push(async () => currentPlan.text === undefined ? unlinkOwned(ctx.adapter.configPath, ctx) : atomicWrite(ctx.adapter.configPath, currentPlan.text, configMode, ctx));
      }
      if (currentPlan.skillLink !== currentPlan.skillTarget) {
        await atomicLink(ctx.adapter.skillPath, currentPlan.skillTarget, ctx);
        undo.push(async () => currentPlan.skillLink ? atomicLink(ctx.adapter.skillPath, currentPlan.skillLink, ctx) : unlinkOwned(ctx.adapter.skillPath, ctx));
      }
      if (currentPlan.launcherLink !== ctx.executable) {
        await atomicLink(ctx.launcherPath, ctx.executable, ctx);
        undo.push(async () => currentPlan.launcherLink ? atomicLink(ctx.launcherPath, currentPlan.launcherLink, ctx) : unlinkOwned(ctx.launcherPath, ctx));
      }
      const receipt = {
        schema: ctx.layout.explicit ? 'fruitctl.install.v2' : 'fruitctl.install.v1', ...(ctx.layout.explicit ? { operationalRoot: ctx.layout.binding, registration: ctx.registration } : {}), id: ctx.id, agent: ctx.agent, scope: ctx.scope, projectDir: ctx.projectDir, version: ctx.version, target: ctx.target, prefix: ctx.prefix, installedAt: new Date().toISOString(), runtime,
        previousReceipt: currentPlan.previous ? historyPath : null,
        config: { path: ctx.adapter.configPath, format: ctx.adapter.config.format, owned: currentPlan.configOwned, expectedEntry: currentPlan.expected, originalEntry: currentPlan.previous ? currentPlan.previous.config.originalEntry : currentPlan.current ?? null, baseBackupPath: currentPlan.previous ? currentPlan.previous.config.baseBackupPath : currentPlan.text === undefined ? null : backupPath, baseExisted: currentPlan.previous ? currentPlan.previous.config.baseExisted : currentPlan.text !== undefined, ...(ctx.layout.explicit ? { baseMode: currentPlan.previous ? currentPlan.previous.config.baseMode : configStat ? configMode : null, baseBackupSha256: currentPlan.previous ? currentPlan.previous.config.baseBackupSha256 : currentPlan.text === undefined ? null : sha256(currentPlan.text) } : {}), basePristine: !currentPlan.previous || currentPlan.previous.config.basePristine !== false && sha256(currentPlan.text || '') === currentPlan.previous.config.afterHash, afterHash: sha256(nextText || '') },
        skill: { path: ctx.adapter.skillPath, target: currentPlan.skillTarget, owned: currentPlan.previous?.skill.owned || !currentPlan.skillStat, originalTarget: currentPlan.previous ? currentPlan.previous.skill.originalTarget : currentPlan.skillLink ?? null },
        launcher: { path: ctx.launcherPath, target: ctx.executable, owned: currentPlan.previous?.launcher.owned || !currentPlan.launcherStat || currentPlan.launcherOwnedBefore, originalTarget: currentPlan.previous ? currentPlan.previous.launcher.originalTarget : currentPlan.launcherOwner ? currentPlan.launcherOwner.receipt.launcher.originalTarget : currentPlan.launcherLink ?? null }
      };
      validateReceipt(receipt, ctx);
      await atomicWrite(ctx.receiptPath, JSON.stringify(receipt, null, 2) + '\n', 0o600, ctx);
      return { ...summary, status: 'installed', dryRun: false, receiptPath: ctx.receiptPath };
    } catch (error) {
      for (const reverse of undo.reverse()) { try { await reverse(); } catch (undoError) { error.message += `; rollback failed: ${undoError.message}`; } }
      throw error;
    }
  });
}

export async function doctor(options = {}) {
  if (!options.agent) {
    const home = path.resolve(options.home || os.homedir());
    const layout = await resolveInstallLayout({ home, installRoot: options.installRoot });
    const aggregate = { home, layout, stateRoot: layout.stateRoot, env: options.env || process.env, platform: options.platform || process.platform, arch: options.arch || process.arch };
    const installations = [];
    for (const { receipt } of await activeReceipts(aggregate)) {
      installations.push(await doctor({ ...options, home: layout.explicit ? receipt.registration.home : home, agent: receipt.agent,
        scope: receipt.scope, projectDir: receipt.projectDir }));
    }
    return { action: 'doctor', status: installations.length ?
      (installations.every(value => value.status === 'configured') ? 'configured' : 'drift') : 'not-installed',
      installations, ...rootResult(aggregate), qualification: 'Configuration checks only; runtime and target behavior unverified' };
  }
  const ctx = await context(options);
  const receipt = await receiptFor(ctx);
  if (!receipt) return { action: 'doctor', status: 'not-installed', agent: ctx.agent, scope: ctx.scope, checks: [], ...rootResult(ctx), qualification: 'No install receipt; runtime behavior unverified' };
  const checks = [];
  try {
    const reason = await managedReason(receipt.config.path);
    const current = readEntry(await readMaybe(receipt.config.path, ctx), ctx.adapter);
    checks.push({ name: 'owned MCP config', ok: !reason && ownedFieldsMatch(current, receipt.config.expectedEntry, ctx.agent), detail: reason });
  } catch (e) { checks.push({ name: 'owned MCP config', ok: false, detail: e.message }); }
  checks.push({ name: 'skill link', ok: await linkMaybe(receipt.skill.path) === receipt.skill.target });
  const launcherTarget = await linkMaybe(receipt.launcher.path);
  const launcherKnown = launcherTarget === receipt.launcher.target || (await activeReceipts(ctx)).some(row => row.receipt.launcher.owned && row.receipt.launcher.path === receipt.launcher.path && row.receipt.launcher.target === launcherTarget);
  checks.push({ name: 'launcher link', ok: launcherKnown, detail: launcherTarget !== receipt.launcher.target && launcherKnown ? 'Shared convenience launcher belongs to another recorded harness version; this MCP entry remains pinned' : undefined });
  try {
    if (ctx.layout.explicit) await checkTargetCapabilities(receipt, ctx);
    const identity = await runtimeIdentity(receipt, ctx);
    checks.push({ name: 'pinned runtime identity', ok: identity?.archiveSha256 === receipt.runtime.archiveSha256 && identity?.manifestSha256 === receipt.runtime.manifestSha256 });
    for (const [relative, digest] of Object.entries(receipt.runtime.files || {})) {
      if (path.isAbsolute(relative) || relative.split('/').includes('..') || path.normalize(relative) !== relative || !/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid runtime file inventory');
      const file = path.join(receipt.prefix, relative);
      await assertInstallIdentity(ctx, file);
      const stat = await statMaybe(file);
      const regular = stat?.isFile() === true;
      const modeMatches = receipt.runtime.modes === undefined || (stat?.mode & 0o777) === receipt.runtime.modes[relative];
      checks.push({ name: relative, ok: regular && modeMatches && digest === sha256(await fs.readFile(file)) });
    }
  } catch (e) { checks.push({ name: 'pinned runtime identity', ok: false, detail: e.message }); }
  return { action: 'doctor', status: checks.every(check => check.ok) ? 'configured' : 'drift', agent: ctx.agent, scope: ctx.scope, version: receipt.version, target: receipt.target, checks, ...rootResult(ctx), qualification: 'Configuration checks only; no agent, GUI, MCP or target connection was launched' };
}

async function restoreConfig(ctx, receipt, desired, fullBackup = false) {
  const reason = await managedReason(receipt.config.path);
  if (reason) throw new Error(reason);
  const text = await readMaybe(receipt.config.path, ctx);
  const current = readEntry(text, ctx.adapter);
  if (!ownedFieldsMatch(current, receipt.config.expectedEntry, ctx.agent)) throw new Error('Fruitctl MCP entry changed after installation; refusing to remove or roll it back');
  if (!receipt.config.owned) return;
  if (fullBackup && receipt.config.basePristine !== false && sha256(text || '') === receipt.config.afterHash) {
    if (!receipt.config.baseExisted) { await unlinkOwned(receipt.config.path, ctx); return; }
    await atomicWrite(receipt.config.path, await fs.readFile(receipt.config.baseBackupPath), ctx.layout.explicit ? receipt.config.baseMode : (await fs.stat(receipt.config.path)).mode & 0o777, ctx); return;
  }
  if (ctx.agent !== 'codex' && desired && typeof desired === 'object') {
    desired = { ...desired };
    for (const key of ctx.agent === 'junie' ? ['enabled', 'disabled'] : ctx.agent === 'opencode' ? ['enabled'] : []) if (typeof current?.[key] === 'boolean') desired[key] = current[key];
  }
  const mode = (await fs.stat(receipt.config.path)).mode & 0o777;
  await atomicWrite(receipt.config.path, patchEntry(text, ctx.adapter, desired), mode, ctx);
}

async function restoreLink(item, target, ctx) {
  if (!item.owned) return;
  if (await linkMaybe(item.path) !== item.target) throw new Error(`Owned ${item.path} changed; refusing to remove or roll it back`);
  if (target) await atomicLink(item.path, target, ctx); else await unlinkOwned(item.path, ctx);
}

async function checkOwnedState(ctx, receipt, others = []) {
  await assertInstallIdentity(ctx);
  if (ctx.layout.explicit && receipt.config.baseExisted) {
    await assertStoragePath(receipt.config.baseBackupPath, ctx.layout);
    const stat = await statMaybe(receipt.config.baseBackupPath);
    if (!stat?.isFile() || process.getuid && stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || sha256(await fs.readFile(receipt.config.baseBackupPath)) !== receipt.config.baseBackupSha256) throw new Error('Original configuration backup hash/mode/ownership changed');
  }
  const shared = name => others.some(row => row.receipt[name]?.path === receipt[name].path);
  if (receipt.config.owned && !shared('config')) {
    const reason = await managedReason(receipt.config.path);
    if (reason) throw new Error(reason);
    const current = readEntry(await readMaybe(receipt.config.path, ctx), ctx.adapter);
    if (!ownedFieldsMatch(current, receipt.config.expectedEntry, ctx.agent)) throw new Error('Fruitctl MCP entry changed after installation; refusing to remove or roll it back');
    if (receipt.config.baseExisted && !(await statMaybe(receipt.config.baseBackupPath))?.isFile()) throw new Error('Original configuration backup is missing or not a regular file');
  }
  for (const name of ['skill', 'launcher']) if (receipt[name].owned && !shared(name) && await linkMaybe(receipt[name].path) !== receipt[name].target) throw new Error(`Owned ${receipt[name].path} changed; refusing to remove or roll it back`);
  if (shared('launcher')) {
    const target = await linkMaybe(receipt.launcher.path);
    if (![receipt, ...others.map(row => row.receipt)].some(row => row.launcher?.path === receipt.launcher.path && row.launcher.target === target)) throw new Error('Shared launcher changed outside recorded installations; refusing recovery');
  }
}

async function checkTargetCapabilities(receipt, ctx) {
  await assertInstallIdentity(ctx, path.join(receipt.prefix, 'package.json'));
  const packagePath = path.join(receipt.prefix, 'package.json'), stat = await statMaybe(packagePath);
  if (!stat?.isFile() || !receipt.runtime.files['package.json'] || sha256(await fs.readFile(packagePath)) !== receipt.runtime.files['package.json']) throw new Error('Pinned runtime installer capability package is missing or changed');
  validateInstallerCapabilities(JSON.parse(await fs.readFile(packagePath, 'utf8')), installerCapabilities);
}

async function runtimeIdentity(receipt, ctx) {
  const file = path.join(receipt.prefix, '.fruitctl-runtime.json');
  await assertInstallIdentity(ctx, file);
  const identity = await receiptJson(file, ctx);
  if (ctx.layout.explicit && (!identity || ['schema', 'version', 'platform', 'arch', 'archiveSha256', 'manifestSha256'].some(key => identity[key] !== receipt.runtime[key]) || JSON.stringify(identity.files) !== JSON.stringify(receipt.runtime.files) || JSON.stringify(identity.modes) !== JSON.stringify(receipt.runtime.modes))) throw new Error('Pinned runtime inventory identity is missing or changed');
  return identity;
}

async function checkRecordedRuntime(receipt, ctx) {
  if (ctx.layout.explicit) await checkTargetCapabilities(receipt, ctx);
  const identity = await runtimeIdentity(receipt, ctx);
  if (!identity || identity.archiveSha256 !== receipt.runtime.archiveSha256 || identity.manifestSha256 !== receipt.runtime.manifestSha256 || !receipt.runtime.files || !Object.keys(receipt.runtime.files).length) throw new Error('Previous runtime identity is missing or changed; refusing rollback');
  for (const [relative, digest] of Object.entries(receipt.runtime.files)) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Invalid runtime receipt path');
    const file = path.join(receipt.prefix, relative);
    await assertInstallIdentity(ctx, file);
    const stat = await statMaybe(file);
    if (!stat?.isFile() || receipt.runtime.modes !== undefined && (stat.mode & 0o777) !== receipt.runtime.modes[relative] || sha256(await fs.readFile(file)) !== digest) throw new Error(`Previous runtime file is missing or changed: ${relative}; refusing rollback`);
  }
}

export async function uninstall(options = {}) {
  const ctx = await context(options); let receipt = await receiptFor(ctx);
  if (!receipt) return { action: 'uninstall', status: 'not-installed', agent: ctx.agent, scope: ctx.scope, ...rootResult(ctx) };
  if (ctx.dryRun) return { action: 'uninstall', status: 'planned', dryRun: true, receiptPath: ctx.receiptPath, ...rootResult(ctx), preserves: ['verified runtime cache', 'unrelated config settings', 'other agent installations'] };
  return locked(ctx, async () => {
    receipt = await receiptFor(ctx);
    if (!receipt) throw new Error('Install receipt changed while acquiring the transaction lock');
    const others = (await activeReceipts(ctx)).filter(row => row.receipt.id !== ctx.id);
    await checkOwnedState(ctx, receipt, others);
    const transfers = [];
    const restores = [];
    for (const name of ['config', 'skill', 'launcher']) {
      const item = receipt[name];
      const references = others.filter(row => row.receipt[name]?.path === item.path);
      if (references.length) {
        if (item.owned) {
          const inheritor = references[0];
          inheritor.receipt[name] = { ...item, ...inheritor.receipt[name], owned: true };
          if (name === 'config') Object.assign(inheritor.receipt.config, { originalEntry: item.originalEntry, baseBackupPath: item.baseBackupPath, baseExisted: item.baseExisted, ...(ctx.layout.explicit ? { baseMode: item.baseMode, baseBackupSha256: item.baseBackupSha256 } : {}), basePristine: item.basePristine !== false && inheritor.receipt.config.basePristine !== false });
          if (name !== 'config') inheritor.receipt[name].originalTarget = item.originalTarget;
          if (name === 'launcher') inheritor.receipt.launcher.target = await linkMaybe(item.path);
          transfers.push(inheritor);
        }
        continue;
      }
      restores.push(async () => name === 'config' ? restoreConfig(ctx, receipt, item.originalEntry ?? undefined, true) : restoreLink(item, item.originalTarget, ctx));
    }
    return recoverableChange([receipt.config.path, receipt.skill.path, receipt.launcher.path, ctx.receiptPath, ...transfers.map(row => row.file)], async () => {
      for (const restore of restores) await restore();
      for (const transfer of transfers) await atomicWrite(transfer.file, JSON.stringify(transfer.receipt, null, 2) + '\n', 0o600, ctx);
      await unlinkOwned(ctx.receiptPath, ctx);
      return { action: 'uninstall', status: 'removed', agent: ctx.agent, scope: ctx.scope, ...rootResult(ctx), preserves: ['verified runtime cache', 'unrelated config settings', 'other agent installations'] };
    }, ctx);
  });
}

export async function rollback(options = {}) {
  const ctx = await context(options); let receipt = await receiptFor(ctx);
  if (!receipt?.previousReceipt) return { action: 'rollback', status: 'no-previous-install', agent: ctx.agent, scope: ctx.scope, ...rootResult(ctx) };
  let previous = await receiptJson(receipt.previousReceipt, ctx);
  if (!previous || previous.id !== receipt.id) throw new Error('Previous install receipt is missing or mismatched');
  validateReceipt(previous, ctx);
  if (ctx.dryRun) return { action: 'rollback', status: 'planned', dryRun: true, from: receipt.version, to: previous.version, ...rootResult(ctx) };
  return locked(ctx, async () => {
    receipt = await receiptFor(ctx);
    if (!receipt?.previousReceipt) throw new Error('Install receipt changed while acquiring the transaction lock');
    previous = validateReceipt(await receiptJson(receipt.previousReceipt, ctx), ctx);
    if (ctx.layout.explicit) await assertRegistrationIdentity(previous.registration);
    // Validate both privately owned paths before changing either one. The
    // convenience launcher can belong to a different, newer harness install.
    const others = (await activeReceipts(ctx)).filter(row => row.receipt.id !== ctx.id);
    await checkOwnedState(ctx, receipt, others);
    if (others.some(row => row.receipt.config.path === receipt.config.path && !ownedFieldsMatch(row.receipt.config.expectedEntry, previous.config.expectedEntry, ctx.agent) || row.receipt.skill.path === receipt.skill.path && row.receipt.skill.target !== previous.skill.target)) throw new Error('Another harness shares this MCP entry or skill; roll back through the common configuration surface');
    await checkRecordedRuntime(previous, ctx);
    return recoverableChange([receipt.config.path, receipt.skill.path, receipt.launcher.path, ctx.receiptPath], async () => {
    const wasPristine = receipt.config.basePristine !== false && sha256(await readMaybe(receipt.config.path, ctx) || '') === receipt.config.afterHash;
    await restoreConfig(ctx, receipt, previous.config.expectedEntry);
    await restoreLink(receipt.skill, previous.skill.target, ctx);
    // A different harness can have advanced the shared convenience launcher.
    // Its absolute MCP executable is unaffected; preserve that newer launcher.
    if (await linkMaybe(receipt.launcher.path) === receipt.launcher.target) await restoreLink(receipt.launcher, previous.launcher.target, ctx);
    else previous.launcher = { ...receipt.launcher, owned: false };
    previous.config.expectedEntry = readEntry(await readMaybe(previous.config.path, ctx), ctx.adapter);
    previous.config.basePristine = previous.config.basePristine !== false && wasPristine;
    previous.config.afterHash = sha256(await readMaybe(previous.config.path, ctx) || '');
    await atomicWrite(ctx.receiptPath, JSON.stringify(previous, null, 2) + '\n', 0o600, ctx);
    return { action: 'rollback', status: 'rolled-back', from: receipt.version, to: previous.version, ...rootResult(ctx) };
    }, ctx);
  });
}
