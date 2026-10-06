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


def app_inventory(app):
    require(app.is_absolute() and app.resolve(strict=True) == app and app.name.endswith(".app")
            and (app / "Contents/Info.plist").is_file(), "canonical existing app bundle required")
    files = {}
    for path in sorted(app.rglob("*")):
        require(not path.is_symlink(), "private app bundle contains a symlink")
        if path.is_file():
            files[path.relative_to(app).as_posix()] = {"sha256": builder.digest(path), "bytes": path.stat().st_size}
    return files


def distribution_receipts(paths, kind):
    receipts = {}
    for value in paths:
        path = Path(value)
        require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file(),
                "canonical distribution receipt required")
        receipt = json.loads(path.read_text())
        require(isinstance(receipt, dict) and receipt.get("kind") == kind and receipt.get("schemaVersion") == 1
                and receipt.get("status") == "passed", "passing distribution receipt required: " + kind)
        name = receipt.get("appName")
        require(isinstance(name, str) and Path(name).name == name and name.endswith(".app"),
                "distribution receipt must identify an app bundle")
        require(name not in receipts, "duplicate distribution receipt for " + name)
        receipts[name] = {"value": receipt, "sha256": builder.digest(path)}
    return receipts


def private_app_receipts(sign_paths, archive_paths, notary_paths, staple_paths, submission_paths, built, build_receipt,
                         build_receipt_sha=None):
    signed = distribution_receipts(sign_paths, "fruitctl-apple-sign")
    archived = distribution_receipts(archive_paths, "fruitctl-apple-submission-archive")
    accepted = distribution_receipts(notary_paths, "fruitctl-apple-notarization")
    stapled = distribution_receipts(staple_paths, "fruitctl-apple-staple")
    names = set(signed)
    require(names == set(archived) == set(accepted) == set(stapled),
            "private app requires its sign, archive, Accepted notarization and staple receipts")
    submissions = {}
    for value in submission_paths:
        path = Path(value)
        require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file() and path.suffix == ".zip",
                "canonical submission ZIP required")
        sha = builder.digest(path)
        require(sha not in submissions, "duplicate submission ZIP")
        submissions[sha] = path.stat().st_size
    require(len(submissions) == len(names), "one exact submission ZIP is required per private app")
    build_sha = builder.digest(build_receipt) if build_receipt_sha is None else build_receipt_sha
    require(isinstance(build_sha, str) and re.fullmatch(r"[a-f0-9]{64}", build_sha), "tested build receipt hash required")
    result = {}
    for name in names:
        sign, archive, notary, staple = (entries[name]["value"] for entries in (signed, archived, accepted, stapled))
        artifact = built.get("artifacts", {}).get(name)
        require(isinstance(artifact, dict) and isinstance(artifact.get("files"), dict), "app is absent from tested build artifacts")
        require(sign.get("buildReceiptSha256") == build_sha == staple.get("buildReceiptSha256"),
                "private app receipt differs from the tested build")
        require(sign.get("unsignedFiles") == artifact["files"], "private app signing receipt differs from exact unsigned build bundle")
        require(isinstance(sign.get("files"), dict) and bool(sign["files"])
                and isinstance(staple.get("files"), dict) and bool(staple["files"])
                and isinstance(sign.get("signature"), dict) and isinstance(staple.get("signature"), dict),
                "private app signature or final inventory is malformed or changed")
        require(set(artifact["files"]).issubset(sign["files"]), "private app signed inventory omits original bundle files")
        # codesign's description includes the app's absolute path. A separate
        # publication copy must retain signing identity and sealed bytes, while
        # that path may legitimately change before stapling.
        require(all(sign["signature"].get(key) == staple["signature"].get(key)
                    for key in ("identifier", "teamIdentifier", "certificateSha1")), "private app signing identity changed")
        require(all(staple["files"].get(path) == descriptor for path, descriptor in sign["files"].items()),
                "stapled app changed original signed bundle bytes")
        for signature in (sign["signature"], staple["signature"]):
            require(isinstance(signature.get("teamIdentifier"), str) and re.fullmatch(r"[A-Z0-9]{10}", signature["teamIdentifier"])
                    and isinstance(signature.get("certificateSha1"), str) and re.fullmatch(r"[A-Fa-f0-9]{40}", signature["certificateSha1"])
                    and isinstance(signature.get("identifier"), str) and bool(signature["identifier"])
                    and isinstance(signature.get("description"), str)
                    and re.search(r"^CodeDirectory .*flags=.*\(runtime\)", signature["description"], re.M)
                    and re.search(r"^Timestamp=.+$", signature["description"], re.M)
                    and "Authority=Developer ID Application:" in signature["description"],
                    "private app receipt lacks verified Developer ID, runtime, timestamp or leaf certificate metadata")
        require(archive.get("signReceiptSha256") == signed[name]["sha256"]
                and staple.get("signReceiptSha256") == signed[name]["sha256"], "private app signing receipt chain differs")
        require(notary.get("archiveReceiptSha256") == archived[name]["sha256"]
                and notary.get("submittedArchiveSha256") == archive.get("archiveSha256")
                and submissions.get(archive.get("archiveSha256")) == archive.get("archiveBytes"),
                "private app submission archive chain differs")
        apple = notary.get("apple", {})
        require(isinstance(apple, dict) and apple.get("status") == "Accepted"
                and isinstance(apple.get("id"), str) and re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", apple["id"]),
                "private app requires an actual Accepted submission identifier")
        require(staple.get("notarizationReceiptSha256") == accepted[name]["sha256"]
                and staple.get("submissionId") == apple["id"], "private app Accepted/staple receipt chain differs")
        result[name] = staple
    return result


def binary_descriptor(path, products, built, signed_tools, private_apps):
    require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file(), "canonical native binary required")
    if path.name in signed_tools:
        signed = signed_tools[path.name]
        return {"sha256": signed["artifactSha256"], "bytes": signed["artifactBytes"]}
    app = next((parent for parent in path.parents if parent.name in private_apps), None)
    if app is not None:
        approved = private_apps[app.name]
        require(app_inventory(app) == approved["files"], "private app bundle differs from its final staple receipt")
        return approved["files"].get(path.relative_to(app).as_posix())
    require(path.is_relative_to(products), "binary must be an actual build output or its receipt-bound signed private copy")
    relative = path.relative_to(products)
    artifact = built.get("artifacts", {}).get(relative.parts[0])
    require(isinstance(artifact, dict), "binary is absent from build artifacts")
    return artifact if len(relative.parts) == 1 else artifact.get("files", {}).get(Path(*relative.parts[1:]).as_posix())


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
    if expected is not None:
        require(all(not path.is_symlink() for path in destination.rglob("*")), "copied dependency source contains a symlink")
        require(tree_hashes(destination) == expected, "copied dependency source differs from the tested build inventory")


def copy_verified_file(source, destination, expected):
    require(source.is_file() and not source.is_symlink() and source.resolve(strict=True) == source
            and builder.digest(source) == expected, "source input differs from its validated hash: " + source.name)
    shutil.copyfile(source, destination)
    require(builder.digest(destination) == expected, "copied source input differs from its validated hash: " + source.name)


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


def native_source_inventory(root):
    require(root.is_absolute() and root.resolve(strict=True) == root and root.is_dir(),
            "canonical native source root required")
    files = {}
    for name in ("ClaudeKVM-Daemon", "FruitctlHost", "Tests", "test"):
        directory = root / name
        require(not directory.is_symlink(), "native source symlinks are refused")
        if not directory.exists():
            continue
        require(directory.is_dir(), "native source directory required: " + name)
        for path in sorted(directory.rglob("*")):
            require(not path.is_symlink(), "native source symlinks are refused")
            if path.is_file() and (name not in ("Tests", "test") or path.suffix == ".swift"):
                files[path.relative_to(root).as_posix()] = builder.digest(path)
    project = root / "project.yml"
    require(not project.is_symlink() and project.is_file(), "regular native project file required")
    files["project.yml"] = builder.digest(project)
    return files


def native_source_provenance(public_root, built, binary_names, tested_root=None):
    """Retain the tested input map; only a controller may use corrected Host docs."""
    expected = built.get("sourceFiles")
    require(isinstance(expected, dict) and bool(expected)
            and all(isinstance(name, str) and isinstance(sha, str) and re.fullmatch(r"[a-f0-9]{64}", sha)
                    for name, sha in expected.items()), "tested native source inventory required")
    tested_tree_sha = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
    require(built.get("sourceTreeSha256") == tested_tree_sha, "tested native source tree hash differs")
    if tested_root is not None:
        require(set(binary_names) == {"claude-kvm-daemon"},
                "tested native source root is permitted only for the selected controller; Host is refused")
        require(native_source_inventory(tested_root) == expected,
                "tested native source root differs from the complete build inventory")
    current = native_source_inventory(public_root)
    require(set(current) == set(expected), "public native source inventory has missing or extra files")
    readme = "FruitctlHost/README.md"
    changed = {name for name in current if current[name] != expected[name]}
    require(not changed or (tested_root is not None and changed == {readme}),
            "Fruitctl source changed after build: " + ", ".join(sorted(changed)))
    resource_docs = []
    tested_docs = {}
    if tested_root is not None:
        require(readme in expected, "tested Host README is absent from the native build inventory")
        data = (tested_root / readme).read_bytes()
        descriptor = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        require(descriptor["sha256"] == expected[readme], "tested Host README changed after inventory verification")
        resource = "Contents/Resources/README.md"
        require(built.get("artifacts", {}).get("FruitctlHost.app", {}).get("files", {}).get(resource) == descriptor,
                "tested Host README differs from the original build bundle resource")
        public_data = (public_root / readme).read_bytes()
        require(hashlib.sha256(public_data).hexdigest() == current[readme],
                "public Host README changed after inventory verification")
        evidence_path = "build-evidence/tested-native-resource-docs/" + readme
        tested_docs[evidence_path] = data
        resource_docs.append({"publicSourcePath": "fruitctl/" + readme, "testedSourcePath": readme,
                              "testedEvidencePath": evidence_path, "testedSha256": descriptor["sha256"],
                              "testedBytes": descriptor["bytes"], "publicSha256": current[readme], "publicBytes": len(public_data),
                              "ownerArtifact": "FruitctlHost.app", "ownerResourcePath": resource,
                              "ownerArtifactIncluded": False, "publicDocumentationChanged": readme in changed})
    value = {"schemaVersion": 1, "mode": "controller-with-tested-host-resource-docs" if tested_root is not None else "strict",
             "selectedBinaries": sorted(binary_names), "testedSourceTreeSha256": tested_tree_sha,
             "publicNativeSourceTreeSha256": hashlib.sha256(json.dumps(current, sort_keys=True).encode()).hexdigest(),
             "testedSourceFiles": dict(expected), "publicNativeSourceFiles": current, "resourceDocs": resource_docs}
    return value, tested_docs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--source-inventory", required=True, help="Reviewed public file/hash inventory; never blindly package a working directory")
    parser.add_argument("--binary", action="append", required=True, help="Final native binary path; repeat for host/controller")
    parser.add_argument("--tested-native-source-root", help="Exact tested native source tree; permits only a controller package with a corrected Host README, retaining both versions")
    parser.add_argument("--staple-receipt", action="append", default=[], help="Actual stapled-app receipt bound to this native build, if signing changed output bytes")
    parser.add_argument("--app-sign-receipt", action="append", default=[], help="Actual app-sign receipt binding the exact original build bundle")
    parser.add_argument("--app-archive-receipt", action="append", default=[], help="Actual app submission-archive receipt bound to its sign receipt")
    parser.add_argument("--app-notarization-receipt", action="append", default=[], help="Actual Accepted app receipt bound to its exact submission archive")
    parser.add_argument("--app-submission-archive", action="append", default=[], help="Exact app ZIP submitted to Apple, bound to the archive receipt")
    parser.add_argument("--tool-sign-receipt", action="append", default=[], help="Actual signed private controller-copy receipt bound to this tested build")
    args = parser.parse_args()
    build = Path(args.build_dir)
    output = Path(args.output)
    receipt_path = Path(args.receipt)
    require(build.is_absolute() and build.resolve(strict=True) == build, "canonical build directory required")
    require(output.is_absolute() and receipt_path.is_absolute() and not output.exists() and not receipt_path.exists(),
            "source archive and receipt must be new absolute paths")
    receipt_bytes = (build / "build-receipt.json").read_bytes()
    build_receipt_sha = hashlib.sha256(receipt_bytes).hexdigest()
    receipt = json.loads(receipt_bytes)
    require(receipt.get("kind") == "fruitctl-native-build" and receipt.get("status") == "passed", "passing native build required")
    native_manifest_bytes = Path(receipt["nativeInputManifest"]).read_bytes()
    native_manifest_sha = hashlib.sha256(native_manifest_bytes).hexdigest()
    require(native_manifest_sha == receipt.get("inputManifestSha256"), "native input manifest differs from the tested build")
    native_manifest = json.loads(native_manifest_bytes)
    dependency = Path(receipt.get("dependencyBuildDir", str(build)))
    require(dependency.is_absolute() and dependency.resolve(strict=True) == dependency, "canonical dependency source directory required")
    public_bytes = Path(args.source_inventory).read_bytes()
    public_inventory_sha = hashlib.sha256(public_bytes).hexdigest()
    public = json.loads(public_bytes)
    require(public.get("schemaVersion") == 1 and public.get("kind") == "fruitctl-public-source-inventory"
            and isinstance(public.get("files"), dict), "reviewed public source inventory required")
    require(isinstance(public.get("sourceRevision"), str) and re.fullmatch(r"[a-f0-9]{40}", public["sourceRevision"]),
            "public source inventory must name a full Git revision")
    required_public = {"LICENSE", "THIRD_PARTY_NOTICES.md", "project.yml", "package-lock.json", "package.json",
                       "scripts/build-native.sh", "scripts/build-host.sh", "scripts/install.sh", "scripts/uninstall.sh",
                       "scripts/verify-native-input.py", "release/native-dependencies.lock.json"}
    required_public.update(path.relative_to(ROOT).as_posix() for directory in (ROOT / "LICENSES", ROOT / "scripts/release")
                           for path in directory.rglob("*") if path.is_file() and not path.is_symlink()
                           and "__pycache__" not in path.relative_to(ROOT).parts)
    require(required_public.issubset(public["files"]), "reviewed source inventory omits licenses, native/install scripts or locks")
    metadata = {}
    for relative in ("release/native-dependencies.lock.json", "LICENSES/dependency-provenance.json", "LICENSES/node-runtime-provenance.json"):
        data = (ROOT / relative).read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        require(public["files"].get(relative) == sha, "public metadata differs from reviewed inventory: " + relative)
        if relative == "release/native-dependencies.lock.json":
            require(receipt.get("sourceLockSha256") == sha, "source lock differs from build")
        metadata[relative] = json.loads(data)
    reviewed = metadata["release/native-dependencies.lock.json"]
    provenance = metadata["LICENSES/dependency-provenance.json"]
    node = metadata["LICENSES/node-runtime-provenance.json"]
    swift = next(component for component in provenance["components"] if component["id"] == "swift-argument-parser")
    binary_hashes = {}
    signed_tools = {}
    for value in args.tool_sign_receipt:
        signed = json.loads(Path(value).read_text())
        require(signed.get("kind") == "fruitctl-apple-tool-sign" and signed.get("status") == "passed"
                and signed.get("buildReceiptSha256") == build_receipt_sha,
                "tool signing receipt differs from the tested build")
        require(receipt.get("artifacts", {}).get(signed["appName"]) == signed["unsignedArtifact"],
                "tool signing receipt does not identify the exact unsigned build artifact")
        signed_tools[signed["appName"]] = signed
    private_apps = private_app_receipts(args.app_sign_receipt, args.app_archive_receipt, args.app_notarization_receipt,
        args.staple_receipt, args.app_submission_archive, receipt, build / "build-receipt.json", build_receipt_sha)
    products = build / "derived/Build/Products/Release"
    for value in args.binary:
        path = Path(value)
        expected = binary_descriptor(path, products, receipt, signed_tools, private_apps)
        actual = {"sha256": builder.digest(path), "bytes": path.stat().st_size}
        require(expected == actual, "binary differs from tested output")
        require(path.name not in binary_hashes, "duplicate binary names")
        binary_hashes[path.name] = actual
    native_provenance, tested_docs = native_source_provenance(ROOT, receipt, binary_hashes,
        Path(args.tested_native_source_root) if args.tested_native_source_root is not None else None)
    require(all(public["files"].get(name) == sha for name, sha in native_provenance["publicNativeSourceFiles"].items()),
            "reviewed inventory omits or differs from public native build sources")
    # Work products remain beside the requested durable archive. No sole durable
    # carrier is left in a system temporary directory.
    with tempfile.TemporaryDirectory(prefix="fruitctl-source-", dir=output.parent) as workspace:
        workspace = Path(workspace)
        package = workspace / "package"
        package.mkdir()
        for relative, expected in public["files"].items():
            path = Path(relative)
            require(not path.is_absolute() and ".." not in path.parts and path.as_posix() == relative
                    and "__pycache__" not in path.parts, "public source inventory path must be normalized and exclude generated caches")
            require(not (path.parts[:3] == ("vendor", "libvnc", "prebuilt") and path.suffix in (".a", ".dylib", ".so")),
                    "opaque historical native archives cannot be claimed as corresponding source")
            source = ROOT / path
            require(not source.is_symlink() and source.is_file() and source.resolve(strict=True) == source
                    and builder.digest(source) == expected,
                    "public source inventory differs: " + relative)
            target = package / "fruitctl" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            require(builder.digest(target) == expected, "public source changed during copying: " + relative)
            target.chmod(0o755 if source.stat().st_mode & 0o111 else 0o644)
        require(native_source_inventory(package / "fruitctl") == native_provenance["publicNativeSourceFiles"],
                "packaged native source differs from the verified public inventory")
        copy_tree(dependency / "openssl-source", package / "dependencies/openssl", receipt["dependencySourceFiles"]["openssl-source"])
        copy_tree(dependency / "libvnc-source", package / "dependencies/libvncclient-patched", receipt["dependencySourceFiles"]["libvnc-source"])
        swift_archive = workspace / "swift-argument-parser.tar.gz"
        builder.download({"url": swift["source_archive"]["source_url"], **swift["source_archive"]}, swift_archive)
        swift_tree = builder.extract(swift_archive, workspace / "swift-source")
        require(receipt.get("swiftPackageRevision") == swift["upstream_revision"], "build does not record the pinned Swift package checkout")
        require(tree_hashes(swift_tree) == receipt.get("swiftPackageSourceFiles"), "Swift source bytes differ from the build checkout")
        copy_tree(swift_tree, package / "dependencies/swift-argument-parser", receipt["swiftPackageSourceFiles"])
        downloads = dependency / "downloads"
        for name, entry in (("openssl.tar.gz", reviewed["openssl"]), ("libvnc.tar.gz", reviewed["libvncclient"]),
                            *((p["commit"] + ".patch", p) for p in reviewed["libvncclient"]["patches"])):
            (package / "upstream-inputs").mkdir(exist_ok=True)
            copy_verified_file(downloads / name, package / "upstream-inputs" / name, entry["sha256"])
        copy_verified_file(swift_archive, package / "upstream-inputs/swift-argument-parser.tar.gz", swift["source_archive"]["sha256"])
        node_archive = workspace / "node-source.tar.xz"
        builder.download({"url": node["source_archive"]["source_url"], **node["source_archive"]}, node_archive)
        copy_verified_file(node_archive, package / "upstream-inputs/node-source.tar.xz", node["source_archive"]["sha256"])
        evidence = package / "build-evidence"
        evidence.mkdir()
        for relative, data in tested_docs.items():
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o644)
        for name, value in (("build-receipt.json", receipt),
                            ("native-input-manifest.json", native_manifest)):
            (evidence / name).write_text(json.dumps(portable_receipt(value, {str(ROOT): "${SOURCE_ROOT}", str(build): "${BUILD_ROOT}",
                 str(dependency): "${DEPENDENCY_BUILD_ROOT}"}), indent=2, sort_keys=True) + "\n")
        manifest = {"schemaVersion": 1, "kind": "fruitctl-corresponding-source", "fruitctl_revision": public["sourceRevision"],
                    "build_snapshot_base_revision": receipt["sourceRevision"], "publicWorkingTreeClean": public.get("workingTreeClean", False),
                    "sourceTreeSha256": receipt["sourceTreeSha256"], "nativeSourceProvenance": native_provenance,
                    "publicSourceInventorySha256": public_inventory_sha, "nativeInputManifestSha256": native_manifest_sha,
                    "native_distribution_license_expression": "GPL-3.0-or-later",
                    "componentLicenses": {"claude-kvm-daemon": "GPL-3.0-or-later", "FruitctlHost.app": "MIT", "node": "LicenseRef-Nodejs-24.21.0"},
                    "components": [*provenance["components"], node], "patches": reviewed["libvncclient"]["patches"],
                    "build_configuration": portable_receipt({"tools": receipt["tools"], "commands": receipt["commands"]},
                        {str(ROOT): "${SOURCE_ROOT}", str(build): "${BUILD_ROOT}", str(dependency): "${DEPENDENCY_BUILD_ROOT}"}),
                    "binary_sha256": binary_hashes, "files": tree_hashes(package)}
        (package / "corresponding-source.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        archive_tree(package, output)
    value = {"schemaVersion": 1, "kind": "fruitctl-corresponding-source-package", "status": "passed",
             "source_archive_sha256": builder.digest(output), "sourceArchiveBytes": output.stat().st_size,
             "buildReceiptSha256": build_receipt_sha, "binary_sha256": binary_hashes,
             "publicSourceInventorySha256": public_inventory_sha, "nativeInputManifestSha256": native_manifest_sha,
             "sourceTreeSha256": receipt["sourceTreeSha256"], "nativeSourceProvenance": native_provenance,
             "qualification": "not-publicly-qualified"}
    value["publicSourceRevision"] = public["sourceRevision"]
    receipt_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": "passed", "sourceArchiveSha256": value["source_archive_sha256"], "receipt": str(receipt_path)}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, StopIteration) as error:
        print("Corresponding source refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
