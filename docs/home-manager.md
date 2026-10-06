# Home Manager consumption

Fruitctl owns the runtime and canonical skill. Your infrastructure repository
owns host profiles, SSH access, credential providers, service enablement and
agent configuration. Pin a full Fruitctl commit in `flake.lock`; a moving
`main` URL is a discovery link, not an installation receipt.

The flake exports `packages.<system>.fruitctl` (`default`, `runtime` and `proxy`
aliases), `homeManagerModules.default`, `overlays.default`, and the canonical skill at
`share/fruitctl/skills/fruitctl`. The Node package is available for ARM and x86
Darwin/Linux evaluation. This does not qualify a native VNC client on every
platform: the historical native artifact is Apple Silicon Darwin only.

```nix
inputs.fruitctl.url = "github:xoxd-ai/fruitctl/<full-commit-sha>";

# In the Home Manager module list:
imports = [ inputs.fruitctl.homeManagerModules.default ];
```

## Darwin controller

`programs.fruitctl` is the public module namespace. A Darwin controller runs
one shared broker. Credentials remain runtime files on that controller;
neither Nix evaluation nor the Linux relay reads their contents.

```nix
{ config, ... }: {
  programs.fruitctl = {
    enable = true;
    agents = [ "claude" "codex" "pi" "junie" ];
    targets.desktop = {
      targetId = "office-desktop";
      vnc = { host = "127.0.0.1"; port = 15900; username = "alex"; };
      credentialFile = "${config.home.homeDirectory}/.config/fruitctl/secrets/desktop";
      daemonPath = "${config.home.homeDirectory}/.local/share/fruitctl/native/claude-kvm-daemon";
    };
  };
}
```

The example paths must already contain a privately provisioned credential and
a qualified signed native client. A separately packaged native release can
instead be selected with `nativePackage`; its executable must be
`bin/claude-kvm-daemon`. No native release is selected implicitly. Keep credential
paths as strings: a Nix path literal or `builtins.readFile` would copy secret
material into the store. Do not put a password in a target profile, agent
configuration, activation command or environment definition.

The module writes the `fruitctl.config.v1` target document under
`~/Library/Application Support/fruitctl/config.json` and supplies an Aqua-user launch agent,
`ai.xoxd.fruitctl.broker`. `enableService = false` installs the configuration
without starting a service. The broker uses a private Unix socket below the
user's state directory. It does not enable
Screen Sharing, grant TCC, install the host indicator, or create an SSH tunnel.
Those prerequisites retain their existing owners.

An optional `targets.<profile>.targetId` records a stable physical-desktop
identity. Use one profile per desktop. The broker rejects duplicate explicit
identities, duplicate configured VNC endpoints (including known loopback
aliases), and reused helper SSH hosts. Different tunnel ports or SSH aliases
can still reach the same machine, so assign its physical identity explicitly;
the broker does not infer arbitrary network aliases.

An optional `targets.<profile>.hostHelper` selects an already installed target
app by `sshHost`, exact `command = [ "<absolute-app-executable>" "--stdio" ]`,
and positive `displayId`. Its optional `mapping` carries the measured
`qualificationReceipt`, matching `displayId`, native/scaled pixel dimensions
and `displayBounds = { x; y; width; height; }` in points. The broker permits
owned observations without a mapping; input requires the independently
qualified mapping. Home Manager does not create a qualification receipt or
infer display geometry.

`packages.aarch64-darwin.legacy-native` consumes the existing
`daemon-v1.0.2-tinyland.4` asset as immutable bytes. It checks the archive,
binary and receipt hashes, expected signing identifier and Developer ID team,
and disables binary fixups/stripping. It is a historical diagnostic baseline;
it **does not include the current fresh-frame repair**. Selecting it explicitly
does not qualify a new Fruitctl release. A new native package must use hashes
from the actual rebuilt, signed, notarized artifact and checked receipt.

## Linux SSH controller

Linux runs the portable Node relay and attaches to the existing Darwin broker
over SSH. Declare profile names only. The Darwin broker resolves those names
to its own VNC connection and credential files.

```nix
{
  programs.fruitctl = {
    enable = true;
    bridgeHost = "desktop-controller"; # Existing SSH config alias.
    # Prefer the immutable executable selected by the bridge's HM generation:
    bridgeCommand = "/nix/store/<qualified-runtime>/bin/fruitctl";
    targets.desktop = { };
  };
}
```

`bridgeCommand` defaults to `fruitctl` when the remote non-interactive PATH is
already correct. `bridgeSocketPath = null` uses the remote user's default
socket (`~/Library/Application Support/fruitctl/run/broker.sock` on Darwin);
set an absolute remote path only when the bridge uses a custom socket.
The local `socketPath` is separate, so Linux `/home/...` and Darwin `/Users/...`
paths never need to match. The systemd user service stays foreground, owns one
persistent SSH attachment and stops within five seconds. SSH host keys and
authentication remain owned by your SSH
configuration. Linux gets no broker credential document and no native package.

The preview disables automatic restart on both platforms: Darwin uses
`KeepAlive = false`, and Linux uses `Restart = "no"`. Recovery is an operator-owned
action. If owned input cleanup is unconfirmed, reconcile the target and verify
held input is cleared before restarting the broker or relay. The broker's
quarantine is process-local; restarting it does not prove cleanup succeeded.

This is the initial Rocky/Linux architecture. A passing Nix evaluation proves
configuration shape; an initialize, changing-frame capture and control journey
over the selected bridge is required for runtime qualification.

## Agent configuration and skills

The module reads the same `integrations/agents.json` manifest as the public
installer. It links the canonical skill to each selected agent's current
user skill root, de-duplicating shared `.agents/skills/fruitctl` destinations.
Claude uses `.claude/skills/fruitctl`; Junie uses `.junie/skills/fruitctl`.

MCP fragments are written under
`~/.config/fruitctl/agents/<agent>/<profile>.json` (Codex uses `.toml`). Each
starts `fruitctl mcp --target <profile> --socket <local-socket>`; the command
cannot select arbitrary hosts or read target credentials. Its server name is
`fruitctl-<profile>`, so fragments for multiple profiles can be merged without
replacing one another. Merge a fragment
through the module that already owns that agent's configuration, or use the
read-only `config.programs.fruitctl.mcpServers` attribute set. Home Manager
does not silently overwrite existing Claude, Codex, Junie or Pi configuration.

Junie's `~/.junie/mcp/mcp.json` is mutable because Junie writes enabled state.
Preserve unknown servers and operator toggles when merging. IntelliJ's
integrated AI Assistant configuration uses its documented settings interface;
a Junie CLI entry is not evidence that the integrated IDE client is enabled.
Pi native MCP requires the version recorded in the agent manifest. A rendered
fragment or skill link is configuration evidence, not a successful agent
desktop journey.

For fleet adoption, preserve existing server/tool names and policies in the
owning infrastructure module while replacing its runtime/skill source with
this pinned package. Validate package evaluation, target selection, secret
absence from generated agent files, and service argv before an attended switch.
No public configuration imports a fleet host inventory or private transcript.
