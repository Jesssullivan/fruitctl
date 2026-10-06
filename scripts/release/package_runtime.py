#!/usr/bin/env python3
"""Assemble a runtime with pinned Node bytes and preserved license notices; never publish."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("source_package", ROOT / "scripts/release/package_source.py")
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)
runtime_spec = importlib.util.spec_from_file_location("runtime_inputs", Path(__file__).with_name("runtime_inputs.py"))
inputs = importlib.util.module_from_spec(runtime_spec); runtime_spec.loader.exec_module(inputs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, help="Explicit prepared runtime tree, never the full repository")
    parser.add_argument("--version", required=True, help="Exact GitHub release tag")
    parser.add_argument("--os", required=True, choices=("darwin", "linux"))
    parser.add_argument("--arch", required=True, choices=("arm64", "x64"))
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--stage-inventory", required=True)
    parser.add_argument("--npm-inputs", required=True)
    args = parser.parse_args()
    stage = Path(args.stage)
    destination = Path(args.output_dir)
    source.require(stage.is_absolute() and stage.resolve(strict=True) == stage, "canonical prepared stage required")
    reviewed = inputs.verify_stage(ROOT, stage, Path(args.stage_inventory), Path(args.npm_inputs))
    source.require(destination.is_absolute() and destination.is_dir() and not destination.is_symlink(), "existing canonical output directory required")
    source.require(re.fullmatch(r"v?[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", args.version), "exact version tag required")
    node = json.loads((ROOT / "LICENSES/node-runtime-provenance.json").read_text())
    platform = args.os + "-" + args.arch
    entry = next((binary for binary in node["binaries"] if binary["platform"] == platform), None)
    source.require(entry is not None and node["version"] == "24.21.0", "reviewed Node platform is missing")
    required = ("package.json", "bin/fruitctl", "bin/fruitctl.mjs", "lib/install/index.mjs", "integrations/agents.json", "skills/fruitctl/SKILL.md")
    for name in required:
        path = stage / name
        source.require(path.is_file() and not path.is_symlink(), "runtime required file is missing: " + name)
    source.require((stage / "bin/fruitctl").stat().st_mode & 0o111, "Fruitctl launcher must be executable")
    asset_name = "fruitctl-" + args.version + "-" + args.os + "-" + args.arch + ".tar.gz"
    output = destination / asset_name
    receipt_path = destination / (asset_name + ".receipt.json")
    source.require(not output.exists() and not receipt_path.exists(), "runtime outputs must be new")
    with tempfile.TemporaryDirectory(prefix="fruitctl-runtime-", dir=destination) as workspace:
        workspace = Path(workspace)
        package = workspace / "package"
        package.mkdir()
        for path in sorted(stage.rglob("*")):
            relative = path.relative_to(stage)
            if ".bin" in relative.parts and "node_modules" in relative.parts:
                continue
            source.require(not path.is_symlink(), "runtime stage contains a symlink: " + relative.as_posix())
            if path.is_file():
                target = package / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, target)
                target.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
        archive = workspace / "node.tar.gz"
        source.builder.download({"url": entry["source_url"], **entry}, archive)
        with tarfile.open(archive) as upstream:
            node_entry = next(item for item in upstream.getmembers() if item.isfile() and item.name.endswith("/bin/node"))
            node_data = upstream.extractfile(node_entry).read()
            source.require(source.hashlib.sha256(node_data).hexdigest() == entry["executable_sha256"], "Node executable hash differs")
            (package / "bin/node").write_bytes(node_data)
            (package / "bin/node").chmod(0o755)
        notices = package / "LICENSES"
        notices.mkdir(exist_ok=True)
        npm = json.loads((stage / "LICENSES/npm-dependencies.json").read_text())
        for dependency in npm["packages"]:
            for notice in dependency["notices"]:
                source.require(source.builder.digest(stage / notice["path"]) == notice["sha256"], "npm notice bytes differ")
        for license_entry in node["license_files"]:
            notice = stage / license_entry["path"]
            source.require(source.builder.digest(notice) == license_entry["sha256"], "Node license bytes differ")
            shutil.copyfile(notice, notices / notice.name)
        shutil.copyfile(stage / "LICENSES/node-runtime-provenance.json", notices / "node-runtime-provenance.json")
        inputs.verify_stage(ROOT, stage, Path(args.stage_inventory), Path(args.npm_inputs))
        source.archive_tree(package, output)
    sha = source.builder.digest(output)
    receipt = {"schemaVersion": 1, "kind": "fruitctl-runtime-package", "status": "passed", "qualification": "not-publicly-qualified",
               "version": args.version, "os": args.os, "arch": args.arch, "runtimeSha256": sha,
               "nodeVersion": node["version"], "nodeArchiveSha256": entry["sha256"], "nodeExecutableSha256": entry["executable_sha256"],
               "stageInventorySha256": source.builder.digest(Path(args.stage_inventory)),
               "dependencyEntriesSha256": reviewed["dependencyEntriesSha256"], "runtimeFiles": reviewed["files"],
               "asset": {"kind": "runtime", "os": args.os, "arch": args.arch, "name": asset_name,
                         "url": "https://github.com/xoxd-ai/fruitctl/releases/download/" + args.version + "/" + asset_name, "sha256": sha}}
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": "passed", "asset": receipt["asset"], "qualification": "not-publicly-qualified"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, StopIteration) as error:
        print("Runtime package refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
