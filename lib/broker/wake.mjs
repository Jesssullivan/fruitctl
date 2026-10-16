// SPDX-License-Identifier: MIT
// D28: while a lease is active on a target whose profile opts in, the broker
// holds `caffeinate -d -u` on the target over SSH so the display stays awake
// for capture. The hold is advisory: spawn or exit failures are logged and
// reported in health, never fatal to the lease or its input.
import { spawn } from 'node:child_process';

export const DISPLAY_ASLEEP = 'display_asleep';
// Same destination character set as the host-helper and doctor validators.
// A leading '-' is refused and the destination follows `--` as one argv entry.
const SSH_DESTINATION = /^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,255}$/;
const DEFAULT_RETRY_MS = 30000;
const STOP_GRACE_MS = 1000;
const live = new Set();
let exitHookInstalled = false;

/** Normalize `targets.<name>.wake`. Absent or `enabled: false` disables it. */
export function wakeOptions(wake) {
  if (wake === undefined) return null;
  if (!wake || typeof wake !== 'object' || Array.isArray(wake) ||
      (wake.enabled !== undefined && typeof wake.enabled !== 'boolean')) {
    throw new Error('Invalid wake profile');
  }
  if (wake.enabled === false) return null;
  if (typeof wake.ssh !== 'string' || !SSH_DESTINATION.test(wake.ssh)) {
    throw new Error('Wake profile requires ssh as an explicit user@host destination');
  }
  return { ssh: wake.ssh };
}

/** Fixed argv; no local shell. `-tt` gives the remote command a terminal, so
 * closing the connection hangs it up instead of orphaning caffeinate. */
export function wakeArguments(destination) {
  return ['-tt', '-o', 'BatchMode=yes', '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '--', destination, 'caffeinate', '-d', '-u'];
}

function defaultSpawn(args) {
  const env = Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  return spawn('ssh', args, { stdio: ['pipe', 'ignore', 'ignore'], env });
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // A crashing broker still hangs up its own holds; signals are synchronous.
  process.once('exit', () => {
    for (const child of live) { try { child.kill('SIGTERM'); } catch { /* best effort */ } }
  });
}

export class WakeHold {
  constructor({ ssh, spawnImpl = defaultSpawn, log = () => {}, now = () => performance.now(),
    retryMs = DEFAULT_RETRY_MS }) {
    this.destination = ssh;
    this.spawnImpl = spawnImpl;
    this.log = log;
    this.now = now;
    this.retryMs = retryMs;
    this.child = null;
    this.state = 'idle';
    this.failures = 0;
    this.lastError = null;
    this.failedAt = -Infinity;
  }

  /** Start the hold unless it is running or a recent failure is backing off. */
  ensure() {
    if (this.child || this.now() - this.failedAt < this.retryMs) return;
    let child;
    try { child = this.spawnImpl(wakeArguments(this.destination)); }
    catch (error) { return this.fail(`spawn failed: ${error?.message || 'unknown'}`); }
    this.child = child;
    this.state = 'holding';
    this.stopping = false;
    live.add(child);
    installExitHook();
    child.stdin?.on?.('error', () => {});
    child.once('error', error => this.exited(child, `ssh failed: ${error?.code || error?.message || 'unknown'}`));
    child.once('exit', (code, signal) => this.exited(child, `ssh exited (${signal || `code ${code}`})`));
  }

  exited(child, reason) {
    live.delete(child);
    if (this.child !== child) return;
    this.child = null;
    const requested = this.stopping;
    this.stopping = false;
    this.resolveStop?.();
    if (requested) { this.state = 'idle'; return; }
    this.fail(reason);
  }

  fail(reason) {
    this.state = 'failed';
    this.failures++;
    this.failedAt = this.now();
    this.lastError = String(reason).slice(0, 256);
    this.log(`Fruitctl wake hold for ${this.destination} failed: ${this.lastError}`);
  }

  /** Hang up the hold (Stop, lease end or broker shutdown). Resolves once the
   * owned SSH child exits or the bounded grace passes; never rejects. */
  stop(reason = 'release') {
    const child = this.child;
    this.lastStop = reason;
    if (!child) {
      if (this.state === 'holding') this.state = 'idle';
      return Promise.resolve();
    }
    if (this.stopping) return this.stopped;
    this.stopping = true;
    this.stopped = new Promise(resolve => {
      let kill;
      const timer = setTimeout(resolve, STOP_GRACE_MS * 2);
      timer.unref?.();
      this.resolveStop = () => { clearTimeout(timer); clearTimeout(kill); this.resolveStop = null; resolve(); };
      try { child.kill('SIGTERM'); } catch { /* await exit or grace */ }
      kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* best effort */ } }, STOP_GRACE_MS);
      kill.unref?.();
    });
    return this.stopped;
  }

  status() {
    return { configured: true, state: this.state, failures: this.failures,
      ...(this.lastError ? { last_error: this.lastError } : {}),
      ...(this.lastStop ? { last_stop: this.lastStop } : {}) };
  }
}

/** A typed display_asleep failure. The broker never infers sleep from pixel
 * colour; it maps only an explicit executor signal. */
export function displayAsleepError(message = 'Target display is asleep; captures cannot show current pixels') {
  return Object.assign(new Error(message), { code: DISPLAY_ASLEEP });
}

export function isDisplayAsleep(error) {
  return error?.code === DISPLAY_ASLEEP || error?.data?.reason === DISPLAY_ASLEEP;
}

/** Give an executor's explicit asleep signal the stable broker code. Cleanup
 * failures and other typed codes are never overwritten. */
export function typedFailure(error) {
  if (error && typeof error === 'object' && error.data?.reason === DISPLAY_ASLEEP &&
      (error.code === undefined || typeof error.code === 'number')) {
    error.code = DISPLAY_ASLEEP;
  }
  return error;
}

/** Health results report the lane's wake hold beside the executor's fields. */
export function withWakeHealth(actions, responses, wake) {
  if (!wake || !Array.isArray(responses)) return responses;
  return responses.map((response, index) => actions[index]?.action === 'health' &&
    response?.result && typeof response.result === 'object' && !Array.isArray(response.result)
    ? { ...response, result: { ...response.result, wake: wake.status() } } : response);
}
