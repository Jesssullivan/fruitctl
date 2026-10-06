// SPDX-License-Identifier: MIT
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';

export function defaultConfigPath(env = process.env) {
  if (env.FRUITCTL_CONFIG_PATH) return env.FRUITCTL_CONFIG_PATH;
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'fruitctl')
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'fruitctl');
  return path.join(base, 'config.json');
}

export function defaultSocketPath(env = process.env) {
  if (env.FRUITCTL_SOCKET_PATH) return env.FRUITCTL_SOCKET_PATH;
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'fruitctl', 'run')
    : path.join(env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.local', 'state'), 'fruitctl');
  return path.join(base, process.platform === 'darwin' ? 'broker.sock' : 'relay.sock');
}

export async function prepareSocket(socketPath) {
  if (!path.isAbsolute(socketPath)) throw new Error('Socket path must be absolute');
  const parent = path.dirname(socketPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory() ||
      parentStat.uid !== process.getuid() || (parentStat.mode & 0o077)) {
    throw new Error('Socket directory must be user-owned with mode 0700');
  }
  let existing;
  try { existing = await fs.lstat(socketPath); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!existing.isSocket() || existing.uid !== process.getuid()) {
    throw new Error('Refusing to replace an unowned socket path');
  }
  const live = await new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false);
      else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Socket probe timed out')); });
  });
  if (live) throw new Error('A Fruitctl service already owns this socket');
  const current = await fs.lstat(socketPath).catch(() => null);
  if (current?.ino === existing.ino && current.uid === process.getuid()) await fs.unlink(socketPath);
}

export async function loadConfig(configPath) {
  const stat = await fs.stat(configPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid Fruitctl config size');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (config.schema !== 'fruitctl.config.v1' || !config.targets ||
      typeof config.targets !== 'object' || Array.isArray(config.targets)) {
    throw new Error('Expected fruitctl.config.v1 with target profiles');
  }
  for (const [name, profile] of Object.entries(config.targets)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) || !profile ||
        typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid target profile');
  }
  return config;
}
