# Compatibility

Compatibility has three separate dimensions: the agent seat, the Darwin
controller, and the target desktop. A working MCP configuration does not prove
screen capture or input worked. Record the exact combination before promoting
it to qualified status.

## Platforms

| Role | Baseline | Status |
| --- | --- | --- |
| Native controller | Apple Silicon; macOS 15+ | Inherited build target; Fruitctl release qualification pending |
| Public Node relay | Node.js 24 | Productization baseline; packaged release pending |
| Linux agent seat | SSH bridge to Darwin controller | Initial supported design; acceptance pending |
| Rocky Linux agent seat | Same SSH bridge | Acceptance pending on a named tested Rocky release |
| Native Linux VNC controller | No native binary promised | Outside initial release |
| Intel macOS controller | No x86_64 artifact promised | Requires separate build and runtime qualification |
| macOS target | Owner-configured Screen Sharing/VNC | Record target OS and capture/input results |
| Other VNC target | Protocol capability varies | No blanket target-OS claim |
| Purple target indicator | Qualified filtered macOS capture only | Separate prototype and exclusion-proof lane |

`project.yml` targets macOS 15.0 and `arm64`. This is a build baseline, not a
claim that every later OS version is tested. Curated public qualification
records live in `versions.json`; an empty list means no public version has yet
earned that claim.

## Agents

| Agent | Adoption surface | Release status |
| --- | --- | --- |
| Codex | Skill plus stdio MCP adapter | Runtime experimental; public release acceptance pending |
| Claude Code | Skill plus stdio MCP adapter | Runtime experimental; public release acceptance pending |
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

## Qualification record

A public record names the release, full source revision, adapter and version,
controller OS/architecture, target OS, capture mode, connection/authentication
mode, frame-mapping proof, reversible input result, stop behavior, and outcome.
It contains no credentials, private host inventories, transcripts, or screenshots
of private desktops.

Separate passing build checks, notarization, and live behavior in the record.
Failed and untested combinations remain explicit. Upgrade a compatibility claim
only after the test runs against the installed release bytes.
