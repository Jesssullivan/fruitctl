import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { analyzePNG } from '../../test/qualification/oracle.mjs';
import { generateHTML, MARKER_CADENCE_MS } from '../../test/qualification/generate.mjs';

const maximumPNG = 12 * 1024 * 1024, maximumLine = 8192, maximumInput = 4 * 1024 * 1024;
const require = (condition, reason) => { if (!condition) throw new Error(reason); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b, keys) => keys.every(key => a[key] === b[key]);
// A held directory is identified by device/inode plus owner and mode. Its link count is not
// identity: APFS counts every entry, so each frame the caller supplies changes it.
const directoryKeys = ['dev', 'ino', 'mode', 'uid'];
const fileKeys = [...directoryKeys, 'nlink', 'size', 'mtimeNs', 'ctimeNs'];

// Serial file evidence only. The caller owns capture, timing and concurrent writers.
export async function runSceneStream(input, output) {
  require(typeof process.getuid === 'function', 'scene_posix_owner_required');
  const uid = BigInt(process.getuid()), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let configuration, directoryHandle, directoryIdentity, count = 0, previousSequence;
  let outputFailure, rejectOutput;
  const onOutputError = error => {
    outputFailure = error; rejectOutput?.(error);
    input.destroy?.(error);
  };
  output.on('error', onOutputError);

  async function emit(result) {
    const line = `${JSON.stringify(result)}\n`;
    require(Buffer.byteLength(line) <= 32768, 'scene_output_budget');
    if (outputFailure) throw outputFailure;
    // Await the write callback, including when write() reports backpressure.
    await new Promise((resolve, reject) => {
      rejectOutput = reject;
      output.write(line, error => {
        rejectOutput = undefined;
        if (error) outputFailure = error;
        if (outputFailure) reject(outputFailure); else resolve();
      });
    });
  }

  async function renewDirectory() {
    const held = await directoryHandle.stat({ bigint: true });
    const named = await lstat(configuration.directory, { bigint: true });
    require(held.isDirectory() && named.isDirectory() && same(directoryIdentity, held, directoryKeys) &&
      same(held, named, directoryKeys) && await realpath(configuration.directory) === configuration.directory,
    'scene_directory_changed');
  }

  async function readOwnedFrame(file) {
    require(path.dirname(file) === configuration.directory &&
      path.basename(file) === `frame-${String(count + 1).padStart(2, '0')}.png`, 'scene_frame_path_or_order');
    await renewDirectory();
    require(await realpath(file) === file, 'scene_noncanonical_frame');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      require(before.isFile() && before.uid === uid && before.nlink === 1n && (before.mode & 0o7777n) === 0o600n &&
        before.size >= 33n && before.size <= BigInt(maximumPNG), 'scene_frame_owner_mode_size');
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, null);
        require(result.bytesRead > 0, 'scene_frame_short_read'); offset += result.bytesRead;
      }
      require(!(await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead &&
        same(before, await handle.stat({ bigint: true }), fileKeys) &&
        same(before, await lstat(file, { bigint: true }), fileKeys), 'scene_frame_changed');
      await renewDirectory();
      // Narrow the allocation/decoding geometry; the public decoder still checks every chunk and CRC.
      require(bytes.subarray(12, 16).toString('ascii') === 'IHDR' && bytes.readUInt32BE(16) === configuration.width &&
        bytes.readUInt32BE(20) === configuration.height, 'scene_native_header_geometry');
      return bytes;
    } finally { await handle.close(); }
  }

  async function accept(bytes) {
    let line;
    try { line = decoder.decode(bytes); } catch { throw new Error('scene_utf8_invalid'); }
    let value;
    try { value = JSON.parse(line); } catch { throw new Error('scene_json_invalid'); }
    if (!configuration) {
      require(value && Object.keys(value).sort().join(',') === 'directory,fixtureSha256,height,maximumFrames,runId,width',
        'scene_configuration_shape');
      require(value.width === 1920 && value.height === 1080 && [30, 600].includes(value.maximumFrames) &&
        typeof value.runId === 'string' && /^[0-9a-f]{32}$/.test(value.runId) &&
        typeof value.fixtureSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.fixtureSha256) &&
        typeof value.directory === 'string' && path.isAbsolute(value.directory) &&
        path.normalize(value.directory) === value.directory, 'scene_configuration_bounds');
      require(digest(generateHTML(value.runId)) === value.fixtureSha256 && MARKER_CADENCE_MS === 50,
        'scene_generated_fixture_identity');
      configuration = value;
      const named = await lstat(value.directory, { bigint: true });
      require(named.isDirectory() && named.uid === uid && (named.mode & 0o7777n) === 0o700n &&
        await realpath(value.directory) === value.directory, 'scene_directory_custody');
      directoryHandle = await open(value.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      directoryIdentity = await directoryHandle.stat({ bigint: true });
      require(same(named, directoryIdentity, directoryKeys), 'scene_directory_changed');
      await renewDirectory();
      await emit({ status: 'prepared', format: 'fruitctl.scene.v1', runId: value.runId, width: value.width,
        height: value.height, markerCadenceMilliseconds: MARKER_CADENCE_MS });
      return false;
    }
    require(count < configuration.maximumFrames && value && Object.keys(value).sort().join(',') === 'file,number' &&
      value.number === count + 1 && typeof value.file === 'string', 'scene_request_order_or_budget');
    const png = await readOwnedFrame(value.file);
    const result = analyzePNG(png, { runId: configuration.runId, width: configuration.width,
      height: configuration.height, previousSequence });
    count++;
    await emit({ status: result.sceneValid ? 'passed' : 'failed-scene', width: configuration.width,
      height: configuration.height, number: count, ...result });
    if (!result.sceneValid) return true;
    previousSequence = result.sequence;
    return false;
  }

  try {
    let pending = Buffer.alloc(0), total = 0;
    for await (const chunk of input) {
      require(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array, 'scene_input_bytes_required');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      total += bytes.length; require(total <= maximumInput, 'scene_total_input_budget');
      let offset = 0;
      while (offset < bytes.length) {
        const end = bytes.indexOf(10, offset), limit = end === -1 ? bytes.length : end;
        require(pending.length + limit - offset <= maximumLine, 'scene_line_budget');
        pending = Buffer.concat([pending, bytes.subarray(offset, limit)]);
        if (end === -1) break;
        require(pending.length > 0, 'scene_line_budget');
        if (await accept(pending)) return 1;
        pending = Buffer.alloc(0); offset = end + 1;
      }
    }
    require(configuration && !pending.length, 'scene_missing_configuration_or_partial_line');
    require(count === configuration.maximumFrames, 'scene_incomplete_series');
    await renewDirectory();
    if (outputFailure) throw outputFailure;
    return 0;
  } finally {
    try { await directoryHandle?.close(); }
    finally {
      // Writable error events may follow their write callback in the next turn.
      if (outputFailure) await new Promise(resolve => setImmediate(resolve));
      output.removeListener('error', onOutputError);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    require(process.argv.length === 2, 'Usage: node scripts/qualification/scene_stream.mjs < SERIES.ndjson');
    process.exitCode = await runSceneStream(process.stdin, process.stdout);
  } catch (error) {
    process.stderr.write(`${error.message}\n`); process.exitCode = 2;
  }
}
