{ lib, buildNpmPackage, importNpmLock, nodejs, makeWrapper, src }:
let
  cleanSrc = lib.cleanSourceWith {
    inherit src;
    filter = path: _type: !(builtins.elem (builtins.baseNameOf path)
      [ ".git" "node_modules" "dist" "build" ".build" "result" ]);
  };
  metadata = builtins.fromJSON (builtins.readFile "${cleanSrc}/package.json");
in buildNpmPackage {
  pname = "fruitctl";
  version = metadata.version;
  inherit nodejs;
  src = cleanSrc;
  # Each dependency is fetched by the integrity hash in package-lock.json.
  # No package install/download occurs with a desktop credential in scope.
  npmDeps = importNpmLock { npmRoot = "${cleanSrc}"; };
  npmConfigHook = importNpmLock.npmConfigHook;
  npmFlags = [ "--ignore-scripts" ];
  npmInstallFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run test:offline
    runHook postCheck
  '';
  nativeBuildInputs = [ makeWrapper ];
  postInstall = ''
    mkdir -p "$out/bin" "$out/share/fruitctl/skills"
    # Use the pinned Node runtime rather than an ambient node from PATH.
    rm -f "$out/bin/fruitctl"
    makeWrapper ${nodejs}/bin/node "$out/bin/fruitctl" \
      --add-flags "$out/lib/node_modules/${metadata.name}/bin/fruitctl.mjs"
    cp -R "${cleanSrc}/skills/fruitctl" "$out/share/fruitctl/skills/fruitctl"
  '';
  passthru = {
    skillPath = "share/fruitctl/skills/fruitctl";
    nativePlatform = "aarch64-darwin";
  };
  meta = {
    description = "Shared VNC broker and MCP adapters; Linux controllers use an SSH Darwin bridge";
    homepage = "https://github.com/xoxd-ai/fruitctl";
    license = lib.licenses.mit;
    platforms = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
    mainProgram = "fruitctl";
  };
}
