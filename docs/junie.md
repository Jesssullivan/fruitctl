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

For a Junie CLI custom model, `baseUrl` is the complete API endpoint.
For `OpenAICompletion`, use the provider's full chat-completions URL,
typically ending in `/v1/chat/completions`. Keep model selection,
authentication and provider configuration under their existing owner;
Fruitctl does not configure them. See [Junie custom
models](https://junie.jetbrains.com/docs/custom-llm-models.html).

Static inspection of Junie CLI nightlies 3703.1 and 3731.1 found that startup
can migrate a saved global model default before per-run `--model` selection
when the migration has not yet been applied. `--model` selects the task's
model; it does not restore the saved global choice after migration.
Fruitctl's installer does not select models or providers or alter
authentication. Keep normal Junie model and authentication settings under
their existing owner. Real Junie CLI and IntelliJ adoption remains unqualified.

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

## Connect IntelliJ AI Chat

JetBrains recommends AI Assistant's AI Chat for Junie. Select **Junie by
JetBrains** there; the IDE downloads the agent automatically. The separate
Junie plugin is needed only for its own tool window. See the [Junie IDE
plugin guide](https://junie.jetbrains.com/docs/junie-ide-plugin.html).

Use your existing supported activation. Integrated Junie supports JetBrains AI
or API keys issued directly by OpenAI or Anthropic. Configuring an arbitrary
OpenAI-compatible endpoint in AI Assistant does not establish Junie activation;
the CLI custom-model configuration above is separate. See [agent
activation](https://www.jetbrains.com/help/ai-assistant/activate-agents.html).
Fruitctl does not select or change that account, provider or model.

After the Fruitctl installer returns `ideSettingsSnippet`:

1. Open Settings → Tools → AI Assistant → Model Context Protocol (MCP), click
   **Add**, choose STDIO and paste that JSON. Retain its absolute command and
   the arguments for your configured target.
2. Select project-level availability and set the working directory to the same
   physical project path used for installation. Click **OK**, then **Apply**;
   applying the entry starts its MCP subprocess.
3. Check the connection's **Status** and open its tool list. Confirm
   `vnc_command`, `action_queue`, `task_complete` and `task_failed`.
4. In Settings → Tools → AI Assistant → Agents, enable **Pass custom MCP
   servers** and click **OK**. Select Junie in AI Chat and follow the real
   frontend journey below using your existing tool-approval settings.

These steps follow the [AI Assistant MCP
configuration](https://www.jetbrains.com/help/ai-assistant/mcp.html) and [Junie
external-tool settings](https://www.jetbrains.com/help/ai-assistant/junie-agent.html).
The installer does not edit internal JetBrains XML; this IDE entry is separate
from the project JSON install. A connection and tool listing establish
configuration discovery, not image handling or desktop-control acceptance.

For the separate Junie tool window, install a compatible **Junie** build from
Settings → Plugins → Marketplace, then open View → Tool Windows → Junie.
Open the project whose `.junie/mcp/mcp.json` Fruitctl installed, and retain
its existing authentication. The [standalone plugin
guide](https://junie.jetbrains.com/docs/junie-ide-plugin.html) documents this
route; verify the MCP surface available in that exact build as described above.

## Use IntelliJ through Gateway on a remote backend

For a Gateway session, keep the qualification project, Fruitctl runtime and
project configuration on the remote backend. Use a dedicated project owned by
the operator and record its physical absolute path. Keep the existing backend
sessions for other projects intact. Gateway and JetBrains Client provide the
local editor; the remote IDE owns the backend project. See the [Remote
Development overview](https://www.jetbrains.com/help/idea/remote-development-overview.html).

Record the exact IntelliJ backend build, matching JetBrains Client build and
AI Assistant/Junie versions selected for this project. In the remote project's
Plugins settings, check each plugin's placement indicator: **On Host**, on the
client, or both. Plugins are installed per remote project; installation in a
local IDE or another backend project does not establish this project's setup.
Follow [remote plugin installation](https://www.jetbrains.com/help/idea/work-inside-remote-project.html).
Use the existing supported account, provider, selected model and tool-approval
settings. The CLI startup-migration warning above is a separate finding; neither
a CLI result nor another IDE's result qualifies this IntelliJ frontend.

Run the project-scope bootstrap above from the backend's terminal in that
physical project. For a verified installed CLI, this equivalent example uses
only stock installer flags. Set the absolute paths to your owned backend
project and storage root, and select an exact published runtime tag and an
already-configured target profile:

```sh
FRUITCTL_BACKEND_CLI='/absolute/path/to/verified/bin/fruitctl'
FRUITCTL_BACKEND_PROJECT='/absolute/path/to/owned/qualification-project'
FRUITCTL_INSTALL_ROOT='/absolute/path/to/owned/fruitctl-root'
FRUITCTL_RELEASE_TAG='v0.1.0-alpha.6'
FRUITCTL_TARGET_PROFILE='desktop'

"$FRUITCTL_BACKEND_CLI" install --agent junie --scope project \
  --project-dir "$FRUITCTL_BACKEND_PROJECT" --install-root "$FRUITCTL_INSTALL_ROOT" \
  --version "$FRUITCTL_RELEASE_TAG" --target "$FRUITCTL_TARGET_PROFILE" --dry-run &&
"$FRUITCTL_BACKEND_CLI" install --agent junie --scope project \
  --project-dir "$FRUITCTL_BACKEND_PROJECT" --install-root "$FRUITCTL_INSTALL_ROOT" \
  --version "$FRUITCTL_RELEASE_TAG" --target "$FRUITCTL_TARGET_PROFILE"
```

An `installed` result records the backend project's `.junie/mcp/mcp.json` and
`.junie/skills/fruitctl` link to the selected immutable runtime. A
`declarative-required` result retains configuration for its owning surface to
merge. Keep the project instructions and unrelated settings intact. Repeat the
same project path and installation root for doctor, rollback and uninstall.
`--install-root` selects runtime, state and launcher storage; it does not select
the MCP execution host or broker/relay socket. The installed CLI resolves exact
published releases; it has no offline-install flag. Private development bundles
need their separately verified installer API inputs and must not be presented
as published bootstrap tags.

In this same remote project, follow **Connect IntelliJ AI Chat** above: paste
`ideSettingsSnippet` into project-level AI Assistant MCP settings, retain its
absolute backend command and configured target, set the working directory to
the recorded backend project, and enable **Pass custom MCP servers**. Applying
MCP settings starts the configured process. These steps follow [AI Assistant
MCP settings](https://www.jetbrains.com/help/ai-assistant/mcp.html) and [Junie's
external-tool settings](https://www.jetbrains.com/help/ai-assistant/junie-agent.html).
The project JSON and IDE entry remain separate configuration surfaces.

Before desktop qualification, observe the actual Fruitctl MCP child on the
backend and record its executable, user, process identity, arguments and working
directory. Confirm the intended owned socket and transport in that process's
context without publishing credentials or inherited environments. A backend
pathname in JSON alone does not establish where a subprocess runs. For a Linux
backend, the configured SSH relay connects to the Darwin broker; the target's
credentials stay on the Darwin controller.

Verify that this exact Junie conversation loads the installed skill and its
operation reference, then complete the real frontend journey below: complete
fresh images, a reversible action and visible result, restoration, acknowledged
release, reacquisition and closure of its owned processes. Record the model's
interpretation of the returned images and the actual tool responses. Official
[Junie skills documentation](https://junie.jetbrains.com/docs/agent-skills.html)
describes IDE support; directory placement alone does not prove discovery.
Keep synthetic frontend compatibility and physical desktop acceptance as
separate results.

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
