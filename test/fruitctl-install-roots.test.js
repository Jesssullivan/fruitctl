import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertRootIdentity, readRootDescriptor, resolveInstallLayout } from '../lib/install/roots.mjs';

const storage = ['state', 'state/install', 'state/install/receipts', 'state/install/backups', 'state/install/history', 'releases', 'bin'];

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-root-check-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), root = path.join(base, 'root');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(root, { mode: 0o700 });
  for (const relative of storage) await fs.mkdir(path.join(root, relative), { mode: 0o700, recursive: true });
  const descriptor = { schema: 'fruitctl.install-root.v1', effectiveRoot: root, layoutVersion: 1, ownerUid: process.getuid?.() ?? null };
  const descriptorPath = path.join(root, 'state/install/root.json');
  await fs.writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  const layout = await resolveInstallLayout({ installRoot: root, home });
  const stats = new Map(await Promise.all(storage.map(async relative => {
    const file = path.join(root, relative); return [file, await fs.lstat(file)];
  })));
  return { base, home, root, layout, stats, descriptor, descriptorPath };
}

const changed = (stat, fields) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, fields);

test('root storage metadata validates ancestors before five independent reads overlap', async t => {
  const f = await fixture(t), original = fs.lstat;
  f.layout.directoryIdentities.clear();
  const originalSet = f.layout.directoryIdentities.set, validated = new Set();
  t.mock.method(f.layout.directoryIdentities, 'set', (file, stat) => {
    validated.add(file); return originalSet.call(f.layout.directoryIdentities, file, stat);
  });
  let active = 0, maximum = 0;
  const started = [], completed = [];
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (!f.stats.has(file)) return original(file, ...args);
    if (file === path.join(f.root, 'state/install') || file.startsWith(path.join(f.root, 'state/install') + path.sep)) {
      assert.ok(validated.has(path.join(f.root, 'state')), 'state passed validation before descendant lookup');
    }
    if (file.startsWith(path.join(f.root, 'state/install') + path.sep)) {
      assert.ok(validated.has(path.join(f.root, 'state/install')), 'state/install passed validation before leaf lookup');
    }
    started.push(file); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => queueMicrotask(resolve));
    completed.push(file); active--;
    return f.stats.get(file);
  });
  await assertRootIdentity(f.layout);
  assert.equal(maximum, 5);
  assert.equal(active, 0);
  assert.deepEqual(started, storage.map(relative => path.join(f.root, relative)));
  assert.equal(completed.length, 7);
  assert.equal(f.layout.directoryIdentities.size, 7);
});

test('unsafe shared ancestors refuse before any descendant lookup', async t => {
  for (const relative of ['state', 'state/install']) {
    for (const kind of ['symlink', 'foreign-owner']) {
      for (const recorded of [false, true]) await t.test(`${relative}: ${kind}, recorded=${recorded}`, async t => {
        const f = await fixture(t), original = fs.lstat, target = path.join(f.root, relative);
        if (!recorded) { f.layout.rootIdentity = undefined; f.layout.directoryIdentities.clear(); }
        const lookedUp = [];
        t.mock.method(fs, 'lstat', async (file, ...args) => {
          if (!f.stats.has(file)) return original(file, ...args);
          lookedUp.push(file);
          const stat = f.stats.get(file);
          return file === target ? changed(stat, kind === 'symlink' ? { mode: 0o120700 } : { uid: stat.uid + 1 }) : stat;
        });
        await assert.rejects(assertRootIdentity(f.layout), /not a regular directory|owned by another user|storage identity changed/);
        assert.deepEqual(lookedUp, ['state', ...(relative === 'state/install' ? ['state/install'] : [])].map(value => path.join(f.root, value)));
        assert.equal(lookedUp.filter(file => file.startsWith(target + path.sep)).length, 0);
      });
    }
  }
});

test('root checks retain first filesystem refusal after later reads reject earlier', async t => {
  const f = await fixture(t), original = fs.lstat;
  const first = new Error('first storage read failed'), later = new Error('later storage read failed');
  const completed = [];
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (!f.stats.has(file)) return original(file, ...args);
    if (file === path.join(f.root, storage[2])) {
      await new Promise(resolve => setImmediate(resolve)); completed.push(file); throw first;
    }
    completed.push(file);
    if (file === path.join(f.root, storage[6])) throw later;
    return f.stats.get(file);
  });
  await assert.rejects(assertRootIdentity(f.layout), error => error === first);
  assert.equal(completed.length, 7, 'all reads settled before refusal');
  assert.equal(completed.at(-1), path.join(f.root, storage[2]));
});

test('an earlier identity refusal precedes a later filesystem failure', async t => {
  const f = await fixture(t), original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (!f.stats.has(file)) return original(file, ...args);
    if (file === path.join(f.root, 'bin')) throw new Error('late filesystem failure');
    const stat = f.stats.get(file);
    return file === path.join(f.root, 'state/install/receipts') ? changed(stat, { ino: stat.ino + 1 }) : stat;
  });
  await assert.rejects(assertRootIdentity(f.layout), /storage identity changed:.*\/state\/install\/receipts$/);
});

test('each recorded storage directory keeps its identity, type and permissions refusals', async t => {
  for (const relative of storage) {
    for (const kind of ['missing', 'inode', 'uid', 'file', 'symlink', 'read-only', 'other-writable', ...(relative.startsWith('state') ? ['not-private'] : [])]) {
      await t.test(`${relative}: ${kind}`, async t => {
        const f = await fixture(t), original = fs.lstat, target = path.join(f.root, relative);
        t.mock.method(fs, 'lstat', async (file, ...args) => {
          if (file !== target) return original(file, ...args);
          if (kind === 'missing') throw Object.assign(new Error('absent'), { code: 'ENOENT' });
          const stat = f.stats.get(file);
          const fields = kind === 'inode' ? { ino: stat.ino + 1 } : kind === 'uid' ? { uid: stat.uid + 1 }
            : { mode: kind === 'file' ? 0o100600 : kind === 'symlink' ? 0o120700
              : kind === 'read-only' ? 0o40500 : kind === 'other-writable' ? 0o40722 : 0o40750 };
          return changed(stat, fields);
        });
        await assert.rejects(assertRootIdentity(f.layout), /storage identity changed|not a regular directory|read-only or writable|mode 0700/);
      });
    }
  }
});

test('non-state directories retain supported owner-writable mode 0750', async t => {
  const f = await fixture(t), original = fs.lstat;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (!['releases', 'bin'].some(relative => file === path.join(f.root, relative))) return original(file, ...args);
    return changed(f.stats.get(file), { mode: 0o40750 });
  });
  await assertRootIdentity(f.layout);
});

test('root replacement still refuses before storage validation', async t => {
  const f = await fixture(t);
  await fs.rename(f.root, path.join(f.base, 'old-root'));
  await fs.mkdir(f.root, { mode: 0o700 });
  await assert.rejects(assertRootIdentity(f.layout), /ancestor identity changed|root identity changed/);
});

test('changed canonical root selection still refuses before storage validation', async t => {
  const f = await fixture(t), alias = path.join(f.base, 'alias'), other = path.join(f.base, 'other');
  await fs.symlink(f.root, alias);
  const layout = await resolveInstallLayout({ installRoot: alias, home: f.home });
  await fs.mkdir(other, { mode: 0o700 });
  await fs.unlink(alias); await fs.symlink(other, alias);
  await assert.rejects(assertRootIdentity(layout), /root path changed/);
});

test('descriptor read still brackets its open with both complete root checks', async t => {
  const f = await fixture(t), lstat = fs.lstat, open = fs.open;
  let storageReads = 0, atOpen;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (f.stats.has(file)) storageReads++;
    return lstat(file, ...args);
  });
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === f.descriptorPath) atOpen = storageReads;
    return open(file, ...args);
  });
  assert.deepEqual(await readRootDescriptor(f.layout), f.descriptor);
  assert.equal(atOpen, 7);
  assert.equal(storageReads, 14);
});

test('descriptor mode, binding and no-follow refusals remain', async t => {
  for (const kind of ['mode', 'binding', 'symlink']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'mode') await fs.chmod(f.descriptorPath, 0o644);
    else if (kind === 'binding') await fs.writeFile(f.descriptorPath, JSON.stringify({ ...f.descriptor, layoutVersion: 2 }));
    else {
      const prior = path.join(f.base, 'prior-descriptor');
      await fs.rename(f.descriptorPath, prior); await fs.symlink(prior, f.descriptorPath);
    }
    await assert.rejects(readRootDescriptor(f.layout), /mode 0600|descriptor identity\/path mismatch|ELOOP/);
  });
});

test('legacy layout bypasses explicit-root metadata checks', async t => {
  t.mock.method(fs, 'lstat', () => { throw new Error('legacy must not select a root'); });
  await assertRootIdentity({ explicit: false });
});
