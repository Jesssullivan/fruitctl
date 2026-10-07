# Install Fruitctl

Copy the [installation prompt](site/install-prompt.md) into your agent. It asks
the agent to inspect its platform, resolve a verified release, install the
appropriate adapter, and qualify the connection. Supply host names and secrets
through local configuration and the controller's credential provider, not this
prompt or a checked-in MCP file.

The [v0.1.0-alpha.3 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.3)
is immutable and source-pinned to
`e00fcc86bbac4247d5a0847d7e656369c52cc15f`. It installs the bundled Node.js 24.21.0
runtime, skill and adapter. On Apple Silicon macOS 15+, that runtime also
installs the signed VNC controller at
`bin/claude-kvm-daemon` inside its versioned cache. Its original controller-ZIP
submission is Apple Accepted; that acceptance covers the controller, and the
complete runtime archive is a separate asset. Linux uses the SSH bridge
to a configured Darwin controller. Every route needs an operator-configured
profile, controller-local credentials and owner-enabled target Screen Sharing.
Archive integrity and the complete Darwin ARM64 runtime's synthetic VNC/MCP
image exchanges have scoped evidence. Desktop and frontend qualification remain
pending.

The canonical docs are live at
[fruitctl.clients.xoxd.ai](https://fruitctl.clients.xoxd.ai/). If the listed preview lacks your runtime
asset or desktop prerequisite, stop with that missing requirement.

## Before installation

- Controller: Apple Silicon macOS 15 or later for the bundled native build.
- Client runtime: Node.js 24 for this productization baseline.
- Target: a reachable VNC service, with Screen Sharing enabled by its owner.
- Agent: an adapter whose MCP configuration can be changed through its normal
  supported installation surface.
- Credentials: a controller-local provider, with no password in arguments,
  repository files, logs, or a Linux bridge environment.

The current broker provider is an owner-only private credential file. Configure
that path on the Darwin controller; the installer does not create a target
password or copy it into the agent configuration.

## One terminal paste

This pins both the bootstrap source and immutable runtime preview. Choose your
adapter from the [agent guide](agents.md), replace `default` with your configured
profile, and preserve any Home Manager-owned configuration through its owner:

```sh
(
  FRUITCTL_SOURCE_SHA='e00fcc86bbac4247d5a0847d7e656369c52cc15f'
  FRUITCTL_RELEASE_TAG='v0.1.0-alpha.3'
  FRUITCTL_SCRIPT=$(mktemp)
  trap 'rm -f "$FRUITCTL_SCRIPT"' EXIT
  curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    "https://raw.githubusercontent.com/xoxd-ai/fruitctl/$FRUITCTL_SOURCE_SHA/scripts/install.sh" \
    -o "$FRUITCTL_SCRIPT" &&
  FRUITCTL_ACTUAL_SHA=$(if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$FRUITCTL_SCRIPT"
  else
    shasum -a 256 "$FRUITCTL_SCRIPT"
  fi) &&
  [ "${FRUITCTL_ACTUAL_SHA%% *}" = '6e05a7a62f57491cfbda1f8d9212291f6237f04f4ac396bc04d183b88747cd58' ] &&
  sh "$FRUITCTL_SCRIPT" --agent codex --scope user \
    --version "$FRUITCTL_RELEASE_TAG" --target default
)
```

The source fetch ignores user `curlrc` options and checks the pinned script's
SHA-256 before execution. The bootstrap verifies release
bytes and uses the bundled Node runtime. Alpha2 passed actual anonymous public
bootstrap for all seven user adapters and Claude project scope on Linux x64,
including doctor, every runtime hash and mode, uninstall and exact unrelated
configuration restoration. These checks qualify installed adapters, not a real
frontend or desktop. That public bootstrap evidence applies to alpha.2. Public
bootstrap validation for alpha.3 remains pending. Doctor checks
installed hashes and modes, including the bundled controller. Rollback uses
the previous verified runtime; uninstall preserves verified versioned caches
and unrelated configuration. Explicit operator native-path overrides remain
operator-owned.

Installation does not start or stop services, launch a GUI, create profiles or
credentials, enable target Screen Sharing, or grant macOS privacy permission.
The target owner follows [Apple's Screen Sharing setup](https://support.apple.com/guide/mac-help/mh11848/mac).
The signed bare controller uses VNC observations; it has no stapled ticket.
Gatekeeper may retrieve its notarization ticket online and request normal user
approval. See [Apple's notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Do not modify or re-sign its bytes to bypass that approval.

The optional Host indicator remains an unqualified source prototype and is
excluded from public runtime payloads and automatic installation. Signing and
notarization do not grant Screen Recording or Accessibility permission. Host
would need its own attended consent and permission qualification; no managed
or headless Screen Capture grant is provided. [Apple's ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
requires user permission and an app restart before capture.

## Choose the control path

On macOS, the Darwin ARM64 runtime provides the verified native controller;
connect the agent adapter to the shared controller through the local relay.
On Linux, including Rocky
Linux, use the SSH bridge to that Darwin controller. Linux native VNC control is
not part of the initial supported path.

The operator creates a named target profile on the Darwin controller. The
profile selects the target, transport, capture mode, and credential provider.
The agent names the configured profile; arbitrary tool parameters cannot
replace its host or credentials.

Configure one profile per desktop. Known duplicate VNC endpoints, helper hosts,
or explicit physical `targetId` values are rejected. Assign the optional identity
through operator configuration when different addresses refer to the same
machine; Fruitctl does not infer those aliases or create an independent control
lane for them.

## Qualification

The release CLI uses these interfaces. Replace the placeholders with the listed
exact release tag and an operator-configured profile:

```text
fruitctl install --agent codex --scope user --version <exact-tag> --target <profile> --dry-run
fruitctl install --agent codex --scope user --version <exact-tag> --target <profile>
fruitctl doctor --agent codex --scope user
fruitctl mcp --target <profile>
```

Adapter identifiers are `claude`, `codex`, `pi`, `junie`, `opencode`, `vscode`,
and `kimi`. The [agent adapter guide](agents.md) documents each configuration
destination, the source-pinned bootstrap, and IntelliJ/Junie setup. Project
scope applies to the selected project; use `--project-dir`
when that project is not the current directory. Review the concrete dry-run
changes, then perform the already requested installation without `--dry-run`.
The scoped doctor inspects installation/configuration without launching an
agent or driving a desktop. It cannot prove image rendering or remote input.

The Darwin service is `fruitctl broker --config <config-path>`. A Linux seat
attaches with `fruitctl relay --bridge <ssh-alias>`; its agent then uses
`fruitctl mcp --target <profile>` against the local relay socket. The Darwin
broker owns the profile and its credential file. Use the
[Home Manager module](home-manager.md) for managed services and profile examples.

`fruitctl rollback --agent <agent> --scope <scope>` restores the prior recorded
Fruitctl installation. `fruitctl uninstall --agent <agent> --scope <scope>`
removes only that installation's owned configuration. Changed or declaratively
managed configuration requires its owning configuration surface; the installer
must not overwrite unrelated settings to repair drift.

After installation, inspect the reported capabilities and connection health.
Capture a complete frame, confirm its dimensions and mapping, then perform one
small reversible action on a designated test surface and capture the result.
This final action needs the user's authorization for that surface. A successful
MCP startup or a codesign receipt alone is not a successful connection test.

Record the release, source commit, adapter version, controller and target OS,
capture mode, and observed outcome without credentials or private screen data.
If the result is unknown, stop and obtain a fresh observation before deciding
what to do next. Never replay the uncertain action automatically.

## Existing source checkout

Contributors install the locked Node dependencies with `just deps`, which runs
`npm ci --ignore-scripts`.
The inherited entrypoint `node index.js` and daemon alias `claude-kvm-daemon`
remain compatibility surfaces. `CLAUDE_KVM_DAEMON_PATH` selects the installed
native executable; `VNC_HOST`, `VNC_PORT`, and `VNC_USERNAME` describe the legacy
connection. The legacy environment credential path is compatibility behavior,
not the new controller-local provider contract.

Use registered `just` recipes for development checks and native builds. A source
checkout does not provide a signed release binary. New adopters should use the
verified public release path once it is qualified.

## Home Manager

The Lab Home Manager consumer pins the public producer's source revision and
signed release bytes. It may configure profiles and wrappers, but must not patch
the producer's daemon or re-sign a released binary. Upgrade the producer release,
checksum, source revision, and associated adoption evidence together.

## Version and URL policy

The installation page and `latest` pointers are discovery surfaces. Resolve a
full source commit SHA and an exact release tag before downloading executable
or skill bytes. Verify the release manifest and SHA-256 hashes. Publish release
assets as one immutable GitHub release; no post-publication asset replacement.

Use full-commit GitHub URLs for vendored source, and exact immutable release URLs
for binaries. If either verification fails, leave the existing installation in
place and report the mismatch.
