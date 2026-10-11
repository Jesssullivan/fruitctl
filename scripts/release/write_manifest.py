#!/usr/bin/env python3
"""Write a release manifest from actual package receipts, without publishing or qualifying it."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import tarfile
import zipfile


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def native_manifest(args, root):
    spec = importlib.util.spec_from_file_location("native_release", Path(__file__).with_name("native_release.py"))
    native = importlib.util.module_from_spec(spec); spec.loader.exec_module(native)
    native.require(not args.runtime_receipt and not args.source_archive and not args.source_receipt and not args.node_source,
                   "native-only and runtime inputs cannot be mixed")
    native.require(args.version and re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", args.version),
                   "native-only needs an explicit release tag")
    native.require(args.native_input, "native-only needs actual native input contracts")
    output_names = {"fruitctl-release.json", "SHA256SUMS", "native-evidence.json", "THIRD_PARTY_NOTICES.md"}
    native.require(not any((root / name).exists() for name in output_names), "native outputs must be new files")
    rows = []; notices = None
    for value in args.native_input:
        row, actual_notices = native.prepare_component(value, root)
        native.require(row["component"] not in {entry["component"] for entry in rows}, "duplicate native component")
        native.require(notices is None or notices == actual_notices, "native source packages contain different notices")
        native.require(not any(row[key] in output_names for key in ("archive", "submissionArchive", "sourceArchive")),
                       "native input uses reserved output name")
        notices = actual_notices; rows.append(row)
    evidence = {"schemaVersion": 1, "kind": "fruitctl-native-release-evidence", "verificationScope": native.QUALIFICATION,
                "originalReceiptHashes": native.ORIGINAL_HASH_SCOPE,
                "components": rows}
    native.public_safe(evidence)
    evidence_bytes = (json.dumps(evidence, indent=2, sort_keys=True) + "\n").encode()
    assets = native.assets_for(root, args.version, rows)
    for name, data in (("native-evidence.json", evidence_bytes), ("THIRD_PARTY_NOTICES.md", notices)):
        assets[name] = {"kind": "evidence", "name": name, "sha256": native.digest_bytes(data),
                        "url": "https://github.com/xoxd-ai/fruitctl/releases/download/" + args.version + "/" + name}
    manifest = {"schema": "fruitctl.release.v1", "mode": "native-only", "version": args.version,
                "repository": "xoxd-ai/fruitctl", "qualification": native.QUALIFICATION,
                "nativeEvidence": "native-evidence.json", "assets": sorted(assets.values(), key=lambda asset: asset["name"])}
    native.public_safe(manifest)
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode()
    checksums = "".join(asset["sha256"] + "  " + asset["name"] + "\n" for asset in manifest["assets"])
    checksums += native.digest_bytes(manifest_bytes) + "  fruitctl-release.json\n"
    # Only after all original-byte chains and complete archive maps passed.
    # Exclusive creates preserve previous release bytes even on a partial I/O failure.
    for name, data in (("native-evidence.json", evidence_bytes), ("THIRD_PARTY_NOTICES.md", notices),
                       ("fruitctl-release.json", manifest_bytes), ("SHA256SUMS", checksums.encode())):
        with (root / name).open("xb") as stream:
            stream.write(data)
    print(json.dumps({"status": "passed", "mode": "native-only", "manifestSha256": native.digest_bytes(manifest_bytes),
                      "assets": len(assets), "nativeComponents": len(rows), "qualification": native.QUALIFICATION,
                      "publication": "not-performed"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-receipt", action="append", default=[])
    parser.add_argument("--source-archive")
    parser.add_argument("--source-receipt")
    parser.add_argument("--node-source", help="Exact official Node source archive beside runtime assets")
    parser.add_argument("--native-only", action="store_true", help="Explicit native bundle; structural verification only")
    parser.add_argument("--version", help="Operator-provided native release tag; never inferred from artifacts")
    parser.add_argument("--native-input", action="append", default=[], help="Private native input JSON; repeat for original Host/controller producers")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    root = Path(args.output_dir)
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise ValueError("canonical release output directory required")
    if args.native_only:
        native_manifest(args, root)
        return
    if args.native_input or args.version:
        raise ValueError("native inputs/version require explicit --native-only")
    if not args.runtime_receipt:
        raise ValueError("runtime release requires at least one runtime receipt")
    manifest = root / "fruitctl-release.json"; checksums = root / "SHA256SUMS"
    if manifest.exists() or checksums.exists():
        raise ValueError("manifest/checksums must be new files")
    assets = []; version = None
    for value in args.runtime_receipt:
        receipt = json.loads(Path(value).read_text())
        if receipt.get("kind") != "fruitctl-runtime-package" or receipt.get("status") != "passed":
            raise ValueError("passing runtime package receipt required")
        if version is not None and version != receipt["version"]:
            raise ValueError("runtime versions differ")
        version = receipt["version"]
        asset = receipt["asset"]
        if digest(root / asset["name"]) != asset["sha256"]:
            raise ValueError("runtime bytes differ from receipt")
        assets.append(asset)
    if bool(args.source_archive) != bool(args.source_receipt):
        raise ValueError("source archive and matching receipt are required together")
    if args.source_archive:
        source = Path(args.source_archive)
        receipt = json.loads(Path(args.source_receipt).read_text())
        if receipt.get("kind") != "fruitctl-corresponding-source-package" or receipt.get("status") != "passed" or digest(source) != receipt["source_archive_sha256"]:
            raise ValueError("matching source package receipt required")
        if source.parent != root:
            raise ValueError("source archive must be beside runtime assets")
        assets.append({"kind": "source", "name": source.name,
                       "url": "https://github.com/xoxd-ai/fruitctl/releases/download/" + version + "/" + source.name,
                       "sha256": digest(source)})
    if args.node_source:
        source = Path(args.node_source)
        node = json.loads((Path(__file__).resolve().parents[2] / "LICENSES/node-runtime-provenance.json").read_text())
        if source.parent != root or digest(source) != node["source_archive"]["sha256"]:
            raise ValueError("Node source bytes differ from official input")
        assets.append({"kind": "source", "name": source.name,
                       "url": "https://github.com/xoxd-ai/fruitctl/releases/download/" + version + "/" + source.name,
                       "sha256": digest(source)})
    if not args.source_archive and not args.node_source:
        raise ValueError("runtime release needs the matching Node source asset or corresponding-source package")
    manifest.write_text(json.dumps({"schema": "fruitctl.release.v1", "version": version, "repository": "xoxd-ai/fruitctl", "assets": assets}, indent=2) + "\n")
    lines = [asset["sha256"] + "  " + asset["name"] for asset in sorted(assets, key=lambda value: value["name"])]
    lines.append(digest(manifest) + "  " + manifest.name)
    checksums.write_text("\n".join(lines) + "\n")
    print(json.dumps({"status": "passed", "manifestSha256": digest(manifest), "assets": len(assets), "publication": "not-performed"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError, zipfile.BadZipFile) as error:
        print("Release manifest refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
