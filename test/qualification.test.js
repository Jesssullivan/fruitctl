import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import vm from 'node:vm';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scene } from './qualification/scene.mjs';
import { decodePNG, MAX_PNG_BYTES, MAX_PNG_CHUNKS } from './qualification/png.mjs';
import { analyzeFrame, analyzePNG, readBoundedPNG } from './qualification/oracle.mjs';
import { generateHTML } from './qualification/generate.mjs';

const expected = { width: 960, height: 640, runId: '0123456789abcdef0123456789abcdef' };
function frame(sequence = 1) { return { ...expected, pixels: scene.renderPixels({ ...expected, sequence }) }; }
function setPixel(image, x, y, rgba) { image.pixels.set(rgba, (y * image.width + x) * 4); }
function replaceMarker(image, markerId, change) {
  const bytes = scene.markerBytes({ ...expected, sequence: 1, markerId });
  change(bytes); new DataView(bytes.buffer).setUint32(46, scene.crc32(bytes.subarray(0, 46)));
  const rect = scene.geometry(expected.width, expected.height).markers[markerId];
  for (let bit = 0; bit < 400; bit++) {
    const color = bytes[bit >>> 3] & (1 << (7 - (bit & 7))) ? scene.colors.white : scene.colors.black;
    for (let dy = 0; dy < 6; dy++) for (let dx = 0; dx < 6; dx++) setPixel(image, rect.x + (bit % 20 + 1) * 6 + dx, rect.y + (Math.floor(bit / 20) + 1) * 6 + dy, color);
  }
}
function pngChunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length); bytes.write(type, 4); payload.copy(bytes, 8);
  bytes.writeUInt32BE(scene.crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
function encodePNG(image, { channels = 4, filters = [0] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = channels === 4 ? 6 : 2;
  const stride = image.width * channels, raster = Buffer.alloc(stride * image.height);
  for (let i = 0; i < image.width * image.height; i++) for (let channel = 0; channel < channels; channel++) raster[i * channels + channel] = image.pixels[i * 4 + channel];
  const rows = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const filter = filters[y % filters.length]; rows[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const offset = y * stride + x, a = x < channels ? 0 : raster[offset - channels], b = y ? raster[offset - stride] : 0, c = y && x >= channels ? raster[offset - stride - channels] : 0;
      const p = a + b - c, distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)], least = Math.min(...distances);
      const prediction = [0, a, b, Math.floor((a + b) / 2), [a, b, c][distances.indexOf(least)]][filter];
      rows[y * (stride + 1) + x + 1] = (raster[offset] - prediction + 256) % 256;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

test('CRC-bound seven-marker scene decodes the prepared run and advancing sequence', () => {
  assert.equal(scene.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const first = analyzeFrame(frame(10), expected), next = analyzeFrame(frame(11), { ...expected, previousSequence: first.sequence });
  assert.equal(first.sceneValid, true); assert.equal(first.strictRasterEqual, true); assert.equal(next.sceneValid, true);
  assert.equal(first.markers.length, 7); assert.equal(next.sequence, 11);
  for (const sequence of [10, 9]) assert.equal(analyzeFrame(frame(sequence), { ...expected, previousSequence: 10 }).sceneValid, false);
});

test('valid CRC cannot authorize a stale format, run ID, geometry or marker identity', () => {
  for (const [change, reason] of [
    [bytes => bytes[4] = 0, 'fixture_format_mismatch'],
    [bytes => bytes[6] ^= 1, 'fixture_run_mismatch'],
    [bytes => bytes[5] = 3, 'marker_geometry_or_id_mismatch'],
    [bytes => new DataView(bytes.buffer).setUint16(26, 961), 'encoded_geometry_mismatch'],
    [bytes => bytes[30] = 1, 'fixture_padding_mismatch'],
  ]) {
    const image = frame(); replaceMarker(image, 0, change);
    const result = analyzeFrame(image, expected);
    assert.equal(result.sceneValid, false); assert.ok(result.markers[0].failures.includes(reason));
    assert.ok(!result.markers[0].failures.includes('marker_crc_mismatch'));
  }
});

test('marker CRC and sequence agreement fail even when every sample is a valid bit', () => {
  const damaged = frame(), rect = scene.geometry(expected.width, expected.height).markers[0];
  // Flip a full payload bit without recomputing its CRC.
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) setPixel(damaged, rect.x + 6 + x, rect.y + 6 + y, scene.colors.white);
  assert.ok(analyzeFrame(damaged, expected).markers[0].failures.includes('marker_crc_mismatch'));
  const mixed = frame(); replaceMarker(mixed, 4, bytes => new DataView(bytes.buffer).setUint32(22, 2));
  assert.ok(analyzeFrame(mixed, expected).errors.includes('inconsistent_marker_sequences'));
});

test('fixed native geometry rejects a toolbar displacement and wrong frame dimensions', () => {
  const original = frame(), displaced = frame();
  displaced.pixels.fill(64);
  for (let y = 0; y < expected.height - 52; y++) displaced.pixels.set(original.pixels.subarray(y * expected.width * 4, (y + 1) * expected.width * 4), (y + 52) * expected.width * 4);
  assert.equal(analyzeFrame(displaced, expected).sceneValid, false);
  assert.deepEqual(analyzeFrame({ ...original, height: 641 }, expected).errors, ['frame_geometry_mismatch']);
});

test('visible pointer has a fixed narrow grayscale zone, distinct from strict equality', () => {
  const image = frame(), zone = scene.geometry(expected.width, expected.height).pointerZone;
  for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) setPixel(image, zone.x + 40 + x, zone.y + 30 + y, [240, 240, 240, 255]);
  const untouched = image.pixels.slice(), result = analyzeFrame(image, expected);
  assert.equal(result.sceneValid, true); assert.equal(result.strictRasterEqual, false);
  assert.equal(result.pointerZone.residualPixels, 200);
  assert.deepEqual(result.pointerZone.bounds, { x: zone.x + 40, y: zone.y + 30, width: 10, height: 20 });
  assert.deepEqual(image.pixels, untouched, 'oracle preserves complete captured pixels');
  setPixel(image, zone.x, zone.y, [90, 0, 160, 255]);
  const purple = analyzeFrame(image, expected);
  assert.equal(purple.sceneValid, false); assert.equal(purple.chromaticOrTransparentPixels, 1);
  setPixel(image, zone.x, zone.y, [64, 64, 65, 255]);
  assert.equal(analyzeFrame(image, expected).sceneValid, false, 'small chromatic casts are not grayscale');
});

test('cursor overlap, broad residuals, transparency and unaccounted system UI fail', () => {
  const layout = scene.geometry(expected.width, expected.height);
  const cases = [
    [layout.markers[4].x + 9, layout.markers[4].y + 9, [218, 218, 218, 255]],
    [1, 1, [235, 235, 235, 255]],
    [layout.pointerZone.x, layout.pointerZone.y, [64, 64, 64, 0]],
  ];
  for (const [x, y, color] of cases) { const image = frame(); setPixel(image, x, y, color); assert.equal(analyzeFrame(image, expected).sceneValid, false); }
  const image = frame(), zone = layout.pointerZone;
  setPixel(image, zone.x, zone.y, [255, 255, 255, 255]); setPixel(image, zone.x + 65, zone.y, [255, 255, 255, 255]);
  assert.ok(analyzeFrame(image, expected).errors.includes('pointer_zone_residual_exceeds_declared_bounds'));
});

test('complete RGB/RGBA PNGs decode all scanline filters; malformed bytes are refused', () => {
  const image = { width: 4, height: 5, pixels: Uint8Array.from({ length: 80 }, (_, i) => i % 4 === 3 ? 255 : (i * 79) % 256) };
  for (const channels of [3, 4]) {
    const png = encodePNG(image, { channels, filters: [0, 1, 2, 3, 4] });
    assert.deepEqual(decodePNG(png).pixels, image.pixels);
    assert.throws(() => decodePNG(png.subarray(0, -1)), /Truncated/);
    assert.throws(() => decodePNG(Buffer.concat([png, Buffer.from([0])])), /trailing/);
    const corrupted = Buffer.from(png); corrupted[29] ^= 1;
    assert.throws(() => decodePNG(corrupted), /CRC/);
  }
  const complete = analyzePNG(encodePNG(frame()), expected);
  assert.equal(complete.sceneValid, true); assert.match(complete.pngSha256, /^[0-9a-f]{64}$/);
  const rgb = encodePNG(image, { channels: 3 });
  assert.throws(() => decodePNG(Buffer.concat([rgb.subarray(0, 33), pngChunk('tRNS', Buffer.alloc(6)), rgb.subarray(33)])), /tRNS/);
  const dataLength = rgb.readUInt32BE(33), payload = rgb.subarray(41, 41 + dataLength);
  assert.throws(() => decodePNG(Buffer.concat([rgb.subarray(0, 33), pngChunk('IDAT', Buffer.concat([payload, Buffer.from([0])])), rgb.subarray(45 + dataLength)])), /Trailing compressed/);
});

test('narrow PNG decoder rejects PLTE variants and bounds chunks and existing inputs', () => {
  const png = encodePNG({ width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) });
  const before = png.subarray(0, 33), after = png.subarray(33), validPalette = pngChunk('PLTE', Buffer.from([0, 0, 0]));
  for (const bad of [
    Buffer.concat([before, pngChunk('PLTE', Buffer.from([0])), after]),
    Buffer.concat([png.subarray(0, -12), validPalette, png.subarray(-12)]),
    Buffer.concat([before, validPalette, validPalette, after]),
  ]) assert.throws(() => decodePNG(bad), /Unsupported PNG chunk PLTE/);
  assert.throws(() => decodePNG(Buffer.concat([before, pngChunk('abcD', Buffer.alloc(0)), after])), /Unsupported PNG reserved-bit/);
  const ancillary = Array.from({ length: MAX_PNG_CHUNKS - 2 }, () => pngChunk('teST', Buffer.alloc(0)));
  assert.throws(() => decodePNG(Buffer.concat([before, ...ancillary, after])), /chunk count/);
  assert.throws(() => decodePNG(new Uint8Array(MAX_PNG_BYTES + 1)), /input type or size/);
});

test('PNG file reading refuses oversized sparse files and nonregular inputs before allocation', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fruitctl-qualification-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = encodePNG({ width: 1, height: 1, pixels: new Uint8Array([64, 64, 64, 255]) });
  const regular = path.join(directory, 'complete.png'); await writeFile(regular, png);
  assert.deepEqual(await readBoundedPNG(regular), png);
  await assert.rejects(readBoundedPNG(directory), /regular file/);
  const oversized = path.join(directory, 'oversized.png'), handle = await open(oversized, 'wx');
  try { await handle.truncate(MAX_PNG_BYTES + 1); } finally { await handle.close(); }
  await assert.rejects(readBoundedPNG(oversized), /byte limit/);
});

test('CRC-valid high-bit chunk names cannot alias an IHDR or ancillary name', () => {
  const png = encodePNG({ width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 255]) });
  const withAncillary = Buffer.concat([png.subarray(0, 33), pngChunk('abCD', Buffer.alloc(0)), png.subarray(33)]);
  for (const [input, chunkOffset, firstByte] of [[png, 8, 0xc9], [withAncillary, 33, 0xe1]]) {
    const malformed = Buffer.from(input), length = malformed.readUInt32BE(chunkOffset);
    malformed[chunkOffset + 4] = firstByte;
    malformed.writeUInt32BE(scene.crc32(malformed.subarray(chunkOffset + 4, chunkOffset + 8 + length)), chunkOffset + 8 + length);
    assert.throws(() => decodePNG(malformed), /Invalid PNG chunk type/);
  }
});

function browserSandbox({ webkit = false } = {}) {
  const html = generateHTML(expected.runId), script = html.match(/<script>([\s\S]*)<\/script>/i)[1];
  const canvas = { getContext: () => ({ fillRect() {}, fillStyle: '' }) }, status = {}, handlers = {}, scheduled = [], events = new Map(), timers = new Map();
  const button = { disabled: false, addEventListener(name, callback) { handlers[name] = callback; } };
  let requests = 0, nextTimer = 1;
  const document = { fullscreenElement: null, webkitFullscreenElement: null, body: { classList: { add() {}, remove() {} } },
    documentElement: webkit ? { webkitRequestFullscreen() { requests++; } } : { async requestFullscreen() { requests++; document.fullscreenElement = this; } },
    addEventListener(name, callback) { events.set(name, callback); }, removeEventListener(name) { events.delete(name); },
    querySelector(selector) { return selector === 'canvas' ? canvas : selector === '#status' ? status : button; } };
  const sandbox = { document, innerWidth: 960, innerHeight: 640, devicePixelRatio: 1, performance: { now: () => 100 }, requestAnimationFrame: callback => scheduled.push(callback),
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(script, sandbox);
  return { html, canvas, status, handlers, scheduled, document, sandbox, button, events, timers, requestCount: () => requests };
}

test('self-contained browser page starts only after fullscreen and stops on a geometry change', async () => {
  const { html, status, handlers, canvas, scheduled, sandbox, events, timers } = browserSandbox();
  assert.match(status.textContent, /0123456789abcdef0123456789abcdef/);
  assert.match(status.textContent, /82% down/);
  await handlers.click(); assert.equal(canvas.width, 960); assert.equal(scheduled.length, 1);
  assert.equal(events.size, 0); assert.equal(timers.size, 0);
  scheduled.shift()(101); sandbox.innerHeight = 641; scheduled.shift()(102);
  assert.match(status.textContent, /geometry changed/); assert.equal(scheduled.length, 0);
  assert.throws(() => generateHTML('stale'), /runId/);
  assert.ok(!html.includes('cursor:none'));
});

test('void-returning WebKit waits for the requested fullscreen change and does not double-dispatch', async () => {
  const { handlers, canvas, scheduled, document, button, events, timers, requestCount } = browserSandbox({ webkit: true });
  const start = handlers.click(); await Promise.resolve();
  assert.equal(button.disabled, true); assert.equal(canvas.width, undefined); assert.equal(scheduled.length, 0);
  await handlers.click(); assert.equal(requestCount(), 1);
  document.webkitFullscreenElement = {}; events.get('webkitfullscreenchange')();
  await Promise.resolve(); assert.equal(scheduled.length, 0, 'unrelated fullscreen element cannot start the scene');
  document.webkitFullscreenElement = document.documentElement; events.get('webkitfullscreenchange')();
  await start; assert.equal(canvas.width, 960); assert.equal(scheduled.length, 1);
  assert.equal(button.disabled, false); assert.equal(events.size, 0); assert.equal(timers.size, 0);
});

test('fullscreen timeout and error end preparation without starting marker frames', async () => {
  for (const reason of ['timeout', 'error']) {
    const { handlers, status, scheduled, button, events, timers } = browserSandbox({ webkit: true });
    const start = handlers.click();
    if (reason === 'timeout') { const timer = [...timers.values()][0]; assert.equal(timer.delay, 5000); timer.callback(); }
    else events.get('webkitfullscreenerror')();
    await start; assert.equal(scheduled.length, 0); assert.equal(button.disabled, false);
    assert.match(status.textContent, reason === 'timeout' ? /timed out/ : /request failed/);
    assert.equal(events.size, 0); assert.equal(timers.size, 0);
  }
});
