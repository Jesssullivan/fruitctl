// SPDX-License-Identifier: MIT
import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, MAX_REQUEST_BYTES } from './protocol.mjs';
import { prepareSocket } from './paths.mjs';

const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export function sshArguments({ bridge, remoteSocket, remoteCommand = 'fruitctl' }) {
  if (typeof bridge !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(bridge)) {
    throw new Error('Bridge must be an explicit SSH host or user@host');
  }
  const command = [remoteCommand, 'attach', '--mux'];
  if (remoteSocket) command.push('--socket', remoteSocket);
  return ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3', bridge,
    command.map(shellQuote).join(' ')];
}

export async function attachMux({ input = process.stdin, output = process.stdout, socketPath }) {
  const channels = new Map();
  const send = frame => writeFrame(output, frame);
  const close = () => { for (const socket of channels.values()) socket.destroy(); channels.clear(); };
  readFrames(input, frame => {
    if (frame.v !== 1 || typeof frame.channel !== 'string' || frame.channel.length > 128) return (close(), false);
    if (frame.kind === 'close') { channels.get(frame.channel)?.destroy(); return; }
    if (frame.kind !== 'packet' || !frame.packet || typeof frame.packet !== 'object') return (close(), false);
    let socket = channels.get(frame.channel);
    if (!socket) {
      if (frame.packet.kind !== 'open' || channels.size >= 128) {
        return send({ v: 1, channel: frame.channel, kind: 'closed' });
      }
      socket = net.connect(socketPath);
      channels.set(frame.channel, socket);
      readFrames(socket, packet => {
        try { send({ v: 1, channel: frame.channel, kind: 'packet', packet }); }
        catch { close(); }
      }, () => socket.destroy());
      socket.once('error', () => socket.destroy());
      socket.once('close', () => {
        channels.delete(frame.channel);
        try { send({ v: 1, channel: frame.channel, kind: 'closed' }); } catch {}
      });
    }
    try { writeFrame(socket, frame.packet); } catch { socket.destroy(); }
  }, close, MAX_REQUEST_BYTES + 1024);
  input.once('end', close);
  input.once('error', close);
  output.once('error', close);
  return { close, channels };
}

export async function createRelay({ socketPath, bridge, remoteSocket, remoteCommand,
  spawnSSH = args => spawn('/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] }) }) {
  await prepareSocket(socketPath);
  const ssh = spawnSSH(sshArguments({ bridge, remoteSocket, remoteCommand }));
  let childClosed = false;
  const childClose = new Promise(resolve => {
    ssh.once('close', () => { childClosed = true; resolve(); });
  });
  let terminatePromise;
  const terminateChild = () => {
    if (terminatePromise) return terminatePromise;
    terminatePromise = (async () => {
      if (childClosed) return;
      ssh.stdin.end();
      // This direct child belongs to this relay. Escalation never targets a
      // shared SSH master, foreign session, or process found by name.
      ssh.kill('SIGTERM');
      const force = setTimeout(() => { if (!childClosed) ssh.kill('SIGKILL'); }, 500);
      let timeout;
      try {
        await Promise.race([childClose, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Owned SSH child exit unconfirmed')), 2000);
        })]);
      } finally { clearTimeout(force); clearTimeout(timeout); }
    })();
    terminatePromise.catch(() => {});
    return terminatePromise;
  };
  const clients = new Map();
  let closed = false;
  let failedReject;
  const failure = new Promise((_, reject) => { failedReject = reject; });
  failure.catch(() => {});
  const send = frame => writeFrame(ssh.stdin, frame);
  const server = net.createServer(socket => {
    if (closed || clients.size >= 128) return socket.destroy();
    const channel = randomUUID();
    clients.set(channel, socket);
    readFrames(socket, packet => {
      try { send({ v: 1, channel, kind: 'packet', packet }); }
      catch { socket.destroy(); }
    }, () => socket.destroy(), MAX_REQUEST_BYTES);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      clients.delete(channel);
      if (!closed) { try { send({ v: 1, channel, kind: 'close' }); } catch {} }
    });
  });
  const fail = () => {
    if (closed) return;
    closed = true;
    for (const socket of clients.values()) socket.destroy();
    server.close();
    ssh.stdin.destroy();
    failedReject(new Error('Fruitctl SSH bridge lost; input was not replayed'));
    void terminateChild().catch(() => {});
  };
  readFrames(ssh.stdout, frame => {
    if (closed) return false;
    if (frame.v !== 1 || typeof frame.channel !== 'string') { fail(); return false; }
    const socket = clients.get(frame.channel);
    if (!socket) return;
    if (frame.kind === 'closed') return socket.destroy();
    if (frame.kind !== 'packet') { fail(); return false; }
    try { writeFrame(socket, frame.packet); } catch { socket.destroy(); }
  }, fail);
  // Never forward remote stderr: SSH startup environments may contain private diagnostics.
  ssh.stderr?.on('data', () => {});
  ssh.stdin.once('error', fail);
  ssh.stdout.once('error', fail);
  ssh.once('error', fail);
  ssh.once('exit', fail);
  ssh.stdout.once('end', fail);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);
    if (closed) throw new Error('Fruitctl SSH bridge failed during startup');
  } catch (error) {
    closed = true;
    for (const socket of clients.values()) socket.destroy();
    server.close();
    ssh.stdin.destroy();
    await terminateChild();
    throw error;
  }
  return { server, failure, async close() {
    closed = true;
    for (const socket of clients.values()) socket.destroy();
    await Promise.all([terminateChild(), new Promise(resolve => server.close(resolve))]);
  } };
}
