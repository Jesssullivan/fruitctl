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

The immutable [v0.1.0-alpha.2 controller runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.2)
is pinned to source commit `6c8a5751b1ab92ee4093aa0091e88ef212021dab`.
It provides the runtime, skill and adapters. The Darwin arm64 runtime includes
the Developer ID-signed, notarized controller at `bin/claude-kvm-daemon`.
Linux uses the separately configured SSH bridge to Darwin. The broker, target
profile, credential provider, target Screen Sharing and any macOS consent remain
operator-owned. The Host application and purple indicator remain source
prototypes with private lab binaries and are not distributed in this preview.

The alpha.2 Linux x64 public download and bootstrap passed anonymous HTTPS
acceptance on Rocky Linux 10.2 using isolated home and project paths containing
spaces. All seven user adapters and Claude project installation, the bundled
Node.js 24.21.0 launcher, all runtime hashes and permissions, aggregate doctor
and every uninstall passed. Uninstalls restored unrelated configuration exactly.
This evidence covers public packaging and configuration; each real frontend
still needs image, input and lease acceptance.

The immutable [v0.1.0-alpha.1 runtime preview](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.1)
remains pinned to `7064d349890a9b18717b62a142452363629681ee` and requires an
existing Darwin native controller. Its earlier anonymous Codex user and Claude
project bootstrap checks remain historical evidence for that release.

```sh
fruitctl install --agent codex --scope user --version v0.1.0-alpha.2 --target <profile> --dry-run
fruitctl install --agent codex --scope user --version v0.1.0-alpha.2 --target <profile>
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

This block pins the published source and runtime preview and can be pasted as
one terminal operation. Replace `default` with your configured profile:

```sh
(
  FRUITCTL_SOURCE_SHA='6c8a5751b1ab92ee4093aa0091e88ef212021dab'
  FRUITCTL_RELEASE_TAG='v0.1.0-alpha.2'
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
  sh "$FRUITCTL_SCRIPT" --agent codex --scope user \
    --version "$FRUITCTL_RELEASE_TAG" --target default
)
```

The GitHub HTTPS origin authenticates the script and checksum inventory. SHA-256
detects differing release bytes; it is not a substitute for Apple signing,
notarization, runtime acceptance or the release publisher's account security.

No separate native-install flag is needed for the bundled Darwin controller.
An explicit profile `daemonPath` takes priority, followed by
`CLAUDE_KVM_DAEMON_PATH`; otherwise Darwin resolves the absolute controller path
inside its installed release. Installation does not start a broker, native
process or service, create a target profile or credential, or grant macOS consent.

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

The alpha.2 skill passed the official `skills-ref` 0.1.0 validator. An isolated
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
AI Assistant/ACP are separate frontends. The installer writes the documented
CLI/standalone config and also returns an `ideSettingsSnippet`. Integrated AI
Assistant users add that snippet through Settings → Tools → AI Assistant → MCP.
For Junie in AI Chat, also enable Settings → Tools → AI Assistant → Agents →
**Pass custom MCP servers**. The standalone plugin uses Tools → Junie → MCP
Settings instead; configuring one frontend does not qualify the others.
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
the VS Code MCP settings. A custom `COPILOT_HOME` changes that user location;
the current installer uses the default, so use declarative configuration for
that case. Record the selected harness when qualifying the connection. Existing
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
