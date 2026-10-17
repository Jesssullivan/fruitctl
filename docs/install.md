# Install Fruitctl

Copy the [rendered installation prompt](https://fruitctl.clients.xoxd.ai/install-prompt.md) into your agent. It asks
the agent to inspect its platform, resolve a verified release, install the
appropriate adapter, and qualify the connection. Supply host names and secrets
through local configuration and the controller's credential provider, not this
prompt or a checked-in MCP file.

The curated adoption route selects the published
[v0.1.0-alpha.11 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11),
producer `142743262d3242775f210c9d62a6b8e423c3ce5a` (signed annotated tag).
It ships Linux x64, Linux ARM64 and Darwin ARM64 runtimes with the bundled
Node.js 24.21.0 runtime, skill and adapters. The Darwin runtime carries the native VNC controller at
`bin/claude-kvm-daemon`, built, signed (Developer ID) and notarized from the
same revision; Gatekeeper reports `Notarized Developer ID`. All 13 public assets
match the [curated inventory](site/versions.json) through anonymous download.

Linux and Rocky Linux seats use the SSH bridge to a Darwin controller. Every
route needs an operator-configured target profile, controller-local
credentials and owner-enabled Screen Sharing on a macOS 26 or 27 target. The
public runtime supplies no FruitctlHost app or purple indicator. Actual agent
frontends, the Linux-to-Darwin SSH journey and measured service objectives
remain pending qualification; the fully qualified product release count is
zero. Older previews stay immutable and are listed with their hashes in the
curated inventory.

The canonical docs are live at
[fruitctl.clients.xoxd.ai](https://fruitctl.clients.xoxd.ai/). If the listed preview lacks your runtime
asset or desktop prerequisite, stop with that missing requirement.

## When the documentation client is rejected

An anonymous default Python HTTP client has observed HTTP 403 with Cloudflare
error 1010 on the canonical origin. Use the source-pinned GitHub raw fallback
listed in the generated `agents.md` or `llms.txt`; this does not establish a
Cloudflare policy repair, and no browser User-Agent impersonation is needed.

The rendered `agents.md` and `llms.txt` provide fallback links that bind the
guide, curated release entry and adoption inputs to one full documentation
commit SHA. Resolve the matching entry at that revision, select its exact tag
and verify publication and the `fruitctl-release.json` asset digest through
GitHub's release API. The release producer's `sourceRevision` separately pins
its bootstrap and skill bytes; verify the entry's bootstrap SHA-256 before
execution.

Raw `docs/site/install-prompt.md` is an authored template with unresolved tokens.
The served `/install-prompt.md` renders those tokens from the selected curated
preview. When the site is unavailable, resolve the template from the same
documentation revision's policy overlay and matching versions entry. The raw
adoption contract and policy overlay are also separate inputs; the served
`adoption.json` combines them with build/release metadata.

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

## Optional installer timings

Installed CLIs from alpha.9 on advertise `--timings` for `install`, `doctor`,
`rollback` and `uninstall`. It reports bounded aggregate installer elapsed
times. It is installer measurement, not a latency SLO. For example, repeat your
recorded root and registration scope:

```sh
<installed-runtime>/bin/fruitctl doctor --agent claude --scope project \
  --project-dir "/absolute/path/to/owned/project" \
  --install-root "/absolute/path/to/owned/fruitctl-root" --timings
```

The option is not accepted by `scripts/install.sh`, `fruitctl-host-install`,
`broker`, `relay` or `mcp`; leave it out of the bootstrap pastes below.
Alpha.8 and older immutable runtimes do not include it. Reports contain bounded
aggregate installer elapsed times; they exclude Node startup/module loading
and CLI parsing, contain no per-file paths or credentials, and establish no
latency SLO or command timeout change. Default result/error output is unchanged
without the option.

## One terminal paste: published alpha.11

This pins both the bootstrap source and immutable runtime preview. Choose your
adapter from the [agent guide](agents.md), replace `default` with your configured
profile, and preserve any Home Manager-owned configuration through its owner:

```sh
(
  FRUITCTL_SOURCE_SHA='142743262d3242775f210c9d62a6b8e423c3ce5a'
  FRUITCTL_RELEASE_TAG='v0.1.0-alpha.11'
  FRUITCTL_SCRIPT=$(mktemp)
  trap 'rm -f "$FRUITCTL_SCRIPT"' EXIT
  curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 120 \
    "https://raw.githubusercontent.com/xoxd-ai/fruitctl/$FRUITCTL_SOURCE_SHA/scripts/install.sh" \
    -o "$FRUITCTL_SCRIPT" &&
  FRUITCTL_ACTUAL_SHA=$(if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$FRUITCTL_SCRIPT"
  else
    shasum -a 256 "$FRUITCTL_SCRIPT"
  fi) &&
  [ "${FRUITCTL_ACTUAL_SHA%% *}" = 'd5aae5f89812def9f5e91e80de4fe8779b4f62263f1e331a26e5734b5fc3ecfc' ] &&
  sh "$FRUITCTL_SCRIPT" --agent codex --scope user \
    --version "$FRUITCTL_RELEASE_TAG" --target default
)
```

The source fetch ignores user `curlrc` options and checks the pinned script's
SHA-256 before execution. The bootstrap verifies release bytes and uses the
bundled Node runtime. This paste uses the ordinary user registration and home
storage layout. For project registration and separate storage, use the
explicit-root instructions below. Installer checks verify installation and
configuration; they do not qualify a frontend or desktop.

Installation does not start or stop services, launch a GUI, create profiles or
credentials, enable target Screen Sharing, or grant macOS privacy permission.
The target owner follows [Apple's Screen Sharing setup](https://support.apple.com/guide/mac-help/mh11848/mac).
The signed bare controller uses VNC observations; it has no stapled ticket.
Gatekeeper may retrieve its notarization ticket online and request normal user
approval. See [Apple's notarization workflow](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).
Do not modify or re-sign its bytes to bypass that approval.

The optional Host indicator is not yet qualified for public capture modes and
is excluded from public runtime payloads and automatic installation. The
[developer Host installer](host-installer.md) provides a separate file-only
path for reviewed native artifacts; no public Host release is available.
Signing and
notarization do not grant Screen Recording or Accessibility permission. Host
would need its own attended consent and permission qualification; no managed
or headless Screen Capture grant is provided. [Apple's ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
requires user permission and an app restart before capture.

The [macOS permissions guide](permissions.md) separates target Screen Sharing,
optional Host capture consent and managed-device policy. It includes attended
setup and upgrade checks plus a reviewed standard-user policy template for an
MDM administrator. The template permits the user's approval; it does not grant
Screen Capture access or install the Host.

## Explicit install root: current preview

The published [v0.1.0-alpha.11 preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11)
implements `--install-root ABSOLUTE_DIRECTORY` for
`install`, `doctor`, `rollback` and `uninstall`, and the stock bootstrap.
The published **alpha.4 bootstrap and runtime do not support
`--install-root`**. The pinned user-scope paste above deliberately keeps the
normal-home storage behavior by omitting that option.

An install root selects Fruitctl's operational storage. Registration remains a
separate choice: an explicit-root installation must also specify `--scope user`
or `--scope project`. `--project-dir` selects the registration project and is
passed through by the bootstrap; when omitted, project scope uses the
current directory. Choose project scope and an explicit project directory when
you want registration confined to an owned project.

Let `R` be the chosen absolute install root:

| Role | No install root: existing layout | Explicit install root `R` |
| --- | --- | --- |
| Verified runtime cache | `~/.local/share/fruitctl/releases/TAG/OS-ARCH` | `R/releases/TAG/OS-ARCH` |
| Locks, receipts, backups and history | `~/.local/state/fruitctl/install` | `R/state/install` |
| Convenience launcher | `~/.local/bin/fruitctl` | `R/bin/fruitctl` |
| User MCP and skill registration | Supported user configuration destinations | Same supported user destinations |
| Project MCP and skill registration | Selected project directory | Same selected project directory |

`--scope user` still changes the ordinary supported user configuration. An
install root does **not** isolate a user profile, relocate the account home,
reassign `HOME` or `CODEX_HOME`, or disable existing adapter environment rules.
It does not create a broker profile, change runtime configuration or socket
paths, or supply credentials. Generated MCP entries pin the installed versioned
executable and existing target/configuration fields; they do not pass
`--install-root`. That storage option is rejected on `mcp`, `broker`, `relay` and
`attach`.

For alpha.11, replace every pathname/profile placeholder below. Use an
absolute project path and a dedicated absolute root you own; quote paths that
contain spaces. Obtain the [exact producer's bootstrap](https://raw.githubusercontent.com/xoxd-ai/fruitctl/142743262d3242775f210c9d62a6b8e423c3ce5a/scripts/install.sh)
and verify SHA-256 `d5aae5f89812def9f5e91e80de4fe8779b4f62263f1e331a26e5734b5fc3ecfc`
before running it. These pins identify alpha.11's bytes; they do not qualify an
arbitrary frontend, profile or desktop:

```text
sh <verified-alpha11-install.sh> --agent junie --scope project \
  --project-dir <absolute-project-directory> \
  --install-root <absolute-install-root> \
  --version v0.1.0-alpha.11 --target <configured-profile> --dry-run

<absolute-install-root>/bin/fruitctl doctor --agent junie --scope project \
  --project-dir <absolute-project-directory> --install-root <absolute-install-root>
```

Review the dry-run destinations, then rerun that installation command without
`--dry-run`. First adoption requires an empty owned root or an existing matching
Fruitctl root descriptor. Relative paths, the filesystem or account-home root,
immutable/store-managed paths, foreign-owned roots and unmarked nonempty roots
are refused. Install-root aliases resolve to the same effective storage
namespace; they do not create a second receipt set. Existing project-path alias
protections remain unchanged. Root identity changes during an operation are
refused.

The API equivalent is `install({ agent: 'junie', scope: 'project', projectDir,
installRoot, version, target })`. Existing API `home` behavior remains compatible
when `installRoot` is omitted. With both supplied, `installRoot` selects storage
and `home` selects user registration; the CLI does not add a `--home` option.

### Select the same root for inspection and recovery

Supply `--install-root` again on every later doctor, rollback or uninstall call,
with the same agent, scope and recorded project directory:

```text
<absolute-install-root>/bin/fruitctl rollback --agent junie --scope project \
  --project-dir <absolute-project-directory> --install-root <absolute-install-root>
<absolute-install-root>/bin/fruitctl uninstall --agent junie --scope project \
  --project-dir <absolute-project-directory> --install-root <absolute-install-root>
```

Aggregate `doctor --install-root <absolute-install-root> --json` inspects only
that root's namespace and reports its selection. Omitting the option inspects
the legacy namespace; an omitted or wrong root cannot certify installations in
another root. There is no automatic root discovery or global home pointer.
Recovery uses the validated receipt's recorded registration destinations rather
than moving them when the invoking environment changes. An existing entry or
skill owned by another root cannot be adopted as a new installation baseline.

Uninstall removes only owned registration, launcher and active receipt state,
subject to shared ownership within that namespace. It retains verified release
caches, generated runtime identity markers, the root descriptor, backups,
history and their directories. It does not delete the install root. Moving or
copying a root does not rewrite its absolute paths or migrate receipts: doctor
reports the mismatch and mutating recovery is refused. To change roots,
uninstall from the original root and recorded project, then install independently
into a new empty root. The original cache and history remain. Automatic
migration and purge are unsupported.

### Older runtimes must refuse explicit-root requests

The bootstrap (alpha.9 and later) verifies the selected runtime's install-root capability
before calling its installer API. The executing installer must also verify that
capability in the target release before committing its cache or registration,
including when installing or rolling back to an older version. Missing or
inconsistent capability markers cause an explicit refusal, with no fallback to
normal-home storage. Do not pass `installRoot` directly to alpha.4's older
exported API: it ignores the unknown property and does not provide this storage
selection. Installations without an explicit root remain compatible with older
releases and their legacy receipt layout.

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

### First run without Home Manager

Install the pinned alpha.11 preview above on the controller and, when needed,
the Linux seat. These examples assume explicit roots `/Users/alex/Tools/fruitctl`
and `/home/alex/Tools/fruitctl`, with the agent registered for profile `default`.
Replace all example accounts, roots, project paths, SSH aliases and the reserved
example address with your operator-selected values. For the ordinary layout,
substitute the installed receipt's versioned `prefix` only in executable and
daemon paths. Omit `--install-root` from doctor and retain the recorded agent,
scope and project; the doctor example below uses explicit-root storage.
Keep your real `HOME`.

These are current configuration instructions. The real Linux-to-Darwin SSH
journey and actual frontend use of the bridge remain unqualified.

**Darwin controller.** Use Apple Silicon macOS 15+ and the unchanged bundled
signed controller. The target owner enables Screen Sharing and handles any
normal Apple approval. Provision the target's existing credential through your
secret manager into a controller-local regular file, readable by the broker
account, with mode `0600` or `0400`. The credential must be nonempty UTF-8,
without NUL, at most 4,096 bytes; the provider file may be at most 4,097 bytes
and one final newline is removed. Keep its contents out of commands, agent
configuration and the Linux seat.

Save this operator-owned JSON as
`/Users/alex/.config/fruitctl/controller.json` (mode `0600`):

```json
{
  "schema": "fruitctl.config.v1",
  "targets": {
    "default": {
      "targetId": "office-desktop",
      "vnc": { "host": "192.0.2.10", "port": 5900, "username": "alex" },
      "credentialFile": "/Users/alex/.config/fruitctl/secrets/desktop",
      "daemonPath": "/Users/alex/Tools/fruitctl/releases/v0.1.0-alpha.11/darwin-arm64/bin/claude-kvm-daemon"
    }
  }
}
```

The optional `"requestMode": "on-demand"` inside `vnc` stops idle incremental
framebuffer requests (see [architecture](architecture.md)). Omit it to keep
the default `stream` mode; it is not yet qualified on Apple Screen Sharing.

The optional `"captureTimeoutMs"` inside `vnc` (an integer from 1000 to 20000)
sets how long each screenshot waits for fresh pixels. Omit it to keep the
default: 10000 on Apple Screen Sharing and 5000 otherwise (see
[compatibility](compatibility.md#apple-screen-sharing-quirks-observed-2026-10-16)).
In Home Manager the option is `programs.fruitctl.targets.<name>.vnc.captureTimeoutMs`.

Run your own broker in a dedicated terminal and leave it running:

```sh
"/Users/alex/Tools/fruitctl/releases/v0.1.0-alpha.11/darwin-arm64/bin/fruitctl" \
  broker --config "/Users/alex/.config/fruitctl/controller.json"
```

Its default socket is
`/Users/alex/Library/Application Support/fruitctl/run/broker.sock`. The launcher
creates a private `0700` socket directory and `0600` socket. If an existing
service owns that socket, use its owner-managed setup; do not remove its socket
or restart another session's broker. No persistent service is installed by
this foreground command.

**Linux seat, including Rocky.** Keep the Darwin broker running. Configure an
existing SSH alias `desktop-controller` for that controller account, with its
host key trusted and authentication usable without interaction. Start your own
foreground relay in a dedicated Linux terminal:

```sh
"/home/alex/Tools/fruitctl/releases/v0.1.0-alpha.11/linux-x64/bin/fruitctl" \
  relay --bridge desktop-controller \
  --remote-command "/Users/alex/Tools/fruitctl/releases/v0.1.0-alpha.11/darwin-arm64/bin/fruitctl" \
  --remote-socket "/Users/alex/Library/Application Support/fruitctl/run/broker.sock"
```

Use the `linux-arm64` prefix instead on an ARM Linux seat. The relay attaches
to the existing Darwin broker; it supplies neither a VNC profile nor credentials
on Linux. Its default local socket is `$XDG_RUNTIME_DIR/fruitctl/relay.sock`,
or `~/.local/state/fruitctl/relay.sock` when that variable is absent. Broker,
relay and agent must agree on each local socket: if an existing
`FRUITCTL_SOCKET_PATH` or explicit `--socket` selects another path, carry that
choice through the supported agent configuration and `--remote-socket`.

**Installed agent next steps.** In a second terminal, inspect the same root,
agent, scope and project recorded by your installation. For a Linux Claude
project installation, the concrete doctor command is:

```sh
"/home/alex/Tools/fruitctl/releases/v0.1.0-alpha.11/linux-x64/bin/fruitctl" \
  doctor --agent claude --scope project --project-dir "/home/alex/Projects/desktop-task" \
  --install-root "/home/alex/Tools/fruitctl" --json
```

On the Darwin seat, use its `darwin-arm64` executable, `/Users/alex` project
path and install root. Select your actual adapter/scope from the installer
receipt. Doctor checks registration and runtime files; it does not test the
broker, target or frontend. The installed MCP entry must use that seat's
versioned absolute `bin/fruitctl` with arguments `mcp --target default` and
connect to the local broker or relay socket. Inspect it through your agent's
supported settings; do not launch another agent as an installation probe.

In the chosen frontend, discover the four real tools, run `vnc_command` health
then screenshot, and inspect the complete fresh image before authorized input.
Follow [qualification](#qualification) for an authorized reversible action
and inspect its fresh result. Finish with `task_complete` and a `summary`, or
`task_failed` and a `reason`; each releases this client's owned session. Report
unconfirmed release as failure. After reconnect, take and inspect a fresh
screenshot before further input; never replay uncertain input. Report the exact
release and observed outcome; registration and these commands alone do not
qualify a frontend or desktop. Public alpha.11 supplies no Host app or purple
indicator. Installation grants no Screen Recording/Accessibility permission
or headless TCC provisioning; any independently installed Host requires its
own consent and capture qualification. Preserve the signed controller bytes.

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

The current source CLI requires explicit `--version TAG` for `install`, including
`--dry-run`, and uses the tag verbatim. `doctor` writes its JSON result and exits
1 for `drift`, 0 for `configured` or `not-installed`. `not-installed` means the
inspection found no receipt; it does not certify an installed runtime. Thrown
errors exit 1 with an error on stderr. These source changes require a new runtime
release; the immutable published alpha.6 runtime retains its earlier behavior.

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

The [Home Manager module](home-manager.md) selects the alpha.11 signed
controller through `nix/native-release.json` on any source pin that includes
it.

Your Home Manager consumer pins the public producer's source revision and
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
