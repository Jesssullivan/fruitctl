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
[fruitctl.clients.xoxd.ai](https://fruitctl.clients.xoxd.ai/). The
[live build manifest](https://fruitctl.clients.xoxd.ai/build-manifest.json)
records the served source revision and artifact checksums. The
[Public documentation workflow](https://github.com/xoxd-ai/fruitctl/actions/workflows/docs.yml)
records automatic main-branch builds and uploads.
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

The immutable [v0.1.0-alpha.3 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.3)
is available with bundled Node.js 24.21.0 and a signed VNC controller in its
macOS 15+ ARM64 runtime. The controller retains its original Apple Accepted
submission; that does not notarize the entire runtime archive. Archive and
corresponding-source integrity, the Darwin ARM64 runtime's synthetic VNC/MCP
exchange, and 14 Linux x64 user/project lifecycle cases through the bundled
installer API across seven adapters have scoped evidence. Linux
connects through the SSH bridge to a configured Darwin controller. Host is an
unqualified source prototype with no public executable or automatic setup.
Real agent rendering and desktop journeys, physical overlay exclusion, the SSH
journey and measured service objectives remain pending. A generated MCP entry
alone proves no desktop action worked.
