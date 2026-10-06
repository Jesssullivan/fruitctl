# Fruitctl

Fruitctl gives an agent a remote desktop over MCP. A native macOS controller
connects to the target's VNC service. The agent can observe the screen, read OCR,
move the pointer, and send keyboard or mouse input through one shared protocol.

Start with the [installation guide](install.md) and its copy-and-paste prompt.
Check [compatibility](compatibility.md) before selecting a controller or adapter.
The [agent adapter guide](agents.md) lists configuration paths and the separate
IntelliJ/Junie installation surfaces.
The [architecture](architecture.md) describes ownership, credential custody,
session control, and the separate target indicator.

Declarative consumers use the [Home Manager module](home-manager.md). Review
[licensing and dependency notices](licensing.md) before distributing native
artifacts.

The canonical source is [xoxd-ai/fruitctl](https://github.com/xoxd-ai/fruitctl).
The public documentation is live at
[fruitctl.clients.xoxd.ai](https://fruitctl.clients.xoxd.ai/). Anonymous canonical
delivery, public DNS and hostname TLS have been checked. All 24 served files of
documentation revision `ca6f19cd4430b0ca809bf07169e8a96362853465`, including HTML
and the build manifest, matched the reviewed build at 02:38 UTC on 2026-10-06.
The site serves `no-transform` response headers to preserve those bytes.

## Adoption contract

- Resolve one exact release and source commit before installing.
- Verify supported OS, architecture, adapter, and artifact checksums.
- Keep target credentials on the configured Darwin controller.
- Obtain a complete fresh observation before sending input.
- Stop on uncertain execution or capture failure; do not replay input.
- Use a human stop control and one active lease for each target.

The site exports `agents.md`, `llms.txt`, `adoption.json`, `adoption.toon`,
`versions.json`, and the installation prompt from reviewed public sources.
Moving discovery URLs point to immutable GitHub source and release artifacts;
they are not the bytes a consumer pins.

Read [product scope](product.md) and [service objectives](slo.md) for the current
milestones and the distinction between Lab targets and public best-effort support.

## Current status

The immutable [v0.1.0-alpha.2 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.2)
is available with bundled Node.js 24.21.0 and a signed, Apple-notarized VNC
controller in its macOS 15+ ARM64 runtime. Archive integrity, offline native
checks, actual public adapter bootstrap and synthetic VNC/MCP image exchange
have scoped evidence. Linux
connects through the SSH bridge to a configured Darwin controller. Host is an
unqualified source prototype with no public executable or automatic setup.
Real agent rendering and desktop journeys, physical overlay exclusion, the SSH
journey and measured service objectives remain pending. A generated MCP entry
alone proves no desktop action worked.
