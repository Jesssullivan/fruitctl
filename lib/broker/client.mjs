// SPDX-License-Identifier: MIT
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFrames, writeFrame, MAX_REQUEST_BYTES } from './protocol.mjs';
import { ResponseBudget, responseMetadata } from '../mcp/protocol.js';

export class BrokerExecutor {
  constructor({ socketPath, target, connectTimeoutMs = 5000 }) {
    this.pending = new Map();
    this.closed = false;
    this.socket = net.connect(socketPath);
    this.opened = new Promise((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    // Prevent rejected connection promises becoming unhandled before execute.
    this.opened.catch(() => {});
    this.openTimer = setTimeout(() => this.fail(new Error('Fruitctl broker connection timed out')), connectTimeoutMs);
    this.socket.once('connect', () => {
      try { writeFrame(this.socket, { v: 1, kind: 'open', profile: target }); }
      catch (error) { this.fail(error); }
    });
    this.socket.once('error', () => this.fail(new Error('Fruitctl broker unavailable; start the configured user service')));
    this.socket.once('close', () => this.fail(new Error('Fruitctl broker disconnected; execution is uncertain')));
    readFrames(this.socket, frame => this.receive(frame), error => this.fail(error));
  }
  receive(frame) {
    if (frame.v !== 1) return this.fail(new Error('Invalid broker protocol version'));
    if (frame.kind === 'opened') {
      clearTimeout(this.openTimer);
      this.resolveOpen();
      return;
    }
    if (!frame.id) return this.fail(new Error(frame.error?.message || 'Broker rejected target'));
    const request = this.pending.get(frame.id);
    if (!request) return;
    if (frame.kind === 'progress') {
      if (!frame.response || typeof frame.response !== 'object') return this.fail(new Error('Invalid broker progress'));
      request.budget.add(frame.response);
      request.responses.push(responseMetadata(frame.response));
      request.onResponse?.(frame.response);
      return;
    }
    if (Array.isArray(frame.responses)) {
      const budget = new ResponseBudget({ maxResponses: request.maxResponses });
      for (const response of frame.responses) budget.add(response);
    }
    this.pending.delete(frame.id);
    request.cleanup();
    if (frame.kind === 'result' && Array.isArray(frame.responses)) request.resolve(frame.responses);
    else {
      const error = new Error(frame.error?.message || 'Broker request failed');
      error.code = frame.error?.code;
      error.responses = Array.isArray(frame.responses) ? frame.responses : [];
      request.reject(error);
    }
  }
  fail(error) {
    clearTimeout(this.openTimer);
    this.rejectOpen(error);
    for (const request of this.pending.values()) {
      request.cleanup();
      const failure = new Error(error.message);
      failure.responses = [...request.responses];
      request.reject(failure);
    }
    this.pending.clear();
    this.socket.destroy();
    this.closed = true;
  }
  async waitOpen({ signal, timeoutMs }) {
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    let timer;
    let abort;
    try {
      await Promise.race([this.opened, new Promise((_, reject) => {
        abort = () => reject(signal.reason || new Error('Operation cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Operation deadline exceeded')), timeoutMs);
      })]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  async execute(actions, { signal, timeoutMs = 30000, onResponse } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    await this.waitOpen({ signal, timeoutMs: deadline - performance.now() });
    timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new Error('Operation deadline exceeded');
    if (this.closed) throw new Error('Broker executor closed');
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        const responses = [...(this.pending.get(id)?.responses || [])];
        this.pending.delete(id);
        cleanup();
        try { writeFrame(this.socket, { v: 1, kind: 'cancel', id }); } catch {}
        const error = new Error(signal?.reason?.message || 'Operation deadline exceeded');
        error.responses = responses;
        reject(error);
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup, responses: [], onResponse,
        maxResponses: Math.max(1, Math.min(256, actions?.length || 1)),
        budget: new ResponseBudget({ maxResponses: Math.max(1, Math.min(256, actions?.length || 1)) }) });
      try { writeFrame(this.socket, { v: 1, kind: 'execute', id, actions, timeoutMs }, MAX_REQUEST_BYTES); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  async release({ signal, timeoutMs = 30000 } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid operation deadline');
    const deadline = performance.now() + Math.min(30000, timeoutMs);
    await this.waitOpen({ signal, timeoutMs: deadline - performance.now() });
    timeoutMs = deadline - performance.now();
    if (timeoutMs <= 0) throw new Error('Operation deadline exceeded');
    if (this.closed) throw new Error('Broker executor closed');
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        try { writeFrame(this.socket, { v: 1, kind: 'cancel', id }); } catch {}
        const error = new Error(`Target release unconfirmed: ${signal?.reason?.message || 'Operation deadline exceeded'}`);
        error.code = 'release_unconfirmed';
        this.fail(error);
        reject(error);
      };
      const timer = setTimeout(abort, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, responses: [], maxResponses: 1,
        budget: new ResponseBudget({ maxResponses: 1 }), cleanup });
      try { writeFrame(this.socket, { v: 1, kind: 'release', id, timeoutMs }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }
  async close() {
    if (!this.closed) {
      try { writeFrame(this.socket, { v: 1, kind: 'close' }); } catch {}
      this.fail(new Error('MCP client closed'));
    }
  }
}
