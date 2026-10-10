# Install Fruitctl

Copy the [rendered installation prompt](https://fruitctl.clients.xoxd.ai/install-prompt.md) into your agent. It asks
the agent to inspect its platform, resolve a verified release, install the
appropriate adapter, and qualify the connection. Supply host names and secrets
through local configuration and the controller's credential provider, not this
prompt or a checked-in MCP file.

The curated adoption route currently selects the published
[v0.1.0-alpha.6 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.6),
producer `8653325c6ccc0e058b3e4cf84eb44101cfd270fc`. Its thirteen public assets
match the reviewed hashes and sizes through anonymous downloads. It retains
the [explicit install root](#explicit-install-root-alpha-6-preview). Its Darwin
ARM64 Junie project installer components are verified as described below;
installed SDK terminal acceptance remains pending.
The rendered installation prompt follows this curated preview, rather than
the newest package version or source checkout. Publication and archive checks
do not qualify a packaged installer, agent frontend or desktop connection.

The historical [v0.1.0-alpha.4 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.4)
is immutable and source-pinned to
`e0f4d064b076e58b33856d877e0e1c9266f55177`. It installs the bundled Node.js 24.21.0
runtime, skill and adapter. On Apple Silicon macOS 15+, that runtime also
installs the signed VNC controller at
`bin/claude-kvm-daemon` inside its versioned cache. Its original controller-ZIP
submission is Apple Accepted. The unchanged native controller's original source
remains `e00fcc86bbac4247d5a0847d7e656369c52cc15f`; that acceptance covers
the controller, and the complete runtime archive is a separate asset. Linux
uses the SSH bridge to a configured Darwin controller. Every route needs an operator-configured
profile, controller-local credentials and owner-enabled target Screen Sharing.
Alpha.4 passed an offline Darwin ARM64 Junie project lifecycle through the
bundled installer API and an installed SDK/shared-broker journey through the
unchanged signed controller to a loopback RFB fixture. That synthetic check
verified four complete 96×53 frames, one reconnect and two terminal releases.
Alpha.4 did not qualify Darwin's stock public bootstrap, desktop or frontend.
Earlier Darwin synthetic image exchanges remain historical
alpha.2/alpha.3 evidence.

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

## One terminal paste: published alpha.6

This pins both the bootstrap source and immutable runtime preview. Choose your
adapter from the [agent guide](agents.md), replace `default` with your configured
profile, and preserve any Home Manager-owned configuration through its owner:

```sh
(
  FRUITCTL_SOURCE_SHA='8653325c6ccc0e058b3e4cf84eb44101cfd270fc'
  FRUITCTL_RELEASE_TAG='v0.1.0-alpha.6'
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
explicit-root instructions below. Alpha.6's verified installer observations
cover Darwin ARM64 Junie project scope with an explicit root. This user-scope
paste, installed SDK terminal acceptance, actual frontends and desktop behavior
remain unqualified; structural release checks do not establish those outcomes.

On Darwin ARM64, alpha.6's stock public bootstrap installed the Junie project
adapter into an explicit root. Installed doctor, same-version reinstall and
same-version history rollback passed. Owned uninstall and post-uninstall doctor
were verified separately. The combined installer/SDK run remained unsuccessful
during its SDK phase; retained metadata does not establish its terminal status
or qualify SDK runtime behavior.

A separate default public uninstall-shell check passed after a fresh
installation through the bundled installer API using retained immutable cache
inputs. With `FRUITCTL_EXECUTABLE` absent, the published uninstall shell returned
`removed` and retained doctor reported `not-installed`. Original project
configuration bytes and modes were restored; all 3,673 runtime payload files and
the root descriptor were retained. This separate check did not repeat the stock
public bootstrap.

These observations verify installer components. Actual Junie and IntelliJ
frontend images, actions, release and reconnect, desktop and physical indicator
behavior, and measured service objectives remain unqualified. The fully
qualified product release count remains zero.

Historical alpha.4 passed an anonymous Linux x64
stock Junie project bootstrap, installed help, doctor and reinstall. A
continuation initialized the MCP SDK against Junie's installed MCP launcher
and called `listTools`, discovering four tool schemas without tool actions. An
alternate-project-alias dry-run was refused. Uninstall restored original
unrelated configuration bytes and modes and preserved 3,671 Linux runtime
payload files, with the generated identity marker accounted for separately.
Installer history and its directory remain as append-only installation
records. Frontend image rendering and desktop acceptance remain pending.

Historical alpha.2 checks cover all seven user adapters and Claude project
scope through anonymous Linux x64 bootstrap. Historical alpha.3 checks cover
one Claude project bootstrap and installed help, doctor, uninstall and
post-uninstall doctor. Their runtime hash/mode and configuration restoration
evidence applies to those releases. Doctor checks
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

## Published alpha.6 pins and qualification

The runtime producer is
`8653325c6ccc0e058b3e4cf84eb44101cfd270fc`. Its exact bootstrap is
[scripts/install.sh at that revision](https://raw.githubusercontent.com/xoxd-ai/fruitctl/8653325c6ccc0e058b3e4cf84eb44101cfd270fc/scripts/install.sh),
SHA-256 `d5aae5f89812def9f5e91e80de4fe8779b4f62263f1e331a26e5734b5fc3ecfc`.
It puts `--disable` first in each bootstrap curl invocation, preserving the
HTTPS and download bounds while ignoring user curl configuration. Its source
checks cover the real-curl parser with offline fixtures. The installer
observations above separately verify the stated packaged components; neither
the parser checks nor those components qualify a desktop connection.

The immutable tag is `v0.1.0-alpha.6`, published on 2026-10-08. Its
`fruitctl-release.json` SHA-256 is
`0cf5e6f713276da0559ec0761b46696ec0f66c363f01279ac1491e93be9bf749`.
The [curated inventory](site/versions.json) records the names, sizes and hashes
of all thirteen published assets, their signed tag and producer bindings.
The producer-binding asset preserves its build-time candidate status; separate
publication and public-byte receipts establish delivery. Its pending runtime
qualification fields are unchanged.

The producer revision is separate from the documentation build revision.
Installer, installed SDK, actual Junie/IDE frontend,
desktop, physical indicator exclusion and measurements for service objectives
must name the exact release. Historical alpha.4/alpha.5 receipts are
not transferred to alpha.6. The native controller retains its original
`e00fcc86bbac4247d5a0847d7e656369c52cc15f` producer and corresponding GPL source;
the original controller-ZIP acceptance does not notarize a complete runtime or
include the Host prototype.

## Explicit install root: alpha.6 preview

The published [v0.1.0-alpha.6 preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.6)
implements `--install-root ABSOLUTE_DIRECTORY` for
`install`, `doctor`, `rollback` and `uninstall`, and the stock bootstrap.
Its source and archive capability checks and the stated Darwin ARM64 Junie
project installer components are verified. Installed SDK terminal acceptance,
real frontend and desktop qualification remain pending. The published
**alpha.4 bootstrap and runtime do not support
`--install-root`**. The pinned alpha.6 user-scope paste above deliberately keeps
the normal-home storage behavior by omitting that option.

An install root selects Fruitctl's operational storage. Registration remains a
separate choice: an explicit-root installation must also specify `--scope user`
or `--scope project`. `--project-dir` selects the registration project and is
passed through by the alpha.6 bootstrap; when omitted, project scope uses the
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

For alpha.6, replace every pathname/profile placeholder below. Use an
absolute project path and a dedicated absolute root you own; quote paths that
contain spaces. Obtain the [exact producer's bootstrap](https://raw.githubusercontent.com/xoxd-ai/fruitctl/8653325c6ccc0e058b3e4cf84eb44101cfd270fc/scripts/install.sh)
and verify SHA-256 `d5aae5f89812def9f5e91e80de4fe8779b4f62263f1e331a26e5734b5fc3ecfc`
before running it. These pins identify alpha.6's bytes; they do not qualify an
arbitrary frontend, profile or desktop:

```text
sh <verified-alpha6-install.sh> --agent junie --scope project \
  --project-dir <absolute-project-directory> \
  --install-root <absolute-install-root> \
  --version v0.1.0-alpha.6 --target <configured-profile> --dry-run

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

The alpha.6 bootstrap verifies the selected runtime's install-root capability
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
