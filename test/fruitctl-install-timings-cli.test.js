import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/fruitctl.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fruitctl-timings-cli-'));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(project, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  delete env.NODE_OPTIONS;
  const invoke = async args => {
    try {
      const result = await run(process.execPath, [cli, ...args], {
        cwd: project, env, timeout: 5_000, maxBuffer: 256 * 1024,
      });
      return { ...result, code: 0 };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { stdout: error.stdout, stderr: error.stderr, code: error.code };
    }
  };
  return { root, project, invoke };
}

test('timed CLI doctor preserves the default result and unrelated configuration', async t => {
  const f = await fixture(t);
  const config = path.join(f.project, '.mcp.json');
  const original = Buffer.from('{"userSetting":"synthetic-private-marker"}\n');
  await fs.writeFile(config, original, { mode: 0o640 });
  const args = ['doctor', '--agent', 'claude', '--scope', 'project', '--install-root',
    path.join(f.root, 'install-root'), '--project-dir', f.project];
  const plain = await f.invoke(args), timed = await f.invoke([...args, '--timings']);
  assert.equal(plain.code, 0); assert.equal(timed.code, 0);
  assert.equal(plain.stderr, ''); assert.equal(timed.stderr, '');
  const expected = JSON.parse(plain.stdout), actual = JSON.parse(timed.stdout);
  assert.equal(Object.hasOwn(expected, 'timings'), false);
  const report = actual.timings; delete actual.timings;
  assert.deepEqual(actual, expected);
  assert.equal(report.schema, 'fruitctl.installer.timings.v1');
  assert.equal(report.measurementComplete, true);
  assert.equal(report.inclusiveStages, true);
  assert.equal(typeof report.commandElapsedMs, 'number');
  assert.equal(JSON.stringify(report).includes('synthetic-private-marker'), false);
  assert.equal(JSON.stringify(report).includes(f.root), false);
  assert.deepEqual(await fs.readFile(config), original);
  assert.equal((await fs.stat(config)).mode & 0o777, 0o640);
});

test('timed CLI refusal preserves its original error and exit status', async t => {
  const f = await fixture(t);
  const args = ['doctor', '--agent', 'claude', '--scope', 'project', '--install-root', 'relative-root'];
  const plain = await f.invoke(args), timed = await f.invoke([...args, '--timings']);
  assert.equal(plain.code, 1); assert.equal(timed.code, plain.code);
  assert.equal(plain.stdout, ''); assert.equal(timed.stdout, '');
  const lines = timed.stderr.trimEnd().split('\n');
  assert.equal(lines[0] + '\n', plain.stderr);
  assert.equal(lines.length, 2);
  const { timings } = JSON.parse(lines[1]);
  assert.equal(timings.schema, 'fruitctl.installer.timings.v1');
  assert.equal(timings.measurementComplete, true);
  assert.equal(JSON.stringify(timings).includes('relative-root'), false);
  assert.deepEqual(await fs.readdir(f.project), []);
});

test('timings is refused before broker startup or socket creation', async t => {
  const f = await fixture(t), socket = path.join(f.root, 'must-not-start.sock');
  const result = await f.invoke(['broker', '--timings', '--socket', socket,
    '--config', path.join(f.root, 'missing-broker-config')]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--timings is supported only by install, doctor, rollback and uninstall/);
  assert.equal(result.stdout, '');
  await assert.rejects(fs.lstat(socket), { code: 'ENOENT' });
});
