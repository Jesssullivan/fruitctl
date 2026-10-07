# Extract only the released controller from its verified Darwin runtime. The
# Node package remains the owner of fruitctl; signed bytes are never rewritten.
{ lib, stdenvNoCC, fetchurl, python3 }:
let
  release = builtins.fromJSON (builtins.readFile ./native-release.json);
  controller = release.controller;
in
assert release.schema == "fruitctl.nix-native-release.v1";
assert release.repository == "xoxd-ai/fruitctl";
assert controller.archivePath == "bin/claude-kvm-daemon";
assert controller.architecture == "arm64";
assert release.notarization.status == "Accepted";
assert release.verifiedScopes.hostShipped == false;
stdenvNoCC.mkDerivation {
  pname = "fruitctl-native-controller";
  version = release.version;
  src = if stdenvNoCC.hostPlatform.system == "aarch64-darwin" then fetchurl {
    inherit (release.runtimeArchive) url hash;
  } else throw "Fruitctl's native controller supports aarch64-darwin only";
  sourceRoot = ".";
  nativeBuildInputs = [ python3 ];
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    ${python3}/bin/python3 - <<'PY'
    import hashlib, json, os, shutil, stat
    from pathlib import Path
    release = json.loads(Path('${./native-release.json}').read_text())
    output = Path(os.environ['out'])
    def checked(path, expected):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size != expected['bytes']:
            raise ValueError('Released controller/notice is not the expected regular file')
        if hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != expected['sha256']:
            raise ValueError('Released controller/notice bytes changed')
        return info
    binary = Path(release['controller']['archivePath'])
    info = checked(binary, release['controller'])
    if stat.S_IMODE(info.st_mode) != release['controller']['mode']:
        raise ValueError('Released controller mode changed')
    if Path('libexec/FruitctlHost.app').exists() or Path('Applications/FruitctlHost.app').exists():
        raise ValueError('Controller-only release unexpectedly includes Host')
    (output / 'bin').mkdir(parents=True)
    shutil.copy2(binary, output / 'bin/claude-kvm-daemon')
    evidence = output / 'share/fruitctl/native-controller'
    for relative, expected in release['noticeFiles'].items():
        source = Path(relative)
        checked(source, expected)
        target = evidence / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    shutil.copyfile('${./native-release.json}', evidence / 'native-release.json')
    PY
    runHook postInstall
  '';
  doInstallCheck = true;
  installCheckPhase = ''
    ${python3}/bin/python3 - <<'PY'
    import hashlib, json, os, stat, subprocess
    from pathlib import Path
    release = json.loads(Path('${./native-release.json}').read_text())
    output = Path(os.environ['out'])
    binary = output / 'bin/claude-kvm-daemon'
    expected = release['controller']
    info = binary.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_size != expected['bytes']
            or stat.S_IMODE(info.st_mode) != expected['mode']
            or hashlib.file_digest(binary.open('rb'), 'sha256').hexdigest() != expected['sha256']):
        raise ValueError('Nix installation changed signed controller bytes or mode')
    if sorted(path.name for path in (output / 'bin').iterdir()) != ['claude-kvm-daemon']:
        raise ValueError('Native output must not duplicate the Node runtime')
    if subprocess.check_output(['/usr/bin/lipo', '-archs', binary], text=True).strip() != 'arm64':
        raise ValueError('Native controller architecture changed')
    dependencies = subprocess.check_output(['/usr/bin/otool', '-L', binary], text=True).splitlines()[1:]
    if any(not line.strip().split()[0].startswith(('/System/Library/', '/usr/lib/')) for line in dependencies):
        raise ValueError('Native controller has a non-system dynamic dependency')
    requirement = ('identifier "' + expected['signingIdentifier'] + '" and anchor apple generic '
                   'and certificate leaf[subject.OU] = "' + expected['developerIDTeam'] + '"')
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', '-R=' + requirement, binary], check=True)
    prefix = Path(os.environ['TMPDIR']) / 'fruitctl-controller-certificate-'
    subprocess.run(['/usr/bin/codesign', '--display', '--extract-certificates=' + str(prefix), binary], check=True)
    if hashlib.sha1(Path(str(prefix) + '0').read_bytes()).hexdigest().upper() != expected['certificateSha1']:
        raise ValueError('Controller signing certificate differs from the released artifact')
    PY
  '';
  passthru = {
    sourceRevision = release.sourceRevision;
    artifactSha256 = controller.sha256;
    releaseMetadata = release;
    containsFreshFrameRepair = true;
    containsHost = false;
  };
  meta = {
    description = "Immutable signed Apple Silicon VNC controller from Fruitctl alpha.3";
    homepage = "https://github.com/xoxd-ai/fruitctl";
    license = lib.licenses.gpl3Plus;
    platforms = [ "aarch64-darwin" ];
    mainProgram = "claude-kvm-daemon";
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
