import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, renameSync, symlinkSync, linkSync,
  openSync, ftruncateSync, closeSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scene } from './qualification/scene.mjs';
import { generateHTML } from './qualification/generate.mjs';
import { runSceneStream } from '../scripts/qualification/scene_stream.mjs';

const expected = { width: 1920, height: 1080, runId: '0123456789abcdef0123456789abcdef' };
const script = fileURLToPath(new URL('../scripts/qualification/scene_stream.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const line = value => Buffer.from(`${JSON.stringify(value)}\n`);
function chunk(type, payload) {
  const bytes = Buffer.alloc(payload.length + 12);
  bytes.writeUInt32BE(payload.length); bytes.write(type, 4); payload.copy(bytes, 8);
  bytes.writeUInt32BE(scene.crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}
function png(image) {
  const header = Buffer.alloc(13); header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    Buffer.from(image.pixels.buffer, image.pixels.byteOffset + y * image.width * 4, image.width * 4)
      .copy(rows, y * (image.width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function setPixel(image, x, y, rgba) { image.pixels.set(rgba, (y * image.width + x) * 4); }

let fixturePromise;
function fixtures() {
  return fixturePromise ??= (async () => {
    let pixels;
    const callbacks = [], handlers = {}, canvas = { getContext: () => context };
    const context = { fillStyle: '', fillRect(x, y, width, height) {
      pixels ??= new Uint8Array(canvas.width * canvas.height * 4);
      const rgba = [...this.fillStyle.match(/^rgb\((\d+),(\d+),(\d+)\)$/).slice(1).map(Number), 255];
      const row = new Uint8Array(width * 4);
      for (let i = 0; i < width; i++) row.set(rgba, i * 4);
      for (let iy = y; iy < y + height; iy++) pixels.set(row, (iy * canvas.width + x) * 4);
    } };
    const document = { fullscreenElement: null,
      documentElement: { async requestFullscreen() { document.fullscreenElement = this; } },
      body: { classList: { add() {}, remove() {} } }, addEventListener() {}, removeEventListener() {},
      querySelector: selector => selector === 'canvas' ? canvas : selector === 'button'
        ? { addEventListener(name, callback) { handlers[name] = callback; } } : {} };
    const html = generateHTML(expected.runId);
    vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], { document, innerWidth: 1920,
      innerHeight: 1080, devicePixelRatio: 1, performance: { now: () => 100 },
      requestAnimationFrame: callback => callbacks.push(callback), setTimeout, clearTimeout });
    await handlers.click();
    const paint = offset => {
      callbacks.shift()(100 + offset);
      return { width: canvas.width, height: canvas.height, pixels: pixels.slice() };
    };
    const first = paint(0), pngs = [png(first)];
    for (let i = 1; i < 30; i++) pngs.push(png(paint(i * 100)));
    return { first, pngs, paint, callbacks };
  })();
}

async function series(images, options = {}) {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), 'fruitctl-stream-'));
  const directory = path.join(container, options.directoryName ?? 'frames'); mkdirSync(directory, { mode: 0o700 });
  try {
    const configuration = { directory, ...expected, maximumFrames: 30,
      fixtureSha256: digest(generateHTML(expected.runId)), ...options.configuration };
    const requests = [configuration];
    images.forEach((bytes, index) => {
      const file = path.join(directory, `frame-${String(index + 1).padStart(2, '0')}.png`);
      writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      if (options.mode !== undefined) chmodSync(file, options.mode);
      requests.push(options.request ? options.request({ file, number: index + 1 }) : { file, number: index + 1 });
    });
    await options.setup?.({ container, directory, requests });
    const bytes = Buffer.concat(requests.map(line));
    if (options.cli) {
      const result = spawnSync(process.execPath, [script], { input: options.input?.(bytes) ?? bytes,
        timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      assert.equal(result.error, undefined);
      return { code: result.status, error: result.stderr.toString(),
        values: result.stdout.toString().trim().split('\n').filter(Boolean).map(value => JSON.parse(value)) };
    }
    const values = [];
    const output = new Writable({ highWaterMark: 1, write(bytes, encoding, callback) {
      const value = JSON.parse(bytes.toString()); values.push(value);
      Promise.resolve(options.written?.(value, { container, directory, requests })).then(() => callback(), callback);
    } });
    const chunks = options.input?.(bytes) ?? [bytes];
    let code, error;
    try { code = await runSceneStream(Readable.from(chunks), output); }
    catch (failure) { code = 2; error = failure.message; }
    return { code, error, values };
  } finally { rmSync(container, { recursive: true, force: true }); }
}

test('CLI accepts a complete 30-frame generated-browser PNG series with all raster evidence', async () => {
  const browser = await fixtures(), result = await series(browser.pngs, { cli: true });
  assert.equal(result.code, 0); assert.equal(result.error, ''); assert.equal(result.values.length, 31);
  assert.equal(result.values[0].status, 'prepared'); assert.equal(result.values[0].markerCadenceMilliseconds, 50);
  for (const [index, value] of result.values.slice(1).entries()) {
    assert.equal(value.status, 'passed'); assert.equal(value.sceneValid, true); assert.equal(value.strictRasterEqual, true);
    assert.equal(value.number, index + 1); assert.equal(value.sequence, index * 2); assert.equal(value.markers.length, 7);
    assert.equal(value.pngSha256, digest(browser.pngs[index])); assert.deepEqual(value.expected, expected);
    assert.ok(value.markers.every(marker => marker.failures.length === 0));
  }
  assert.equal(browser.callbacks.length, 1, 'missed paints are not queued');
});

test('scene-negative exits1, preserves evidence and stops before further frame requests', async () => {
  const browser = await fixtures();
  for (const next of [browser.pngs[1], browser.pngs[0]]) {
    const result = await series([browser.pngs[1], next, browser.pngs[2]], { cli: true });
    assert.equal(result.code, 1); assert.equal(result.error, ''); assert.equal(result.values.length, 3);
    assert.equal(result.values[2].status, 'failed-scene'); assert.equal(result.values[2].sceneValid, false);
    assert.ok(result.values[2].markers.every(marker => marker.failures.includes('sequence_not_advancing')));
  }
});

test('CRC/run/geometry/full-raster negatives retain original pixels and seven-marker diagnostics', async () => {
  const { first } = await fixtures(), layout = scene.geometry(expected.width, expected.height), cases = [];
  const crc = { ...first, pixels: first.pixels.slice() }, rect = layout.markers[0];
  for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) setPixel(crc, rect.x + 6 + x, rect.y + 6 + y, scene.colors.white);
  cases.push([crc, 'marker_crc_mismatch']);
  cases.push([{ ...expected, pixels: scene.renderPixels({ ...expected, runId: '1'.repeat(32), sequence: 1 }) }, 'fixture_run_mismatch']);
  const displaced = { ...first, pixels: first.pixels.slice() };
  for (let y = expected.height - 1; y >= 52; y--) {
    displaced.pixels.set(first.pixels.subarray((y - 52) * expected.width * 4, (y - 51) * expected.width * 4), y * expected.width * 4);
  }
  cases.push([displaced, 'marker_']);
  const purple = { ...first, pixels: first.pixels.slice() }; setPixel(purple, 1, 1, [90, 0, 160, 255]);
  cases.push([purple, 'unexpected_chromatic']);
  for (const [image, reason] of cases) {
    const before = digest(image.pixels), bytes = png(image), result = await series([bytes]);
    assert.equal(result.code, 1); assert.equal(result.values[1].status, 'failed-scene');
    assert.ok(result.values[1].errors.some(error => error.includes(reason)));
    assert.equal(result.values[1].pngSha256, digest(bytes)); assert.equal(digest(image.pixels), before);
  }
});

test('pointer allowance remains distinct from strict equality and physical attribution', async () => {
  const { first } = await fixtures(), image = { ...first, pixels: first.pixels.slice() };
  const zone = scene.geometry(expected.width, expected.height).pointerZone;
  setPixel(image, zone.x + 40, zone.y + 30, [240, 240, 240, 255]);
  const result = await series([png(image)]);
  assert.equal(result.code, 2); assert.equal(result.error, 'scene_incomplete_series');
  assert.equal(result.values[1].sceneValid, true); assert.equal(result.values[1].strictRasterEqual, false);
  assert.equal(result.values[1].pointerZone.residualPixels, 1); assert.match(result.values[1].pointerZone.attribution, /unattributed/);
});

test('empty, prepare-only, short30/600 and partial final lines cannot claim a complete series', async () => {
  const browser = await fixtures();
  for (const options of [{}, { configuration: { maximumFrames: 600 } }]) {
    for (const images of [[], browser.pngs.slice(0, 2)]) {
      const result = await series(images, options);
      assert.equal(result.code, 2); assert.equal(result.error, 'scene_incomplete_series');
    }
  }
  const empty = await series([], { cli: true, input: () => Buffer.alloc(0) });
  assert.equal(empty.code, 2); assert.match(empty.error, /scene_missing_configuration_or_partial_line/);
  const partial = await series(browser.pngs, { input: bytes => [bytes.subarray(0, -1)] });
  assert.equal(partial.code, 2); assert.equal(partial.error, 'scene_missing_configuration_or_partial_line');
  assert.equal(partial.values.length, 30, 'unterminated last frame is not analyzed');
});

test('600 selection applies the same oracle and still requires all600 rather than two end-window samples', async () => {
  const browser = await fixtures();
  const result = await series([png(browser.paint(59_800)), png(browser.paint(59_900))], { configuration: { maximumFrames: 600 } });
  assert.equal(result.code, 2); assert.equal(result.error, 'scene_incomplete_series');
  assert.deepEqual(result.values.slice(1).map(value => value.sequence), [1196, 1198]);
  assert.ok(result.values.slice(1).every(value => value.sceneValid && value.strictRasterEqual && value.markers.length === 7));
});

test('configuration shape, fixture digest, geometry and only30/600 bounds are enforced', async () => {
  for (const configuration of [{ maximumFrames: 0 }, { maximumFrames: 31 }, { maximumFrames: 601 },
    { width: 960 }, { height: 1081 }, { fixtureSha256: '0'.repeat(64) }, { runId: 'z'.repeat(32) }, { extra: true }]) {
    const result = await series([], { configuration });
    assert.equal(result.code, 2); assert.equal(result.values.length, 0); assert.ok(result.error);
  }
});

test('string fields refuse regex-coercible arrays before preparation, even with their matching generated fixture', async () => {
  for (const configuration of [{ runId: [expected.runId], fixtureSha256: digest(generateHTML([expected.runId])) },
    { fixtureSha256: [digest(generateHTML(expected.runId))] }]) {
    const result = await series([], { configuration });
    assert.equal(result.code, 2); assert.equal(result.error, 'scene_configuration_bounds'); assert.equal(result.values.length, 0);
  }
});

test('request order, names, paths and extra requests after a complete series fail before acceptance', async () => {
  const { pngs } = await fixtures();
  for (const request of [value => ({ ...value, number: 2 }), value => ({ ...value, number: '1' }),
    value => ({ ...value, file: path.join(path.dirname(value.file), 'frame-02.png') }),
    value => ({ ...value, file: path.basename(value.file) }), value => ({ ...value, extra: true })]) {
    const result = await series(pngs.slice(0, 1), { request });
    assert.equal(result.code, 2); assert.equal(result.values.length, 1);
  }
  const extra = await series(pngs, { setup({ requests }) { requests.push({ file: 'unused.png', number: 31 }); } });
  assert.equal(extra.code, 2); assert.equal(extra.error, 'scene_request_order_or_budget');
  assert.equal(extra.values.length, 31);
});

test('strict UTF8 accepts a split multibyte path but rejects replacement decoding, BOM and bad JSON', async () => {
  const { pngs } = await fixtures();
  const split = await series(pngs.slice(0, 1), { directoryName: 'frames-λ', input(bytes) {
    const index = bytes.indexOf(Buffer.from('λ')); return [bytes.subarray(0, index + 1), bytes.subarray(index + 1)];
  } });
  assert.equal(split.code, 2); assert.equal(split.error, 'scene_incomplete_series'); assert.equal(split.values[1].status, 'passed');
  const malformed = await series([], { directoryName: 'frames-λ', input(bytes) {
    const altered = Buffer.from(bytes); altered[altered.indexOf(Buffer.from('λ'))] = 0xff; return [altered];
  } });
  assert.equal(malformed.code, 2); assert.equal(malformed.error, 'scene_utf8_invalid'); assert.equal(malformed.values.length, 0);
  for (const bytes of [Buffer.from('{bad}\n'), Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 10])]) {
    const result = await series([], { input: () => [bytes] });
    assert.equal(result.code, 2); assert.equal(result.error, 'scene_json_invalid');
  }
});

test('line and aggregate input limits refuse oversized data before further protocol work', async () => {
  for (const bytes of [Buffer.from('\n'), Buffer.from(' '.repeat(8193) + '\n'), Buffer.alloc(4 * 1024 * 1024 + 1)]) {
    const result = await series([], { input: () => [bytes] });
    assert.equal(result.code, 2); assert.match(result.error, /scene_(line|total_input)_budget/); assert.equal(result.values.length, 0);
  }
});

test('held directory renewal refuses replacement and mode changes even with matching replacement PNGs', async () => {
  const { pngs } = await fixtures();
  for (const mutate of [({ directory }) => chmodSync(directory, 0o755), ({ directory }) => {
    renameSync(directory, `${directory}-old`); mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path.join(directory, 'frame-01.png'), pngs[0], { mode: 0o600, flag: 'wx' });
  }]) {
    const result = await series(pngs.slice(0, 1), { written(value, context) { if (value.status === 'prepared') mutate(context); } });
    assert.equal(result.code, 2); assert.equal(result.error, 'scene_directory_changed'); assert.equal(result.values.length, 1);
  }
  const result = await series(pngs.slice(0, 2), { written(value, { directory }) {
    if (value.number === 1) { renameSync(directory, `${directory}-old`); symlinkSync(`${directory}-old`, directory); }
  } });
  assert.equal(result.code, 2); assert.equal(result.error, 'scene_directory_changed'); assert.equal(result.values.length, 2);
});

test('directory custody refuses initial symlinks and public modes', async () => {
  for (const setup of [({ directory }) => chmodSync(directory, 0o755), ({ directory }) => {
    renameSync(directory, `${directory}-old`); symlinkSync(`${directory}-old`, directory);
  }]) {
    const result = await series([], { setup });
    assert.equal(result.code, 2); assert.equal(result.error, 'scene_directory_custody'); assert.equal(result.values.length, 0);
  }
});

test('frame custody refuses public mode, symlink, hardlink, directory and oversized sparse input', async () => {
  const { pngs } = await fixtures();
  const setups = [({ requests }) => chmodSync(requests[1].file, 0o644), ({ requests, container }) => {
    const target = path.join(container, 'other.png'); renameSync(requests[1].file, target); symlinkSync(target, requests[1].file);
  }, ({ requests, container }) => linkSync(requests[1].file, path.join(container, 'other.png')),
  ({ requests }) => { rmSync(requests[1].file); mkdirSync(requests[1].file, { mode: 0o700 }); },
  ({ requests }) => { const fd = openSync(requests[1].file, 'r+'); try { ftruncateSync(fd, 12 * 1024 * 1024 + 1); } finally { closeSync(fd); } }];
  for (const setup of setups) {
    const result = await series(pngs.slice(0, 1), { setup });
    assert.equal(result.code, 2); assert.equal(result.values.length, 1); assert.match(result.error, /scene_(frame|noncanonical_frame)/);
  }
});

test('complete PNG checks refuse truncated, trailing, CRC-corrupt and wrong native geometry files', async () => {
  const { pngs } = await fixtures(), corrupt = Buffer.from(pngs[0]); corrupt[29] ^= 1;
  for (const bytes of [pngs[0].subarray(0, -1), Buffer.concat([pngs[0], Buffer.from([0])]), corrupt,
    png({ width: 64, height: 48, pixels: new Uint8Array(64 * 48 * 4) })]) {
    const result = await series([bytes]); assert.equal(result.code, 2); assert.equal(result.values.length, 1);
  }
  const result = await series(pngs.slice(0, 1), { setup({ requests }) {
    assert.equal(digest(readFileSync(requests[1].file)), digest(pngs[0]));
  } });
  assert.equal(result.values[1].pngSha256, digest(pngs[0]));
});

test('output backpressure completes each write before the consumer pulls another record, and errors stop the series', async () => {
  const container = mkdtempSync(path.join(realpathSync(tmpdir()), 'fruitctl-stream-output-'));
  try {
    const configuration = { directory: container, ...expected, maximumFrames: 30, fixtureSha256: digest(generateHTML(expected.runId)) };
    let written = false, advanced = false;
    const output = new Writable({ highWaterMark: 1, write(bytes, encoding, callback) {
      setImmediate(() => { written = true; callback(); });
    } });
    async function* input() { yield line(configuration); assert.equal(written, true); advanced = true; }
    await assert.rejects(runSceneStream(input(), output), /scene_incomplete_series/);
    assert.equal(advanced, true); assert.equal(output.writableNeedDrain, false);
    let next = false;
    async function* failingInput() { yield line(configuration); next = true; yield line({ number: 1, file: 'unused' }); }
    const failure = new Writable({ write(bytes, encoding, callback) { setImmediate(() => callback(new Error('synthetic_output_failure'))); } });
    await assert.rejects(runSceneStream(failingInput(), failure), /synthetic_output_failure/);
    assert.equal(next, false); assert.equal(failure.listenerCount('error'), 0);
  } finally { rmSync(container, { recursive: true, force: true }); }
});

test('queued Readable records process the next frame only after the prepared output callback supplies its file', async () => {
  const { pngs } = await fixtures();
  const result = await series(pngs.slice(0, 1), {
    setup({ requests }) { rmSync(requests[1].file); },
    async written(value, { requests }) {
      if (value.status === 'prepared') {
        await new Promise(resolve => setImmediate(resolve));
        writeFileSync(requests[1].file, pngs[0], { flag: 'wx', mode: 0o600 });
      }
    },
  });
  assert.equal(result.code, 2); assert.equal(result.error, 'scene_incomplete_series');
  assert.deepEqual(result.values.map(value => value.status), ['prepared', 'passed']);
});
