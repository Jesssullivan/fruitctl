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

The immutable [v0.1.0-alpha.4 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.4)
pins portable source `e0f4d064b076e58b33856d877e0e1c9266f55177` and bundles
Node.js 24.21.0. Its macOS 15+ ARM64 runtime reuses the signed VNC controller
from `e00fcc86bbac4247d5a0847d7e656369c52cc15f`, retaining that controller's
original Apple Accepted submission. The entire runtime archive is a separate
asset.

On Linux x64, alpha.4 passed an anonymous stock Junie project bootstrap, help,
doctor, reinstall, alternate-project-alias dry-run refusal and uninstall. A
continuation initialized the MCP SDK against Junie's installed MCP launcher
and discovered four tool schemas. Original unrelated configuration bytes/modes and
3,671 Linux runtime payload files were preserved; the generated identity
marker is separate and installer history remains append-only. No tool action
or frontend image rendering ran.

On Darwin ARM64, alpha.4 passed an offline Junie project lifecycle through the
bundled installer API and an installed SDK/shared-broker journey through the
unchanged signed controller to a loopback RFB fixture. The synthetic journey
verified four complete 96×53 frames, one reconnect and two terminal releases.

Alpha.2's seven-adapter bootstrap and alpha.3's Claude bootstrap, 14 bundled-API
lifecycle cases and Darwin synthetic image exchange remain explicitly
historical. Linux uses the configured SSH bridge to Darwin. Host is an unqualified source
prototype with no public executable or automatic setup. Real frontend and
desktop journeys, physical overlay exclusion, the SSH journey and measured
service objectives remain pending.
