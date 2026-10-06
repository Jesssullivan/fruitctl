# Preserve the already-published .4 artifact exactly. It is a legacy baseline,
# not a release of the current fresh-frame repair. New release hashes must come
# from the real signed/notarized artifact and its independently checked receipt.
{ lib, stdenvNoCC, fetchurl }:
let
  version = "1.0.2-tinyland.4";
  artifactSha256 = "946112b0fcf015d3964ee610a9f2114594762f1c8e82b532e244462c83377e59";
  receiptSha256 = "a50d32c8b580486028d74cea6fbd415c27048fb894748551e7c756ce3eae96ed";
in stdenvNoCC.mkDerivation {
  pname = "fruitctl-legacy-native";
  inherit version;
  src = if stdenvNoCC.hostPlatform.system == "aarch64-darwin" then fetchurl {
    url = "https://github.com/xoxd-ai/fruitctl/releases/download/daemon-v${version}/claude-kvm-daemon-${version}-darwin-arm64.tar.gz";
    hash = "sha256-J+HEfvpyoR+7ARWADMO75HW/r7+n+zTCH9ZEdRzX8xQ=";
  } else throw "Fruitctl's legacy native artifact supports aarch64-darwin only";
  sourceRoot = ".";
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin" "$out/share/fruitctl/legacy-native"
    cp claude-kvm-daemon "$out/bin/claude-kvm-daemon"
    cp receipt.json "$out/share/fruitctl/legacy-native/receipt.json"
    chmod 755 "$out/bin/claude-kvm-daemon"
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    printf '%s  %s\n' '${artifactSha256}' "$out/bin/claude-kvm-daemon" \
      '${receiptSha256}' "$out/share/fruitctl/legacy-native/receipt.json" | /usr/bin/shasum -a 256 -c -
    /usr/bin/codesign --verify --strict \
      -R='identifier "dev.tinyland.pzm-computer-use" and anchor apple generic and certificate leaf[subject.OU] = "QP994XQKNH"' \
      "$out/bin/claude-kvm-daemon"
  '';
  passthru = {
    inherit artifactSha256 receiptSha256;
    sourceRevision = "654848c2f6ee9f51d4c37684428c888da90bb883";
    containsFreshFrameRepair = false;
  };
  meta = {
    description = "Immutable historical signed Apple Silicon VNC client (.4); no current-source acceptance claim";
    homepage = "https://github.com/xoxd-ai/fruitctl";
    # The statically linked LibVNCClient distribution has GPL obligations.
    license = lib.licenses.gpl3Plus;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "claude-kvm-daemon";
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
