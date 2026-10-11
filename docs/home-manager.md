# Home Manager consumption

Fruitctl owns the runtime and canonical skill. Your infrastructure repository
owns host profiles, SSH access, credential providers, service enablement and
agent configuration. Pin a full Fruitctl commit in `flake.lock`; a moving
`main` URL is a discovery link, not an installation receipt.

The flake exports `packages.<system>.fruitctl` (`default`, `runtime` and `proxy`
aliases), `homeManagerModules.default`, `overlays.default`, and the canonical skill at
`share/fruitctl/skills/fruitctl`. The Node package is available for ARM and x86
Darwin/Linux evaluation. `packages.aarch64-darwin.native-controller` supplies
the released alpha.3 signed controller; native VNC control is Apple Silicon
Darwin only. Linux uses the SSH bridge. The Host prototype has no public package
export or runtime payload.

```nix
inputs.fruitctl.url = "github:xoxd-ai/fruitctl/cd34bbcdcc9e70bf25f77cbcfd1f129e1eac30db";

# In the Home Manager module list:
imports = [ inputs.fruitctl.homeManagerModules.default ];
```

This tested alpha.7 source pin includes the portable runtime, skill and
qualification helpers. Its Linux leaf package passed 556 of 557 offline
tests on October 10, 2026, under Node 24.21.0; one declared real-curl test was
skipped because curl was unavailable.

An October 10 managed delivery also passed through the infrastructure's normal
Home Manager canary and follower path. The canary's Fruitctl consumer stayed
disabled; one enabled Linux seat received the alpha.7 package, three skill
roots and four generated MCP fragments, with its relay service disabled. A
fresh login resolved the selected executable, and installed package metadata
reported `0.1.0-alpha.7`. A limited read-only follow-up on October 11 confirmed
the same installed version and skill/fragment files on that seat. These are
dated package and delivery observations; they do not qualify an agent frontend,
a Darwin Home Manager installation, target control or new native artifacts.

Repin reviewed code changes after their own package check. Documentation-only
commits may advance `main` without changing the last tested code-source pin.
Earlier package evidence for
`e599109df9b75fdec3e483b5e2f1b874db22f37f` and delivery records for
`2bf0e4b545123f700a344aa05c29d43854cb413e` remain historical; their acceptance
does not transfer to this pin.

The public [alpha.7 runtime](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.7)
uses producer `cd34bbcdcc9e70bf25f77cbcfd1f129e1eac30db`. The earlier immutable
alpha.6 runtime producer `8653325c6ccc0e058b3e4cf84eb44101cfd270fc` remains a
historical packaging record. Every consumer's final pin, package realization
and Home Manager activation need their own recorded checks; changing this
example does not upgrade a published runtime archive.
The explicitly selected `native-controller` package separately consumes the
immutable alpha.3 controller produced from
`e00fcc86bbac4247d5a0847d7e656369c52cc15f`. Advancing the source pin does not
rebuild, patch or re-sign those released bytes. Alpha.7's Darwin runtime also
reuses that native payload; its newer portable-source revision does not change
the controller's original source or Apple submission.

## CLI and skills installation

Install the portable CLI and selected agents' canonical skills before declaring
a desktop connection:

```nix
programs.fruitctl = {
  enable = true;
  installOnly = true;
  agents = [ "claude" "codex" "pi" "junie" ];
};
```

This mode needs no target, credential file or SSH bridge on Darwin or Linux.
It installs the Node package and skill links, with no broker configuration,
MCP fragments, socket directory or service. `enableService` defaults to false
in this mode; explicitly enabling it, declaring targets or setting bridge
options is rejected. `mcpServers` is empty and `configPath` is null.

An explicitly selected `nativePackage` may also be staged on its supported
Darwin architecture. It stays null by default and is rejected on Linux or an
incompatible Darwin architecture; installation starts no native process
and grants no target access or macOS permissions. Selecting the published
controller verifies distribution integrity, without qualifying a desktop
connection or an agent frontend.

To configure a connection, set `installOnly = false` (its default) and declare
the controller prerequisites below. `enableService = false` in controller mode
still writes connection configuration and MCP fragments while withholding the
service. This allows an operator to inspect the complete configuration before
a separate activation.

## Darwin controller

`programs.fruitctl` is the public module namespace. A Darwin controller runs
one shared broker. Credentials remain runtime files on that controller;
neither Nix evaluation nor the Linux relay reads their contents.

```nix
{ config, inputs, ... }: {
  programs.fruitctl = {
    enable = true;
    enableService = false; # Install packages/configuration before starting a broker.
    nativePackage = inputs.fruitctl.packages.aarch64-darwin.native-controller;
    agents = [ "claude" "codex" "pi" "junie" ];
    targets.desktop = {
      targetId = "office-desktop";
      vnc = { host = "127.0.0.1"; port = 15900; username = "alex"; };
      credentialFile = "${config.home.homeDirectory}/.config/fruitctl/secrets/desktop";
    };
  };
}
```

The credential path must already contain a privately provisioned credential.
The selected `nativePackage` supplies `bin/claude-kvm-daemon`; alternatively, an
absolute `targets.<profile>.daemonPath` selects an independently provisioned
client. The module defaults off and `nativePackage` defaults to null, so no
native release or service is selected implicitly. The existing target Screen
Sharing service and controller-side SSH tunnel must be established separately.
Keep credential
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

The optional Host/indicator remains a private prototype until its exact
capture mode passes background and indicator-exclusion qualification. Alpha.7
ships no Host app, ZIP, package export, service or helper mapping. The existing
`targets.<profile>.hostHelper` option remains available for independently
qualified private work and defaults to null; configuring it does not install or
start an app. Home Manager never creates a qualification receipt or infers
display geometry.

The `native-controller` package extracts only the unchanged signed controller
from the [alpha.3 Darwin runtime](https://github.com/xoxd-ai/fruitctl/releases/tag/v0.1.0-alpha.3).
Its output contains `bin/claude-kvm-daemon`, the native notices and curated
release metadata; the separate Node package owns `bin/fruitctl`. Archive,
executable and notice hashes, archive file modes, ARM64 linkage and the strict
Developer ID signature are checked. Nix makes store files read-only, so the
archive executable mode `0755` need not remain unchanged in the store; the
executable bytes and signature remain unchanged. Fixups, stripping and
re-signing are disabled.
The exact artifact and corresponding-source bindings live in
[`nix/native-release.json`](../nix/native-release.json), which remains the
historical alpha.3 controller input. The public alpha.7 runtime inventory is a
separate packaging record. Apple returned `Accepted`
for the original controller-ZIP submission; that does not notarize the complete
runtime archive. The command-line tool is not stapled. These checks do not
qualify real VNC authentication, target pixels/input mapping, an agent frontend,
the Linux bridge journey or product SLOs.

`packages.aarch64-darwin.legacy-native` consumes the existing
`daemon-v1.0.2-tinyland.4` asset as immutable bytes. It checks the archive,
binary and receipt hashes, expected signing identifier and Developer ID team,
and disables binary fixups/stripping. It is a historical diagnostic baseline;
it **does not include the current fresh-frame repair**. Selecting it explicitly
does not qualify a new Fruitctl release. It remains separate from the explicitly
selected alpha.3 `native-controller` package.

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
