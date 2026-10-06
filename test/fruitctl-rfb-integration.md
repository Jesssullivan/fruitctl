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

The native run has three scenarios. The MCP run adds four more:

- For 100 captures per transport, decode the actual PNG, verify its CRCs,
  dimensions, allocation metadata and every RGB pixel, and require an increasing
  server marker. Each capture follows pointer input and must contain the marker
  at the exact coordinate received by the RFB server. Button and key press/release
  messages are also checked.
- After a prior complete capture, return only half of the framebuffer. Require
  an error with no image within ten seconds; cached complete pixels must not
  become a successful fresh capture.
- Advertise a full raw rectangle, send half its bytes and close the connection.
  Require an error with no image within ten seconds.
- Through MCP, invoke all four compatible tools. Verify a two-action queue and
  its coordinate effect, active ownership release through `task_complete`, and
  active ownership release through `task_failed` in a separate scenario. The
  RFB connection must close before release is acknowledged.

The receipt records the fixture, daemon, Node, selected MCP/broker source and
optional runtime archive hashes. It retains 100 synthetic PNGs per transport,
input events, refusal details and owned process exit codes. The optional archive
hash records the supplied archive; extraction integrity remains the caller's
responsibility. Latencies describe this small loopback fixture only.

On 2026-10-06, seven scenarios passed with 100 native and 100 shared-broker MCP
captures using Node `v24.21.0`, compiled daemon SHA-256
`fcedbc0892b207b5fb637f32b685e973a7af659df92a900eca80b24f711fcb0e`,
and Darwin runtime archive SHA-256
`9926c097c0debc344e53945c06a019009fe3b81152d44f566f28d30d5c5f9188`.
All owned native, MCP and broker processes exited with code zero. This is
synthetic harness proof. It does not qualify real VNC authentication, TCC,
overlay exclusion, a signed or notarized distribution, the SSH bridge, agent
frontends, live desktop contention or live product latency/SLOs.
