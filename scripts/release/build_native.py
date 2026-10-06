#!/usr/bin/env python3
"""Regenerate native inputs and build/test in an exclusively owned Darwin directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LOCK = ROOT / "release/native-dependencies.lock.json"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def find_tool(name):
    found = shutil.which(name)
    if found:
        return found
    for prefix in ("/opt/homebrew/bin", "/usr/local/bin"):
        path = Path(prefix) / name
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    raise ValueError("required build tool is not installed: " + name)


def download(entry, path):
    with urllib.request.urlopen(entry["url"], timeout=120) as response, path.open("xb") as output:
        shutil.copyfileobj(response, output)
    if digest(path) != entry["sha256"] or ("bytes" in entry and path.stat().st_size != entry["bytes"]):
        raise ValueError("upstream download does not match the reviewed source lock")


def extract(path, destination):
    destination.mkdir()
    with tarfile.open(path) as archive:
        for entry in archive.getmembers():
            relative = Path(entry.name)
            if relative.is_absolute() or ".." in relative.parts or not (entry.isfile() or entry.isdir()):
                raise ValueError("unsafe source archive entry")
        archive.extractall(destination)
    directories = list(destination.iterdir())
    if len(directories) != 1 or not directories[0].is_dir():
        raise ValueError("source archive must contain one root directory")
    return directories[0]


def source_inventory():
    files = {}
    for directory in (ROOT / "ClaudeKVM-Daemon", ROOT / "FruitctlHost", ROOT / "Tests", ROOT / "test"):
        if directory.exists():
            for path in sorted(directory.rglob("*")):
                if path.is_file() and not path.is_symlink() and (directory.name not in ("Tests", "test") or path.suffix == ".swift"):
                    files[path.relative_to(ROOT).as_posix()] = digest(path)
    files["project.yml"] = digest(ROOT / "project.yml")
    return files



PUBLIC_OPENSSL_PREFIX = "/opt/fruitctl"


def dependency_build_configuration():
    # Cache identity concerns library construction, independent of the later
    # executable stripping policy and a particular private workspace path.
    return {"version": 1, "architecture": "arm64", "minimumMacOS": "15.0",
            "openssl": {"prefix": PUBLIC_OPENSSL_PREFIX, "openssldir": PUBLIC_OPENSSL_PREFIX + "/ssl",
                        "libdir": "lib", "configureOptions": ["darwin64-arm64-cc", "no-shared", "no-module", "no-tests"],
                        "privateInstallStage": "${BUILD_ROOT}/openssl-stage", "compilerFlagsPolicy": "path-free",
                        "compilerFlags": ["-mmacosx-version-min=15.0"]},
            "libvncCompilerPathMapPolicy": {"source": "/fruitctl/source", "build": "/fruitctl/build",
                                      "cOptions": ["-ffile-prefix-map", "-fdebug-prefix-map"]},
            "libvncclient": {"target": "vncclient", "shared": False, "tls": "static-openssl"}}


def dependency_configuration_sha256():
    return hashlib.sha256(json.dumps(dependency_build_configuration(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def verify_reusable_dependency_configuration(receipt, manifest):
    for value in (receipt, manifest):
        if (value.get("dependencyBuildConfiguration") != dependency_build_configuration()
                or value.get("dependencyBuildConfigurationSha256") != dependency_configuration_sha256()):
            raise ValueError("reused native dependencies lack the exact public dependency build configuration")


def c_path_maps(output):
    return [option + "=" + str(path) + "=" + replacement
            for option in ("-ffile-prefix-map", "-fdebug-prefix-map")
            for path, replacement in ((ROOT, "/fruitctl/source"), (output, "/fruitctl/build"))]


def build_openssl(openssl, output, run, jobs):
    openssl_stage = output / "openssl-stage"
    prefix = openssl_stage / PUBLIC_OPENSSL_PREFIX.lstrip("/")
    openssl_build = output / "openssl-build"
    openssl_build.mkdir()
    # OpenSSL exposes configured compiler flags through OPENSSL_CFLAGS.
    # Absolute prefix-map arguments would recreate the private path leak.
    run(["perl", openssl / "Configure", "darwin64-arm64-cc", "no-shared", "no-module", "no-tests",
         "--prefix=" + PUBLIC_OPENSSL_PREFIX, "--openssldir=" + PUBLIC_OPENSSL_PREFIX + "/ssl", "--libdir=lib",
         "-mmacosx-version-min=15.0"], openssl_build, "openssl-configure")
    run(["make", "-j" + str(jobs), "build_sw"], openssl_build, "openssl-build")
    run(["make", "DESTDIR=" + str(openssl_stage), "install_sw"], openssl_build, "openssl-install")
    return prefix

def prepare_dependencies(output, run, jobs, sdk, cmake):
    sources = json.loads(LOCK.read_text())
    openssl_archive = output / "downloads/openssl.tar.gz"
    libvnc_archive = output / "downloads/libvnc.tar.gz"
    download(sources["openssl"], openssl_archive)
    download(sources["libvncclient"], libvnc_archive)
    openssl = extract(openssl_archive, output / "openssl-source")
    libvnc = extract(libvnc_archive, output / "libvnc-source")
    for patch in sources["libvncclient"]["patches"]:
        patch_path = output / "downloads" / (patch["commit"] + ".patch")
        download(patch, patch_path)
        run(["git", "apply", "--check", patch_path], cwd=libvnc, label="check-" + patch["commit"][:8])
        run(["git", "apply", patch_path], cwd=libvnc, label="apply-" + patch["commit"][:8])
    prefix = build_openssl(openssl, output, run, jobs)
    native = output / "native-inputs"
    (native / "lib").mkdir(parents=True)
    shutil.copytree(prefix / "include", native / "include", symlinks=False)
    for name in ("libssl.a", "libcrypto.a"):
        shutil.copy2(prefix / "lib" / name, native / "lib" / name)
    libvnc_build = output / "libvnc-build"
    options = ["-D" + key + "=OFF" for key in ("BUILD_SHARED_LIBS", "WITH_GNUTLS", "WITH_GCRYPT", "WITH_JPEG", "WITH_PNG", "WITH_LZO",
                "WITH_SDL", "WITH_GTK", "WITH_LIBSSHTUNNEL", "WITH_SYSTEMD", "WITH_FFMPEG", "WITH_WEBSOCKETS", "WITH_SASL", "WITH_XCB",
                "WITH_EXAMPLES", "WITH_TESTS", "WITH_QT")]
    run([cmake, "-S", libvnc, "-B", libvnc_build, "-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_BUILD_TYPE=Release",
         "-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0", "-DCMAKE_OSX_SYSROOT=" + sdk,
         "-DCMAKE_C_FLAGS=" + " ".join(c_path_maps(output)),
         "-DOPENSSL_ROOT_DIR=" + str(prefix), "-DOPENSSL_USE_STATIC_LIBS=TRUE", "-DOPENSSL_SSL_LIBRARY=" + str(prefix / "lib/libssl.a"),
         "-DOPENSSL_CRYPTO_LIBRARY=" + str(prefix / "lib/libcrypto.a"), "-DOPENSSL_INCLUDE_DIR=" + str(prefix / "include"),
         "-DZLIB_LIBRARY=" + sdk + "/usr/lib/libz.tbd", "-DZLIB_INCLUDE_DIR=" + sdk + "/usr/include", *options], label="libvnc-configure")
    run([cmake, "--build", libvnc_build, "--target", "vncclient", "--parallel", str(jobs)], label="libvnc-build")
    shutil.copy2(libvnc_build / "libvncclient.a", native / "lib/libvncclient.a")
    (native / "include/rfb").mkdir()
    for name in ("keysym.h", "threading.h", "rfb.h", "rfbclient.h", "rfbproto.h", "rfbregion.h"):
        shutil.copy2(libvnc / "include/rfb" / name, native / "include/rfb" / name)
    shutil.copy2(libvnc_build / "include/rfb/rfbconfig.h", native / "include/rfb/rfbconfig.h")
    (native / "include/CLibVNCClient.h").write_text("// SPDX-License-Identifier: MIT\n#include <rfb/rfbclient.h>\n")
    (native / "module.modulemap").write_text('module CLibVNCClient [system] { umbrella header "include/CLibVNCClient.h" link "vncclient" link "z" link "pthread" export * }\n')
    files = {}
    for path in sorted(native.rglob("*")):
        if path.is_file():
            files[path.relative_to(native).as_posix()] = {"sha256": digest(path), "bytes": path.stat().st_size}
            path.chmod(0o444)
    for path in sorted(native.rglob("*"), reverse=True):
        if path.is_dir():
            path.chmod(0o555)
    native.chmod(0o555)
    manifest = output / "native-input-manifest.json"
    write_json(manifest, {"schemaVersion": 1, "kind": "fruitctl-native-inputs", "platform": "darwin", "architecture": "arm64",
                          "minimumMacOS": "15.0", "sourceLockSha256": digest(LOCK), "files": files,
                          "dependencyBuildConfiguration": dependency_build_configuration(),
                          "dependencyBuildConfigurationSha256": dependency_configuration_sha256()})
    manifest.chmod(0o444)
    return native, manifest



def verify_public_native_binary(path):
    """Reject private build paths anywhere in the bytes admitted to distribution."""
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.resolve(strict=True) != path:
        raise ValueError("native artifact must be a canonical regular file")
    data = path.read_bytes()
    if not data:
        raise ValueError("native artifact must not be empty")
    markers = (b"/Users/", b"/home/", b"fruitctl-builds/")
    if any(marker in data for marker in markers):
        raise ValueError("native artifact contains private workspace paths: " + path.name)
    return {"sha256": digest(path), "bytes": len(data), "privateWorkspacePathsAbsent": True}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--jobs", type=int, default=2, choices=(1, 2))
    parser.add_argument("--reuse-inputs", help="Reuse a verified task-owned dependency build; never rebuild its libraries")
    parser.add_argument("--build-scheme", action="append", default=[])
    parser.add_argument("--test-scheme", action="append", default=[])
    parser.add_argument("--source-revision", help="Git revision of the reviewed source snapshot when .git is not transferred")
    parser.add_argument("--build-ready-file", help="Wait for this task-owned marker after dependencies, before freezing source and compiling")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise ValueError("native builds require a Darwin arm64 build host; Linux uses the SSH bridge")
    output = Path(args.output_dir)
    if not output.is_absolute() or output.resolve() != output or output == Path.home() or output in Path.home().parents:
        raise ValueError("output must be a canonical task-owned directory, not a home root or ancestor")
    output.mkdir(parents=True, exist_ok=False)
    (output / "logs").mkdir()
    (output / "downloads").mkdir()
    cmake, xcodegen = find_tool("cmake"), find_tool("xcodegen")
    sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
    env = os.environ.copy()
    env.update(SDKROOT=sdk, MACOSX_DEPLOYMENT_TARGET="15.0", ZERO_AR_DATE="1")
    receipt = {"schemaVersion": 1, "kind": "fruitctl-native-build", "status": "running",
               "architecture": "arm64", "minimumMacOS": "15.0", "nativeLicense": "GPL-3.0-or-later",
               "componentLicenses": {"claude-kvm-daemon": "GPL-3.0-or-later", "FruitctlHost.app": "MIT"},
               "sourceLockSha256": digest(LOCK), "commands": [], "startedAtUnix": int(time.time()),
               "dependencyBuildConfiguration": dependency_build_configuration(),
               "dependencyBuildConfigurationSha256": dependency_configuration_sha256(),
               "nativeArtifactPolicy": {"stripDebugArguments": ["-S"], "swiftPathMapOptions": ["-file-prefix-map", "-debug-prefix-map"],
                                        "sourceReplacement": "/fruitctl/source", "buildReplacement": "/fruitctl/build"},
               "tools": {}, "tests": [], "qualification": "not-publicly-qualified"}
    for name, command in {"xcode": ["xcodebuild", "-version"], "clang": ["xcrun", "clang", "--version"],
                          "cmake": [cmake, "--version"], "xcodegen": [xcodegen, "--version"],
                          "macOS": ["sw_vers", "-productVersion"]}.items():
        receipt["tools"][name] = subprocess.check_output(command, text=True).strip()
    receipt["sourceRevision"] = args.source_revision or subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if not receipt["sourceRevision"] or any(c not in "0123456789abcdef" for c in receipt["sourceRevision"]) or len(receipt["sourceRevision"]) != 40:
        raise ValueError("source revision must be a full Git commit; sourceTreeSha256 separately identifies working changes")

    def run(command, cwd=ROOT, label=None):
        label = label or "step-" + str(len(receipt["commands"]) + 1)
        portable = [str(argument).replace(str(output), "${BUILD_ROOT}").replace(str(ROOT), "${SOURCE_ROOT}") for argument in command]
        receipt["commands"].append({"label": label, "argv": portable})
        write_json(output / "build-receipt.json", receipt)
        with (output / "logs" / (label + ".log")).open("w") as log:
            subprocess.run([str(argument) for argument in command], cwd=cwd, env=env,
                           stdout=log, stderr=subprocess.STDOUT, check=True)

    try:
        if args.reuse_inputs:
            dependency = Path(args.reuse_inputs)
            if not dependency.is_absolute() or dependency.resolve(strict=True) != dependency:
                raise ValueError("reused build directory must be absolute and canonical")
            native = dependency / "native-inputs"
            manifest = dependency / "native-input-manifest.json"
            receipt["dependencyBuildDir"] = str(dependency)
            receipt["dependencyBuildReceiptSha256"] = digest(dependency / "build-receipt.json")
            receipt["dependencyBuildReceipt"] = json.loads((dependency / "build-receipt.json").read_text())
            verify_reusable_dependency_configuration(receipt["dependencyBuildReceipt"], json.loads(manifest.read_text()))
            reviewed = json.loads(LOCK.read_text())
            for name, entry in (("openssl.tar.gz", reviewed["openssl"]), ("libvnc.tar.gz", reviewed["libvncclient"])):
                if digest(dependency / "downloads" / name) != entry["sha256"]:
                    raise ValueError("reused upstream source archive differs from lock")
            for patch in reviewed["libvncclient"]["patches"]:
                if digest(dependency / "downloads" / (patch["commit"] + ".patch")) != patch["sha256"]:
                    raise ValueError("reused security patch differs from lock")
        else:
            native, manifest = prepare_dependencies(output, run, args.jobs, sdk, cmake)
            dependency = output
        receipt["dependencySourceFiles"] = {}
        for folder in ("openssl-source", "libvnc-source"):
            receipt["dependencySourceFiles"][folder] = {path.relative_to(dependency / folder).as_posix(): digest(path)
                for path in sorted((dependency / folder).rglob("*")) if path.is_file() and not path.is_symlink()}
        run([sys.executable, "-I", ROOT / "scripts/verify-native-input.py", manifest, native, "before-link"], label="input-before-link")
        if args.build_ready_file:
            marker = Path(args.build_ready_file)
            deadline = time.monotonic() + 1800
            while not marker.is_file():
                if time.monotonic() > deadline:
                    raise ValueError("source-ready marker did not arrive within 30 minutes")
                time.sleep(1)
        source_files = source_inventory()
        run([xcodegen, "generate", "--spec", ROOT / "project.yml", "--project", ROOT], label="xcodegen")
        if source_inventory() != source_files:
            raise ValueError("XcodeGen changed authored source; use INFOPLIST_FILE and disable generated app Info.plist")
        receipt["sourceFiles"] = source_files
        receipt["sourceTreeSha256"] = hashlib.sha256(json.dumps(source_files, sort_keys=True).encode()).hexdigest()
        project = ROOT / "Claude-KVM-Daemon.xcodeproj"
        common = ["xcodebuild", "-project", project, "-configuration", "Release", "-derivedDataPath", output / "derived",
                  "-jobs", str(args.jobs), "FRUITCTL_NATIVE_INPUT_MANIFEST=" + str(manifest), "FRUITCTL_NATIVE_INPUT_DIR=" + str(native),
                  "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO",
                  "OTHER_SWIFT_FLAGS=$(inherited) -file-prefix-map " + str(ROOT) + "=/fruitctl/source"
                  + " -debug-prefix-map " + str(ROOT) + "=/fruitctl/source"
                  + " -file-prefix-map " + str(output) + "=/fruitctl/build"
                  + " -debug-prefix-map " + str(output) + "=/fruitctl/build",
                  "OTHER_CFLAGS=$(inherited) -ffile-prefix-map=" + str(ROOT) + "=/fruitctl/source"
                  + " -fdebug-prefix-map=" + str(ROOT) + "=/fruitctl/source"
                  + " -ffile-prefix-map=" + str(output) + "=/fruitctl/build"
                  + " -fdebug-prefix-map=" + str(output) + "=/fruitctl/build"]
        builds = args.build_scheme or ["claude-kvm-daemon", "FruitctlHost"]
        tests = args.test_scheme or ["VNCReconnectTests", "NativeBehaviorTests", "FruitctlHostTests"]
        for scheme in builds:
            run([*common, "-scheme", scheme, "build"], label="build-" + scheme)
        for scheme in tests:
            result = output / (scheme + ".xcresult")
            run([*common, "-scheme", scheme, "-destination", "platform=macOS,arch=arm64", "-parallel-testing-enabled", "NO",
                 "-resultBundlePath", result, "test"], label="test-" + scheme)
            receipt["tests"].append({"scheme": scheme, "status": "passed", "resultBundle": result.name})
        run([sys.executable, "-I", ROOT / "scripts/verify-native-input.py", manifest, native, "after-link"], label="input-after-link")
        for relative, original in source_files.items():
            if digest(ROOT / relative) != original:
                raise ValueError("source changed during build: " + relative)
        for folder, files in receipt["dependencySourceFiles"].items():
            for relative, expected in files.items():
                if digest(dependency / folder / relative) != expected:
                    raise ValueError("dependency source changed during build: " + folder + "/" + relative)
        receipt["nativeInputDir"] = str(native)
        receipt["nativeInputManifest"] = str(manifest)
        receipt["inputManifestSha256"] = digest(manifest)
        swift_checkout = output / "derived/SourcePackages/checkouts/swift-argument-parser"
        receipt["swiftPackageRevision"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=swift_checkout, text=True).strip()
        provenance = json.loads((ROOT / "LICENSES/dependency-provenance.json").read_text())
        swift = next(component for component in provenance["components"] if component["id"] == "swift-argument-parser")
        if receipt["swiftPackageRevision"] != swift["upstream_revision"]:
            raise ValueError("Swift package checkout differs from the pinned source")
        tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=swift_checkout).decode().split("\0")
        receipt["swiftPackageSourceFiles"] = {name: digest(swift_checkout / name) for name in tracked if name}
        products = output / "derived/Build/Products/Release"
        # Keep unstripped unsigned originals privately for diagnostics. Admit
        # only pre-signing stripped products to artifact receipts.
        originals = output / "unstripped-unsigned"
        originals.mkdir()
        receipt["unstrippedUnsignedArtifacts"] = {}
        receipt["publicBinaryPrivacy"] = {}
        for relative in ("claude-kvm-daemon", "FruitctlHost.app/Contents/MacOS/FruitctlHost"):
            binary = products / relative
            requested = "FruitctlHost" if relative.startswith("FruitctlHost.app/") else "claude-kvm-daemon"
            if not binary.is_file():
                if requested in builds:
                    raise ValueError("requested native build artifact is missing: " + relative)
                continue
            if binary.is_symlink() or binary.resolve(strict=True) != binary:
                raise ValueError("native build artifact is linked or noncanonical")
            copied = originals / relative
            copied.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(binary, copied)
            receipt["unstrippedUnsignedArtifacts"][relative] = {"sha256": digest(copied), "bytes": copied.stat().st_size}
            run(["xcrun", "strip", "-S", binary], label="strip-debug-" + binary.name)
            receipt["publicBinaryPrivacy"][relative] = verify_public_native_binary(binary)
        receipt["artifacts"] = {}
        for name in ("claude-kvm-daemon", "FruitctlHost.app"):
            artifact = products / name
            if artifact.is_dir():
                receipt["artifacts"][name] = {"files": {path.relative_to(artifact).as_posix(): {"sha256": digest(path), "bytes": path.stat().st_size}
                    for path in sorted(artifact.rglob("*")) if path.is_file() and not path.is_symlink()}}
            elif artifact.is_file():
                receipt["artifacts"][name] = {"sha256": digest(artifact), "bytes": artifact.stat().st_size}
        receipt["status"] = "passed"
    except Exception as error:
        receipt["status"] = "failed"
        receipt["failureClass"] = type(error).__name__
        raise
    finally:
        receipt["finishedAtUnix"] = int(time.time())
        write_json(output / "build-receipt.json", receipt)
    print(json.dumps({"status": "passed", "receipt": str(output / "build-receipt.json"), "qualification": "not-publicly-qualified"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("Native build failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
