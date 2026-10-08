import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const uid = () => process.getuid?.() ?? null;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;
const identity = stat => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
async function statMaybe(file) { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } }
const normalized = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value;

async function canonicalSelection(requested) {
  let ancestor = requested;
  const suffix = [];
  while (!await statMaybe(ancestor)) {
    suffix.unshift(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Install root has no existing ancestor');
    ancestor = parent;
  }
  const physical = await fs.realpath(ancestor);
  const stat = await fs.stat(physical);
  return { effectiveRoot: path.join(physical, ...suffix), anchor: physical, anchorIdentity: identity(stat), stat };
}

function ownedDirectory(stat, file, privateState = false) {
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Install root directory is not a regular directory: ${file}`);
  if (uid() !== null && stat.uid !== uid()) throw new Error(`Install root directory is owned by another user: ${file}`);
  if (!(stat.mode & 0o200) || stat.mode & 0o022) throw new Error(`Install root directory is read-only or writable by another user: ${file}`);
  if (privateState && (stat.mode & 0o777) !== 0o700) throw new Error(`Install root state directory must have mode 0700: ${file}`);
}

export async function resolveInstallLayout({ installRoot, home }) {
  if (installRoot === undefined) return { explicit: false, stateRoot: path.join(home, '.local/state/fruitctl/install'), releasesRoot: path.join(home, '.local/share/fruitctl/releases'), launcherPath: path.join(home, '.local/bin/fruitctl') };
  if (typeof installRoot !== 'string' || !installRoot || installRoot.includes('\0') || !path.isAbsolute(installRoot)) throw new Error('Install root must be a nonempty absolute path');
  const requestedRoot = path.normalize(installRoot);
  const selected = await canonicalSelection(requestedRoot);
  const forbiddenHomes = new Set([path.resolve(home), path.resolve(os.homedir())]);
  for (const accountHome of [...forbiddenHomes]) { try { forbiddenHomes.add(await fs.realpath(accountHome)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  if (selected.effectiveRoot === path.parse(selected.effectiveRoot).root || forbiddenHomes.has(selected.effectiveRoot) || /^\/(?:home|Users)\/[^/]+$/.test(selected.effectiveRoot)) throw new Error('Install root cannot be a filesystem or account-home root');
  if (selected.effectiveRoot === '/nix/store' || selected.effectiveRoot.startsWith('/nix/store/')) throw new Error('Install root cannot be immutable/store-managed');
  ownedDirectory(selected.stat, selected.anchor);
  const rootStat = await statMaybe(selected.effectiveRoot);
  if (rootStat) ownedDirectory(rootStat, selected.effectiveRoot);
  const layout = { explicit: true, requestedRoot, effectiveRoot: selected.effectiveRoot, anchor: selected.anchor, anchorIdentity: selected.anchorIdentity, rootIdentity: rootStat && identity(rootStat), directoryIdentities: new Map(), createdDirectories: [], createdDescriptor: undefined,
    stateRoot: path.join(selected.effectiveRoot, 'state/install'), releasesRoot: path.join(selected.effectiveRoot, 'releases'), launcherPath: path.join(selected.effectiveRoot, 'bin/fruitctl') };
  layout.descriptorPath = path.join(layout.stateRoot, 'root.json');
  layout.binding = { schema: 'fruitctl.install-root.v1', effectiveRoot: layout.effectiveRoot, layoutVersion: 1, ownerUid: uid() };
  layout.rootSelection = { requestedRoot, effectiveRoot: layout.effectiveRoot, layoutVersion: 1 };
  await assertRootIdentity(layout);
  const descriptor = await readRootDescriptor(layout);
  if (!descriptor && rootStat && (await fs.readdir(layout.effectiveRoot)).length) throw new Error('Unmarked nonempty install root cannot be adopted');
  return layout;
}

export async function assertRootIdentity(layout) {
  if (!layout?.explicit) return;
  const current = await canonicalSelection(layout.requestedRoot);
  if (current.effectiveRoot !== layout.effectiveRoot) throw new Error('Install root path changed during transaction');
  const anchorStat = await statMaybe(layout.anchor);
  if (!anchorStat || !same(anchorStat, layout.anchorIdentity)) throw new Error('Install root ancestor identity changed during transaction');
  ownedDirectory(anchorStat, layout.anchor);
  const rootStat = await statMaybe(layout.effectiveRoot);
  if (layout.rootIdentity && (!rootStat || !same(rootStat, layout.rootIdentity))) throw new Error('Install root identity changed or moved during transaction');
  if (rootStat) ownedDirectory(rootStat, layout.effectiveRoot);
  // Validate shared ancestors before descendant lookups. Only the final five
  // independent paths overlap; each batch retains the original refusal order.
  const batches = [['state'], ['state/install'], ['state/install/receipts', 'state/install/backups', 'state/install/history', 'releases', 'bin']];
  for (const paths of batches) {
    const snapshots = await Promise.allSettled(paths.map(relative => statMaybe(path.join(layout.effectiveRoot, relative))));
    for (const [index, relative] of paths.entries()) {
      const snapshot = snapshots[index];
      if (snapshot.status === 'rejected') throw snapshot.reason;
      const directory = path.join(layout.effectiveRoot, relative), stat = snapshot.value;
      const recorded = layout.directoryIdentities.get(directory);
      if (recorded && (!stat || !same(stat, recorded))) throw new Error(`Install root storage identity changed: ${directory}`);
      if (stat) { ownedDirectory(stat, directory, relative.startsWith('state')); if (!recorded) layout.directoryIdentities.set(directory, identity(stat)); }
    }
  }
}

export async function readPrivateJson(file, layout) {
  await assertRootIdentity(layout);
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || uid() !== null && stat.uid !== uid() || (stat.mode & 0o777) !== 0o600) throw new Error(`Install root receipt/descriptor must be an owned regular file with mode 0600: ${file}`);
    const value = JSON.parse(await handle.readFile('utf8'));
    await assertRootIdentity(layout);
    return value;
  } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  finally { await handle?.close(); }
}

export async function readRootDescriptor(layout) {
  if (!layout?.explicit) return;
  const descriptor = await readPrivateJson(layout.descriptorPath, layout);
  if (descriptor !== undefined && (JSON.stringify(Object.keys(descriptor).sort()) !== JSON.stringify(Object.keys(layout.binding).sort()) || Object.entries(layout.binding).some(([key, value]) => descriptor[key] !== value))) throw new Error('Install root descriptor identity/path mismatch; relocation is unsupported');
  return descriptor;
}

export async function ensureInstallRoot(layout) {
  if (!layout?.explicit) return;
  await assertRootIdentity(layout);
  if (await readRootDescriptor(layout)) return;
  const rootStat = await statMaybe(layout.effectiveRoot);
  if (rootStat && (await fs.readdir(layout.effectiveRoot)).length) throw new Error('Unmarked nonempty install root cannot be adopted');
  const missing = [];
  for (let directory = layout.stateRoot; !await statMaybe(directory); directory = path.dirname(directory)) missing.unshift(directory);
  for (const directory of missing) {
    await assertRootIdentity(layout);
    try { await fs.mkdir(directory, { mode: 0o700 }); layout.createdDirectories.push({ path: directory, identity: identity(await fs.lstat(directory)) }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; ownedDirectory(await fs.lstat(directory), directory, directory.startsWith(path.join(layout.effectiveRoot, 'state'))); }
    if (directory === layout.effectiveRoot) layout.rootIdentity = identity(await fs.lstat(directory));
  }
  await assertRootIdentity(layout);
  let handle;
  try {
    handle = await fs.open(layout.descriptorPath, 'wx', 0o600);
    layout.createdDescriptor = identity(await handle.stat());
    await handle.writeFile(JSON.stringify(layout.binding, null, 2) + '\n');
  } catch (e) { if (e.code !== 'EEXIST') throw e; }
  finally { await handle?.close(); }
  await readRootDescriptor(layout);
}

// A refused first install may leave only R itself. Never purge caches or an
// adopted namespace. Empty directories are removed with inode/live-path guards.
export async function recoverNewInstallRoot(layout) {
  if (!layout?.explicit || !layout.createdDescriptor && !layout.createdDirectories.length) return;
  await assertRootIdentity(layout);
  const descriptorStat = await statMaybe(layout.descriptorPath);
  if (descriptorStat && !layout.createdDescriptor) return;
  if (layout.createdDescriptor && (!descriptorStat || !same(descriptorStat, layout.createdDescriptor))) throw new Error('First-install descriptor changed; refusing cleanup');
  const namesMaybe = async directory => { try { return await fs.readdir(directory); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  // Concurrent/unexpected entries are retained with a valid namespace marker.
  // In particular, never remove a descriptor while another lock exists.
  const allowedAtRoot = new Set(['state', 'releases']);
  if ((await namesMaybe(layout.effectiveRoot)).some(name => !allowedAtRoot.has(name))) return;
  if ((await namesMaybe(path.join(layout.effectiveRoot, 'state'))).some(name => name !== 'install')) return;
  const allowedAtState = new Set(['root.json', 'receipts', 'backups', 'history']);
  if ((await namesMaybe(layout.stateRoot)).some(name => !allowedAtState.has(name))) return;
  const nonemptyFiles = async directory => {
    try {
      for (const name of await fs.readdir(directory)) {
        const file = path.join(directory, name), stat = await fs.lstat(file);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await nonemptyFiles(file)) return true;
      }
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    return false;
  };
  // Once verified cache or recovery evidence exists, retain its descriptor.
  if (await nonemptyFiles(layout.releasesRoot) || await nonemptyFiles(path.join(layout.stateRoot, 'receipts')) || await nonemptyFiles(path.join(layout.stateRoot, 'backups')) || await nonemptyFiles(path.join(layout.stateRoot, 'history'))) return;
  const removeEmpty = async directory => {
    const stat = await statMaybe(directory); if (!stat) return;
    ownedDirectory(stat, directory, directory.startsWith(path.join(layout.effectiveRoot, 'state')));
    for (const name of await fs.readdir(directory)) {
      const child = path.join(directory, name), childStat = await fs.lstat(child);
      if (!childStat.isDirectory() || childStat.isSymbolicLink()) throw new Error('Unexpected first-install cleanup entry');
      await removeEmpty(child);
    }
    await assertRootIdentity(layout);
    if (!same(await fs.lstat(directory), stat)) throw new Error('First-install cleanup directory changed');
    await fs.rmdir(directory); layout.directoryIdentities.delete(directory);
  };
  for (const directory of [layout.releasesRoot, path.join(layout.stateRoot, 'receipts'), path.join(layout.stateRoot, 'backups'), path.join(layout.stateRoot, 'history')]) await removeEmpty(directory);
  await assertRootIdentity(layout); if (descriptorStat) await fs.unlink(layout.descriptorPath);
  for (const row of layout.createdDirectories.slice().reverse()) {
    if (row.path === layout.effectiveRoot || !row.path.startsWith(`${layout.effectiveRoot}${path.sep}`)) continue;
    const stat = await statMaybe(row.path); if (!stat || !same(stat, row.identity)) throw new Error('First-install scaffolding changed; refusing cleanup');
    await assertRootIdentity(layout); await fs.rmdir(row.path); layout.directoryIdentities.delete(row.path);
  }
  layout.createdDescriptor = undefined;
}

export async function registrationIdentity(projectDir) {
  let realpath;
  try { realpath = await fs.realpath(projectDir); }
  catch (e) { throw new Error(`Registration project is missing or moved: ${e.message}`); }
  const stat = await fs.stat(realpath);
  if (!stat.isDirectory()) throw new Error('Registration project must be an existing directory');
  return { realpath, dev: stat.dev, ino: stat.ino };
}

export async function assertRegistrationIdentity(registration) {
  const recorded = registration?.projectIdentity;
  if (!recorded) return;
  if (!normalized(recorded.realpath) || !Number.isSafeInteger(recorded.dev) || !Number.isSafeInteger(recorded.ino)) throw new Error('Invalid registration project identity');
  let live;
  try { live = await registrationIdentity(registration.projectDir); }
  catch (e) { throw new Error(`Recorded registration project moved or is missing: ${e.message}`); }
  if (live.realpath !== recorded.realpath || live.dev !== recorded.dev || live.ino !== recorded.ino) throw new Error('Recorded registration project identity changed or moved');
}

export async function registrationPathGuards(registration) {
  return Promise.all([...new Set([path.dirname(registration.configPath), path.dirname(registration.skillPath)])].map(async requested => {
    const selected = await canonicalSelection(requested);
    const stat = await statMaybe(selected.effectiveRoot);
    return { requested, effective: selected.effectiveRoot, anchor: selected.anchor, anchorIdentity: selected.anchorIdentity, directoryIdentity: stat && identity(stat) };
  }));
}

export async function assertRegistrationPaths(guards) {
  for (const guard of guards || []) {
    const selected = await canonicalSelection(guard.requested), anchor = await statMaybe(guard.anchor);
    if (selected.effectiveRoot !== guard.effective || !anchor || !same(anchor, guard.anchorIdentity)) throw new Error('Registration destination ancestor identity changed during transaction');
    const stat = await statMaybe(guard.effective);
    if (guard.directoryIdentity && (!stat || !same(stat, guard.directoryIdentity))) throw new Error('Registration destination directory identity changed during transaction');
    if (stat && !stat.isDirectory()) throw new Error('Registration destination parent is not a directory');
    if (stat && !guard.directoryIdentity) guard.directoryIdentity = identity(stat);
  }
}

export async function assertStoragePath(file, layout) {
  if (!layout?.explicit || !file.startsWith(`${layout.effectiveRoot}${path.sep}`)) return;
  await assertRootIdentity(layout);
  for (let directory = path.dirname(file); directory.startsWith(`${layout.effectiveRoot}${path.sep}`); directory = path.dirname(directory)) {
    const stat = await statMaybe(directory);
    if (stat) ownedDirectory(stat, directory, directory.startsWith(path.join(layout.effectiveRoot, 'state')));
  }
}
