// SPDX-License-Identifier: MIT
// Each caller keeps a small return margin instead of starting an equal inner
// timer later. These reserves scale down for short, positive caller budgets.
export function replyBudget(timeoutMs) {
  return timeoutMs - Math.min(100, timeoutMs / 10);
}

// Work and safety retirement share one total deadline. Reserving at most half
// a short budget leaves positive work time without granting a fresh grace.
export function executionBudget(timeoutMs) {
  const cleanupMs = Math.min(2000, timeoutMs / 2);
  return { workMs: timeoutMs - cleanupMs, cleanupMs };
}

export const RETIREMENT_TIMEOUT_MS = 2000;

// Retirement inherits its caller's cutoff; entering another cleanup phase
// never creates a fresh grace period. An expired inherited deadline is valid:
// it requires immediate termination and an unconfirmed result, not more time.
export function retirementDeadline({ timeoutMs = RETIREMENT_TIMEOUT_MS, deadline,
  now = performance.now() } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30000 ||
      !Number.isFinite(now) || (deadline !== undefined && !Number.isFinite(deadline))) {
    throw new Error('Invalid retirement deadline');
  }
  return Math.min(now + timeoutMs, deadline ?? Infinity);
}
