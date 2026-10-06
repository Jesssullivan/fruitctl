# Fruitctl

Give your agent a remote desktop through MCP. Fruitctl connects a native macOS
VNC client to a target desktop and exposes screenshots, mouse and keyboard
input, scrolling, and OCR. Claude Code, Codex, Pi, and Junie use the same control
protocol; each adapter has its own installation and acceptance checks.

The public source authority is [xoxd-ai/fruitctl](https://github.com/xoxd-ai/fruitctl).
This repository preserves the Agent KVM / Claude KVM history. Legacy executable,
MCP tool, and signed application identities remain compatibility surfaces.

## Install with your agent

Copy the [installation prompt](docs/site/install-prompt.md) into your agent and
follow the [installation guide](docs/install.md). The prompt resolves a pinned,
verified release, configures a named target, and checks a fresh observation
before input. If the release does not support your controller and agent, it
reports the missing prerequisite instead of claiming installation succeeded.

The immutable [v0.1.0-alpha.2 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.2)
ships bundled Node.js 24.21.0, the installer, shared skill and MCP/broker code.
Its Apple Silicon macOS 15+ runtime also contains the unchanged Developer
ID-signed, Apple-notarized VNC controller. Archive integrity, offline native
checks, actual public adapter bootstrap and synthetic VNC/MCP image exchange
have scoped evidence. Linux uses
the SSH bridge to a configured Darwin controller. Real frontend and desktop
journeys, physical overlay exclusion, SSH adoption and measured service
objectives remain pending.

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
