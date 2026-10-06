#!/usr/bin/env python3
"""Package matching native source; a package is not a runtime qualification claim."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_builder", ROOT / "scripts/release/build_native.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def tree_hashes(root):
    return {path.relative_to(root).as_posix(): builder.digest(path) for path in sorted(root.rglob("*"))
            if path.is_file() and not path.is_symlink()}


def copy_tree(source, destination, expected=None):
    if expected is not None:
        require(tree_hashes(source) == expected, "dependency source inventory differs from the tested build")
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in (".git", "node_modules", "build-docs", ".DS_Store", "__pycache__")
               or part.endswith(".xcodeproj") for part in relative.parts):
            continue
        if relative.parts[:3] == ("vendor", "libvnc", "prebuilt") or relative.name == "core-build.yml":
            continue
        require(not path.is_symlink(), "source package refuses symlinks: " + relative.as_posix())
        if path.is_file():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            target.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)


def archive_tree(source, target):
    with target.open("xb") as stream, gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for path in sorted(source.rglob("*")):
                if not path.is_file():
                    continue
                info = archive.gettarinfo(str(path), arcname=path.relative_to(source).as_posix())
                info.uid = info.gid = 0; info.uname = info.gname = ""; info.mtime = 0
                with path.open("rb") as content:
                    archive.addfile(info, content)


def portable_receipt(value, replacements):
    if isinstance(value, str):
        for original, replacement in sorted(replacements.items(), key=lambda entry: len(entry[0]), reverse=True):
            value = value.replace(original, replacement)
        return value
    if isinstance(value, list):
        return [portable_receipt(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: portable_receipt(item, replacements) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--source-inventory", required=True, help="Reviewed public file/hash inventory; never blindly package a working directory")
    parser.add_argument("--binary", action="append", required=True, help="Final native binary path; repeat for host/controller")
    parser.add_argument("--staple-receipt", action="append", default=[], help="Actual stapled-app receipt bound to this native build, if signing changed output bytes")
    parser.add_argument("--tool-sign-receipt", action="append", default=[], help="Actual signed private controller-copy receipt bound to this tested build")
    args = parser.parse_args()
    build = Path(args.build_dir)
    output = Path(args.output)
    receipt_path = Path(args.receipt)
    require(build.is_absolute() and build.resolve(strict=True) == build, "canonical build directory required")
    require(output.is_absolute() and receipt_path.is_absolute() and not output.exists() and not receipt_path.exists(),
            "source archive and receipt must be new absolute paths")
    receipt = json.loads((build / "build-receipt.json").read_text())
    require(receipt.get("kind") == "fruitctl-native-build" and receipt.get("status") == "passed", "passing native build required")
    require(receipt.get("sourceLockSha256") == builder.digest(ROOT / "release/native-dependencies.lock.json"), "source lock differs from build")
    for relative, expected in receipt["sourceFiles"].items():
        require(builder.digest(ROOT / relative) == expected, "Fruitctl source changed after build: " + relative)
    provenance = json.loads((ROOT / "LICENSES/dependency-provenance.json").read_text())
    dependency = Path(receipt.get("dependencyBuildDir", str(build)))
    require(dependency.is_absolute() and dependency.resolve(strict=True) == dependency, "canonical dependency source directory required")
    public = json.loads(Path(args.source_inventory).read_text())
    require(public.get("schemaVersion") == 1 and public.get("kind") == "fruitctl-public-source-inventory"
            and isinstance(public.get("files"), dict), "reviewed public source inventory required")
    require(isinstance(public.get("sourceRevision"), str) and re.fullmatch(r"[a-f0-9]{40}", public["sourceRevision"]),
            "public source inventory must name a full Git revision")
    required_public = {"LICENSE", "THIRD_PARTY_NOTICES.md", "project.yml", "package-lock.json", "package.json",
                       "scripts/build-native.sh", "scripts/build-host.sh", "scripts/install.sh", "scripts/uninstall.sh",
                       "scripts/verify-native-input.py", "release/native-dependencies.lock.json"}
    required_public.update(path.relative_to(ROOT).as_posix() for directory in (ROOT / "LICENSES", ROOT / "scripts/release")
                           for path in directory.rglob("*") if path.is_file() and not path.is_symlink())
    require(required_public.issubset(public["files"]), "reviewed source inventory omits licenses, native/install scripts or locks")
    swift = next(component for component in provenance["components"] if component["id"] == "swift-argument-parser")
    binary_hashes = {}
    signed_tools = {}
    for value in args.tool_sign_receipt:
        signed = json.loads(Path(value).read_text())
        require(signed.get("kind") == "fruitctl-apple-tool-sign" and signed.get("status") == "passed"
                and signed.get("buildReceiptSha256") == builder.digest(build / "build-receipt.json"),
                "tool signing receipt differs from the tested build")
        require(receipt.get("artifacts", {}).get(signed["appName"]) == signed["unsignedArtifact"],
                "tool signing receipt does not identify the exact unsigned build artifact")
        signed_tools[signed["appName"]] = signed
    stapled = {}
    for value in args.staple_receipt:
        signed = json.loads(Path(value).read_text())
        require(signed.get("kind") == "fruitctl-apple-staple" and signed.get("status") == "passed"
                and signed.get("buildReceiptSha256") == builder.digest(build / "build-receipt.json")
                and bool(signed.get("submissionId")), "stapled receipt differs from the tested build")
        stapled[signed["appName"]] = signed
    products = build / "derived/Build/Products/Release"
    for value in args.binary:
        path = Path(value)
        require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file(), "canonical native binary required")
        if path.name in signed_tools:
            signed = signed_tools[path.name]
            expected = {"sha256": signed["artifactSha256"], "bytes": signed["artifactBytes"]}
        else:
            require(path.is_relative_to(products), "binary must be an actual build output or its receipt-bound signed private copy")
            relative = path.relative_to(products)
            artifact = receipt.get("artifacts", {}).get(relative.parts[0])
            require(isinstance(artifact, dict), "binary is absent from build artifacts")
            expected = artifact if len(relative.parts) == 1 else artifact.get("files", {}).get(Path(*relative.parts[1:]).as_posix())
            if relative.parts[0] in stapled:
                expected = stapled[relative.parts[0]]["files"].get(Path(*relative.parts[1:]).as_posix())
        require(expected == {"sha256": builder.digest(path), "bytes": path.stat().st_size}, "binary differs from tested output")
        require(path.name not in binary_hashes, "duplicate binary names")
        binary_hashes[path.name] = {"sha256": builder.digest(path), "bytes": path.stat().st_size}
    # Work products remain beside the requested durable archive. No sole durable
    # carrier is left in a system temporary directory.
    with tempfile.TemporaryDirectory(prefix="fruitctl-source-", dir=output.parent) as workspace:
        workspace = Path(workspace)
        package = workspace / "package"
        package.mkdir()
        for relative, expected in public["files"].items():
            path = Path(relative)
            require(not path.is_absolute() and ".." not in path.parts and path.as_posix() == relative,
                    "public source inventory path must be normalized")
            require(not (path.parts[:3] == ("vendor", "libvnc", "prebuilt") and path.suffix in (".a", ".dylib", ".so")),
                    "opaque historical native archives cannot be claimed as corresponding source")
            source = ROOT / path
            require(not source.is_symlink() and source.is_file() and builder.digest(source) == expected,
                    "public source inventory differs: " + relative)
            target = package / "fruitctl" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            target.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)
        require(set(receipt["sourceFiles"]).issubset(public["files"]), "reviewed inventory omits native build sources")
        copy_tree(dependency / "openssl-source", package / "dependencies/openssl", receipt["dependencySourceFiles"]["openssl-source"])
        copy_tree(dependency / "libvnc-source", package / "dependencies/libvncclient-patched", receipt["dependencySourceFiles"]["libvnc-source"])
        swift_archive = workspace / "swift-argument-parser.tar.gz"
        builder.download({"url": swift["source_archive"]["source_url"], **swift["source_archive"]}, swift_archive)
        swift_tree = builder.extract(swift_archive, workspace / "swift-source")
        require(receipt.get("swiftPackageRevision") == swift["upstream_revision"], "build does not record the pinned Swift package checkout")
        require(tree_hashes(swift_tree) == receipt.get("swiftPackageSourceFiles"), "Swift source bytes differ from the build checkout")
        copy_tree(swift_tree, package / "dependencies/swift-argument-parser")
        reviewed = json.loads(builder.LOCK.read_text())
        downloads = dependency / "downloads"
        for name, entry in (("openssl.tar.gz", reviewed["openssl"]), ("libvnc.tar.gz", reviewed["libvncclient"]),
                            *((p["commit"] + ".patch", p) for p in reviewed["libvncclient"]["patches"])):
            require(builder.digest(downloads / name) == entry["sha256"], "upstream archive or patch changed")
            (package / "upstream-inputs").mkdir(exist_ok=True)
            shutil.copyfile(downloads / name, package / "upstream-inputs" / name)
        shutil.copyfile(swift_archive, package / "upstream-inputs/swift-argument-parser.tar.gz")
        node = json.loads((ROOT / "LICENSES/node-runtime-provenance.json").read_text())
        node_archive = workspace / "node-source.tar.xz"
        builder.download({"url": node["source_archive"]["source_url"], **node["source_archive"]}, node_archive)
        shutil.copyfile(node_archive, package / "upstream-inputs/node-source.tar.xz")
        evidence = package / "build-evidence"
        evidence.mkdir()
        for name in ("build-receipt.json", "native-input-manifest.json"):
            source = build / name if name == "build-receipt.json" else Path(receipt["nativeInputManifest"])
            value = json.loads(source.read_text())
            (evidence / name).write_text(json.dumps(portable_receipt(value, {str(ROOT): "${SOURCE_ROOT}", str(build): "${BUILD_ROOT}",
                 str(dependency): "${DEPENDENCY_BUILD_ROOT}"}), indent=2, sort_keys=True) + "\n")
        manifest = {"schemaVersion": 1, "kind": "fruitctl-corresponding-source", "fruitctl_revision": public["sourceRevision"],
                    "build_snapshot_base_revision": receipt["sourceRevision"], "publicWorkingTreeClean": public.get("workingTreeClean", False),
                    "sourceTreeSha256": receipt["sourceTreeSha256"], "native_distribution_license_expression": "GPL-3.0-or-later",
                    "componentLicenses": {"claude-kvm-daemon": "GPL-3.0-or-later", "FruitctlHost.app": "MIT", "node": "LicenseRef-Nodejs-24.21.0"},
                    "components": [*provenance["components"], node], "patches": json.loads(builder.LOCK.read_text())["libvncclient"]["patches"],
                    "build_configuration": portable_receipt({"tools": receipt["tools"], "commands": receipt["commands"]},
                        {str(ROOT): "${SOURCE_ROOT}", str(build): "${BUILD_ROOT}", str(dependency): "${DEPENDENCY_BUILD_ROOT}"}),
                    "binary_sha256": binary_hashes, "files": tree_hashes(package)}
        (package / "corresponding-source.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        archive_tree(package, output)
    value = {"schemaVersion": 1, "kind": "fruitctl-corresponding-source-package", "status": "passed",
             "source_archive_sha256": builder.digest(output), "sourceArchiveBytes": output.stat().st_size,
             "buildReceiptSha256": builder.digest(build / "build-receipt.json"), "binary_sha256": binary_hashes,
             "sourceTreeSha256": receipt["sourceTreeSha256"], "qualification": "not-publicly-qualified"}
    value["publicSourceRevision"] = public["sourceRevision"]
    receipt_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": "passed", "sourceArchiveSha256": value["source_archive_sha256"], "receipt": str(receipt_path)}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, StopIteration) as error:
        print("Corresponding source refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
