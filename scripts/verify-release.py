#!/usr/bin/env python3
"""Verify exact local release assets and safe installer archive structure; never publish."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def runtime_archive(path, node_hash, node_license_hash=None):
    required = {"bin/node", "bin/fruitctl", "bin/fruitctl.mjs", "lib/install/index.mjs",
                "package.json", "integrations/agents.json", "skills/fruitctl/SKILL.md", "LICENSES/Node-24.21.0-LICENSE.txt"}
    files = {}; seen = set()
    with tarfile.open(path) as archive:
        for member in archive.getmembers():
            name = Path(member.name)
            require(not name.is_absolute() and ".." not in name.parts and name.as_posix() == member.name,
                    "archive path must be normalized and relative")
            require(member.isfile() or member.isdir(), "archive symlinks/hardlinks/devices are refused")
            require(member.name not in seen, "duplicate archive entry")
            seen.add(member.name)
            if member.isfile():
                files[member.name] = member
        require(required.issubset(files), "runtime archive omits required installer files or Node license")
        for name in ("bin/node", "bin/fruitctl"):
            require(files[name].mode & 0o111, "runtime executable lacks execute permission")
        node = archive.extractfile(files["bin/node"])
        value = hashlib.sha256()
        for block in iter(lambda: node.read(1024 * 1024), b""):
            value.update(block)
        require(value.hexdigest() == node_hash, "runtime Node executable differs from official pinned bytes")
        if node_license_hash:
            require(hashlib.sha256(archive.extractfile(files["LICENSES/Node-24.21.0-LICENSE.txt"]).read()).hexdigest() == node_license_hash,
                    "runtime Node license differs from pinned notice bytes")
    return len(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("--assets-dir", required=True)
    parser.add_argument("--native-only", action="store_true", help="Verify native bundle explicitly; does not authenticate Apple or qualify runtime")
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    require(manifest.get("schema") == "fruitctl.release.v1" and manifest.get("repository") == "xoxd-ai/fruitctl", "unexpected release schema or repository")
    version = manifest.get("version")
    require(isinstance(version, str) and re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version), "exact release tag required")
    assets = manifest.get("assets")
    require(isinstance(assets, list) and assets, "release assets are absent")
    root = Path(args.assets_dir)
    require(root.is_absolute() and root.resolve(strict=True) == root, "canonical asset directory required")
    if args.native_only:
        spec = importlib.util.spec_from_file_location("native_release", ROOT / "scripts/release/native_release.py")
        native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
        require(native.canonical_file(args.manifest) == root / "fruitctl-release.json", "native manifest must be beside its assets")
        manifest = native.json_bytes(Path(args.manifest).read_bytes())
        require(manifest.get("schema") == "fruitctl.release.v1" and manifest.get("repository") == "xoxd-ai/fruitctl"
                and manifest.get("version") == version, "native manifest identity differs")
        require(manifest.get("nativeEvidence") == "native-evidence.json", "native evidence asset required")
        evidence = native.json_bytes(native.canonical_file(root / "native-evidence.json").read_bytes())
        count = native.verify_native(manifest, root, evidence)
        expected = {asset["name"]: asset["sha256"] for asset in assets}
        expected[Path(args.manifest).name] = digest(Path(args.manifest))
        lines = native.canonical_file(root / "SHA256SUMS").read_text().splitlines()
        actual = {}
        for line in lines:
            match = re.fullmatch(r"([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._-]+)", line)
            require(match is not None and match.group(2) not in actual, "invalid or duplicate checksum row")
            actual[match.group(2)] = match.group(1)
        require(actual == expected, "native checksum inventory differs")
        print(json.dumps({"kind": "fruitctl-release-structure-verification", "schemaVersion": 1, "status": "passed",
                          "mode": "native-only", "manifestSha256": digest(Path(args.manifest)), "assetsVerified": len(assets),
                          "nativeComponents": count, "runtimeCount": 0, "qualification": native.QUALIFICATION,
                          "appleAuthentication": "not-performed", "originalPrivateReceiptBytes": "not-reconstructed-from-projections"}))
        return
    require(manifest.get("mode", "runtime") == "runtime", "native bundle requires explicit --native-only")
    node = json.loads((ROOT / "LICENSES/node-runtime-provenance.json").read_text())
    names = set(); platforms = set(); runtime_count = 0
    for asset in assets:
        name = asset.get("name")
        require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]+", name) and name not in names, "invalid or duplicate asset name")
        names.add(name)
        require(asset.get("url") == "https://github.com/xoxd-ai/fruitctl/releases/download/" + version + "/" + name,
                "asset URL is not its immutable canonical release route")
        require(isinstance(asset.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", asset["sha256"]), "invalid asset digest")
        path = root / name
        require(path.is_file() and not path.is_symlink() and digest(path) == asset["sha256"], "asset bytes differ: " + name)
        require(asset.get("kind") in ("runtime", "source", "native", "evidence"), "unknown asset kind")
        if asset["kind"] == "runtime":
            platform = (asset.get("os"), asset.get("arch"))
            require(platform not in platforms and platform[0] in ("darwin", "linux") and platform[1] in ("arm64", "x64"), "invalid or duplicate runtime platform")
            platforms.add(platform)
            expected = "fruitctl-" + version + "-" + platform[0] + "-" + platform[1] + ".tar.gz"
            require(name == expected, "runtime name differs from installer contract")
            entry = next((binary for binary in node["binaries"] if binary["platform"] == "-".join(platform)), None)
            require(entry is not None, "platform has no pinned Node provenance")
            runtime_archive(path, entry["executable_sha256"], entry["license_sha256"])
            runtime_count += 1
    require(runtime_count > 0, "release contains no installable runtime")
    print(json.dumps({"kind": "fruitctl-release-structure-verification", "schemaVersion": 1, "status": "passed",
                      "manifestSha256": digest(Path(args.manifest)), "assetsVerified": len(assets), "runtimeCount": runtime_count,
                      "runtimeQualification": "not-established-by-structural-verification"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError, zipfile.BadZipFile) as error:
        print("Release asset refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
