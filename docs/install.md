# Install Fruitctl

Copy the [installation prompt](site/install-prompt.md) into your agent. It asks
the agent to inspect its platform, resolve a verified release, install the
appropriate adapter, and qualify the connection. Supply host names and secrets
through local configuration and the controller's credential provider, not this
prompt or a checked-in MCP file.

The public docs origin is reserved at `https://fruitctl.clients.xoxd.ai/`.
Use this repository copy until the origin has a served deployment receipt.
If no compatible verified Fruitctl release is listed, the installer must stop
with the missing prerequisite. Do not substitute an unreviewed source build or
claim the planned one-paste path is already released.

## Before installation

- Controller: Apple Silicon macOS 15 or later for the existing native build.
- Client runtime: Node.js 24 for this productization baseline.
- Target: a reachable VNC service, with Screen Sharing enabled by its owner.
- Agent: an adapter whose MCP configuration can be changed through its normal
  supported installation surface.
- Credentials: a controller-local provider, with no password in arguments,
  repository files, logs, or a Linux bridge environment.

A target-side indicator is optional and separate from the VNC controller. Its
installation does not replace Screen Sharing setup. Signing and notarization
do not grant Screen Recording or Accessibility permission. When macOS requires
user consent, the installer explains the exact local step and resumes after the
user completes it. It does not promise a headless TCC bypass.

## Choose the control path

On macOS, install the verified native controller and connect the agent adapter
to the shared controller through the local relay. On Linux, including Rocky
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

The release CLI uses these interfaces. Replace the placeholders with a listed
exact release tag and an operator-configured profile; these are examples, not
claims that an installable release has been published:

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
