// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveNativeDaemonPath } from '../lib/mcp/native.js';

function fixture(t) {
  const scratch = process.env.TMPDIR;
  assert.ok(scratch && path.isAbsolute(scratch), 'owned TMPDIR is required');
  const parent = fs.lstatSync(scratch);
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid());
  const directory = fs.mkdtempSync(path.join(scratch, 'fruitctl-native-path-'));
  const binary = path.join(directory, 'controller');
  fs.writeFileSync(binary, 'owned path-selection fixture', { mode: 0o755, flag: 'wx' });
  t.after(() => {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return { directory, binary };
}

test('Darwin selects its bundled controller independently of the shell PATH', (t) => {
  const { binary } = fixture(t);
  assert.equal(resolveNativeDaemonPath({ platform: 'darwin', env: { PATH: '' }, bundledPath: binary }), binary);
});

test('explicit profile and environment controller paths retain priority', (t) => {
  const { binary } = fixture(t);
  fs.chmodSync(binary, 0o644);
  const options = { platform: 'darwin', bundledPath: binary, env: { CLAUDE_KVM_DAEMON_PATH: '/operator/environment-controller' } };
  assert.equal(resolveNativeDaemonPath(options), '/operator/environment-controller');
  assert.equal(resolveNativeDaemonPath({ ...options, daemonPath: '/operator/profile-controller' }), '/operator/profile-controller');
});

test('Darwin rejects damaged and linked bundled controllers', (t) => {
  const { directory, binary } = fixture(t);
  fs.chmodSync(binary, 0o644);
  assert.throws(() => resolveNativeDaemonPath({ platform: 'darwin', env: {}, bundledPath: binary }), /regular executable/);
  fs.chmodSync(binary, 0o641);
  assert.throws(() => resolveNativeDaemonPath({ platform: 'darwin', env: {}, bundledPath: binary }), /accessible to this user/);
  fs.chmodSync(binary, 0o755);
  const link = path.join(directory, 'linked-controller');
  fs.symlinkSync(binary, link);
  assert.throws(() => resolveNativeDaemonPath({ platform: 'darwin', env: {}, bundledPath: link }), /regular executable/);
});

test('Linux and older runtimes preserve the existing controller lookup', (t) => {
  const { binary } = fixture(t);
  assert.equal(resolveNativeDaemonPath({ platform: 'linux', env: {}, bundledPath: binary }), 'claude-kvm-daemon');
  assert.equal(resolveNativeDaemonPath({ platform: 'darwin', env: {}, bundledPath: binary + '-absent' }), 'claude-kvm-daemon');
});
