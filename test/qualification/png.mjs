import { inflateSync } from 'node:zlib';
import { scene } from './scene.mjs';

export const MAX_PNG_BYTES = 128 * 1024 * 1024;
export const MAX_PNG_CHUNKS = 4096;

// Deliberately narrow: complete non-interlaced 8-bit RGB/RGBA PNGs, unchanged.
export function decodePNG(input) {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_PNG_BYTES) throw new Error('Invalid PNG input type or size');
  // Check the byte length first, then take a bounded view without copying input.
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG signature or size');
  let offset = 8, header, ended = false, dataEnded = false, chunkCount = 0;
  const parts = [], metadataChunks = [];
  while (offset < bytes.length) {
    if (++chunkCount > MAX_PNG_CHUNKS) throw new Error('PNG chunk count exceeds limit');
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    const rawType = bytes.subarray(offset + 4, offset + 8);
    if (!rawType.every(byte => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) throw new Error('Invalid PNG chunk type');
    const type = rawType.toString('ascii');
    // A deliberate narrow policy; general PNG decoders may treat this as unknown.
    if (type[2] !== type[2].toUpperCase()) throw new Error('Unsupported PNG reserved-bit chunk');
    const payload = bytes.subarray(offset + 8, end - 4);
    if (scene.crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error(`PNG ${type} CRC mismatch`);
    if (!header && type !== 'IHDR') throw new Error('IHDR must be first');
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('Invalid IHDR');
      const width = payload.readUInt32BE(0), height = payload.readUInt32BE(4), channels = payload[9] === 2 ? 3 : payload[9] === 6 ? 4 : 0;
      if (!width || !height || width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024 ||
          payload[8] !== 8 || !channels || payload[10] || payload[11] || payload[12]) throw new Error('Unsupported PNG geometry, depth, color type or interlace');
      header = { width, height, channels };
    } else if (type === 'IDAT') {
      if (dataEnded) throw new Error('Noncontiguous IDAT');
      parts.push(payload);
    } else if (type === 'IEND') {
      if (length || !parts.length || end !== bytes.length) throw new Error('Invalid IEND or trailing PNG bytes');
      ended = true; offset = end; break;
    } else {
      if (parts.length) dataEnded = true;
      if (['acTL', 'fcTL', 'fdAT', 'tRNS', 'PLTE'].includes(type) || type[0] === type[0].toUpperCase()) throw new Error(`Unsupported PNG chunk ${type}`);
      metadataChunks.push(type);
    }
    offset = end;
  }
  if (!ended) throw new Error('Incomplete PNG');
  const { width, height, channels } = header, stride = width * channels, expected = height * (stride + 1);
  const compressed = Buffer.concat(parts), result = inflateSync(compressed, { maxOutputLength: expected, info: true });
  if (result.engine.bytesWritten !== compressed.length) throw new Error('Trailing compressed PNG bytes');
  const inflated = result.buffer;
  if (inflated.length !== expected) throw new Error('Incomplete or excess PNG scanlines');
  const raster = new Uint8Array(height * stride), pixels = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    if (filter > 4) throw new Error('Invalid PNG scanline filter');
    if (filter === 0) { raster.set(inflated.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride); continue; }
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, left = x >= channels ? raster[index - channels] : 0;
      const up = y ? raster[index - stride] : 0, upperLeft = y && x >= channels ? raster[index - stride - channels] : 0;
      const prediction = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      raster[index] = (inflated[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = raster[i * channels]; pixels[i * 4 + 1] = raster[i * channels + 1]; pixels[i * 4 + 2] = raster[i * channels + 2];
    pixels[i * 4 + 3] = channels === 4 ? raster[i * channels + 3] : 255;
  }
  return { width, height, pixels, metadataChunks, colorConversion: 'none; encoded RGB samples' };
}
