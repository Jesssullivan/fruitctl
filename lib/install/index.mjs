import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agentManifest, resolveAdapter, serverEntry, renderIntegration } from './adapters.mjs';
import { jsonEntry, patchJsonEntry, tomlEntry, patchTomlEntry, ownedFieldsMatch } from './config.mjs';
import { validateVersion, validateRuntimeModes, resolveRelease, extractRuntime, sha256 } from './release.mjs';

export { renderIntegration };
export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));

async function statMaybe(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function readMaybe(file) { try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
async function jsonMaybe(file) { const text = await readMaybe(file); return text === undefined ? undefined : JSON.parse(text); }
async function linkMaybe(file) { const stat = await statMaybe(file); return stat?.isSymbolicLink() ? path.resolve(path.dirname(file), await fs.readlink(file)) : undefined; }

async function atomicWrite(file, data, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.fruitctl-${randomBytes(8).toString('hex')}`;
  try { await fs.writeFile(temp, data, { mode, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

async function atomicLink(file, target) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.fruitctl-${randomBytes(8).toString('hex')}`;
  try { await fs.symlink(target, temp); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}

async function recoverableChange(files, change) {
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
          if (!current?.isSymbolicLink() || await fs.readlink(snapshot.file) !== snapshot.target) await atomicLink(snapshot.file, snapshot.target);
        }
        else if (snapshot.data !== undefined) {
          if (!current?.isFile() || !(await fs.readFile(snapshot.file)).equals(snapshot.data)) await atomicWrite(snapshot.file, snapshot.data, snapshot.mode);
        }
        else await fs.rm(snapshot.file, { force: true });
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
  const home = path.resolve(options.home || os.homedir());
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const scope = options.scope || 'user';
  const env = options.env || process.env;
  const adapter = resolveAdapter({ agent: options.agent, scope, home, projectDir, env });
  const stateRoot = path.join(home, '.local/state/fruitctl/install');
  const releasesRoot = path.join(home, '.local/share/fruitctl/releases');
  const platform = options.platform || process.platform, arch = options.arch || process.arch;
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported controller ${platform}/${arch}; v1 uses Linux SSH bridge or Darwin`);
  const id = `${options.agent}-${scope}-${sha256(scope === 'project' ? projectDir : home).slice(0, 16)}`;
  let version = options.version;
  if (needsVersion && !version) version = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  if (version) validateVersion(version);
  const prefix = version ? path.join(releasesRoot, version, `${platform}-${arch}`) : undefined;
  return { ...options, env, home, projectDir, scope, adapter, stateRoot, releasesRoot, platform, arch, id, version, prefix, receiptPath: path.join(stateRoot, 'receipts', `${id}.json`), executable: prefix ? path.join(prefix, 'bin/fruitctl') : undefined, launcherPath: path.join(home, '.local/bin/fruitctl') };
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
  const receipt = await jsonMaybe(ctx.receiptPath);
  if (receipt) validateReceipt(receipt, ctx);
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
  return receipt;
}

function validateReceipt(receipt, ctx) {
  if (!receipt || receipt.schema !== 'fruitctl.install.v1' || receipt.id !== ctx.id || receipt.agent !== ctx.agent || receipt.scope !== ctx.scope || receipt.projectDir !== ctx.projectDir && ctx.scope === 'project') throw new Error('Install receipt identity mismatch');
  validateVersion(receipt.version);
  const normalized = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;
  const under = (value, directory) => normalized(value) && value.startsWith(`${directory}${path.sep}`);
  const prefix = path.join(ctx.releasesRoot, receipt.version, `${ctx.platform}-${ctx.arch}`);
  if (receipt.prefix !== prefix || !receipt.runtime || receipt.runtime.version !== receipt.version || !/^[a-f0-9]{64}$/.test(receipt.runtime.archiveSha256 || '') || !/^[a-f0-9]{64}$/.test(receipt.runtime.manifestSha256 || '')) throw new Error('Install receipt runtime identity mismatch');
  const required = ['bin/fruitctl', 'bin/node', 'bin/fruitctl.mjs', 'lib/install/index.mjs', 'integrations/agents.json', 'skills/fruitctl/SKILL.md'];
  if (!receipt.runtime.files || required.some(file => !Object.hasOwn(receipt.runtime.files, file)) || Object.entries(receipt.runtime.files).some(([file, digest]) => path.isAbsolute(file) || path.normalize(file) !== file || file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(digest || ''))) throw new Error('Invalid install receipt runtime inventory');
  validateRuntimeModes(receipt.runtime);
  if (!receipt.config || !normalized(receipt.config.path) || receipt.config.format !== ctx.adapter.config.format || typeof receipt.config.owned !== 'boolean' || typeof receipt.config.baseExisted !== 'boolean' || receipt.config.baseBackupPath && !under(receipt.config.baseBackupPath, path.join(ctx.stateRoot, 'backups'))) throw new Error('Invalid install receipt configuration');
  if (!receipt.skill || !normalized(receipt.skill.path) || receipt.skill.target !== path.join(prefix, 'skills/fruitctl') || typeof receipt.skill.owned !== 'boolean' || receipt.skill.originalTarget !== null && !normalized(receipt.skill.originalTarget)) throw new Error('Invalid install receipt skill');
  if (!receipt.launcher || receipt.launcher.path !== ctx.launcherPath || !under(receipt.launcher.target, ctx.releasesRoot) || !receipt.launcher.target.endsWith('/bin/fruitctl') || typeof receipt.launcher.owned !== 'boolean' || receipt.launcher.originalTarget !== null && !normalized(receipt.launcher.originalTarget)) throw new Error('Invalid install receipt launcher');
  if (receipt.previousReceipt !== null && !under(receipt.previousReceipt, path.join(ctx.stateRoot, 'history'))) throw new Error('Invalid install receipt history path');
  return receipt;
}

async function activeReceipts(ctx) {
  const directory = path.join(ctx.stateRoot, 'receipts');
  try { return await Promise.all((await fs.readdir(directory)).filter(file => file.endsWith('.json')).map(async file => {
    const receipt = await jsonMaybe(path.join(directory, file));
    if (!receipt || !Object.hasOwn(agentManifest.agents, receipt.agent || '') || !['user', 'project'].includes(receipt.scope) || typeof receipt.projectDir !== 'string' || file !== `${receipt.id}.json`) throw new Error('Invalid install receipt');
    const other = await context({ home: ctx.home, projectDir: receipt.projectDir, agent: receipt.agent, scope: receipt.scope, env: ctx.env, platform: ctx.platform, arch: ctx.arch });
    validateReceipt(receipt, other);
    return { file: path.join(directory, file), receipt };
  })); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

async function locked(ctx, fn) {
  await fs.mkdir(ctx.stateRoot, { recursive: true, mode: 0o700 });
  const lock = path.join(ctx.stateRoot, 'transaction.lock');
  let handle;
  try { handle = await fs.open(lock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another Fruitctl install transaction holds the lock; inspect its receipt before retrying'); throw e; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n'); return await fn(); }
  finally { await handle.close(); await fs.unlink(lock); }
}

async function planInstall(ctx) {
  const previous = await receiptFor(ctx);
  const text = await readMaybe(ctx.adapter.configPath);
  let managed = await managedReason(ctx.adapter.configPath);
  if (previous && (previous.config.path !== ctx.adapter.configPath || previous.skill.path !== ctx.adapter.skillPath)) managed ||= 'Recorded installation uses a different MCP or skill destination; uninstall that installation before selecting another path, or apply the fragment through its owning configuration surface';
  if (ctx.agent === 'claude' && ctx.scope === 'user' && ctx.env.CLAUDE_CONFIG_DIR) managed ||= 'Custom CLAUDE_CONFIG_DIR: apply the generated MCP fragment through that account\'s configuration surface or use project scope';
  if (ctx.agent === 'vscode' && ctx.scope === 'project') {
    const legacy = path.join(ctx.projectDir, '.vscode/mcp.json');
    const legacyText = await readMaybe(legacy);
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
  const summary = { action: 'install', agent: ctx.agent, scope: ctx.scope, version: ctx.version, target: ctx.target, prefix: ctx.prefix, configPath: ctx.adapter.configPath, skillPath: ctx.adapter.skillPath, launcherPath: ctx.launcherPath, snippet: plan.snippet, qualification: 'configuration only; MCP/image/input acceptance has not been run', ...(ctx.agent === 'junie' ? { ideSettingsSnippet: plan.snippet } : {}) };
  if (plan.managed.length) return { ...summary, status: 'declarative-required', dryRun: !!ctx.dryRun, reasons: plan.managed };
  if (ctx.dryRun) return { ...summary, status: 'planned', dryRun: true, releaseUrl: `https://github.com/xoxd-ai/fruitctl/releases/tag/${ctx.version}`, writes: [ctx.prefix, ctx.adapter.configPath, ctx.adapter.skillPath, ctx.launcherPath, ctx.receiptPath] };
  return locked(ctx, async () => {
    const currentPlan = await planInstall(ctx);
    if (currentPlan.managed.length) throw new Error(currentPlan.managed.join('; '));
    const release = await resolveRelease(ctx, dependencies);
    const runtime = await extractRuntime(release, ctx.prefix);
    const transaction = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    const backupPath = path.join(ctx.stateRoot, 'backups', `${ctx.id}-${transaction}.config`);
    const historyPath = path.join(ctx.stateRoot, 'history', `${ctx.id}-${transaction}.json`);
    const nowManaged = await managedReason(ctx.adapter.configPath);
    if (nowManaged) throw new Error(`Agent configuration became managed during release download: ${nowManaged}`);
    const configStat = await statMaybe(ctx.adapter.configPath);
    const configMode = configStat ? configStat.mode & 0o777 : 0o600;
    const nextText = currentPlan.configOwned ? patchEntry(currentPlan.text, ctx.adapter, currentPlan.expected) : currentPlan.text;
    if (await readMaybe(ctx.adapter.configPath) !== currentPlan.text || await linkMaybe(ctx.adapter.skillPath) !== currentPlan.skillLink || await linkMaybe(ctx.launcherPath) !== currentPlan.launcherLink) throw new Error('Agent configuration changed during release download; retry after reviewing that edit');
    if (currentPlan.text !== undefined) await atomicWrite(backupPath, currentPlan.text);
    if (currentPlan.previous) await atomicWrite(historyPath, JSON.stringify(currentPlan.previous, null, 2) + '\n');
    const undo = [];
    try {
      if (currentPlan.configOwned) {
        await atomicWrite(ctx.adapter.configPath, nextText, configMode);
        undo.push(async () => currentPlan.text === undefined ? fs.unlink(ctx.adapter.configPath) : atomicWrite(ctx.adapter.configPath, currentPlan.text, configMode));
      }
      if (currentPlan.skillLink !== currentPlan.skillTarget) {
        await atomicLink(ctx.adapter.skillPath, currentPlan.skillTarget);
        undo.push(async () => currentPlan.skillLink ? atomicLink(ctx.adapter.skillPath, currentPlan.skillLink) : fs.unlink(ctx.adapter.skillPath));
      }
      if (currentPlan.launcherLink !== ctx.executable) {
        await atomicLink(ctx.launcherPath, ctx.executable);
        undo.push(async () => currentPlan.launcherLink ? atomicLink(ctx.launcherPath, currentPlan.launcherLink) : fs.unlink(ctx.launcherPath));
      }
      const receipt = {
        schema: 'fruitctl.install.v1', id: ctx.id, agent: ctx.agent, scope: ctx.scope, projectDir: ctx.projectDir, version: ctx.version, target: ctx.target, prefix: ctx.prefix, installedAt: new Date().toISOString(), runtime,
        previousReceipt: currentPlan.previous ? historyPath : null,
        config: { path: ctx.adapter.configPath, format: ctx.adapter.config.format, owned: currentPlan.configOwned, expectedEntry: currentPlan.expected, originalEntry: currentPlan.previous ? currentPlan.previous.config.originalEntry : currentPlan.current ?? null, baseBackupPath: currentPlan.previous ? currentPlan.previous.config.baseBackupPath : currentPlan.text === undefined ? null : backupPath, baseExisted: currentPlan.previous ? currentPlan.previous.config.baseExisted : currentPlan.text !== undefined, basePristine: !currentPlan.previous || currentPlan.previous.config.basePristine !== false && sha256(currentPlan.text || '') === currentPlan.previous.config.afterHash, afterHash: sha256(nextText || '') },
        skill: { path: ctx.adapter.skillPath, target: currentPlan.skillTarget, owned: currentPlan.previous?.skill.owned || !currentPlan.skillStat, originalTarget: currentPlan.previous ? currentPlan.previous.skill.originalTarget : currentPlan.skillLink ?? null },
        launcher: { path: ctx.launcherPath, target: ctx.executable, owned: currentPlan.previous?.launcher.owned || !currentPlan.launcherStat || currentPlan.launcherOwnedBefore, originalTarget: currentPlan.previous ? currentPlan.previous.launcher.originalTarget : currentPlan.launcherOwner ? currentPlan.launcherOwner.receipt.launcher.originalTarget : currentPlan.launcherLink ?? null }
      };
      await atomicWrite(ctx.receiptPath, JSON.stringify(receipt, null, 2) + '\n');
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
    const directory = path.join(home, '.local/state/fruitctl/install/receipts');
    let files;
    try { files = await fs.readdir(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
    const installations = [];
    for (const file of files.filter(value => value.endsWith('.json'))) {
      const receipt = await jsonMaybe(path.join(directory, file));
      if (receipt?.schema !== 'fruitctl.install.v1' || !Object.hasOwn(agentManifest.agents, receipt.agent || '') || !['user', 'project'].includes(receipt.scope) || typeof receipt.projectDir !== 'string' || typeof receipt.id !== 'string' || file !== `${receipt.id}.json`) throw new Error('Invalid install receipt');
      installations.push(await doctor({ ...options, home, agent: receipt.agent,
        scope: receipt.scope, projectDir: receipt.projectDir }));
    }
    return { action: 'doctor', status: installations.length ?
      (installations.every(value => value.status === 'configured') ? 'configured' : 'drift') : 'not-installed',
      installations, qualification: 'Configuration checks only; runtime and target behavior unverified' };
  }
  const ctx = await context(options);
  const receipt = await receiptFor(ctx);
  if (!receipt) return { action: 'doctor', status: 'not-installed', agent: ctx.agent, scope: ctx.scope, checks: [], qualification: 'No install receipt; runtime behavior unverified' };
  const checks = [];
  try {
    const reason = await managedReason(receipt.config.path);
    const current = readEntry(await readMaybe(receipt.config.path), ctx.adapter);
    checks.push({ name: 'owned MCP config', ok: !reason && ownedFieldsMatch(current, receipt.config.expectedEntry, ctx.agent), detail: reason });
  } catch (e) { checks.push({ name: 'owned MCP config', ok: false, detail: e.message }); }
  checks.push({ name: 'skill link', ok: await linkMaybe(receipt.skill.path) === receipt.skill.target });
  const launcherTarget = await linkMaybe(receipt.launcher.path);
  const launcherKnown = launcherTarget === receipt.launcher.target || (await activeReceipts(ctx)).some(row => row.receipt.launcher.owned && row.receipt.launcher.path === receipt.launcher.path && row.receipt.launcher.target === launcherTarget);
  checks.push({ name: 'launcher link', ok: launcherKnown, detail: launcherTarget !== receipt.launcher.target && launcherKnown ? 'Shared convenience launcher belongs to another recorded harness version; this MCP entry remains pinned' : undefined });
  try {
    const identity = await jsonMaybe(path.join(receipt.prefix, '.fruitctl-runtime.json'));
    checks.push({ name: 'pinned runtime identity', ok: identity?.archiveSha256 === receipt.runtime.archiveSha256 && identity?.manifestSha256 === receipt.runtime.manifestSha256 });
    for (const [relative, digest] of Object.entries(receipt.runtime.files || {})) {
      if (path.isAbsolute(relative) || relative.split('/').includes('..') || path.normalize(relative) !== relative || !/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('Invalid runtime file inventory');
      const file = path.join(receipt.prefix, relative);
      const stat = await statMaybe(file);
      const regular = stat?.isFile() === true;
      const modeMatches = receipt.runtime.modes === undefined || (stat?.mode & 0o777) === receipt.runtime.modes[relative];
      checks.push({ name: relative, ok: regular && modeMatches && digest === sha256(await fs.readFile(file)) });
    }
  } catch (e) { checks.push({ name: 'pinned runtime identity', ok: false, detail: e.message }); }
  return { action: 'doctor', status: checks.every(check => check.ok) ? 'configured' : 'drift', agent: ctx.agent, scope: ctx.scope, version: receipt.version, target: receipt.target, checks, qualification: 'Configuration checks only; no agent, GUI, MCP or target connection was launched' };
}

async function restoreConfig(ctx, receipt, desired, fullBackup = false) {
  const reason = await managedReason(receipt.config.path);
  if (reason) throw new Error(reason);
  const text = await readMaybe(receipt.config.path);
  const current = readEntry(text, ctx.adapter);
  if (!ownedFieldsMatch(current, receipt.config.expectedEntry, ctx.agent)) throw new Error('Fruitctl MCP entry changed after installation; refusing to remove or roll it back');
  if (!receipt.config.owned) return;
  if (fullBackup && receipt.config.basePristine !== false && sha256(text || '') === receipt.config.afterHash) {
    if (!receipt.config.baseExisted) { await fs.unlink(receipt.config.path); return; }
    await atomicWrite(receipt.config.path, await fs.readFile(receipt.config.baseBackupPath), (await fs.stat(receipt.config.path)).mode & 0o777); return;
  }
  if (ctx.agent !== 'codex' && desired && typeof desired === 'object') {
    desired = { ...desired };
    for (const key of ctx.agent === 'junie' ? ['enabled', 'disabled'] : ctx.agent === 'opencode' ? ['enabled'] : []) if (typeof current?.[key] === 'boolean') desired[key] = current[key];
  }
  const mode = (await fs.stat(receipt.config.path)).mode & 0o777;
  await atomicWrite(receipt.config.path, patchEntry(text, ctx.adapter, desired), mode);
}

async function restoreLink(item, target) {
  if (!item.owned) return;
  if (await linkMaybe(item.path) !== item.target) throw new Error(`Owned ${item.path} changed; refusing to remove or roll it back`);
  if (target) await atomicLink(item.path, target); else await fs.unlink(item.path);
}

async function checkOwnedState(ctx, receipt, others = []) {
  const shared = name => others.some(row => row.receipt[name]?.path === receipt[name].path);
  if (receipt.config.owned && !shared('config')) {
    const reason = await managedReason(receipt.config.path);
    if (reason) throw new Error(reason);
    const current = readEntry(await readMaybe(receipt.config.path), ctx.adapter);
    if (!ownedFieldsMatch(current, receipt.config.expectedEntry, ctx.agent)) throw new Error('Fruitctl MCP entry changed after installation; refusing to remove or roll it back');
    if (receipt.config.baseExisted && !(await statMaybe(receipt.config.baseBackupPath))?.isFile()) throw new Error('Original configuration backup is missing or not a regular file');
  }
  for (const name of ['skill', 'launcher']) if (receipt[name].owned && !shared(name) && await linkMaybe(receipt[name].path) !== receipt[name].target) throw new Error(`Owned ${receipt[name].path} changed; refusing to remove or roll it back`);
  if (shared('launcher')) {
    const target = await linkMaybe(receipt.launcher.path);
    if (![receipt, ...others.map(row => row.receipt)].some(row => row.launcher?.path === receipt.launcher.path && row.launcher.target === target)) throw new Error('Shared launcher changed outside recorded installations; refusing recovery');
  }
}

async function checkRecordedRuntime(receipt) {
  const identity = await jsonMaybe(path.join(receipt.prefix, '.fruitctl-runtime.json'));
  if (!identity || identity.archiveSha256 !== receipt.runtime.archiveSha256 || identity.manifestSha256 !== receipt.runtime.manifestSha256 || !receipt.runtime.files || !Object.keys(receipt.runtime.files).length) throw new Error('Previous runtime identity is missing or changed; refusing rollback');
  for (const [relative, digest] of Object.entries(receipt.runtime.files)) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Invalid runtime receipt path');
    const file = path.join(receipt.prefix, relative);
    const stat = await statMaybe(file);
    if (!stat?.isFile() || receipt.runtime.modes !== undefined && (stat.mode & 0o777) !== receipt.runtime.modes[relative] || sha256(await fs.readFile(file)) !== digest) throw new Error(`Previous runtime file is missing or changed: ${relative}; refusing rollback`);
  }
}

export async function uninstall(options = {}) {
  const ctx = await context(options); let receipt = await receiptFor(ctx);
  if (!receipt) return { action: 'uninstall', status: 'not-installed', agent: ctx.agent, scope: ctx.scope };
  if (ctx.dryRun) return { action: 'uninstall', status: 'planned', dryRun: true, receiptPath: ctx.receiptPath, preserves: ['verified runtime cache', 'unrelated config settings', 'other agent installations'] };
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
          if (name === 'config') Object.assign(inheritor.receipt.config, { originalEntry: item.originalEntry, baseBackupPath: item.baseBackupPath, baseExisted: item.baseExisted, basePristine: item.basePristine !== false && inheritor.receipt.config.basePristine !== false });
          if (name !== 'config') inheritor.receipt[name].originalTarget = item.originalTarget;
          if (name === 'launcher') inheritor.receipt.launcher.target = await linkMaybe(item.path);
          transfers.push(inheritor);
        }
        continue;
      }
      restores.push(async () => name === 'config' ? restoreConfig(ctx, receipt, item.originalEntry ?? undefined, true) : restoreLink(item, item.originalTarget));
    }
    return recoverableChange([receipt.config.path, receipt.skill.path, receipt.launcher.path, ctx.receiptPath, ...transfers.map(row => row.file)], async () => {
      for (const restore of restores) await restore();
      for (const transfer of transfers) await atomicWrite(transfer.file, JSON.stringify(transfer.receipt, null, 2) + '\n');
      await fs.unlink(ctx.receiptPath);
      return { action: 'uninstall', status: 'removed', agent: ctx.agent, scope: ctx.scope, preserves: ['verified runtime cache', 'unrelated config settings', 'other agent installations'] };
    });
  });
}

export async function rollback(options = {}) {
  const ctx = await context(options); let receipt = await receiptFor(ctx);
  if (!receipt?.previousReceipt) return { action: 'rollback', status: 'no-previous-install', agent: ctx.agent, scope: ctx.scope };
  let previous = await jsonMaybe(receipt.previousReceipt);
  if (!previous || previous.id !== receipt.id) throw new Error('Previous install receipt is missing or mismatched');
  validateReceipt(previous, ctx);
  if (ctx.dryRun) return { action: 'rollback', status: 'planned', dryRun: true, from: receipt.version, to: previous.version };
  return locked(ctx, async () => {
    receipt = await receiptFor(ctx);
    if (!receipt?.previousReceipt) throw new Error('Install receipt changed while acquiring the transaction lock');
    previous = validateReceipt(await jsonMaybe(receipt.previousReceipt), ctx);
    // Validate both privately owned paths before changing either one. The
    // convenience launcher can belong to a different, newer harness install.
    const others = (await activeReceipts(ctx)).filter(row => row.receipt.id !== ctx.id);
    await checkOwnedState(ctx, receipt, others);
    if (others.some(row => row.receipt.config.path === receipt.config.path && !ownedFieldsMatch(row.receipt.config.expectedEntry, previous.config.expectedEntry, ctx.agent) || row.receipt.skill.path === receipt.skill.path && row.receipt.skill.target !== previous.skill.target)) throw new Error('Another harness shares this MCP entry or skill; roll back through the common configuration surface');
    await checkRecordedRuntime(previous);
    return recoverableChange([receipt.config.path, receipt.skill.path, receipt.launcher.path, ctx.receiptPath], async () => {
    const wasPristine = receipt.config.basePristine !== false && sha256(await readMaybe(receipt.config.path) || '') === receipt.config.afterHash;
    await restoreConfig(ctx, receipt, previous.config.expectedEntry);
    await restoreLink(receipt.skill, previous.skill.target);
    // A different harness can have advanced the shared convenience launcher.
    // Its absolute MCP executable is unaffected; preserve that newer launcher.
    if (await linkMaybe(receipt.launcher.path) === receipt.launcher.target) await restoreLink(receipt.launcher, previous.launcher.target);
    else previous.launcher = { ...receipt.launcher, owned: false };
    previous.config.expectedEntry = readEntry(await readMaybe(previous.config.path), ctx.adapter);
    previous.config.basePristine = previous.config.basePristine !== false && wasPristine;
    previous.config.afterHash = sha256(await readMaybe(previous.config.path) || '');
    await atomicWrite(ctx.receiptPath, JSON.stringify(previous, null, 2) + '\n');
    return { action: 'rollback', status: 'rolled-back', from: receipt.version, to: previous.version };
    });
  });
}
