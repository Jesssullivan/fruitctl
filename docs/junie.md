# Install Fruitctl for Junie and IntelliJ

Fruitctl's `junie` adapter installs MCP configuration and the shared skill for
Junie CLI or the standalone Junie IDE plugin. Junie inside IntelliJ's AI Chat
has a separate IDE configuration step. These are experimental frontends;
installation and a successful doctor check do not establish desktop acceptance.

## Choose the frontend and prepare the connection

| Frontend | MCP configuration | Verification surface |
| --- | --- | --- |
| Junie CLI | Project `.junie/mcp/mcp.json` or user `~/.junie/mcp/mcp.json` | `/mcp` in the existing Junie session |
| Standalone Junie IDE plugin | The same project/user JSON files | The selected build's MCP listing/status; older builds exposed Settings → Tools → Junie → MCP Settings |
| Junie in IntelliJ AI Chat | Add the generated JSON through Settings → Tools → AI Assistant → Model Context Protocol (MCP), then enable Agents → **Pass custom MCP servers** | That IDE's MCP connection status and the actual Junie conversation |

The first two destinations follow [Junie's MCP documentation](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html).
The AI Chat steps follow [Junie in AI Assistant](https://www.jetbrains.com/help/ai-assistant/junie-agent.html).
In an ACP client, `/mcp` lists configured servers and their source/status; it does
not open the CLI installation assistant or edit configurations.

The standalone menu is build-dependent. Although the standalone guide still
names Settings → Tools → Junie → MCP Settings, the
[Marketplace release metadata](https://plugins.jetbrains.com/api/plugins/26104/updates?size=5)
for `261.2144.120` and `262.2144.120`, reviewed on 2026-10-07, includes its
removal in the `2xx.1966.xx` release notes. Use the documented JSON files and
the MCP listing/status actually available in the selected frontend; do not
assume the legacy menu exists. The AI Chat configuration path above is the
separately documented AI Assistant surface.

Before installing, have these prerequisites ready:

- An existing Junie installation and its normal account or model-provider
  authentication. In IntelliJ, install/activate AI Assistant and select Junie
  in AI Chat, or install the separate Junie plugin for its standalone window.
- A named Fruitctl target profile on the Darwin controller, a private
  controller-local credential file, and owner-enabled target Screen Sharing.
  The complete configuration examples are in [Home Manager](home-manager.md).
- A running, configured Darwin broker. A Linux seat also needs its configured
  SSH relay and socket. The MCP subprocess runs on the machine executing Junie;
  that machine must have the runtime and the intended broker/relay connection.
- A writable project configuration, or the owning Home Manager configuration
  surface for store-managed files. Existing settings must remain intact.

The bootstrap installs the runtime and configuration. It does not install Junie
or IntelliJ, create the target profile or credentials, start the broker/relay,
enable Screen Sharing, or grant macOS consent. The public preview excludes the
optional Host application and purple indicator.

## One project-scope terminal paste

Run this in the root of the project you intend to open in Junie. Replace
`desktop` with your already-configured target profile. This uses the immutable
alpha.3 runtime preview and checks the pinned bootstrap script before execution.
The first invocation previews the operation; the second installs it.

```sh
(
  FRUITCTL_TARGET_PROFILE='desktop'
  FRUITCTL_SOURCE_SHA='e00fcc86bbac4247d5a0847d7e656369c52cc15f'
  FRUITCTL_RELEASE_TAG='v0.1.0-alpha.3'
  FRUITCTL_SCRIPT=$(mktemp)
  trap 'rm -f "$FRUITCTL_SCRIPT"' EXIT
  curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    "https://raw.githubusercontent.com/xoxd-ai/fruitctl/$FRUITCTL_SOURCE_SHA/scripts/install.sh" \
    -o "$FRUITCTL_SCRIPT" &&
  FRUITCTL_ACTUAL_SHA=$(if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$FRUITCTL_SCRIPT"
  else
    shasum -a 256 "$FRUITCTL_SCRIPT"
  fi) &&
  [ "${FRUITCTL_ACTUAL_SHA%% *}" = '6e05a7a62f57491cfbda1f8d9212291f6237f04f4ac396bc04d183b88747cd58' ] &&
  sh "$FRUITCTL_SCRIPT" --agent junie --scope project \
    --version "$FRUITCTL_RELEASE_TAG" --target "$FRUITCTL_TARGET_PROFILE" --dry-run &&
  sh "$FRUITCTL_SCRIPT" --agent junie --scope project \
    --version "$FRUITCTL_RELEASE_TAG" --target "$FRUITCTL_TARGET_PROFILE"
)
```

The bootstrap needs `curl`, `tar`, `awk`, `mktemp`, and `sha256sum` or `shasum`;
Node.js is bundled. For user scope, replace both `--scope project` occurrences
with `--scope user`. This bootstrap selects project scope from the current
directory; it has no `--project-dir` option. The installed CLI supports that
option when subsequently selecting another project.

Use the receipt's recorded project path for subsequent lifecycle commands.
Alpha.3's bootstrap uses the physical current directory, while the installed
CLI preserves an explicit `--project-dir` spelling. Under symlinked paths,
using another spelling can create a second receipt for the same project.
Current source refuses that alternate path and names the recorded path; this
guard requires a subsequent runtime release and does not migrate old receipts.

Inspect the JSON result. `installed` records the versioned runtime, MCP entry
and skill link. `declarative-required` means configuration was retained: apply
its fragment through Home Manager or the owning configuration surface.
For an installed result, run from the same project:

```sh
"$HOME/.local/bin/fruitctl" doctor --agent junie --scope project
```

The generated `mcpServers.fruitctl` entry uses the absolute versioned executable
with `args: ["mcp", "--target", "desktop"]` for the selected profile. An optional
installed-CLI `--config` value becomes a `FRUITCTL_CONFIG_PATH` pathname; no
profile contents or VNC password are embedded in MCP configuration. Junie's
mutable enabled/disabled state is preserved on an owned entry update.

For AI Chat, copy the returned `ideSettingsSnippet` into the IDE's MCP settings
using the [documented STDIO JSON surface](https://www.jetbrains.com/help/ai-assistant/mcp.html),
then enable **Pass custom MCP servers**. The installer does not edit internal
JetBrains XML. Adding this IDE entry is separate from the project JSON install.

## Versions, skills and project instructions

Official documentation was reviewed on 2026-10-07. The standalone plugin guide
lists IntelliJ Ultimate 2024.3.2 and Community 2025.1 as installation floors;
the [Marketplace changelog](https://plugins.jetbrains.com/plugin/26104-junie-the-ai-coding-agent-by-jetbrains)
also records deprecation of the 2024.3/2025.1 lines. Those floors therefore do
not establish compatibility with the latest plugin. Record the exact IDE and
plugin build selected by Marketplace. Optional
[Junie CLI integration with a running IntelliJ instance](https://junie.jetbrains.com/docs/junie-cli-jetbrains-ide-integration.html)
requires IntelliJ 2026.1 or newer, the Junie plugin, and the same project path.
That connection is separate from configuring Fruitctl MCP.

The installer links `.junie/skills/fruitctl` under the chosen scope. Current
[Junie skills documentation](https://junie.jetbrains.com/docs/agent-skills.html)
describes CLI and IDE support; the AI Assistant 2026.2
[agent matrix](https://www.jetbrains.com/help/ai-assistant/agents.html), dated
2026-08-05, lists a narrower Junie skill surface. Verify discovery in the exact
frontend rather than assuming that one document qualifies every build.
For CLI, use `/skills` to check that `fruitctl` loads and is enabled, then
`/fruitctl` or `$fruitctl` to request it. The documented folder locations do not
by themselves prove that a particular frontend follows the installed symlink.

Keep the project's existing `AGENTS.md`. The standalone plugin's
`.junie/AGENTS.md`, if already present, takes precedence over root instructions;
Fruitctl does not create or replace it. Existing custom guideline settings also
remain under the project owner's control.

## Verify the real frontend journey

Use the existing Junie session and normal external-tool approval settings.
Configuration registration is only the first stage:

1. Check MCP connection status in the selected frontend. In CLI, `/mcp` should
   show Fruitctl active with the expected project/user source. Confirm the
   actual discovered tool schemas, including `vnc_command`, `action_queue`,
   `task_complete`, and `task_failed`.
2. Request a fresh, complete desktop observation through Fruitctl. Inspect
   the image actually delivered in that conversation; a JSON image descriptor
   or a doctor result does not prove that Junie received useful pixels.
3. With the target owner's authorized test scene, make one reversible action,
   capture its visible result, release the session, and verify reconnect.
   Follow the installed skill and discovered schemas. Stop on an uncertain
   result rather than replaying input.
4. Record the exact release, Junie version, IDE/plugin build if applicable,
   execution host, capture mode and observed results. CLI, standalone plugin
   and AI Chat require separate records. Keep credentials and private screen
   data out of public evidence.

If an IDE cannot discover the skill, supply its reviewed instructions in that
session and record skill discovery as incomplete. A passed configuration check
or MCP listing does not change the frontend's experimental status; qualification
requires the observation/action/observation and session-lifecycle results.
