# Compatibility

Compatibility has three separate dimensions: the agent seat, the Darwin
controller, and the target desktop. A working MCP configuration does not prove
screen capture or input worked. Record the exact combination before promoting
it to qualified status.

## Platforms

| Role | Baseline | Status |
| --- | --- | --- |
| Native controller | Apple Silicon; macOS 15+ | Alpha3 bundles signed bytes with an Apple Accepted controller submission; synthetic VNC/MCP checks passed; live desktop qualification pending |
| Public Node relay | Bundled Node.js 24.21.0 | Immutable runtime preview; synthetic MCP checks on Linux x64 and Darwin arm64 |
| Linux x64 runtime | Rootless preview bundle | Alpha3 public Claude project bootstrap and installed CLI continuation passed; bundled-installer API covers seven adapters separately |
| Linux arm64 runtime | Preview bundle available | Archive integrity checked; runtime execution pending |
| Linux agent seat | SSH bridge to Darwin controller | Initial supported design; acceptance pending |
| Rocky Linux agent seat | Same SSH bridge | Historical alpha2 Linux x64 bootstrap passed on Rocky 10.2; SSH/desktop journey pending |
| Native Linux VNC controller | No native binary promised | Outside initial release |
| Intel macOS controller | No x86_64 artifact promised | Requires separate build and runtime qualification |
| macOS target | Owner-configured Screen Sharing/VNC | Record target OS and capture/input results |
| Other VNC target | Protocol capability varies | No blanket target-OS claim |
| Purple target indicator | Qualified filtered macOS capture only | Unqualified source prototype; no public Host binary or automatic setup |

`project.yml` targets macOS 15.0 and `arm64`. This is a build baseline, not a
claim that every later OS version is tested. The immutable
[v0.1.0-alpha.3 preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.3)
publishes Darwin arm64, Linux x64 and Linux arm64 runtime archives. Its Darwin
runtime includes `bin/claude-kvm-daemon`, with exact Developer ID signature,
Apple Accepted controller-ZIP submission and corresponding source evidence.
That acceptance does not cover the whole runtime archive. A bare binary has no
stapled ticket. Linux still needs a configured Darwin controller through
SSH. The older alpha1 preview retains its existing-controller prerequisite.
`versions.json` records scoped preview checks separately from
fully qualified product releases. The current fully qualified release count is
zero.

## Agents

| Agent | Adoption surface | Release status |
| --- | --- | --- |
| Codex | Skill plus stdio MCP adapter | Preview bootstrap checked; real frontend acceptance pending |
| Claude Code | Skill plus stdio MCP adapter | Preview bootstrap checked; real frontend acceptance pending |
| Pi | Shared skill plus native MCP in 0.99.0+ | Configuration documented; runtime experimental |
| Junie CLI | Shared skill plus supported MCP settings | Configuration documented; runtime experimental |
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

Alpha3's actual anonymous Linux x64 stock bootstrap installed Claude project
scope; its installed CLI continuation passed help, doctor, uninstall and
post-uninstall doctor with unrelated configuration bytes and modes preserved.
Separate bundled-installer API checks cover 14 user/project lifecycle cases
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
