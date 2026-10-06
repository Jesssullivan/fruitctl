{ pkgs, homeManagerSource, fruitctlFlake }:
let
  evaluate = system: settings:
    let
      targetPkgs = import fruitctlFlake.inputs.nixpkgs { inherit system; };
      hm = import "${homeManagerSource}/modules" {
        pkgs = targetPkgs;
        configuration = {
          imports = [ fruitctlFlake.homeManagerModules.default ];
          home.username = "fruitctl-test";
          home.homeDirectory = if targetPkgs.stdenv.hostPlatform.isDarwin then "/Users/fruitctl-test" else "/home/fruitctl-test";
          home.stateVersion = "25.05";
          programs.fruitctl = settings;
        };
      };
    in hm.config;
  linux = evaluate "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    bridgeSocketPath = "/Users/bridge/custom-fruitctl/broker.sock";
    targets.desktop = { };
    targets."second.desktop" = { };
  };
  darwin = evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      targetId = "fixture-desktop";
      credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      vnc.username = "fixture-user";
    };
  };
  nativeController = fruitctlFlake.packages.aarch64-darwin.native-controller;
  nativeDarwin = evaluate "aarch64-darwin" {
    enable = true;
    enableService = false;
    nativePackage = nativeController;
    targets.desktop.credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
  };
  disabledDarwin = evaluate "aarch64-darwin" { };
  # Only this evaluator fixture discards dependency context before JSON parsing.
  nativeDocument = builtins.fromJSON (builtins.unsafeDiscardStringContext
    nativeDarwin.home.file."Library/Application Support/fruitctl/config.json".text);
  helperDarwin = evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      hostHelper = {
        sshHost = "fixture-target";
        command = [ "/Users/fixture/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost" "--stdio" ];
        displayId = 7;
        mapping = {
          qualificationReceipt = "fixture/owned-capture-mapping.json";
          displayId = 7;
          nativeWidth = 3840;
          nativeHeight = 2160;
          scaledWidth = 1920;
          scaledHeight = 1080;
          displayBounds = { x = -1920; y = 0; width = 1920; height = 1080; };
        };
      };
    };
  };
  helperDocument = builtins.fromJSON helperDarwin.home.file."Library/Application Support/fruitctl/config.json".text;
  linuxRelay = linux.systemd.user.services.fruitctl-relay.Service;
  darwinBroker = darwin.launchd.agents.fruitctl-broker.config;
  linuxFiles = linux.xdg.configFile;
  # Drop derivation context only in the evaluator fixture to inspect JSON keys.
  # The installed fragments retain their immutable runtime dependencies.
  desktopFragment = builtins.fromJSON (builtins.unsafeDiscardStringContext linuxFiles."fruitctl/agents/claude/desktop.json".text);
  secondFragment = builtins.fromJSON (builtins.unsafeDiscardStringContext linuxFiles."fruitctl/agents/claude/second.desktop.json".text);
  darwinDocument = builtins.fromJSON darwin.home.file."Library/Application Support/fruitctl/config.json".text;
  credentialRejected = !(builtins.tryEval (evaluate "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    targets.desktop.credentialFile = "/home/fruitctl-test/private/password";
  }).programs.fruitctl.mcpServers).success;
  missingBridgeRejected = !(builtins.tryEval (evaluate "x86_64-linux" {
    enable = true;
    targets.desktop = { };
  }).programs.fruitctl.mcpServers).success;
  noProfilesRejected = !(builtins.tryEval (evaluate "aarch64-darwin" {
    enable = true;
  }).programs.fruitctl.mcpServers).success;
  skillRoots = builtins.filter (path: pkgs.lib.hasSuffix "skills/fruitctl" path) (builtins.attrNames linux.home.file);
in
assert builtins.attrNames fruitctlFlake.packages.aarch64-darwin == [ "default" "fruitctl" "legacy-native" "native-controller" "proxy" "runtime" ];
assert builtins.all (system: !(builtins.hasAttr "native-controller" fruitctlFlake.packages.${system})) [ "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
assert nativeController.dontBuild && nativeController.dontFixup && nativeController.dontStrip;
assert nativeController.containsHost == false;
assert nativeController.releaseMetadata.notarization.status == "Accepted";
assert nativeDocument.targets.desktop.daemonPath == "${nativeController}/bin/claude-kvm-daemon";
assert !(nativeDocument.targets.desktop ? hostHelper);
assert builtins.elem nativeController.drvPath (map (package: package.drvPath) nativeDarwin.home.packages);
assert !(nativeDarwin.launchd.agents ? fruitctl-broker);
assert !disabledDarwin.programs.fruitctl.enable && disabledDarwin.programs.fruitctl.nativePackage == null;
assert linux.programs.fruitctl.nativePackage == null;
assert !(builtins.hasAttr "fruitctl/config.json" linuxFiles);
assert linuxRelay.Restart == "no";
assert darwinBroker.KeepAlive == false;
assert pkgs.lib.hasInfix "--remote-socket /Users/bridge/" (builtins.head linuxRelay.ExecStart);
assert !(pkgs.lib.hasInfix "credential" (builtins.toJSON linux.programs.fruitctl.mcpServers));
assert builtins.attrNames (desktopFragment.mcpServers // secondFragment.mcpServers) == [ "fruitctl-desktop" "fruitctl-second.desktop" ];
assert pkgs.lib.hasInfix ''[mcp_servers."fruitctl-second.desktop"]'' linuxFiles."fruitctl/agents/codex/second.desktop.toml".text;
assert darwinDocument.schema == "fruitctl.config.v1";
assert darwinDocument.targets.desktop.targetId == "fixture-desktop";
assert darwinDocument.targets.desktop.credentialFile == "/Users/fruitctl-test/.config/private/desktop-password";
assert helperDocument.targets.desktop.hostHelper.mapping.displayBounds.x == -1920;
assert helperDocument.targets.desktop.hostHelper.mapping.nativeWidth == 3840;
assert helperDocument.targets.desktop.hostHelper.mapping.qualificationReceipt == "fixture/owned-capture-mapping.json";
assert darwinBroker.ProgramArguments == [ "${darwin.programs.fruitctl.package}/bin/fruitctl" "broker" "--socket" "/Users/fruitctl-test/Library/Application Support/fruitctl/run/broker.sock" "--config" "/Users/fruitctl-test/Library/Application Support/fruitctl/config.json" ];
assert builtins.elem ".agents/skills/fruitctl" skillRoots && builtins.elem ".claude/skills/fruitctl" skillRoots && builtins.elem ".junie/skills/fruitctl" skillRoots;
assert credentialRejected && missingBridgeRejected && noProfilesRejected;
pkgs.runCommand "fruitctl-home-manager-contract" { } ''
  # Configuration assertions above run at evaluation, without native builds,
  # credential reads, SSH, service startup or a Home Manager switch.
  touch "$out"
''
