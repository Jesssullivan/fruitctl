# Agent adapters

Fruitctl has one portable skill at [`skills/fruitctl`](../skills/fruitctl/SKILL.md)
and an adapter registry at [`integrations/agents.json`](../integrations/agents.json).
The skill uses the [Agent Skills specification](https://agentskills.io/specification):
YAML metadata and Markdown instructions with references loaded when needed.
TOON inventories can supplement that contract. They do not replace a harness's
native skill or MCP configuration format.

All seven adapters currently have documented configuration formats and offline
installer tests. End-to-end image rendering, input and lease qualification is
pending for each frontend. A successful configuration check means **configured**;
it does not mean a desktop session or native binary has been qualified.

## Install a pinned release

Use an exact published tag from the release inventory and an operator-configured
target profile. The commands below illustrate the interface; the preview package
version does not assert that downloadable qualified assets exist.

```sh
fruitctl install --agent codex --scope user --version <exact-tag> --target <profile> --dry-run
fruitctl install --agent codex --scope user --version <exact-tag> --target <profile>
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

Once an exact source commit and qualified release tag are listed, this block can
be pasted as one terminal operation. Replace both placeholders first:

```sh
(
  FRUITCTL_SOURCE_SHA='<full-source-commit>'
  FRUITCTL_RELEASE_TAG='<exact-release-tag>'
  FRUITCTL_SCRIPT=$(mktemp)
  trap 'rm -f "$FRUITCTL_SCRIPT"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    "https://raw.githubusercontent.com/xoxd-ai/fruitctl/$FRUITCTL_SOURCE_SHA/scripts/install.sh" \
    -o "$FRUITCTL_SCRIPT" &&
  sh "$FRUITCTL_SCRIPT" --agent codex --scope user \
    --version "$FRUITCTL_RELEASE_TAG" --target default
)
```

The GitHub HTTPS origin authenticates the script and checksum inventory. SHA-256
detects differing release bytes; it is not a substitute for Apple signing,
notarization, runtime acceptance or the release publisher's account security.

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

**IntelliJ and Junie:** Junie CLI, standalone Junie IDE plugin and integrated
AI Assistant/ACP are separate frontends. The installer writes the documented
CLI/standalone config and also returns an `ideSettingsSnippet`. Integrated AI
Assistant users add that snippet through Settings → Tools → AI Assistant → MCP.
The installer does not edit JetBrains internal XML or download/open an IDE.
Current Junie documentation describes IDE skills, while older AI Assistant
documentation lists a narrower support matrix; qualify the exact IDE build and
agent frontend. [Junie skills](https://junie.jetbrains.com/docs/agent-skills.html),
[standalone plugin](https://junie.jetbrains.com/docs/junie-ide-plugin.html),
[AI Assistant MCP](https://www.jetbrains.com/help/ai-assistant/mcp.html).

**VS Code:** the adapter uses current portable MCP files. Existing
`.vscode/mcp.json` uses `servers`, a different root. Merge through the documented
legacy surface if that file already owns the Fruitctl entry. Remote SSH can move
MCP execution to the remote host; configure the runtime and relay there. Codex
through VS Code Agent Host is experimental and requires qualification separate
from the official Codex extension. [VS Code MCP](https://code.visualstudio.com/docs/agent-customization/mcp-servers),
[VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills).

**OpenCode:** this adapter targets v1. The experimental v2 format nests servers
under `mcp.servers` and uses different enablement fields; the installer does not
silently emit that schema. [OpenCode v2 MCP](https://dev.opencode.ai/v2/docs/mcp-servers/).

**Kimi:** native Kimi uses its own adapter. Kimi used as the provider inside
Claude Code inherits Claude's adapter, while image/model capabilities still need
their own acceptance run. [Kimi in Claude](https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html).

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

Private receipts and backups live under `~/.local/state/fruitctl/install` with
owner-only permissions. Release bundles live under
`~/.local/share/fruitctl/releases/<tag>/<platform>-<arch>`. The convenience launcher
is `~/.local/bin/fruitctl`; MCP configurations use the absolute versioned path.
Rollback restores the previous recorded entry and skill after checking the prior
bundle's integrity. A shared `.mcp.json` entry or skill cannot pin conflicting
versions; such upgrades require the common configuration surface. The convenience
launcher can advance independently while every MCP entry retains its absolute
release path. Uninstall retains
unrelated edits and shared installations; verified release caches remain so
recovery is possible. Doctor checks receipts, owned config, links and every
recorded runtime file hash. Uninstall and rollback restore their previous file
state if a later filesystem operation fails. Doctor never launches an agent,
contacts a target or verifies desktop pixels.

Workspace trust, model credentials, Screen Sharing and any macOS consent remain
the owning client's and host's normal prerequisites. Capture a complete frame,
inspect the actual returned image, perform an authorized reversible action,
capture its result, release the lease, and test reconnect before recording an
adapter as qualified. A source-pinned skill or passing configuration check alone
is insufficient evidence.
