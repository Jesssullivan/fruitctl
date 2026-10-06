fruitctlFlake:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.fruitctl;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  manifest = builtins.fromJSON (builtins.readFile "${fruitctlFlake}/integrations/agents.json");
  targetNames = builtins.attrNames cfg.targets;
  skillRoots = lib.unique (map (agent: manifest.agents.${agent}.skill.user) cfg.agents);
  nativePath = if cfg.nativePackage == null then null else "${cfg.nativePackage}/bin/claude-kvm-daemon";
  relayArgs = [ executable "relay" "--bridge" (if cfg.bridgeHost == null then "" else cfg.bridgeHost) "--socket" cfg.socketPath ]
    ++ lib.optionals (cfg.bridgeSocketPath != null) [ "--remote-socket" cfg.bridgeSocketPath ]
    ++ [ "--remote-command" cfg.bridgeCommand ];
  publicTarget = _name: target: {
    inherit (target) vnc credentialFile;
  } // lib.optionalAttrs (target.targetId != null) {
    inherit (target) targetId;
  } // lib.optionalAttrs (target.daemonPath != null || nativePath != null) {
    daemonPath = if target.daemonPath != null then target.daemonPath else nativePath;
  } // lib.optionalAttrs (target.hostHelper != null) {
    hostHelper = {
      inherit (target.hostHelper) sshHost command displayId;
    } // lib.optionalAttrs (target.hostHelper.mapping != null) {
      inherit (target.hostHelper) mapping;
    };
  };
  brokerConfig = {
    schema = "fruitctl.config.v1";
    targets = lib.mapAttrs publicTarget cfg.targets;
  };
  executable = "${cfg.package}/bin/fruitctl";
  serverEntry = target: {
    command = executable;
    args = [ "mcp" "--target" target "--socket" cfg.socketPath ];
  };
  serverEntries = builtins.listToAttrs (map (target: lib.nameValuePair "fruitctl-${target}" (serverEntry target)) targetNames);
  fragment = agent: target:
    let
      entry = serverEntry target;
      serverName = "fruitctl-${target}";
      definition = manifest.agents.${agent};
      jsonEntry = entry
        // lib.optionalAttrs (builtins.elem agent [ "claude" "vscode" ]) { type = "stdio"; };
      document = if agent == "opencode" then {
        mcp.${serverName} = { type = "local"; command = [ executable ] ++ entry.args; enabled = true; };
      } else { mcpServers.${serverName} = jsonEntry; };
    in if definition.config.format == "toml" then ''
      [mcp_servers.${builtins.toJSON serverName}]
      command = ${builtins.toJSON executable}
      args = ${builtins.toJSON entry.args}
    '' else builtins.toJSON document + "\n";
  fragments = builtins.listToAttrs (lib.concatMap (agent:
    map (target: lib.nameValuePair
      "fruitctl/agents/${agent}/${target}.${if manifest.agents.${agent}.config.format == "toml" then "toml" else "json"}"
      { text = fragment agent target; }) targetNames) cfg.agents);
  profileModule = { ... }: {
    options = {
      targetId = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
        default = null;
        description = "Optional stable physical-desktop identity on the Darwin broker. Use one profile per desktop; duplicate identities are refused.";
      };
      vnc = {
        host = lib.mkOption { type = lib.types.str; default = "127.0.0.1"; description = "Seat-side VNC address, usually an SSH tunnel loopback endpoint."; };
        port = lib.mkOption { type = lib.types.port; default = 15900; description = "Seat-side VNC port; distinct from a local Screen Sharing listener."; };
        username = lib.mkOption { type = lib.types.str; default = ""; description = "Target account name. No password is stored in configuration."; };
      };
      credentialFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Absolute runtime credential file on the Darwin controller. Use a string, never a Nix path or readFile of its contents.";
      };
      daemonPath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Absolute signed native-client path; overrides nativePackage for this target.";
      };
      hostHelper = lib.mkOption {
        default = null;
        type = lib.types.nullOr (lib.types.submodule {
          options = {
            sshHost = lib.mkOption { type = lib.types.str; description = "Existing SSH host alias for the separately installed capture/indicator helper."; };
            command = lib.mkOption { type = lib.types.listOf lib.types.str; description = "Absolute helper executable and literal arguments; no shell expression."; };
            displayId = lib.mkOption { type = lib.types.nullOr lib.types.ints.unsigned; default = null; description = "Qualified target display identifier."; };
            mapping = lib.mkOption {
              default = null;
              description = "Qualified capture-to-native input mapping. Without it the helper permits observations only.";
              type = lib.types.nullOr (lib.types.submodule {
                options = {
                  qualificationReceipt = lib.mkOption { type = lib.types.str; description = "Durable qualification receipt identifying this measured mapping."; };
                  displayId = lib.mkOption { type = lib.types.ints.positive; description = "Display identifier matching hostHelper.displayId."; };
                  nativeWidth = lib.mkOption { type = lib.types.ints.positive; description = "Qualified native framebuffer width in pixels."; };
                  nativeHeight = lib.mkOption { type = lib.types.ints.positive; description = "Qualified native framebuffer height in pixels."; };
                  scaledWidth = lib.mkOption { type = lib.types.ints.positive; description = "Qualified observation width in pixels."; };
                  scaledHeight = lib.mkOption { type = lib.types.ints.positive; description = "Qualified observation height in pixels."; };
                  displayBounds = {
                    x = lib.mkOption { type = lib.types.number; description = "Measured display origin x in points."; };
                    y = lib.mkOption { type = lib.types.number; description = "Measured display origin y in points."; };
                    width = lib.mkOption { type = lib.types.number; description = "Measured positive display width in points."; };
                    height = lib.mkOption { type = lib.types.number; description = "Measured positive display height in points."; };
                  };
                };
              });
            };
          };
        });
        description = "Optional independently qualified target capture/indicator app; no helper is installed by this module.";
      };
    };
  };
  absolute = value: value != null && lib.hasPrefix "/" value && !(lib.hasInfix "\n" value);
in {
  options.programs.fruitctl = {
    enable = lib.mkEnableOption "Fruitctl runtime, shared session service and agent skills";
    installOnly = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Install the CLI and canonical agent skills without target configuration, MCP entries, socket directories or services.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = fruitctlFlake.packages.${pkgs.stdenv.hostPlatform.system}.fruitctl;
      description = "Immutable upstream Node runtime. Linux uses an SSH Darwin bridge.";
    };
    nativePackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "An explicitly selected signed native release on Darwin. installOnly stages it without starting a broker. There is no implicit legacy fallback.";
    };
    targets = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule profileModule);
      default = { };
      description = "Operator-declared target profiles. Linux declares names only; VNC credentials and configuration live on its Darwin bridge.";
    };
    bridgeHost = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Existing SSH alias of the Darwin controller; required on Linux. Never supply a credential here.";
    };
    bridgeSocketPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Remote Darwin broker socket, if non-default. Null uses the remote user's default; it is distinct from the local Linux socket.";
    };
    bridgeCommand = lib.mkOption {
      type = lib.types.str;
      default = "fruitctl";
      description = "Remote Fruitctl executable; an absolute immutable path avoids non-interactive SSH PATH differences.";
    };
    socketPath = lib.mkOption {
      type = lib.types.str;
      default = if isDarwin
        then "${config.home.homeDirectory}/Library/Application Support/fruitctl/run/broker.sock"
        else "${config.xdg.stateHome}/fruitctl/relay.sock";
      description = "Private shared broker/relay socket on this seat. bridgeSocketPath selects a separate remote socket.";
    };
    enableService = lib.mkOption {
      type = lib.types.bool;
      default = !cfg.installOnly;
      description = "Run one shared broker on Darwin, or one SSH relay on Linux. Must be false in installOnly mode.";
    };
    agents = lib.mkOption {
      type = lib.types.listOf (lib.types.enum (builtins.attrNames manifest.agents));
      default = [ "claude" "codex" "pi" "junie" ];
      description = "Agent skill projections and MCP configuration fragments. Existing mutable agent configuration is never overwritten.";
    };
    mcpServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      readOnly = true;
      description = "Declarative MCP entries for the owning harness module to merge. Entries contain no credential values.";
    };
    configPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      description = "Controller configuration path; null when disabled or installOnly. Linux does not get a credential-bearing target document.";
    };
  };

  config = lib.mkMerge [
    {
      programs.fruitctl.mcpServers = if cfg.enable && !cfg.installOnly then serverEntries else { };
      programs.fruitctl.configPath = if !cfg.enable || cfg.installOnly then null
        else if isDarwin
        then "${config.home.homeDirectory}/Library/Application Support/fruitctl/config.json"
        else "${config.xdg.configHome}/fruitctl/config.json";
    }
    (lib.mkIf cfg.enable {
      assertions = [
        { assertion = !cfg.installOnly || !cfg.enableService; message = "Fruitctl installOnly cannot enable a broker or relay service."; }
        { assertion = !cfg.installOnly || targetNames == [ ]; message = "Fruitctl installOnly requires no targets; use controller mode for target profiles."; }
        { assertion = !cfg.installOnly || (cfg.bridgeHost == null && cfg.bridgeSocketPath == null && cfg.bridgeCommand == "fruitctl"); message = "Fruitctl installOnly cannot configure an SSH bridge."; }
        { assertion = isDarwin || cfg.nativePackage == null; message = "Fruitctl nativePackage is Darwin-only; Linux uses the portable CLI and SSH relay."; }
        { assertion = cfg.nativePackage == null || lib.meta.availableOn pkgs.stdenv.hostPlatform cfg.nativePackage; message = "Fruitctl nativePackage must support this controller's Darwin architecture."; }
      ];
      home.packages = [ cfg.package ] ++ lib.optional (isDarwin && cfg.nativePackage != null) cfg.nativePackage;
      home.file = builtins.listToAttrs (map (root: lib.nameValuePair root {
        source = "${cfg.package}/share/fruitctl/skills/fruitctl";
        recursive = true;
      }) skillRoots);
    })
    (lib.mkIf (cfg.enable && !cfg.installOnly) {
      assertions = [
        { assertion = targetNames != [ ]; message = "programs.fruitctl.targets must declare at least one profile."; }
        { assertion = builtins.all (name: builtins.match "[A-Za-z0-9][A-Za-z0-9._-]{0,127}" name != null) targetNames; message = "Fruitctl target names must be profile identifiers, not host expressions."; }
        { assertion = absolute cfg.socketPath && builtins.stringLength cfg.socketPath < 104; message = "Fruitctl socketPath must be absolute and shorter than the Darwin Unix-socket path limit (104 bytes)."; }
        { assertion = lib.hasPrefix "${config.home.homeDirectory}/" (builtins.dirOf cfg.socketPath); message = "Fruitctl's managed socket directory must be a dedicated subdirectory of this user's home."; }
        { assertion = cfg.bridgeSocketPath == null || absolute cfg.bridgeSocketPath; message = "Fruitctl bridgeSocketPath must be an absolute remote path when supplied."; }
        { assertion = cfg.bridgeCommand == "fruitctl" || absolute cfg.bridgeCommand; message = "Fruitctl bridgeCommand must be fruitctl or an absolute executable path."; }
        { assertion = isDarwin || (cfg.bridgeHost != null && cfg.bridgeHost != "" && !(lib.hasPrefix "-" cfg.bridgeHost) && !(lib.hasInfix "\n" cfg.bridgeHost)); message = "Linux Fruitctl requires an existing Darwin bridgeHost SSH alias."; }
        { assertion = isDarwin || (cfg.nativePackage == null && builtins.all (name: cfg.targets.${name}.targetId == null && cfg.targets.${name}.credentialFile == null && cfg.targets.${name}.daemonPath == null && cfg.targets.${name}.hostHelper == null && cfg.targets.${name}.vnc.username == "" && cfg.targets.${name}.vnc.host == "127.0.0.1" && cfg.targets.${name}.vnc.port == 15900) targetNames); message = "Linux declares Fruitctl target names only; configure physical identities, VNC, credentials and native clients on the Darwin bridge."; }
        { assertion = !isDarwin || builtins.all (name: absolute cfg.targets.${name}.credentialFile && absolute (if cfg.targets.${name}.daemonPath != null then cfg.targets.${name}.daemonPath else nativePath)) targetNames; message = "Each Darwin Fruitctl target requires an absolute credentialFile and a qualified daemonPath or nativePackage."; }
        { assertion = builtins.all (name: let helper = cfg.targets.${name}.hostHelper; in helper == null || (helper.sshHost != "" && builtins.length helper.command == 2 && absolute (builtins.head helper.command) && builtins.elemAt helper.command 1 == "--stdio" && helper.displayId != null && helper.displayId > 0)) targetNames; message = "Fruitctl hostHelper requires an SSH alias, [ absolute-executable --stdio ] command and positive displayId."; }
        { assertion = builtins.all (name: let helper = cfg.targets.${name}.hostHelper; mapping = if helper == null then null else helper.mapping; in mapping == null || (mapping.qualificationReceipt != "" && mapping.displayId == helper.displayId && mapping.displayBounds.width > 0 && mapping.displayBounds.height > 0)) targetNames; message = "Fruitctl hostHelper mapping requires its qualification receipt, matching displayId and positive display bounds."; }
      ];
      home.file = lib.optionalAttrs isDarwin {
        "Library/Application Support/fruitctl/config.json".text = builtins.toJSON brokerConfig + "\n";
      };
      xdg.configFile = fragments;
      home.activation.fruitctlSocketDirectory = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        $DRY_RUN_CMD mkdir -p ${lib.escapeShellArg (builtins.dirOf cfg.socketPath)}
        $DRY_RUN_CMD chmod 0700 ${lib.escapeShellArg (builtins.dirOf cfg.socketPath)}
      '';
      launchd.agents.fruitctl-broker = lib.mkIf (isDarwin && cfg.enableService) {
        enable = true;
        config = {
          Label = "ai.xoxd.fruitctl.broker";
          ProgramArguments = [ executable "broker" "--socket" cfg.socketPath "--config" cfg.configPath ];
          ProcessType = "Interactive";
          RunAtLoad = true;
          # Cleanup quarantine is process-local in the preview. A fresh broker
          # must not automatically clear it after an unconfirmed input release.
          KeepAlive = false;
        };
      };
      systemd.user.services.fruitctl-relay = lib.mkIf (!isDarwin && cfg.enableService) {
        Unit.Description = "Fruitctl SSH bridge to the Darwin desktop broker";
        Service = {
          ExecStart = lib.escapeShellArgs relayArgs;
          Restart = "no";
          TimeoutStopSec = "5s";
          UMask = "0077";
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
