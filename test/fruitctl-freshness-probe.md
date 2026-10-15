# Attended freshness probe

`fruitctl-freshness-probe.py` runs the TIN-5509 attended probe arms against a
real Screen Sharing target. It uses an already built native controller and
never builds anything. It sends only `health` and `screenshot`. It never
clicks, types or presses keys, and the method gate refuses anything else
before it is written.

The controller is launched as the broker launches it (`lib/broker/server.mjs`
`nativeFactory`, `lib/mcp/native.js`):

- `--host`, `--port` and an optional `--username` come from the argv.
- `--rfb-request-mode stream|on-demand`, `--rfb-wire-ledger`, `--no-reconnect`
  and `-v` are added.
- The credential arrives as one length-prefixed frame on descriptor 3.

The target and credential come from the `VNC_HOST`, `VNC_PORT`,
`VNC_USERNAME` and `VNC_PASSWORD` environment variables. With
`--profile NAME`, they come instead from the broker's
`fruitctl.config.v1` profile and its private `credentialFile`. The credential
is never printed, never placed in the argv and never written to a receipt.

| Arm | Mode | Schedule (defaults) | Pass |
|---|---|---|---|
| `P0` | `stream` | 10 captures 10 s apart, then 5 captures, each after 120 s idle | every capture completes in under 5 s; the wire ledger and the provenance each show exactly one full request per capture |
| `P1` | `on-demand` | P0, then 2 captures, each after 600 s idle | P0's criteria; plus the connection generation never changes, `health` reports connected after every gap, `request_gate_leaks == 0`, and no incremental request is written |
| `P-ctl` | `--mode` of the passing arm | a baseline, then 5 captures; before each, the operator changes the screen and presses Enter | each capture hash differs from the previous one |
| `P-eq` | `--mode` of the passing arm | 3 captures on a static screen, then the first capture of a new controller connection | the last in-session hash equals the new connection's first hash |

Any capture failure is a FAIL with its reason. A typed `stale_screen`
(`-32010`) is recorded as `stale_screen:<data.reason>` with its diagnostics.
Input on the wire ledger is also a FAIL.

Gate leaks are taken as the larger of two counts:

- the controller's verbose "Request gate reopened" log lines;
- any `request_gate_leaks` value in `stale_screen` diagnostics.

The daemon flag `--rfb-wire-ledger` writes to stderr. The runner splits the
`[RFB-WIRE]` lines out to `rfb-wire-ledger.s<N>.txt`, one file per connection.
It assigns each line to a capture by its arrival time.

Durations and counts are configurable for development:

- `--gap-seconds`, `--warm-captures`
- `--idle-seconds`, `--idle-captures`
- `--long-idle-seconds`, `--long-idle-captures`
- `--ctl-captures`, `--eq-captures`, `--eq-gap-seconds`

A schedule shorter than the design is marked `qualifying: false` in the
receipt.

## Output

The receipt is `freshness-probe-receipt.json`, written to a new
`--output-dir` with mode `0600`. It holds:

- the arm and mode, and the daemon sha256 and size;
- the verified build receipt hash and `sourceRevision`;
- for each capture: `t`, `latency_ms`, `sha256`, `ok`, `reason`, the
  `provenance` returned by the controller, the health read before it, and the
  windowed ledger counts;
- for each connection: ledger totals, gate leaks, `vnc_state` changes and
  exit code;
- the verdict and its reasons.

The ledger and verbose stderr files are kept next to the receipt. Images are
not saved unless `--save-images` is given. The username is redacted from the
recorded argv.

## Running on an operator seat

The runner only observes. It needs:

- Python 3.9 or newer;
- the controller from the pull request's `Core checks` artifact
  `fruitctl-native-rfb-<run>-<attempt>`;
- an established tunnel to the target.

Keep exactly one attended console owner and no other viewer. Hide the
menu-bar clock and stop anything that animates.

```sh
SHA=$(git rev-parse HEAD)
RUN=$(gh run list -R xoxd-ai/fruitctl --workflow 'Core checks' --commit "$SHA" \
  --status success --json databaseId -q '.[0].databaseId')
ATTEMPT=$(gh run view "$RUN" -R xoxd-ai/fruitctl --json attempt -q .attempt)
P="$HOME/fruitctl-probe-$(date +%Y%m%d)"
gh run download "$RUN" -R xoxd-ai/fruitctl -n "fruitctl-native-rfb-$RUN-$ATTEMPT" -D "$P/artifact"
N="$P/artifact/fruitctl-native-$RUN-$ATTEMPT"

# Verify the sha256 and size against build-receipt.json before trusting the bytes.
python3 -I test/fruitctl-freshness-probe.py --probe P1 --profile TARGET \
  --daemon "$N/unstripped-unsigned/claude-kvm-daemon" \
  --build-receipt "$N/build-receipt.json" --dry-run

# actions/upload-artifact drops the exec bit; the runner refuses until you restore it.
chmod 0755 "$N/unstripped-unsigned/claude-kvm-daemon"

python3 -I test/fruitctl-freshness-probe.py --probe P0 --profile TARGET \
  --daemon "$N/unstripped-unsigned/claude-kvm-daemon" \
  --build-receipt "$N/build-receipt.json" --output-dir "$P/P0"
```

Run `P1` the same way, with `--output-dir "$P/P1"`. Then run `P-ctl` and
`P-eq` with `--mode stream` if P0 passed, or `--mode on-demand` if only P1
passed. If the target's RFB banner is slow, add `--connect-timeout 30`.

The exit status is 0 for PASS, 1 for FAIL and 2 for a refusal before
connecting. A pass is evidence about one target, one controller build and one
attended window. It does not qualify other hosts or release builds.

`fruitctl-freshness-probe.test.js` covers the dry run, the refusals, the
receipt and the verdict rules offline. It uses a fake controller and contacts
no desktop.
