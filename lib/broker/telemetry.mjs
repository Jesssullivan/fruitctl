// SPDX-License-Identifier: MIT
// D30: per-action latency telemetry. The size-rotated JSONL file is the source
// of truth; the Prometheus textfile is a derived summary for node_exporter's
// textfile collector, rewritten atomically (temporary file + rename) so a
// scrape never reads a partial exposition. Off unless a directory is configured.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LATENCY_SCHEMA = 'fruitctl.latency.v1';
export const LATENCY_BUCKETS_SECONDS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 5;
const LABEL = /^[a-z][a-z0-9_]{0,63}$/;

const escapeLabel = value => String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
// Target names come from operator configuration. Untrusted action names cannot
// create unbounded label series.
const labelValue = value => typeof value === 'string' && LABEL.test(value) ? value : 'other';

export function telemetryOptions(config) {
  if (config === undefined || config === null) return null;
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid telemetry configuration');
  if (config.enabled === false) return null;
  const { dir, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP } = config;
  if (typeof dir !== 'string' || !path.isAbsolute(dir) ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 4096 ||
      !Number.isSafeInteger(keep) || keep < 1 || keep > 100) {
    throw new Error('Telemetry requires an absolute dir, maxBytes >= 4096 and keep 1-100');
  }
  return { dir, maxBytes, keep };
}

export class LatencyTelemetry {
  constructor({ dir, maxBytes = DEFAULT_MAX_BYTES, keep = DEFAULT_KEEP, now = () => new Date(), onError = () => {} }) {
    ({ dir, maxBytes, keep } = telemetryOptions({ dir, maxBytes, keep }));
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.now = now;
    this.onError = onError;
    this.jsonl = path.join(dir, 'latency.jsonl');
    this.prom = path.join(dir, 'fruitctl.prom');
    this.series = new Map();
    this.tail = Promise.resolve();
    this.failures = 0;
    this.lastError = null;
  }

  observe(sample) {
    const labels = { target: String(sample.target), method: labelValue(sample.method),
      route: labelValue(sample.route), outcome: labelValue(sample.outcome) };
    const key = canonicalLabels(labels);
    let series = this.series.get(key);
    if (!series) {
      series = { labels, count: 0, sum: 0, buckets: LATENCY_BUCKETS_SECONDS.map(() => 0) };
      this.series.set(key, series);
    }
    const seconds = Math.max(0, sample.latencyMs) / 1000;
    series.count++;
    series.sum += seconds;
    LATENCY_BUCKETS_SECONDS.forEach((bound, index) => { if (seconds <= bound) series.buckets[index]++; });
  }

  /** Append one batch of samples and refresh the summary. Telemetry failure is
   * reported in status and never fails or delays a returned action result. */
  record(samples) {
    if (!samples.length) return this.tail;
    for (const sample of samples) this.observe(sample);
    const ts = this.now().toISOString();
    const lines = samples.map(sample => JSON.stringify({ schema: LATENCY_SCHEMA, ts,
      session: sample.session, target: sample.target, method: sample.method, route: sample.route,
      outcome: sample.outcome, latency_ms: Math.round(sample.latencyMs * 1000) / 1000,
      ...(sample.queueMs === undefined ? {} : { queue_ms: Math.round(sample.queueMs * 1000) / 1000 }),
      ...(sample.estimated ? { estimated: true } : {}) }) + '\n').join('');
    const work = this.tail.then(async () => {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      await this.rotate(Buffer.byteLength(lines));
      await fs.appendFile(this.jsonl, lines, { mode: 0o600 });
      await this.writeSummary();
    }).catch(error => {
      this.failures++;
      this.lastError = String(error?.message || 'Telemetry write failed').slice(0, 256);
      this.onError(error);
    });
    this.tail = work;
    return work;
  }

  async rotate(incoming) {
    const size = await fs.stat(this.jsonl).then(stat => stat.size, error => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    });
    if (!size || size + incoming <= this.maxBytes) return;
    await fs.rm(`${this.jsonl}.${this.keep}`, { force: true });
    for (let index = this.keep - 1; index >= 1; index--) {
      await fs.rename(`${this.jsonl}.${index}`, `${this.jsonl}.${index + 1}`).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await fs.rename(this.jsonl, `${this.jsonl}.1`);
  }

  exposition() {
    const lines = [
      '# HELP fruitctl_actions_total Broker actions by target, method, route and outcome.',
      '# TYPE fruitctl_actions_total counter',
    ];
    const series = [...this.series.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
    for (const { labels, count } of series) lines.push(`fruitctl_actions_total{${canonicalLabels(labels)}} ${count}`);
    lines.push('# HELP fruitctl_action_latency_seconds Per-action broker latency.',
      '# TYPE fruitctl_action_latency_seconds histogram');
    for (const { labels, count, sum, buckets } of series) {
      const base = canonicalLabels(labels);
      LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push(`fruitctl_action_latency_seconds_bucket{${base},le="${bound}"} ${buckets[index]}`);
      });
      lines.push(`fruitctl_action_latency_seconds_bucket{${base},le="+Inf"} ${count}`);
      lines.push(`fruitctl_action_latency_seconds_sum{${base}} ${Number(sum.toFixed(6))}`);
      lines.push(`fruitctl_action_latency_seconds_count{${base}} ${count}`);
    }
    return lines.join('\n') + '\n';
  }

  async writeSummary() {
    const temporary = path.join(this.dir, `.fruitctl.prom.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, this.exposition(), { mode: 0o644 });
      await fs.rename(temporary, this.prom);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  flush() { return this.tail; }

  status() {
    return { dir: this.dir, failures: this.failures, ...(this.lastError ? { last_error: this.lastError } : {}) };
  }
}

function canonicalLabels(labels) {
  return ['target', 'method', 'route', 'outcome'].map(key => `${key}="${escapeLabel(labels[key])}"`).join(',');
}
