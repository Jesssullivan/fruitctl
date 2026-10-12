# Installer timings

Optional installer timings are a source feature for a later runtime release.
The published `v0.1.0-alpha.8` runtime does not include this option. Use a source
checkout with Node 24 to inspect the implementation:

```sh
node bin/fruitctl.mjs doctor --agent claude --scope project \
  --install-root /absolute/path/to/your/fruitctl-root --timings
```

`--timings` applies to `install`, `doctor`, `rollback` and `uninstall`. A successful
command adds a `timings` object to its JSON result. A rejected command retains its
original error and exit status; its timing report is a separate JSON line on
stderr. Commands without the option retain their existing result and error
output. Timings do not grant permissions, connect to a desktop or change which
files the installer checks.

The `fruitctl.installer.timings.v1` report contains `commandElapsedMs`, fixed
aggregate stages, and measurement flags. `commandElapsedMs` measures the
installer operation, including its initial checks and awaited work. It excludes
Node startup, module loading and CLI argument parsing; measure process elapsed
time separately when comparing complete command invocations.

| Stage | Work measured |
| --- | --- |
| `metadataManifest` | Release metadata and manifest verification |
| `archiveFetch` | Reading or downloading the selected archive |
| `archiveExtraction` | Archive inspection, extraction and staging |
| `freshFileAudit` | The complete extracted runtime inventory |
| `cacheFileAudit` | Audits of installed or cached runtime files |
| `rootGuards` | Root and guarded path identity checks |
| `descriptorGuards` | Root descriptor validation |
| `registration` | Registration checks and changes |
| `restoration` | Rollback, uninstall and transaction recovery |

Each stage has `calls`, `failures`, `fileChecks` and `totalMs`. `fileChecks` counts
attempted audit leaves. `failures` counts stage exceptions: a doctor's failed
checks can produce `status: "drift"` with no stage exception. Use the command
result to assess the installation.

The counters and durations have fixed ceilings; `saturated` reports when a
ceiling would be exceeded. These are measurement limits and do not change command
deadlines. `measurementComplete` is false for invalid clock readings or exceeded
reporting ceilings. It describes the measurements and establishes no product
qualification. A clock failure does not replace the command result or its
original error.

Stage intervals are inclusive: guard work can occur within an archive or audit
stage. The report declares `inclusiveStages: true`; adding the stage durations
does not yield command elapsed time. Timings are elapsed observations, with no
CPU, I/O or latency SLO attribution. They contain no per-file traces, paths,
configuration bodies or credentials.

Measure successful and rejected paths before changing guard or audit work. The
complete expected-file, digest, mode, ownership and race checks remain required.
No persistent root trust cache or same-version reinstall shortcut is introduced
by this feature.

The offline source checks use the registered recipe:

```sh
just test-installer /absolute/path/to/node-24
```
