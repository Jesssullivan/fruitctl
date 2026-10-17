# Fruitctl

Fruitctl gives an agent a remote desktop over MCP. A native macOS controller
connects to the target's VNC service. The agent can observe the screen, read OCR,
move the pointer, and send keyboard or mouse input through one shared protocol.

Start with the [installation guide](install.md) and its copy-and-paste prompt.
Check [compatibility](compatibility.md) before selecting a controller or adapter.
The [agent adapter guide](agents.md) lists configuration paths and the separate
IntelliJ/Junie installation surfaces.
The [architecture](architecture.md) describes ownership, credential custody,
session control, and the separate target indicator. The
[Fruitctl-ready target profile](target-profile.md) lists the macOS settings
that `fruitctl doctor --macos` checks on a target.

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

The curated current preview is immutable
[v0.1.0-alpha.11](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11),
runtime producer `142743262d3242775f210c9d62a6b8e423c3ce5a`, with a signed
annotated tag. Use the [current installation guide](install.md) or
[rendered agent prompt](https://fruitctl.clients.xoxd.ai/install-prompt.md) for
the exact bootstrap and release checksums. The runtime bundles Node.js 24.21.0.
The Darwin ARM64 runtime bundles the native controller, built, Developer
ID-signed and notarized from the same revision.

All 13 alpha.11 assets match the curated hashes through anonymous download.
Real agent frontends, the Linux-to-Darwin SSH journey and measured service
objectives remain pending, so no product release is fully qualified yet. The
optional Host and purple indicator have no public binary or automatic setup.
Profiles, controller-local credentials, broker and SSH setup, target Screen
Sharing and macOS consent remain operator prerequisites. Eleven runtime
previews are published; each older one stays immutable and is listed with its
hashes in the [curated release inventory](site/versions.json).
