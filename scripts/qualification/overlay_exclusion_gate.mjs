// SPDX-License-Identifier: MIT
// Attended Host-route overlay exclusion gate (TIN-5541). Observation only: the
// runner sends `health` and `screenshot` through the operator's configured
// Fruitctl MCP target and nothing else. It never launches the Host, grants a
// permission, sends input, or masks pixels.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { decodePNG } from '../../test/qualification/png.mjs';

// FruitctlHost/HostRenderer.swift draws feathered edges in this sRGB purple
// (alpha 0.94 at the outer edge, pulsing between 0.48 and 1.0 layer opacity).
export const OVERLAY_RGB = Object.freeze([75, 0, 130]);
// Over any neutral pixel the overlay at alpha a adds 75a to min(R, B) - G. The
// scene fixture and any scaling of it mix only neutrals and cyan (G == B), so
// their excess is <= 0. 12 detects the overlay down to alpha 0.16.
export const PURPLE_EXCESS_THRESHOLD = 12;
// The outer ring sits inside the overlay's strongest band (feather >= 80 pt)
// and outside the scene fixture's 16-pixel marker margin.
export const ringWidth = (width, height) => Math.max(2, Math.floor(Math.min(width, height) / 100));
// A control frame anchors the gate when the overlay covers this much of every side.
export const CONTROL_SIDE_FRACTION = 0.5;
export const SLO_LATENCY_MS = 5000; // docs/slo.md: warm capture within 5 s
export const SLO_FRACTION = 0.95;
const ALLOWED_ACTIONS = new Set(['health', 'screenshot']);

const purpleExcess = (r, g, b) => Math.min(r, b) - g;

/** Count overlay-coloured pixels: per ring side, and anywhere in the frame. */
export function overlaySignature({ width, height, pixels }) {
  const ring = ringWidth(width, height);
  const sides = Object.fromEntries(['top', 'bottom', 'left', 'right'].map(side => [side, { pixels: 0, tinted: 0 }]));
  let tinted = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const hit = purpleExcess(pixels[offset], pixels[offset + 1], pixels[offset + 2]) >= PURPLE_EXCESS_THRESHOLD;
      const inSides = [y < ring && 'top', y >= height - ring && 'bottom', x < ring && 'left', x >= width - ring && 'right'];
      for (const side of inSides) if (side) { sides[side].pixels++; if (hit) sides[side].tinted++; }
      if (!hit) continue;
      tinted++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return { width, height, ring, sides, tinted,
    bounds: tinted ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null };
}

export function controlAnchored(signature) {
  return Object.values(signature.sides).every(side => side.pixels > 0 && side.tinted / side.pixels >= CONTROL_SIDE_FRACTION);
}

// The Host route attests the overlay only through a live activity receipt.
// raw_vnc_exclusion:false says raw VNC pixels would contain it, so a frame
// counts only when it came from the Host's own filtered capture.
export function labelFailures(structured) {
  const expected = { route: 'host', indicator: 'present', capture_backend: 'owned_sck',
    raw_vnc_exclusion: false, overlay_ready: true, capture_enabled: true };
  return Object.entries(expected).filter(([key, value]) => structured?.[key] !== value).map(([key]) => key);
}

export function percentile(sorted, fraction) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] : null;
}

function imageOf(result) {
  const block = result?.content?.find(entry => entry.type === 'image' && entry.mimeType === 'image/png');
  return block ? Buffer.from(block.data, 'base64') : null;
}

/**
 * Run N Host-route captures at a fixed cadence and stop at the first failure.
 * `call(action)` returns an MCP tool result; `readControl()` returns the
 * control PNG bytes or null. Both are injected so offline tests use real logic.
 */
export async function runGate({ call, readControl, frames = 600, intervalMs = 100,
  latencyLimitMs = SLO_LATENCY_MS, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onFrame = async () => {} }) {
  if (!Number.isSafeInteger(frames) || frames < 1 || frames > 10000) throw new Error('frames must be 1..10000');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) throw new Error('interval must be a non-negative integer');
  const guarded = action => {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`observation-only gate refuses ${action}`);
    return call(action);
  };
  const health = await guarded('health');
  const records = [];
  let failure = health?.isError || health?.structuredContent?.route !== 'host'
    ? { number: 0, reason: 'host_route_unavailable', detail: health?.structuredContent ?? null } : null;
  const start = now();
  for (let index = 0; !failure && index < frames; index++) {
    const wait = start + index * intervalMs - now();
    if (wait > 0) await sleep(wait);
    const sent = now();
    const result = await guarded('screenshot');
    const latencyMs = now() - sent, number = index + 1;
    const png = result?.isError ? null : imageOf(result);
    if (!png) {
      failure = { number, reason: 'capture_failed', detail: result?.structuredContent ?? null };
      records.push({ number, latencyMs, ok: false });
      break;
    }
    const labels = labelFailures(result.structuredContent);
    const signature = overlaySignature(decodePNG(png));
    const record = { number, latencyMs, sha256: createHash('sha256').update(png).digest('hex'),
      width: signature.width, height: signature.height, overlayPixels: signature.tinted,
      overlayBounds: signature.bounds, labelFailures: labels, ok: !labels.length && signature.tinted === 0 };
    records.push(record);
    await onFrame(png, record);
    if (labels.length) failure = { number, reason: 'labels', detail: labels };
    else if (signature.tinted) failure = { number, reason: 'overlay_pixels_present', detail: signature.bounds };
  }
  const durationMs = now() - start;
  const latencies = records.map(record => record.latencyMs).sort((a, b) => a - b);
  const within = latencies.filter(value => value <= latencyLimitMs).length;
  const latency = { count: latencies.length, p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95),
    max: latencies.at(-1) ?? null, withinLimit: within, limitMs: latencyLimitMs };
  // The control is read last, so it can be captured while this series runs.
  const controlBytes = await readControl();
  const control = controlBytes ? overlaySignature(decodePNG(controlBytes)) : null;
  const anchored = Boolean(control && controlAnchored(control));
  if (!failure && records.length === frames && within / frames < SLO_FRACTION) {
    failure = { number: null, reason: 'latency', detail: latency };
  }
  const status = failure ? 'failed' : anchored ? 'passed' : 'unanchored';
  return { schema: 'fruitctl.overlay-exclusion-gate.v1', status, failure, framesRequested: frames,
    framesCaptured: records.length, intervalMs, durationMs, latency,
    control: control && { anchored, ring: control.ring, sides: control.sides, overlayPixels: control.tinted },
    overlay: { rgb: OVERLAY_RGB, purpleExcessThreshold: PURPLE_EXCESS_THRESHOLD },
    records, scope: 'Host-route agent frames versus the Host overlay only; no scene, consent, Stop, input or SLO qualification' };
}

const usage = `Usage: node scripts/qualification/overlay_exclusion_gate.mjs --attended --target PROFILE \\
  --control /absolute/control.png --output-dir /absolute/new-dir [--frames 600] [--interval-ms 100]
  [--latency-limit-ms 5000] [--save-frames] [--fruitctl /absolute/fruitctl.mjs] [--socket PATH]`;

async function main() {
  const { values } = parseArgs({ options: { attended: { type: 'boolean' }, target: { type: 'string' },
    control: { type: 'string' }, 'output-dir': { type: 'string' }, frames: { type: 'string', default: '600' },
    'interval-ms': { type: 'string', default: '100' }, 'latency-limit-ms': { type: 'string', default: String(SLO_LATENCY_MS) },
    'save-frames': { type: 'boolean' }, fruitctl: { type: 'string' }, socket: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) { process.stdout.write(usage + '\n'); return 0; }
  const output = values['output-dir'];
  if (!values.attended || !values.target || !values.control || !output ||
      !path.isAbsolute(values.control) || !path.isAbsolute(output)) throw new Error(usage);
  await mkdir(output, { mode: 0o700 }); // Refuses an existing directory.
  const fruitctl = values.fruitctl ?? fileURLToPath(new URL('../../bin/fruitctl.mjs', import.meta.url));
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fruitctl, 'mcp', '--target', values.target, ...(values.socket ? ['--socket', values.socket] : [])] });
  const client = new Client({ name: 'fruitctl-overlay-exclusion-gate', version: '1' });
  await client.connect(transport);
  let receipt;
  try {
    receipt = await runGate({ frames: Number(values.frames), intervalMs: Number(values['interval-ms']),
      latencyLimitMs: Number(values['latency-limit-ms']),
      call: action => client.callTool({ name: 'vnc_command', arguments: { action } }),
      readControl: () => readFile(values.control).catch(error => { if (error.code === 'ENOENT') return null; throw error; }),
      onFrame: (png, record) => (values['save-frames'] || !record.ok)
        ? writeFile(path.join(output, `frame-${String(record.number).padStart(4, '0')}.png`), png, { flag: 'wx', mode: 0o600 })
        : undefined });
  } finally { await client.close(); } // Closing the session releases the Host lease.
  await writeFile(path.join(output, 'overlay-exclusion-receipt.json'), JSON.stringify(receipt, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  const { records: _records, ...summary } = receipt;
  process.stdout.write(JSON.stringify(summary) + '\n');
  return receipt.status === 'passed' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; },
    error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
