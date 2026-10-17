// SPDX-License-Identifier: MIT
// D8/D16: clipboard_read text leaves the Darwin broker only after this check.
// A value that contains a declared secret is withheld entirely, never masked
// in place: a partial mask still reveals the secret's position and length.

export const CLIPBOARD_MAX_BYTES = Object.freeze({ min: 1, max: 1024 * 1024, default: 16 * 1024 });
export const CLIPBOARD_TTL_MS = Object.freeze({ min: 1000, max: 86400000 });
// Shorter secrets are matched exactly, not as substrings, so a one-letter
// credential cannot withhold every clipboard containing that letter.
const MIN_SUBSTRING_SECRET = 4;

export function validClipboardMaxBytes(value) {
  return Number.isInteger(value) && value >= CLIPBOARD_MAX_BYTES.min && value <= CLIPBOARD_MAX_BYTES.max;
}

export function validClipboardTtlMs(value) {
  return Number.isInteger(value) && value >= CLIPBOARD_TTL_MS.min && value <= CLIPBOARD_TTL_MS.max;
}

function matchesSecret(text, secrets) {
  for (const secret of secrets) {
    if (typeof secret !== 'string' || !secret.length) continue;
    if (text === secret || (secret.length >= MIN_SUBSTRING_SECRET && text.includes(secret))) return true;
  }
  return false;
}

/** Bound one native clipboard_read result. Redaction is decided on the whole
 * text before truncation, so a cut can never split a secret past the check.
 * Truncation keeps whole UTF-8 code points. */
export function boundClipboard(clipboard, { maxBytes = CLIPBOARD_MAX_BYTES.default, secrets = [] } = {}) {
  if (!clipboard || typeof clipboard.text !== 'string') throw new Error('Invalid native clipboard result');
  const { text, ...metadata } = clipboard;
  const bytes = Buffer.byteLength(text);
  if (matchesSecret(text, secrets)) return { ...metadata, bytes, redacted: true };
  if (bytes <= maxBytes) return { ...metadata, text, bytes };
  let end = maxBytes;
  const encoded = Buffer.from(text);
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return { ...metadata, text: encoded.subarray(0, end).toString('utf8'), bytes, truncated: true };
}

/** A clipboard_read response with its text bounded, or the response as is. */
export function boundClipboardResponse(response, options) {
  const clipboard = response?.result?.clipboard;
  if (!clipboard || typeof clipboard.text !== 'string') return response;
  return { ...response, result: { ...response.result, clipboard: boundClipboard(clipboard, options) } };
}
