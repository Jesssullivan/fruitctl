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
