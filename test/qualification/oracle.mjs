import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { scene } from './scene.mjs';
import { decodePNG, MAX_PNG_BYTES } from './png.mjs';

export async function readBoundedPNG(file) {
  // NONBLOCK avoids waiting for a writer if the supplied path is a FIFO.
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 8 || before.size > MAX_PNG_BYTES) throw new Error('PNG must be a regular file within the byte limit');
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) throw new Error('PNG file truncated while reading');
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw new Error('PNG file grew while reading');
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('PNG file changed while reading');
    return bytes;
  } finally { await handle.close(); }
}

function neutral(r, g, b) { return r === g && g === b; }
function colorMatches(actual, expected) {
  return actual[3] === 255 && actual.slice(0, 3).every((value, index) => Math.abs(value - expected[index]) <= 16) &&
    (expected[0] === expected[1] && expected[1] === expected[2] ? neutral(...actual) : actual[1] === actual[2]);
}
function inRect(x, y, rect) { return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height; }

export function analyzeFrame(frame, { runId, width, height, previousSequence } = {}) {
  // Expected dimensions and run ID come from the prepared episode, never the captured image.
  const layout = scene.geometry(width, height);
  if (!/^[0-9a-f]{32}$/.test(runId ?? '')) throw new Error('Expected runId is required');
  if (previousSequence !== undefined && (!Number.isInteger(previousSequence) || previousSequence < 0 || previousSequence > 0xffffffff)) throw new Error('Invalid previousSequence');
  const errors = [], markers = [];
  if (frame.width !== width || frame.height !== height || frame.pixels.length !== width * height * 4) {
    return { format: scene.format, sceneValid: false, strictRasterEqual: false, errors: ['frame_geometry_mismatch'], expected: { runId, width, height } };
  }
  for (let markerId = 0; markerId < 7; markerId++) {
    const rect = layout.markers[markerId], bytes = new Uint8Array(50);
    let contaminatedSamples = 0;
    for (let bit = 0; bit < scene.cells * scene.cells; bit++) {
      const x = rect.x + (bit % scene.cells + 1) * scene.cellSize + 3;
      const y = rect.y + (Math.floor(bit / scene.cells) + 1) * scene.cellSize + 3;
      const center = frame.pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
      const white = colorMatches(center, scene.colors.white), black = colorMatches(center, scene.colors.black);
      if (!white && !black) contaminatedSamples++;
      // Every 3x3 sample must belong to the same bit; no averaging away a cursor.
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const offset = ((y + dy) * width + x + dx) * 4;
        if (!colorMatches(frame.pixels.subarray(offset, offset + 4), white ? scene.colors.white : scene.colors.black)) contaminatedSamples++;
      }
      if (white) bytes[bit >>> 3] |= 1 << (7 - (bit & 7));
    }
    const view = new DataView(bytes.buffer), failures = [];
    const decodedRunId = [...bytes.subarray(6, 22)].map(v => v.toString(16).padStart(2, '0')).join('');
    const sequence = view.getUint32(22);
    if (contaminatedSamples) failures.push('marker_sample_overlap_or_contamination');
    if (!bytes.subarray(0, 4).every((v, i) => v === [0x46, 0x51, 0x53, 0x31][i]) || bytes[4] !== scene.version) failures.push('fixture_format_mismatch');
    if (bytes[5] !== markerId) failures.push('marker_geometry_or_id_mismatch');
    if (decodedRunId !== runId) failures.push('fixture_run_mismatch');
    if (view.getUint16(26) !== width || view.getUint16(28) !== height) failures.push('encoded_geometry_mismatch');
    if (scene.crc32(bytes.subarray(0, 46)) !== view.getUint32(46)) failures.push('marker_crc_mismatch');
    if (bytes.subarray(30, 46).some(v => v !== 0)) failures.push('fixture_padding_mismatch');
    if (previousSequence !== undefined && sequence <= previousSequence) failures.push('sequence_not_advancing');
    markers.push({ markerId, sequence, failures, contaminatedSamples });
    errors.push(...failures.map(failure => `marker_${markerId}:${failure}`));
  }
  const sequence = markers[0].sequence;
  if (markers.some(marker => marker.sequence !== sequence)) errors.push('inconsistent_marker_sequences');
  const expectedPixels = scene.renderPixels({ width, height, runId, sequence });
  let residualPixels = 0, invalidPixels = 0, pointerResidualPixels = 0, chromaticOrTransparentPixels = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let offset = 0; offset < expectedPixels.length; offset += 4) {
    const r = frame.pixels[offset], g = frame.pixels[offset + 1], b = frame.pixels[offset + 2], a = frame.pixels[offset + 3];
    const er = expectedPixels[offset], eg = expectedPixels[offset + 1], eb = expectedPixels[offset + 2];
    if (r === er && g === eg && b === eb && a === 255) continue;
    residualPixels++;
    const grayscale = a === 255 && neutral(r, g, b);
    if (a === 255 && Math.abs(r - er) <= 16 && Math.abs(g - eg) <= 16 && Math.abs(b - eb) <= 16 &&
        (er === eg && eg === eb ? grayscale : g === b)) continue;
    const x = (offset / 4) % width, y = Math.floor(offset / 4 / width);
    if (!grayscale) chromaticOrTransparentPixels++;
    if (inRect(x, y, layout.pointerZone) && grayscale) {
      pointerResidualPixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    } else invalidPixels++;
  }
  // Fixed format allowance, not learned from failed images: one <=64x80 grayscale residual, <=4096 pixels.
  const pointerBounds = pointerResidualPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  if (pointerBounds && (pointerResidualPixels > 4096 || pointerBounds.width > 64 || pointerBounds.height > 80)) errors.push('pointer_zone_residual_exceeds_declared_bounds');
  if (invalidPixels) errors.push('unexpected_raster_pixels');
  if (chromaticOrTransparentPixels) errors.push('unexpected_chromatic_or_transparent_pixels');
  return { format: scene.format, expected: { runId, width, height }, sequence, sceneValid: errors.length === 0,
    strictRasterEqual: errors.length === 0 && residualPixels === 0, residualPixels, invalidPixels,
    pointerZone: { ...layout.pointerZone, residualPixels: pointerResidualPixels, bounds: pointerBounds, attribution: pointerResidualPixels ? 'unattributed opaque grayscale; not proof of cursor identity' : 'no out-of-tolerance residual' },
    chromaticOrTransparentPixels, markers, errors,
    scope: 'versioned fixture and fixed parking-zone diagnostic; no product, overlay-exclusion, Stop, consent or input qualification' };
}

export function analyzePNG(bytes, expected) {
  const frame = decodePNG(bytes);
  return { ...analyzeFrame(frame, expected), pngSha256: createHash('sha256').update(bytes).digest('hex'),
    pngMetadataChunks: frame.metadataChunks, colorConversion: frame.colorConversion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runId, widthText, heightText, ...files] = process.argv.slice(2);
  if (!files.length) { process.stderr.write('Usage: node test/qualification/oracle.mjs RUN_ID WIDTH HEIGHT FRAME.png [...]\n'); process.exitCode = 2; }
  else {
    let previousSequence;
    for (const file of files) {
      try {
        const result = analyzePNG(await readBoundedPNG(file), { runId, width: Number(widthText), height: Number(heightText), previousSequence });
        process.stdout.write(`${JSON.stringify({ file, ...result })}\n`);
        if (!result.sceneValid) { process.exitCode = 1; break; }
        previousSequence = result.sequence;
      } catch (error) { process.stdout.write(`${JSON.stringify({ file, sceneValid: false, error: error.message })}\n`); process.exitCode = 1; break; }
    }
  }
}
