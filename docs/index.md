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
The reserved public documentation origin is `https://fruitctl.clients.xoxd.ai/`.
Cloudflare has allocated `xoxd-ai-fruitctl.pages.dev` and accepted that custom
domain. DNS, served documentation, and release qualification are pending;
allocation is not a deployment receipt.

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

The inherited native client has been used in the Lab. The public Fruitctl
installer, shared controller path, harness adapters, and purple target indicator
require their own reproducible qualification. Source interfaces and build
configuration show what is implemented; the compatibility matrix records what
may be claimed. A generated MCP entry alone proves no desktop action worked.
