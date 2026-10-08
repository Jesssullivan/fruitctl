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
- A selected model/provider that accepts MCP image content for the
  observation/action/observation journey. Tool registration and a text-only
  invocation do not establish vision capability.
- A named Fruitctl target profile on the Darwin controller, a private
  controller-local credential file, and owner-enabled target Screen Sharing.
  The complete configuration examples are in [Home Manager](home-manager.md).
- A running, configured Darwin broker. A Linux seat also needs its configured
  SSH relay and socket. The MCP subprocess runs on the machine executing Junie;
  that machine must have the runtime and the intended broker/relay connection.
- A writable project configuration, or the owning Home Manager configuration
  surface for store-managed files. Existing settings must remain intact.

For a custom model, Junie uses `baseUrl` as the complete API endpoint.
For `OpenAICompletion`, use the provider's full chat-completions URL,
typically ending in `/v1/chat/completions`. Keep model selection,
authentication and provider configuration under their existing owner;
Fruitctl does not configure them. See [Junie custom
models](https://junie.jetbrains.com/docs/custom-llm-models.html).

The bootstrap installs the runtime and configuration. It does not install Junie
or IntelliJ, create the target profile or credentials, start the broker/relay,
enable Screen Sharing, or grant macOS consent. The public preview excludes the
optional Host application and purple indicator.

## One project-scope terminal paste

Run this in the root of the project you intend to open in Junie. Replace
`desktop` with your already-configured target profile. This uses the immutable
alpha.6 runtime preview and checks the pinned bootstrap script before execution.
The first invocation previews the operation; the second installs it.

```sh
(
  FRUITCTL_TARGET_PROFILE='desktop'
  FRUITCTL_SOURCE_SHA='8653325c6ccc0e058b3e4cf84eb44101cfd270fc'
  FRUITCTL_RELEASE_TAG='v0.1.0-alpha.6'
  FRUITCTL_PROJECT_DIR=$(pwd -P)
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
  [ "${FRUITCTL_ACTUAL_SHA%% *}" = 'd5aae5f89812def9f5e91e80de4fe8779b4f62263f1e331a26e5734b5fc3ecfc' ] &&
  sh "$FRUITCTL_SCRIPT" --agent junie --scope project \
    --project-dir "$FRUITCTL_PROJECT_DIR" --version "$FRUITCTL_RELEASE_TAG" --target "$FRUITCTL_TARGET_PROFILE" --dry-run &&
  sh "$FRUITCTL_SCRIPT" --agent junie --scope project \
    --project-dir "$FRUITCTL_PROJECT_DIR" --version "$FRUITCTL_RELEASE_TAG" --target "$FRUITCTL_TARGET_PROFILE"
)
```

The bootstrap needs `curl`, `tar`, `awk`, `mktemp`, and `sha256sum` or `shasum`;
Node.js is bundled. For user scope, replace both `--scope project` occurrences
with `--scope user`. The bootstrap supports `--project-dir`; this example
selects the physical current project path explicitly. It also supports
`--install-root` for a separate absolute storage root. That option requires
explicit scope; repeat the same root for doctor, rollback and uninstall.
See [installation roots](install.md#explicit-install-root-alpha-6-preview) before choosing a root
for an existing installation.

Use the receipt's recorded project path for subsequent lifecycle commands.
The example selects the physical current directory. Alpha.6's installed CLI
retains the project-alias refusal introduced in alpha.4 and names the recorded
path, including during dry-run. Historical alpha.3 could create another receipt
for that alias; later releases do not migrate those older records automatically.

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

## Current preview and historical installation evidence

Alpha.6 is the current pinned preview. It includes explicit storage roots and
ambient-curl configuration isolation. The public runtime excludes FruitctlHost
and the purple indicator. Darwin ARM64 Junie project bootstrap, installed doctor,
same-version reinstall and rollback, and owned uninstall have verified component
evidence. A separate default public uninstall-shell check used a fresh
offline-cache installation. The combined installer/SDK run remained unsuccessful;
installed SDK terminal acceptance and real Junie/IntelliJ frontend qualification
remain pending. Historical alpha.4 observations below remain specific to alpha.4.
See [current installation evidence](install.md).

### Observed alpha.4 installation scope

The anonymous Linux x64 stock Junie project bootstrap passed, followed by
installed help, doctor and reinstall. A continuation initialized the MCP SDK
against Junie's installed MCP launcher and called `listTools`, discovering all
four tool schemas without executing a tool action. An alternate-project-alias
dry-run was refused, and uninstall restored original unrelated configuration
bytes and modes. The 3,671 Linux runtime payload files were preserved, with the
generated identity marker accounted for separately. Reinstall retains
append-only installer history and its directory; the preservation claim covers
configuration and runtime payloads.

On Darwin ARM64, alpha.4 separately passed an offline Junie project lifecycle
through the bundled installer API and an installed SDK/shared-broker journey
through the unchanged signed controller to a loopback RFB fixture. Four complete
96×53 frames, one reconnect and releases through `task_complete` and
`task_failed` passed as synthetic protocol evidence. The alpha.4 Darwin stock
public bootstrap remains unqualified.

Image rendering, desktop input, release and reconnect in an actual Junie
conversation remain pending, as does separate IntelliJ acceptance. Historical
alpha.2 seven-adapter and alpha.3 Claude/API checks do not qualify the alpha.4
Junie frontend.

One alpha.4 run through native Junie CLI 3623.1 with a monitored MCP entry
initialized Fruitctl and
listed all four tools, then received HTTP 502 from its model provider before
any tool call. This is MCP discovery evidence only; actual frontend tool use
and image interpretation remain unqualified.

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

A successful Fruitctl doctor or MCP listing does not establish model-provider
health. If Junie reports `Failed to build ...`, inspect the underlying exception
chain in its local log. An HTTP provider failure can propagate through task
artifacts with that message; address the provider cause before repairing
templates or changing Fruitctl configuration. Preserve provider, model and
authentication settings, keep credentials and raw logs private, and do not
replay a control action whose outcome is uncertain.

If an IDE cannot discover the skill, supply its reviewed instructions in that
session and record skill discovery as incomplete. A passed configuration check
or MCP listing does not change the frontend's experimental status; qualification
requires the observation/action/observation and session-lifecycle results.
