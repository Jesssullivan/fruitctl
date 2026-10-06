#!/usr/bin/env python3
"""Write a release manifest from actual package receipts, without publishing or qualifying it."""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-receipt", action="append", required=True)
    parser.add_argument("--source-archive")
    parser.add_argument("--source-receipt")
    parser.add_argument("--node-source", help="Exact official Node source archive beside runtime assets")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    root = Path(args.output_dir)
    if not root.is_absolute() or root.resolve(strict=True) != root:
        raise ValueError("canonical release output directory required")
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
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("Release manifest refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
