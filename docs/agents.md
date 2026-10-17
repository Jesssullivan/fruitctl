# Agent adapters

Fruitctl has one portable skill at [`skills/fruitctl`](../skills/fruitctl/SKILL.md)
and an adapter registry at [`integrations/agents.json`](../integrations/agents.json).
The skill uses the [Agent Skills specification](https://agentskills.io/specification):
YAML metadata and Markdown instructions with references loaded when needed.
TOON inventories can supplement that contract. They do not replace a harness's
native skill or MCP configuration format.

For desktop work, follow the installed skill's
[operation reference](../skills/fruitctl/references/operation.md): health, a fresh
image, bounded authorized input, verification and session release. The hosted
reference describes the current workflow; use your installed release's skill
and discovered tool schemas when their versions differ.

Frontends whose models were trained on the Anthropic `computer` tool or OpenAI
`computer_call` can use the `computer` MCP tool. It ships from alpha.10. In
alpha.10 and alpha.11 the alias refuses `hold_key` and modifier clicks; later
sources map them onto native `hold_key` and `mouse_click` modifiers. It translates those action
shapes into ordinary Fruitctl batches with the same deadline, ownership and
route labels. Actions the backend does not advertise are refused with
`unsupported_action`; it never emulates them. The tool is reached through the
frontend's MCP configuration under its prefixed name, for example
`mcp__fruitctl__computer`. It does not replace or register as the frontend's
built-in computer-use tool. See the
[alias mapping](../skills/fruitctl/references/operation.md#computer-use-alias).

All seven adapters currently have documented configuration formats and offline
installer tests. Complete desktop qualification is pending for each frontend;
the scoped Claude synthetic observations below do not complete it. A successful
configuration check means **configured**;
it does not mean a desktop session or native binary has been qualified.

## Install a pinned release

The curated current preview is immutable
[v0.1.0-alpha.11](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11),
pinned to runtime producer `142743262d3242775f210c9d62a6b8e423c3ce5a` with a signed annotated tag.
It provides the runtime, skill and adapters. The Darwin arm64 runtime includes
the native controller at `bin/claude-kvm-daemon`, built, Developer ID-signed
and notarized from the same revision. Linux, including Rocky Linux, uses the
separately configured SSH bridge to Darwin. The broker, target profile,
credential provider, target Screen Sharing and any macOS consent remain
operator-owned. The Host application and purple indicator are not distributed
in this preview; the runtime includes portable Host-installer payload and help
only.

Complete platform, physical desktop, real SSH, native Host, consent and
whole-frontend qualification remain pending; Gateway/Junie remains deferred.

### Current install and recovery commands

```sh
fruitctl install --agent codex --scope user --version v0.1.0-alpha.11 --target <profile> --dry-run
fruitctl install --agent codex --scope user --version v0.1.0-alpha.11 --target <profile>
fruitctl doctor --agent codex --scope user
fruitctl doctor --json
fruitctl rollback --agent codex --scope user
fruitctl uninstall --agent codex --scope user
```

For a source checkout, run the same command with `node bin/fruitctl.mjs`; dry-run
does not download a release or write configuration. `--project-dir` selects a
project other than the current directory. `--config` supplies the Fruitctl profile
configuration pathname; it is passed as `FRUITCTL_CONFIG_PATH`, without copying
credentials or profile contents into an MCP configuration.

The rootless [`scripts/install.sh`](../scripts/install.sh) bootstrap needs `curl`,
`tar`, `awk`, `mktemp`, and `sha256sum` or `shasum`. It downloads an exact-tag
runtime archive and `SHA256SUMS` over HTTPS, verifies the archive, rejects unsafe
archive paths and links, and uses the bundled Node 24 runtime. Before editing an
agent config, the installer verifies GitHub's manifest asset digest, release
identity, platform and archive checksum again. Missing assets or a missing
manifest digest fail explicitly. No agent or GUI is launched and no root access
or package-manager install scripts are needed.

For one terminal operation, use the
[published alpha.11 paste](install.md#one-terminal-paste-published-alpha-11).
For installation by an agent, copy the
[rendered prompt](https://fruitctl.clients.xoxd.ai/install-prompt.md).
Replace `default` with your configured profile. Those routes select the same
curated release and bootstrap pins; the ordinary user-scope paste remains an
unqualified installation scope.

The GitHub HTTPS origin authenticates the script and checksum inventory. SHA-256
detects differing release bytes; it is not a substitute for Apple signing,
notarization, runtime acceptance or the release publisher's account security.

No separate native-install flag is needed for the bundled Darwin controller.
An explicit profile `daemonPath` takes priority, followed by
`CLAUDE_KVM_DAEMON_PATH`; otherwise Darwin resolves the absolute controller path
inside its installed release. Installation does not start a broker, native
process or service, create a target profile or credential, or grant macOS consent.

## Install root and registration: current preview

The current [v0.1.0-alpha.11 preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.11)
separates operational storage from adapter registration with
`--install-root ABSOLUTE_DIRECTORY`. **Alpha.4 does not support this option.**
See the
[explicit install-root guide](install.md#explicit-install-root-current-preview)
for the exact alpha.11 bootstrap pin, storage layout and recovery commands.

An explicit-root installation requires an explicit `--scope`. Use
`--scope project --project-dir <absolute-project-directory>` to choose the
project's MCP and skill destinations independently of the runtime cache, private
installer state and launcher beneath the install root. The bootstrap
passes `--project-dir` through; project scope still uses the current directory
when it is omitted. With `--scope user`, registration still uses the supported
user configuration and adapter environment rules. Choosing a storage root does
not isolate that user profile or reassign `HOME`, `CODEX_HOME` or other adapter
variables.

Generated MCP entries continue to launch the installed absolute versioned
executable with the selected target/configuration fields. They do not pass
`--install-root`, relocate broker configuration or sockets, or create credentials.
Supply the same install root on subsequent doctor, rollback and uninstall
commands. Doctor inspects that namespace; recovery uses the receipt's recorded
registration paths. Another root cannot adopt an existing owned entry or skill.
Uninstall retains verified cache, root metadata, backups and history; there is
no automatic discovery, migration or purge.

Explicit-root bootstrap and release selection must reject a runtime without the
capability before it can fall back to normal-home storage. Alpha.4's older API
ignores an unknown `installRoot` property; passing it directly does not select
storage. Omitting the option preserves the existing defaults, legacy receipts
and older-release compatibility.

Optional installer `--timings` is limited to an installed CLI from alpha.9 on and its installer commands; see [timing scope](install.md#optional-installer-timings). Do not pass it to the shell bootstrap, MCP or Host installer. Alpha.8 lacks that flag.

## Configuration destinations

All generated entries launch the installed absolute `bin/fruitctl` path with
`mcp --target <profile>`. Configuration uses local stdio; Linux reaches the Darwin
broker through the separately configured SSH relay. The execution host must have
that relay socket and the intended SSH configuration.

| Adapter | User MCP file | Project MCP file | Shape | Skill root used by installer |
| --- | --- | --- | --- | --- |
| `claude` | `~/.claude.json` | `.mcp.json` | `mcpServers.fruitctl`, command + args | `.claude/skills/fruitctl` |
| `codex` | `~/.codex/config.toml` | `.codex/config.toml` | `[mcp_servers.fruitctl]` | `.agents/skills/fruitctl` |
| `pi` | `~/.pi/agent/mcp.json` | `.pi/mcp.json` | `mcpServers.fruitctl`, command + args | `.agents/skills/fruitctl` |
| `junie` | `~/.junie/mcp/mcp.json` | `.junie/mcp/mcp.json` | `mcpServers.fruitctl`, command + args | `.junie/skills/fruitctl` |
| `opencode` | `~/.config/opencode/opencode.json` | `opencode.json` or existing `.jsonc` | `mcp.fruitctl`, `type:local`, command array | `.agents/skills/fruitctl` |
| `vscode` | `~/.copilot/mcp-config.json` | `.mcp.json` | Portable `mcpServers.fruitctl`, `type:stdio` | `.agents/skills/fruitctl` |
| `kimi` | `~/.kimi-code/mcp.json` | `.kimi-code/mcp.json` | `mcpServers.fruitctl`, command + args | `.agents/skills/fruitctl` |

User config resolution honors `CODEX_HOME`, `PI_CODING_AGENT_DIR`,
`KIMI_CODE_HOME`, and OpenCode's `OPENCODE_CONFIG`/`XDG_CONFIG_HOME`. Run installation
in the same environment as the harness. Custom Claude account directories and
enterprise-managed destinations need their owning configuration surface; review
the generated fragment instead of assuming the default user path is active.

Sources: [Claude MCP](https://code.claude.com/docs/en/mcp),
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Codex environment](https://learn.chatgpt.com/docs/config-file/environment-variables),
[Pi MCP](https://pi.dev/docs/latest/mcp), [Pi configuration](https://pi.dev/docs/latest/configuration),
[Junie MCP](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html),
[OpenCode MCP](https://opencode.ai/docs/mcp-servers/),
[VS Code MCP](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[Kimi MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html).

## Frontend boundaries

**Pi:** native MCP requires 0.99.0 or later. An extension that registers `/mcp`
replaces native MCP behavior, so inspect the extension's actual registration
before claiming native configuration will be read. [Pi changelog](https://pi.dev/changelog),
[Pi MCP](https://pi.dev/docs/latest/mcp).

Historical alpha.2 evidence (release published 2026-10-06): its skill passed
the official `skills-ref` 0.1.0 validator. An isolated
Pi 1.0.4 SDK check discovered its user and project skill symlinks and loaded the
user skill through `DefaultResourceLoader`. A fresh isolated alpha.2 Pi user
installation then supplied the configuration for an SDK fixture using the
installer's default codemode exposure: the entry has no `exposure` field.
Only the server launch fields were substituted with an owned synthetic stdio
server. Pi's upstream MCP and codemode extensions initialized and discovered
that server, invoked health, and projected a byte-identical synthetic PNG through
`image(block)`. The fixture supplied synthetic assistant call records; no model
or provider turn ran, and the Fruitctl MCP server and broker were not launched.

A nested MCP image reaches codemode's outer image content only when the script
calls `image(block)`; printing its metadata alone emits no outer image. These
checks cover installed skill discovery and Pi's stdio/codemode image plumbing.
They do not qualify CLI/TUI image rendering, a model's use of Fruitctl, a real
VNC desktop, input or leases. [Pi SDK](https://pi.dev/docs/latest/sdk),
[Pi codemode](https://pi.dev/docs/latest/codemode),
[Agent Skills validation](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref).

**IntelliJ and Junie:** Junie CLI, standalone Junie IDE plugin and integrated
AI Assistant/ACP are separate frontends. Follow the [Junie installation
guide](junie.md) for project-scope installation and the settings for each IDE
surface. The installer writes the documented
CLI/standalone config and also returns an `ideSettingsSnippet`. Integrated AI
Assistant users add that snippet through Settings → Tools → AI Assistant →
Model Context Protocol (MCP).
For Junie in AI Chat, also enable Settings → Tools → AI Assistant → Agents →
**Pass custom MCP servers**. Older standalone plugin builds used Tools → Junie
→ MCP Settings; current Marketplace releases removed that page. Use the
documented project/user JSON files and verify the actual selected frontend's
MCP status. Configuring one frontend does not qualify the others.
The installer does not edit JetBrains internal XML or download/open an IDE.
Current Junie documentation describes IDE skills, while older AI Assistant
documentation lists a narrower support matrix; qualify the exact IDE build and
agent frontend. [Junie skills](https://junie.jetbrains.com/docs/agent-skills.html),
[standalone plugin](https://junie.jetbrains.com/docs/junie-ide-plugin.html),
[AI Assistant MCP](https://www.jetbrains.com/help/ai-assistant/mcp.html),
[Junie in AI Chat](https://www.jetbrains.com/help/ai-assistant/junie-agent.html).

**VS Code:** the adapter uses current portable MCP files. Agent Host sessions
read `.mcp.json` and `~/.copilot/mcp-config.json` directly. In an extension-host
session, discovery of the Copilot user file is off by default; enable the
`copilot` source in `chat.mcp.discovery.enabled` or configure the server through
the VS Code MCP settings. A custom `COPILOT_HOME` replaces the default user
location. The alpha.4 installer retains alpha.3's support for it in user scope
and records the actual destination for doctor and uninstall. Uninstall the
recorded installation before selecting a different MCP or skill destination;
recovery uses its recorded
paths even if the environment changes. The immutable alpha.2 installer predates
this support, so use declarative configuration for a custom Copilot home with
that release. Record the selected harness when qualifying the connection. Existing
`.vscode/mcp.json` uses `servers`, a different root. Merge through the documented
legacy surface if that file already owns the Fruitctl entry. Remote SSH can move
MCP execution to the remote host; configure the runtime and relay there. Codex
through VS Code Agent Host is experimental and requires qualification separate
from the official Codex extension. [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration),
[VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills).

**OpenCode:** this adapter targets v1. The experimental v2 format nests servers
under `mcp.servers` and uses different enablement fields; the installer does not
silently emit that schema. [OpenCode v2 MCP](https://dev.opencode.ai/v2/docs/mcp-servers/).

**Kimi:** native Kimi uses its own adapter. Kimi used as the provider inside
Claude Code inherits Claude's adapter, while image/model capabilities still need
their own acceptance run. [Kimi in Claude](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).

## Frontend acceptance journey

A frontend counts as qualified on a target only after two fresh sessions each
complete this journey on the real desktop, the second one after the first has
released its session. The operator runs it in the frontend under test. An
agent must never launch another agent's binary to produce it. Paste the prompt
into a new session, replacing `<marker>` with a lowercase alphanumeric marker
unique to that session, for example `fruitctlqual1` and then `fruitctlqual2`.

```text
Use only the Fruitctl MCP tools (vnc_command, action_queue, task_complete,
task_failed; your frontend may prefix them). Do not launch, quit or install
apps, and do not change settings.
1. vnc_command health. If it reports a typed failure, call task_failed with it.
2. vnc_command screenshot. Describe what is on screen.
3. If a System Settings window shows its sidebar search field, click it with
   mouse_click. Otherwise send key_combo with keys ["cmd","space"] to open
   Spotlight, take a screenshot, and click inside the Spotlight field.
4. key_type the text <marker>.
5. Take a screenshot and say whether <marker> is visible in that field.
6. Clear it: key_combo with keys ["cmd","a"], then key_tap backspace. If
   Spotlight is open, key_tap escape. Take a screenshot showing the field
   empty or closed.
7. Call task_complete with a one-line summary that names <marker>, or
   task_failed with the reason if any step failed. Do not retry past one
   stale_screen or input_not_ready retry per step.
```

Verify each run on the broker host from the [action journal](architecture.md#action-journal),
not from the transcript alone:

1. Each session leaves one new `journal/<session>.jsonl`, so two runs leave
   two files. List them by time with `ls -t` in the journal directory.
2. `fruitctl journal verify FILE` returns `"ok": true` for both files. The
   installed CLI must include the `journal` command.
3. Each file records `health`, then `screenshot` with `outcome` `ok` and a
   non-null `frame_sha256`, then `mouse_click`, `key_type` with `params.text`
   equal to that session's marker, the clearing keys, and a final
   `screenshot`, all with `outcome` `ok`. Session 2 has its own session UUID
   and its own marker.
4. The transcript shows `task_complete` succeeding. Release is not a journal
   action, so this is the only release evidence.
5. The screenshots in the transcript show the marker in the field after step 5
   and no marker after step 6. A tool acknowledgement alone is not evidence of
   either.

## Preservation and recovery

The installer changes only its `fruitctl` MCP entry and creates a symlink to the
release's canonical skill. It preserves unrelated JSON/JSONC settings and
comments, and unrelated TOML sections. Inline/dotted TOML server declarations
that cannot be safely merged require a manual or declarative fragment.
Junie `enabled`/`disabled` and OpenCode `enabled` remain user-controlled on updates.

Symlinked, store-managed or read-only config files yield `declarative-required`
and a fragment without being overwritten. Use [Home Manager](home-manager.md)
to apply it. Existing unowned or changed launch entries are never adopted silently.
No `AGENTS.md`, instruction override, `.junie/AGENTS.md`, agent binary or IDE
setting is created or launched.

Without an explicit install root, private receipts and backups live under
`~/.local/state/fruitctl/install` with
owner-only permissions. Release bundles live under
`~/.local/share/fruitctl/releases/<tag>/<platform>-<arch>`. The convenience launcher
is `~/.local/bin/fruitctl`; MCP configurations use the absolute versioned path.
Rollback restores the previous recorded entry and skill after checking the prior
bundle's regular files, hashes and recorded permissions. Darwin's bundled
controller follows that restored release; explicit operator controller paths
remain operator-owned. A shared `.mcp.json` entry or skill cannot pin conflicting
versions; such upgrades require the common configuration surface. The convenience
launcher can advance independently while every MCP entry retains its absolute
release path. Uninstall retains
unrelated edits and shared installations; verified release caches, including
the bundled Darwin controller, remain so recovery is possible. Doctor checks
receipts, owned config, links and every recorded runtime file hash and permission.
Legacy hash-only receipts remain readable. Doctor does not validate Apple signing
or notarization. Uninstall and rollback restore their previous file
state if a later filesystem operation fails. Doctor never launches an agent,
contacts a target or verifies desktop pixels.

Workspace trust, model credentials, Screen Sharing and any macOS consent remain
the owning client's and host's normal prerequisites. Capture a complete frame,
inspect the actual returned image, perform an authorized reversible action,
capture its result, release the lease, and test reconnect before recording an
adapter as qualified. A source-pinned skill or passing configuration check alone
is insufficient evidence.
