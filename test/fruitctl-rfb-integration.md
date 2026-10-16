# Offline dynamic RFB fixture

`fruitctl-rfb-integration.py` runs an existing compiled daemon against its own
RFB 3.8 server on an ephemeral `127.0.0.1` port. It never connects to Screen
Sharing, launches a GUI or sends input to a real desktop. Authentication is
None; a synthetic credential still exercises the native descriptor-3 delivery
contract.

Run on a supported Darwin host with Python 3.9 or newer and an already compiled
native daemon. The output directory must be new. When using the shared broker,
keep its absolute path short enough for Darwin's Unix socket limit; the script
checks the generated socket path before starting the broker.

```sh
python3 -I test/fruitctl-rfb-integration.py \
  --daemon /path/to/claude-kvm-daemon \
  --output-dir "$HOME/fruitctl-proof-01" \
  --captures 100
```

To include the actual Node MCP and shared broker, extract a Darwin runtime
archive into a new directory and supply its bundled Node and source root:

```sh
python3 -I test/fruitctl-rfb-integration.py \
  --daemon /path/to/claude-kvm-daemon \
  --node /path/to/extracted-runtime/bin/node \
  --source-dir /path/to/extracted-runtime \
  --runtime-archive /path/to/fruitctl-runtime.tar.gz \
  --output-dir "$HOME/fruitctl-proof-02" \
  --captures 100
```

The default MCP route invokes `bin/fruitctl.mjs mcp` and
`bin/fruitctl.mjs broker` with a private fixture socket and a synthetic
credential provider with mode `0600`. The broker delivers that credential to
the native daemon on descriptor 3. The fixture removes its synthetic provider
after stopping its owned children. `--mcp-route legacy-direct` selects the
compatible `index.js` entrypoint instead.

The native run has four content scenarios plus four request-model scenarios
per request mode. The MCP run adds four more:

- For 100 captures per transport, decode the actual PNG, verify its CRCs,
  dimensions, allocation metadata and every RGB pixel, and require an increasing
  server marker. Each capture follows pointer input and must contain the marker
  at the exact coordinate received by the RFB server. Button and key press/release
  messages are also checked, after the release-only key-up for every modifier
  that precedes the connection's first input.
- Native only, after the captures: `triple_click`, a `shift`+`cmd`
  `mouse_click`, a right-button `mouse_drag`, a 150 ms `hold_key` and
  `cursor_position`, then batch-scoped holds: an unscoped `mouse_down` must be
  refused with `-32011` `hold_outside_batch` and write nothing, a scoped hold
  must stay pressed across a move until `mouse_up`, a request from outside the
  batch must force-release a live hold, and `release_holds` must release one.
  Every resulting RFB message is compared exactly, in order.
- After a prior complete capture, return only half of the framebuffer. Require
  an error with no image within ten seconds; cached complete pixels must not
  become a successful fresh capture.
- Advertise a full raw rectangle, send half its bytes and close the connection.
  Require an error with no image within ten seconds.
- Native only: send `key_combo ["alt","cmd","n"]` and require, after the
  release-only modifier key-ups that precede the first input, Alt_L down,
  Meta_L down, `n` down/up, then Meta_L and Alt_L up. Then stop answering
  non-incremental requests. Require the original five-second fresh-capture
  timeout with no image, no superseding incremental request during the pending
  capture, and refusal of subsequent input until a new complete observation.
  This synthetic silence is not qualification of macOS static-screen behavior
  or Apple's Option interpretation.
- Native only, per `--request-modes` (`stream`, `on-demand` or both; default
  `stream`): four request-model
  scenarios pin synthetic hypotheses for an idle Apple screen (TIN-5509). Each
  connection keeps its own outstanding requests; a static screen never
  answers an incremental request. `latest-wins` answers when the newest
  outstanding request is full; `first-wins` lets the oldest outstanding
  request absorb later ones; `session-start-only` answers only the first full
  request of a connection; `silent` answers nothing. `latest-wins` must return
  three fresh captures, as must `first-wins` in `on-demand` mode; their
  screenshot, `cursor_crop`, `diff_check`, `set_baseline` and
  `detect_elements` results must each carry capture provenance. On demand,
  each must report no request outstanding at admission and
  `ordered_after_prior_input: true`; in stream mode, LibVNC's re-arm is
  outstanding, so each must report `false`. Every other
  combination must return JSON-RPC `-32010` with `data.reason`
  `server_silent` within the original five-second deadline and no image. Each
  scenario runs the daemon with `--rfb-wire-ledger` and requires the ledger's
  written (not `suppressed`) request counts to equal the requests the server
  received, one shared
  ClientInit, no Key/Pointer/Cut message inside any capture window and, in
  `on-demand` mode, zero incremental requests. These models are not Apple's
  server.
- Through MCP, invoke all four compatible tools. Verify a two-action queue and
  its coordinate effect, active ownership release through `task_complete`, and
  active ownership release through `task_failed` in a separate scenario. The
  RFB connection must close before release is acknowledged.

The receipt records the fixture, daemon, Node, selected MCP/broker source and
optional runtime archive hashes. It retains 100 synthetic PNGs per transport,
input events, refusal details and owned process exit codes. The optional archive
hash records the supplied archive; extraction integrity remains the caller's
responsibility. Latencies describe this small loopback fixture only.

`test/fruitctl-rfb-request-models.test.js` drives the same request models
offline with a LibVNC-shaped loopback client, without a native daemon.

On 2026-10-06, seven scenarios passed with 100 native and 100 shared-broker MCP
captures using Node `v24.21.0`, compiled daemon SHA-256
`fcedbc0892b207b5fb637f32b685e973a7af659df92a900eca80b24f711fcb0e`,
and Darwin runtime archive SHA-256
`9926c097c0debc344e53945c06a019009fe3b81152d44f566f28d30d5c5f9188`.
All owned native, MCP and broker processes exited with code zero. This is
synthetic harness proof. It does not qualify real VNC authentication, TCC,
overlay exclusion, a signed or notarized distribution, the SSH bridge, agent
frontends, live desktop contention or live product latency/SLOs.
