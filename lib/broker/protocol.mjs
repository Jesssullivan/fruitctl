// SPDX-License-Identifier: MIT
export const MAX_FRAME_BYTES = 96 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 1024 * 1024;

export function readFrames(stream, onFrame, onFailure, limit = MAX_FRAME_BYTES) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = Buffer.alloc(0);
  let bytes = 0;
  let stopped = false;
  const fail = () => {
    if (stopped) return;
    stopped = true;
    onFailure(new Error('Invalid or oversized Fruitctl protocol frame'));
  };
  stream.on('data', chunk => {
    if (stopped || stream.destroyed) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < input.length) {
      const newline = input.indexOf(10, offset);
      const end = newline === -1 ? input.length : newline;
      const length = bytes + end - offset;
      if (length > limit) return fail();
      if (length > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(limit, Math.max(length, buffer.length * 2, 65536)));
        buffer.copy(grown, 0, 0, bytes);
        buffer = grown;
      }
      input.copy(buffer, bytes, offset, end);
      bytes = length;
      if (newline === -1) return;
      let frame;
      try {
        const line = decoder.decode(buffer.subarray(0, bytes));
        bytes = 0;
        if (!line.trim()) { offset = newline + 1; continue; }
        frame = JSON.parse(line);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return fail();
        if (onFrame(frame) === false || stream.destroyed) { stopped = true; return; }
      } catch { return fail(); }
      offset = newline + 1;
    }
  });
  stream.once('end', () => { if (bytes) fail(); });
}

export function writeFrame(stream, frame, limit = MAX_FRAME_BYTES) {
  const line = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(line) > limit || stream.writableLength > MAX_FRAME_BYTES * 2) {
    throw new Error('Fruitctl protocol output limit exceeded');
  }
  if (stream.destroyed || stream.writableEnded) throw new Error('Fruitctl transport closed');
  stream.write(line);
}

export function errorRecord(error) {
  return { message: String(error.message || 'Fruitctl operation failed').slice(0, 1024),
    code: error.code || 'operation_failed' };
}
