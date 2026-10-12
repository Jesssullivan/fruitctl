import { AsyncLocalStorage } from 'node:async_hooks';

const active = new AsyncLocalStorage();
const errorReports = new WeakMap();
export const timingStages = Object.freeze([
  'metadataManifest', 'archiveFetch', 'archiveExtraction', 'freshFileAudit',
  'cacheFileAudit', 'rootGuards', 'descriptorGuards', 'registration', 'restoration'
]);
const maximumCount = 1_000_000;
const maximumNs = 86_400_000_000_000n;

function recorder(clock) {
  const stages = Object.fromEntries(timingStages.map(name => [name,
    { calls: 0, failures: 0, fileChecks: 0, ns: 0n }]));
  let last, complete = true, saturated = false, closed = false;
  function now() {
    try {
      const value = clock();
      if (typeof value !== 'bigint' || value < 0n || last !== undefined && value < last) {
        complete = false; return undefined;
      }
      last = value; return value;
    } catch { complete = false; return undefined; }
  }
  function increment(row, key) {
    if (row[key] < maximumCount) row[key]++;
    else saturated = true;
  }
  function elapsed(start, end) {
    if (start === undefined || end === undefined) return 0n;
    const value = end - start;
    if (value > maximumNs) { saturated = true; return maximumNs; }
    return value;
  }
  const started = now();
  return {
    async measure(name, operation) {
      const row = Object.hasOwn(stages, name) ? stages[name] : undefined;
      if (closed || !row) return operation();
      increment(row, 'calls'); const start = now();
      try { return await operation(); }
      catch (error) { increment(row, 'failures'); throw error; }
      finally {
        const duration = elapsed(start, now());
        if (row.ns + duration > maximumNs) { row.ns = maximumNs; saturated = true; }
        else row.ns += duration;
      }
    },
    fileCheck(name) {
      if (!closed && Object.hasOwn(stages, name)) increment(stages[name], 'fileChecks');
    },
    finish() {
      const duration = elapsed(started, now()); closed = true;
      const milliseconds = ns => Number(ns / 1000n) / 1000;
      return {
        schema: 'fruitctl.installer.timings.v1', unit: 'milliseconds',
        commandElapsedMs: milliseconds(duration), inclusiveStages: true,
        measurementComplete: complete && !saturated, saturated,
        stages: Object.fromEntries(timingStages.map(name => {
          const { calls, failures, fileChecks, ns } = stages[name];
          return [name, { calls, failures, fileChecks, totalMs: milliseconds(ns) }];
        }))
      };
    }
  };
}

// Only command-created aggregate reports can reach the CLI error output.
// An existing/frozen Error.timings property is never trusted or overwritten.
export function timingsForError(error) {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? errorReports.get(error) : undefined;
}

export async function timedInstallerCommand(options, dependencies, operation) {
  // Nested aggregate doctor calls share the one outer report. No clock reads
  // or result/error changes occur for an ordinary untimed command.
  if (active.getStore() || options?.timings !== true) return operation();
  let clock;
  try { clock = dependencies?.timingClock ?? (() => process.hrtime.bigint()); }
  catch { clock = () => undefined; }
  const measurement = recorder(clock);
  return active.run(measurement, async () => {
    try {
      const result = await operation();
      return { ...result, timings: measurement.finish() };
    } catch (error) {
      const report = measurement.finish();
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        errorReports.set(error, report);
        try {
          if (!Object.hasOwn(error, 'timings')) Object.defineProperty(error, 'timings', { value: report });
        } catch { /* Frozen/nonextensible errors keep their original behavior. */ }
      }
      throw error;
    }
  });
}

export function measureInstallerStage(name, operation) {
  const measurement = active.getStore();
  return measurement ? measurement.measure(name, operation) : operation();
}

export function recordInstallerFileCheck(name) {
  active.getStore()?.fileCheck(name);
}
