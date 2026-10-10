# Fruitctl

Give your agent a remote desktop through MCP. Fruitctl connects a native macOS
VNC client to a target desktop and exposes screenshots, mouse and keyboard
input, scrolling, and OCR. Claude Code, Codex, Pi, and Junie use the same control
protocol; each adapter has its own installation and acceptance checks.

The public source authority is [xoxd-ai/fruitctl](https://github.com/xoxd-ai/fruitctl).
This repository preserves the Agent KVM / Claude KVM history. Legacy executable,
MCP tool, and signed application identities remain compatibility surfaces.

## Install with your agent

Copy the [rendered installation prompt](https://fruitctl.clients.xoxd.ai/install-prompt.md) into your agent and
follow the [installation guide](docs/install.md). The prompt resolves a pinned,
verified release, configures a named target, and checks a fresh observation
before input. If the release does not support your controller and agent, it
reports the missing prerequisite instead of claiming installation succeeded.

The published immutable [v0.1.0-alpha.6 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.6)
uses producer `8653325c6ccc0e058b3e4cf84eb44101cfd270fc`. Its thirteen public
assets match the reviewed hashes and sizes through anonymous downloads. The
bootstrap disables user curl configuration and retains explicit install-root
support, normal-home storage and separate user/project registration choices.
Source tests, archive structure and Darwin ARM64 Junie project installer
components are verified. The combined installer/SDK run was unsuccessful;
installed SDK terminal acceptance, actual Junie/IDE frontend, desktop and
measured service objectives remain pending. See the
[exact install pins and component evidence](docs/install.md).

Alpha.5 introduced the explicit install-root contract. Its producer
`00beadf9a62189c6306f147c7d2aad128ff133d7` and older qualification records remain
separate from alpha.6; older receipts qualify their recorded releases only.

The historical immutable [v0.1.0-alpha.4 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.4)
ships bundled Node.js 24.21.0, the installer, shared skill and MCP/broker code.
Its portable source is `e0f4d064b076e58b33856d877e0e1c9266f55177`. The Apple
Silicon macOS 15+ runtime reuses the unchanged Developer ID-signed VNC
controller originally produced from `e00fcc86bbac4247d5a0847d7e656369c52cc15f`.
Apple accepted that original controller-ZIP submission; the complete runtime
archive is separate.

Alpha.4's anonymous Linux x64 Junie project bootstrap, installed CLI lifecycle
and four-tool MCP metadata discovery have scoped evidence. No desktop tool
action or frontend image rendering was exercised. On Darwin ARM64, alpha.4
passed an offline Junie project lifecycle through the bundled installer API and
an installed SDK/shared-broker journey through the unchanged signed controller
to a loopback RFB fixture: four complete 96×53 frames, one reconnect and two
terminal releases. These are synthetic protocol checks. Earlier seven-adapter,
Claude bootstrap and Darwin image checks remain historical alpha.2/alpha.3
evidence. Real frontends, desktop journeys, physical overlay exclusion, SSH
adoption and measured service objectives remain pending. Linux uses the SSH
bridge to a configured Darwin controller.

The canonical public documentation is live at
[fruitctl.clients.xoxd.ai](https://fruitctl.clients.xoxd.ai/), with verified
anonymous delivery and hostname TLS. See the
[compatibility matrix](docs/compatibility.md) for the precise preview scope.

## Control path

`agent MCP → shared relay → Darwin controller → VNC → target desktop`

Credentials stay on the Darwin controller. A Linux seat uses the SSH bridge;
it does not receive the target password. Target configuration belongs to the
operator and cannot be redirected through tool arguments. A human can stop
control, and uncertain input is never replayed automatically.

The optional **FuzzyBot spell** indicator is a target-side purple heartbeat
overlay. Its Host source remains an unqualified prototype, and no Host binary,
installer or service is included in public previews. It will ship only for
capture modes that prove the indicator stays out of the agent's observations.

## Develop and adopt

Use the registered `just` recipes for checks, builds, documentation, and native
release work. The public client runtime baseline is Node.js 24; the existing
native build targets Apple Silicon and macOS 15 or later. Native release builds
require the qualified inputs in [project.yml](project.yml).

- [Product documentation](docs/index.md)
- [Agent adapters and IntelliJ/Junie setup](docs/agents.md)
- [Junie CLI and IntelliJ installation guide](docs/junie.md)
- [Architecture and capture contract](docs/architecture.md)
- [Product scope](docs/product.md) and [service objectives](docs/slo.md)
- [Test entrypoints](test/README.md) and [MCP tool schemas](tools/index.js)
- [Public docs build and hosting contract](docs/site/README.md)

Public support is best effort. Lab service objectives do not establish a
commercial SLA or a promise that every agent, OS, or capture mode is qualified.

Fork of [Claude KVM](https://github.com/ARAS-Workspace/claude-kvm), originally
authored by Rıza Emre ARAS. The original source notice is [MIT](LICENSE); linked
native distribution must also meet its GPL-compatible dependency obligations.
See [component licensing](docs/licensing.md). This project is separate from
[counterbeing/fruitctl](https://github.com/counterbeing/fruitctl), the Apple
Calendar and Reminders gateway.
