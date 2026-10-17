# Compatibility

Compatibility has three separate dimensions: the agent seat, the Darwin
controller, and the target desktop. A working MCP configuration does not prove
screen capture or input worked. Record the exact combination before promoting
it to qualified status.

## Platforms

The current public preview is
[v0.1.0-alpha.11](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11),
runtime producer `142743262d3242775f210c9d62a6b8e423c3ce5a` with a signed annotated tag. All 13 public assets match
the curated hashes through anonymous download.
See the [installation guide](install.md) and the
[macOS permissions guide](permissions.md) for operator setup steps. Eleven
runtime previews are published; fully qualified product releases remain zero.

| Role | Baseline | Status |
| --- | --- | --- |
| Darwin ARM64 runtime installer | Junie project scope; explicit storage root | Historical alpha.6 stock bootstrap, doctor, reinstall, same-version rollback and owned uninstall verified as components; separate default public uninstall shell from offline-cache setup passed; alpha.11 installed runtime/frontend/desktop pending |
| Native controller | Apple Silicon; macOS 15+ | Alpha.11 bundles a controller built, Developer ID-signed and notarized from its own revision (Gatekeeper: Notarized Developer ID); five published-bytes input journeys to a macOS 26.7.1 target passed with fresh captures; real agent frontends pending |
| Public Node relay | Bundled Node.js 24.21.0 | Alpha.4 Darwin synthetic MCP journey and Linux MCP metadata checked; real SSH journey pending |
| Linux x64 runtime | Rootless preview bundle | Alpha.9: Linux x64 stock public bootstrap and Claude project configuration lifecycle: install, help, doctor, timed doctor, reinstall, same-version prior-receipt rollback and uninstall/cache retention; populated project configuration bytes and mode 0640 were restored. Alpha.11 installer lifecycle, complete frontend/SSH/physical desktop pending |
| Linux arm64 runtime | Preview bundle available | Archive integrity checked; runtime execution pending |
| Home Manager vendoring | Opt-in Linux x64 alpha.9 consumer | October 12 package: 665 passing checks and one declared curl skip; normal serialized canary/follower delivery to one enabled Linux seat, with canary consumer default-off. Separate canonical installed-package two-task Claude synthetic MCP component observed; real SSH, physical desktop and complete frontend qualification pending |
| Linux agent seat | SSH bridge to Darwin controller | Initial supported design; acceptance pending |
| Rocky Linux agent seat | Same SSH bridge | Historical alpha2 Linux x64 bootstrap passed on Rocky 10.2; SSH/desktop journey pending |
| Native Linux VNC controller | No native binary promised | Outside initial release |
| Intel macOS controller | No x86_64 artifact promised | Requires separate build and runtime qualification |
| macOS target | macOS 26 (26.6.1 or later) and 27; owner-configured Screen Sharing or Remote Management | Enforced by `fruitctl doctor --macos`; record target OS and capture/input results |
| Other VNC target | Protocol capability varies | No blanket target-OS claim |
| Purple target indicator | Qualified filtered macOS capture only | Unqualified source prototype; no public Host binary or automatic setup |

`project.yml` targets macOS 15.0 and `arm64`. This is a build baseline, not a
claim that every later OS version is tested. The immutable alpha.11 preview
publishes Darwin arm64, Linux x64 and Linux arm64 runtime archives. Its Darwin
runtime bundles `bin/claude-kvm-daemon` built, Developer ID-signed and
notarized from `142743262d3242775f210c9d62a6b8e423c3ce5a`; the notarization covers the controller submission, not
the whole runtime archive, and a bare binary has no stapled ticket. Linux still
needs a configured Darwin controller through SSH.
`versions.json` records scoped preview checks separately from
fully qualified product releases. An installed MCP entry and `doctor` result do not
establish tool actions, returned-image rendering or target behavior.

Historical alpha.8 public asset integrity, Linux bootstrap/configuration lifecycle and public-installed two-task Claude synthetic component observations remain scoped to alpha.8. They do not qualify alpha.9. The current Home Manager component has its own recorded evidence below.

The October 12 [Home Manager delivery](home-manager.md) bound source
`1ba90e84d4b6fe464c9146e7c41c4cffc3edf8e3` to one enabled Linux seat through the
normal serialized canary/follower path; the canary consumer stayed disabled.
Separately, two real Claude Code CLI sessions used that installed package and
shipped skill against an owned synthetic desktop: four complete images, two
reversible inputs, two awaited releases and a reconnect to the restored scene.
Normal settings were retained without authentication, model or provider
overrides. This canonical installed Home Manager component observation is
separate from public bootstrap/configuration acceptance. Real SSH, physical
desktop, native Host, macOS permissions, complete frontend and product SLO
qualification remain open; Gateway/Junie remains deferred.

Historical October 11 alpha.8 Home Manager delivery and synthetic component
observations remain scoped to that earlier package:

The October 11 [Home Manager delivery](home-manager.md) bound the tested
alpha.8 portable producer to one enabled Linux seat while the canary consumer
stayed disabled. A separate installed-package check used two real Claude Code
CLI sessions against an owned synthetic desktop: four complete images, two
reversible inputs, two awaited releases and a reconnect to the restored scene.
Normal settings were retained without authentication or model overrides. This
is an installed Home Manager component observation, distinct from the public
bootstrap/component journey; real SSH, physical desktop, native Host, macOS
permissions and complete frontend qualification remain open. Gateway/Junie
remains deferred.

The separate October 10 [Home Manager delivery](home-manager.md) observation
bound the enabled development seat's installed alpha.7 package and skill/MCP
projections to producer `cd34bbcdcc9e70bf25f77cbcfd1f129e1eac30db`. This is a
historical package/configuration delivery result, not a fresh host-state claim
or evidence that an agent loaded the configuration and controlled a desktop.
The default-off canary consumer remained disabled; no broader fleet enablement
or Host, signing or permission acceptance follows from that delivery.

Historical alpha.4's portable source is
`e0f4d064b076e58b33856d877e0e1c9266f55177`. Its Darwin ARM64 runtime passed an
offline Junie project lifecycle through the bundled installer API and an
installed SDK/shared-broker journey through the unchanged signed controller to
a loopback RFB fixture. Four complete 96×53 frames, synthetic input/pixel
checks, one reconnect and releases through `task_complete` and `task_failed`
passed. This scope is synthetic protocol evidence. The alpha.4 Darwin stock
public bootstrap remains unqualified, and earlier alpha.2/alpha.3 proofs stay
historical. Alpha.6's combined installer/SDK run remained unsuccessful;
accepted installer components and the separate public uninstall-shell check do
not qualify its installed SDK terminal status or actual frontend. The fully
qualified product release count remains zero.

Alpha.9 includes the portable Host-installer payload and help. There is no
public native Host bundle, automatic consent or qualified Host capture mode.

## macOS target support

Fruitctl supports macOS 26 and 27 targets only. `fruitctl doctor --macos`
enforces this with read-only SSH probes of the target (see
[macOS permissions](permissions.md#target-preflight)). Other versions fail with
a typed result instead of being attempted.

| Target | Minimum | Result below it |
| --- | --- | --- |
| macOS 26 Tahoe | 26.6.1 | `macos_below_patch_floor` |
| macOS 27 | 27.0 | None: every 27 release includes the fix |
| macOS 15 and earlier, or 28 and later | Unsupported | `macos_unsupported` |
| Missing or malformed `sw_vers` | Unverifiable | `macos_version_unknown` |

The floor exists because of CVE-2026-65400. That flaw in Screen Sharing's
`screensharingd` lets a network attacker authenticate without valid
credentials, whatever the authentication mode. CISA lists it as known
exploited. Apple fixed it in
[macOS Tahoe 26.6.1](https://support.apple.com/en-us/148170) and lists the same
fix in [macOS 27](https://support.apple.com/en-us/149035) (both are Apple
security notes). Fruitctl's loopback-plus-SSH posture keeps port 5900
unreachable; it does not replace patching.

The preflight also reports the Apple remote mode. Each of these fails with a
typed code and is never attempted:

- Screen Sharing off: `screen_sharing_disabled`.
- Remote Management privileges limited to Observe: `observe_only`, or
  `remote_control_not_permitted` when there is no control privilege at all.
- An active High Performance session: `high_performance_session`. Fruitctl
  does not support High Performance mode.
- The console at the login window: `no_console_session`.
- A locked screen: `screen_locked`.

Remote Management and plain Screen Sharing are both accepted, and the result
names which one is on. Some results stay `unknown` and are listed as such:

- Curtain mode, which has no passive host-side signal.
- Observe-only under plain Screen Sharing, which the viewer chooses.
- Remote Management privileges that are not readable. Per-user privileges are
  read for the profile's VNC account, which governs input, and are `unknown`
  when that account is not known.
- Whether Remote Management or plain Screen Sharing is on, when the Remote
  Management activation marker is absent or unreadable. Readable privileges
  are still checked in that case.

Each run is a single sample of the target. It does not qualify capture or input.

### Apple input settle time

Apple's Screen Sharing server ignores input for a short time after a viewer
connects. Measured on 2026-10-16 against macOS 26.7.1 with Remote Management on
and ARD authentication (type 30): `screensharingd` dropped every pointer and key
event for about 2.5 s after it logged a good authentication, logging
`ignore key event` with no change on screen. Keys sent 1.3, 1.8 and 2.3 s
after authentication were ignored, and keys from 2.8 s on were accepted. The
VNC client cannot detect the drop, because each write succeeds locally.

The native controller holds input for 3000 ms after ServerInit on each
connection to a server it detects as Apple, and for 0 ms on any other server.
`--input-settle-ms` overrides the time. With the 3 s hold, the full measured
journey worked. Observation is not delayed. See
[Architecture](architecture.md#input-readiness-after-connect) for how waiting,
deadlines and the `-32013` `input_not_ready` error work. This is one
measurement of one target, not a qualification of other macOS releases or
of plain Screen Sharing without Remote Management.

### Apple Screen Sharing quirks observed 2026-10-16

Observed on one macOS 26.7.1 target (PZM) with Remote Management on. These are
observations of one target, not qualifications.

- **Post-auth input-ignore window.** `screensharingd` logs `ignore key event`
  and drops input for about 2.5 to 2.8 s after authentication. See
  [Apple input settle time](#apple-input-settle-time); the controller's
  `--input-settle-ms` handles it.
- **Mid-update pause after UI-heavy input.** Right after input that makes the
  target redraw heavily (typing into System Settings search, for example),
  `screensharingd` sent the start of its answer to a full framebuffer request
  at once, then paused for up to about 4.7 s before finishing it. With a fixed
  5 s capture deadline, about one in three post-input screenshots failed as
  `-32010` `stale_screen`, and the next capture succeeded. A focused blinking
  caret alone gave no stale capture in 20 tries. The controller now waits up
  to 10000 ms for a capture on a server it detects as Apple and 5000 ms on any
  other server. `--capture-timeout-ms` or the profile's
  `vnc.captureTimeoutMs` (1000 to 20000) overrides it. The wait is for the
  same fresh pixels: no cached frame is returned, and a capture that misses the
  deadline still fails closed. The request's own deadline caps the wait, so the
  failure stays typed. Agents take one more screenshot on `stale_screen`.
- **Menu-bar indicator fade-in.** macOS fades in its "Screen Sharing active"
  menu-bar indicator about 1 to 2 s after a viewer connects. A new
  connection's first frame can catch it mid-fade: at 1280x720 scaled, the only
  differing pixels were at x 1037-1181, y 1-20. The freshness probe's P-eq arm
  waits `--eq-settle-seconds` and can ignore that band with `--eq-ignore-rect`.
- **Chrome Remote Desktop.** Keys ignored by `screensharingd` coincided with
  local input from Chrome Remote Desktop, which was also attached. Doctor
  warns `remote_input_owner_other` for it; keep one input owner per Mac.
- **Third-party RFB control.** With Remote Management on and
  `VNCLegacyConnectionsEnabled` 0, input from third-party RFB clients was
  observed dropped, but the input-ignore window confounded the test. Doctor
  warns `remote_management_vnc_control_disabled`
  ([target profile](target-profile.md#remote-management-rfb-control)).

### macOS desktop state before input

macOS can put UI in front of the desktop that an agent cannot act through: a
privacy (TCC) prompt such as UserNotificationCenter's "tailscaled would like
to access data from other apps", an administrator or keychain prompt, a
Gatekeeper prompt, a Software Update countdown, the lock screen or login
window, a screen saver, or an asleep display. A click or key sent then can be
eaten, can answer the prompt, or can land somewhere else.

When a target profile has an SSH destination, the broker reads this state
before each batch that contains input, and refuses the batch, typed, before
any event is sent. See [target profile](target-profile.md#desktop-state-sentinel)
for the profile key and the codes. Health and screenshot results carry the
state as `desktop_state`.

Observed read-only on PZM (macOS 26.7.1) on 2026-10-17:

- `CoreServicesUIAgent`, `SoftwareUpdateNotificationManager` and
  `UserNotificationCenter` were running for the whole session with no window
  on screen. A running process is therefore not a dialog. The sentinel counts
  only an on-screen window owned by one of these processes, read with
  `CGWindowListCopyWindowInfo` (owner, layer, size; no titles, no pixels).
- That window list and `CGDisplayIsAsleep` were readable over SSH when the SSH
  account was the console user.
- A Chrome Remote Desktop session was active. WindowServer named
  `remoting_me2me_host` as the source of recent input, and the sentinel
  reported it as `other_input_owner`.

Detection of a live dialog, lock or asleep display through this path has not
yet been qualified on a physical target. Each result is one sample, cached for
about 2 s, so a dialog that appears during a batch is seen by the next one.

## Agents

| Agent | Adoption surface | Release status |
| --- | --- | --- |
| Codex | Skill plus stdio MCP adapter | Historical preview bootstrap checked; real frontend acceptance pending |
| Claude Code | Skill plus stdio MCP adapter | Alpha.9 installer/configuration scope only; historical alpha.8 public-installed and current alpha.9 Home Manager synthetic components remain separate. Real desktop/SSH and complete frontend qualification pending |
| Pi | Shared skill plus native MCP in 0.99.0+ | Configuration documented; runtime experimental |
| Junie CLI | Shared skill plus supported MCP settings | Alpha.6 Darwin project installer components verified; historical alpha.4 install/lifecycle and MCP metadata checked; current SDK terminal and actual frontend acceptance pending |
| IntelliJ Junie | Standalone IDE plugin MCP settings and instructions | Separate IDE/plugin version qualification pending |
| OpenCode | Shared skill plus MCP configuration | Configuration documented; runtime experimental |
| VS Code / GitHub Copilot | Shared skill plus portable MCP configuration | Configuration documented; runtime experimental |
| Kimi | Shared skill plus native CLI MCP configuration | Configuration documented; runtime experimental |
| Other MCP clients | Standards-compatible stdio adapter | Discover capabilities; no blanket qualification |

Each supported adapter must install without replacing unrelated MCP servers or
agent instructions. Junie setup must use the supported surface for the installed
IDE and plugin version; the presence of an IntelliJ plugin is not proof that its
agent consumes an MCP configuration or discovers this skill.

The [adapter registry](../integrations/agents.json) owns configuration paths and
upstream references. The [adoption contract](../integrations/adoption.json) owns
frontend qualification state. This matrix summarizes those records; generated
configuration does not promote runtime status.

Alpha.4's anonymous Linux x64 stock bootstrap installed Junie project scope.
Installed help, doctor, reinstall, alternate-project-alias dry-run refusal and
uninstall passed. A continuation initialized the MCP SDK against Junie's
installed MCP launcher and called `listTools`, discovering four tool schemas without
tool actions. Original unrelated configuration bytes/modes and 3,671 Linux
runtime payload files were preserved; the generated identity marker is separate
and installer history remains append-only. Frontend images, input and session
lifecycle remain pending.

Historical alpha.3 evidence: its anonymous Linux x64 stock bootstrap installed
Claude project scope; its installed CLI continuation passed help, doctor,
uninstall and post-uninstall doctor with unrelated configuration bytes and
modes preserved.
Its separate bundled-installer API checks cover 14 user/project lifecycle cases
across seven adapters. These are configuration checks, not frontend acceptance.

Historical alpha2 evidence (release published 2026-10-06): all seven user
adapters and Claude project scope passed actual anonymous bootstrap with its
Linux x64 bundle, including runtime hashes,
modes, doctor, uninstall and exact unrelated configuration restoration. Alpha2's
Darwin synthetic RFB checks exercise the bundled native controller and all four
MCP tools with complete PNG images. Those checks do not start the real agent
frontends, render their returned images, connect the Linux SSH journey or prove
physical overlay exclusion. Each of those remains a separate acceptance lane.

## Qualification record

A public record names the release, full source revision, adapter and version,
controller OS/architecture, target OS, capture mode, connection/authentication
mode, frame-mapping proof, reversible input result, stop behavior, and outcome.
It contains no credentials, private host inventories, transcripts, or screenshots
of private desktops.

Separate passing build checks, notarization, and live behavior in the record.
Failed and untested combinations remain explicit. Upgrade a compatibility claim
only after the test runs against the installed release bytes.

Optional installer `--timings` is an alpha.9 portable CLI feature, not a native-controller, Host, MCP or shell-bootstrap flag. The public Linux x64 installed alpha.9 CLI advertised `--timings`; timed doctor emitted the fixed nine-stage report with the same installation result as default doctor. This is optional installer measurement evidence and establishes no latency SLO or speedup. Its bounded elapsed reports establish no product SLO.
