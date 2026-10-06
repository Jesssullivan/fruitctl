// SPDX-License-Identifier: MIT
import net from 'node:net';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, errorRecord, MAX_REQUEST_BYTES } from './protocol.mjs';
import { prepareSocket } from './paths.mjs';
import { ResponseBudget, responseMetadata } from '../mcp/protocol.js';

const MAX_ACTIONS = 256;
const MAX_WAITING = 64;
const TOOL_TIMEOUT_MS = 30000;

async function nativeFactory(profile) {
  const { createNativeExecutor } = await import('../../index.js');
  if (!profile.vnc || !profile.credentialFile) throw new Error('Target lacks a VNC credential provider');
  const { host, port, username = '' } = profile.vnc;
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof username !== 'string') throw new Error('Invalid VNC profile');
  const secretStat = await fs.stat(profile.credentialFile);
  if (!secretStat.isFile() || secretStat.size > 4097 || (secretStat.mode & 0o077)) {
    throw new Error('Credential provider must be a private file of at most 4097 bytes');
  }
  const credential = (await fs.readFile(profile.credentialFile, 'utf8')).replace(/\r?\n$/, '');
  const env = { ...process.env, VNC_HOST: host, VNC_PORT: String(port),
    VNC_USERNAME: username, VNC_PASSWORD: credential };
  delete env.CLAUDE_KVM_DAEMON_PARAMETERS;
  const native = await createNativeExecutor({ env, daemonPath: profile.daemonPath, startupTimeoutMs: TOOL_TIMEOUT_MS,
    log: () => {}, emitDiagnostics: false });
  if (!profile.hostHelper) return native;
  const { createHostHelperExecutor } = await import('./host-helper.mjs');
  try { return await createHostHelperExecutor({ nativeExecutor: native, hostHelper: profile.hostHelper }); }
  catch (error) { await native.close({ graceful: false }); throw error; }
}

function boundedErrorResponses(responses, count) {
  const admitted = [];
  const budget = new ResponseBudget({ maxResponses: Math.max(1, Math.min(MAX_ACTIONS, count || 1)) });
  if (!Array.isArray(responses)) return admitted;
  for (const response of responses) {
    try { admitted.push(budget.add(responseMetadata(response))); } catch { break; }
  }
  return admitted;
}

export class TargetLane {
  constructor(profile, factory = nativeFactory, { idleMs = 300000, leaseMs = 60000 } = {}) {
    this.profile = profile;
    this.factory = factory;
    this.idleMs = idleMs;
    this.tail = Promise.resolve();
    this.waiting = 0;
    this.executor = null;
    this.closed = false;
    this.leaseMs = leaseMs;
    this.owner = null;
    this.controllers = new Set();
  }
  acquire(owner) {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed || this.releasing || (this.owner && this.owner !== owner)) {
      throw new Error('Target is controlled by another session or is releasing');
    }
    this.owner = owner;
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => { void this.release(owner).catch(() => {}); }, this.leaseMs);
    this.leaseTimer.unref();
  }
  release(owner) {
    if (this.owner !== owner) return Promise.resolve();
    if (this.releasePromise) return this.releasePromise;
    this.releasing = true;
    clearTimeout(this.leaseTimer);
    for (const controller of this.controllers) controller.abort(new Error('Target control released'));
    this.releasePromise = this.tail.then(() => this.dropExecutor()).then(() => {
      this.owner = null;
      this.releasing = false;
      this.releasePromise = null;
    });
    // Failed cleanup keeps the target blocked; no successor receives uncertain input state.
    this.tail = this.releasePromise.catch(() => {});
    return this.releasePromise;
  }
  async dropExecutor() {
    if (this.cleanupFailure) throw this.cleanupFailure;
    const executor = this.executor;
    if (!executor) return;
    try {
      await executor.release?.();
      await executor.close();
      this.executor = null;
    } catch {
      this.cleanupFailure = new Error('Target input release is unconfirmed; reconcile the target before restarting its broker');
      // Terminate only our executor; retain the failure even after it exits.
      try { await executor.close({ graceful: false }); } catch {}
      throw this.cleanupFailure;
    }
  }
  execute(actions, { signal, timeoutMs = TOOL_TIMEOUT_MS, onResponse } = {}) {
    if (this.closed) return Promise.reject(new Error('Target lane closed'));
    if (this.waiting >= MAX_WAITING) return Promise.reject(new Error('Target queue full'));
    if (!Array.isArray(actions) || !actions.length || actions.length > MAX_ACTIONS ||
        actions.some(action => !action || typeof action !== 'object' || Array.isArray(action) ||
          typeof action.action !== 'string')) return Promise.reject(new Error('Invalid action batch'));
    const budget = Math.min(TOOL_TIMEOUT_MS, timeoutMs);
    if (!Number.isFinite(budget) || budget <= 0) return Promise.reject(new Error('Invalid operation deadline'));
    const deadline = performance.now() + budget;
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(signal.reason || new Error('Operation cancelled'));
    if (signal?.aborted) { this.controllers.delete(controller); return Promise.reject(signal.reason || new Error('Operation cancelled')); }
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Operation deadline exceeded')), budget);
    clearTimeout(this.idleTimer);
    this.waiting++;
    const progressBudget = new ResponseBudget({ maxResponses: actions.length });
    const task = this.tail.then(async () => {
      if (controller.signal.aborted || this.closed) throw controller.signal.reason || new Error('Target lane closed');
      this.executor ??= await this.factory(this.profile);
      if (controller.signal.aborted) {
        await this.dropExecutor();
        throw controller.signal.reason;
      }
      try {
        const responses = await this.executor.execute(actions, { signal: controller.signal,
          onResponse: response => { progressBudget.add(response); onResponse?.(response); },
          timeoutMs: Math.max(1, deadline - performance.now()) });
        if (!Array.isArray(responses)) throw new Error('Invalid executor response batch');
        const finalBudget = new ResponseBudget({ maxResponses: actions.length });
        for (const response of responses) finalBudget.add(response);
        return responses;
      } catch (error) {
        // Uncertain native execution is never replayed or handed to another owner.
        await this.dropExecutor();
        throw error;
      }
    }).catch(error => {
      // Revoke before resolving the queue tail: already queued input cannot
      // race the caller's later error handling and enter an uncertain session.
      this.releasing = true;
      for (const queued of this.controllers) queued.abort(new Error('Target control revoked after operation failure'));
      throw error;
    });
    this.tail = task.catch(() => {});
    return task.finally(() => {
      this.controllers.delete(controller);
      this.waiting--;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!this.waiting && !this.closed) {
        this.idleTimer = setTimeout(() => {
          this.tail = this.tail.then(() => this.dropExecutor()).catch(() => {});
        }, this.idleMs);
        this.idleTimer.unref();
      }
    });
  }
  async close() {
    this.closed = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.leaseTimer);
    for (const controller of this.controllers) controller.abort(new Error('Target lane closed'));
    await this.tail;
    try { await this.dropExecutor(); } finally { await this.executor?.close({ graceful: false }); }
  }
}

export async function createBroker({ socketPath, config, factory, idleMs, leaseMs }) {
  // Names are discovery aliases, not independent permission to control the
  // same desktop. Reject known overlaps before opening a public socket.
  const identities = new Map();
  for (const [name, profile] of Object.entries(config.targets)) {
    const keys = [];
    if (profile.vnc) {
      let host = String(profile.vnc.host).toLowerCase().replace(/^\[|\]$/g, '');
      if (['localhost', '127.0.0.1', '::1'].includes(host)) host = 'loopback';
      keys.push(`vnc:${host}:${profile.vnc.port}`);
    }
    if (profile.hostHelper) keys.push(`helper:${String(profile.hostHelper.sshHost).toLowerCase()}`);
    if (profile.targetId !== undefined) {
      if (typeof profile.targetId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(profile.targetId)) {
        throw new Error('Invalid physical target identity');
      }
      keys.push(`target:${profile.targetId}`);
    }
    for (const key of keys) {
      if (identities.has(key)) throw new Error('Duplicate target endpoint or physical identity; use one profile per desktop');
      identities.set(key, name);
    }
  }
  await prepareSocket(socketPath);
  const lanes = new Map(Object.entries(config.targets).map(([name, profile]) =>
    [name, new TargetLane(profile, factory, { idleMs, leaseMs })]));
  const sockets = new Set();
  const active = new Set();
  let closing = false;
  let closePromise;
  const server = net.createServer(socket => {
    if (closing || sockets.size >= 128) return socket.destroy();
    sockets.add(socket);
    const clientId = randomUUID();
    const pending = new Map();
    let lane;
    const reply = frame => {
      try { writeFrame(socket, { v: 1, ...frame }); } catch { socket.destroy(); }
    };
    readFrames(socket, frame => {
      if (frame.v !== 1) return socket.destroy();
      if (frame.kind === 'open') {
        if (lane || !lanes.has(frame.profile)) return reply({ kind: 'error', error: { message: 'Unknown or already opened profile' } });
        lane = lanes.get(frame.profile);
        return reply({ kind: 'opened', clientId });
      }
      if (frame.kind === 'cancel') { pending.get(frame.id)?.abort(new Error('Operation cancelled')); return; }
      if (frame.kind === 'close') {
        for (const controller of pending.values()) controller.abort(new Error('Client closed'));
        void lane?.release(clientId).catch(() => {});
        socket.end();
        return false;
      }
      if (frame.kind === 'release' && lane && typeof frame.id === 'string' && frame.id.length <= 128) {
        lane.release(clientId).then(() => reply({ kind: 'result', id: frame.id, responses: [] }))
          .catch(() => reply({ kind: 'error', id: frame.id, error: { message: 'Target release unconfirmed' } }));
        return;
      }
      if (frame.kind !== 'execute' || !lane || typeof frame.id !== 'string' || frame.id.length > 128 || pending.has(frame.id)) {
        return reply({ kind: 'error', id: frame.id, error: { message: 'Invalid broker request' } });
      }
      if (pending.size >= MAX_WAITING) return reply({ kind: 'error', id: frame.id, error: { message: 'Client queue full' } });
      try { lane.acquire(clientId); }
      catch (error) { return reply({ kind: 'error', id: frame.id, error: errorRecord(error) }); }
      const controller = new AbortController();
      pending.set(frame.id, controller);
      active.add(controller);
      lane.execute(frame.actions, { signal: controller.signal, timeoutMs: frame.timeoutMs,
        onResponse: response => {
          const progress = responseMetadata(response);
          reply({ kind: 'progress', id: frame.id, response: progress });
        } })
        .then(responses => reply({ kind: 'result', id: frame.id, responses }))
        .catch(error => {
          reply({ kind: 'error', id: frame.id, error: errorRecord(error), responses: boundedErrorResponses(error.responses, frame.actions?.length) });
          void lane.release(clientId).catch(() => {});
        })
        .finally(() => { pending.delete(frame.id); active.delete(controller); });
    }, () => socket.destroy(), MAX_REQUEST_BYTES);
    socket.once('error', () => socket.destroy());
    socket.once('close', () => {
      for (const controller of pending.values()) controller.abort(new Error('Client disconnected'));
      sockets.delete(socket);
      void lane?.release(clientId).catch(() => {});
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
  return { server, lanes, close() {
    if (closePromise) return closePromise;
    closing = true;
    // Stop admission before awaiting owned executor cleanup. A connection
    // already queued for acceptance is refused by the closing flag above.
    const listenerClosed = new Promise(resolve => server.close(resolve));
    for (const controller of active) controller.abort(new Error('Broker shutting down'));
    for (const socket of sockets) socket.destroy();
    closePromise = (async () => {
      const results = await Promise.allSettled([...lanes.values()].map(lane => lane.close()));
      await listenerClosed;
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
    return closePromise;
  } };
}
