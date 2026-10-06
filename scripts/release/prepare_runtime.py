#!/usr/bin/env python3
"""Create a reviewed runtime stage directly from public source and locked npm archives."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("runtime_inputs", Path(__file__).with_name("runtime_inputs.py"))
inputs = importlib.util.module_from_spec(spec); spec.loader.exec_module(inputs)

SOURCE_FILES = ("package.json", "package-lock.json", "index.js", "LICENSE", "THIRD_PARTY_NOTICES.md")
SOURCE_ROOTS = ("bin", "lib", "tools", "integrations", "skills", "LICENSES")


def git_revision(root):
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()


def stage_authored_source(root, stage, reviewed_revision=None):
    """Copy curated tracked files only when their source still matches Git HEAD."""
    revision = reviewed_revision or git_revision(root)
    tracked = {os.fsdecode(name) for name in subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=root).split(b"\0") if name}
    inputs.require(set(SOURCE_FILES) <= tracked, "required public runtime source files must be tracked")
    names = sorted(name for name in tracked if name in SOURCE_FILES or Path(name).parts[0] in SOURCE_ROOTS)
    inputs.require(root.resolve() == root and not root.is_symlink(), "public runtime source symlinks are refused")
    for name in names:
        path = root
        for component in Path(name).parts:
            path = path / component
            inputs.require(not path.is_symlink(), "public runtime source symlinks are refused")
        inputs.require(path.is_file(), "public runtime source must be a regular file: " + name)
    # Index-only additions and modified tracked bytes are not reviewed HEAD
    # inputs. Untracked/ignored files and changes outside the curated roots do
    # not alter the runtime's authored source set.
    changed = subprocess.check_output(
        ["git", "diff", "--name-only", "-z", revision, "--", *SOURCE_FILES, *SOURCE_ROOTS], cwd=root)
    inputs.require(not changed, "public runtime authored source must match Git HEAD")
    # Bind hashes to immutable committed blobs, not a second mutable working
    # tree read after the cleanliness check.
    source_files = {name: inputs.sha(subprocess.check_output(
        ["git", "show", revision + ":" + name], cwd=root)) for name in names}
    for name in source_files:
        path = root / name; target = stage / name
        inputs.require(inputs.file_sha(path) == source_files[name], "public runtime authored source must match Git HEAD")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target); target.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
        inputs.require(inputs.file_sha(target) == source_files[name], "public runtime authored source changed during copying")
    inputs.require(git_revision(root) == revision, "public runtime source revision changed during staging")
    return source_files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--reuse-archives", help="Existing reviewed npm input cache; every copied archive is reverified")
    args = parser.parse_args()
    output = Path(args.output_dir)
    inputs.require(output.is_absolute() and output.resolve() == output and not output.exists(), "new canonical task-owned output required")
    output.mkdir(parents=True)
    stage = output / "stage"; stage.mkdir()
    archives = output / "npm-inputs"; archives.mkdir()
    dependencies, lock_digest = inputs.locked_dependencies(ROOT)
    source_revision = git_revision(ROOT)
    source_files = stage_authored_source(ROOT, stage, reviewed_revision=source_revision)

    unique = {inputs.archive_name(entry): entry for entry in dependencies.values()}
    def fetch(value):
        name, entry = value
        cached = Path(args.reuse_archives) / name if args.reuse_archives else None
        if cached and cached.is_file() and not cached.is_symlink():
            shutil.copyfile(cached, archives / name)
            return inputs.archive_files(entry, archives / name)
        return inputs.download(entry, archives / name)
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(fetch, unique.items()))

    def prepare(value):
        name, entry = value
        files = inputs.archive_files(entry, archives / inputs.archive_name(entry))
        for relative, item in files.items():
            target = stage / name / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(item["data"]); target.chmod(item["mode"])
        return {"name": entry["name"], "version": entry["version"], "archiveSha256": entry["source_archive_sha256"]}

    with ThreadPoolExecutor(max_workers=4) as pool:
        installed = list(pool.map(prepare, dependencies.items()))
    inputs.require(git_revision(ROOT) == source_revision, "public runtime source revision changed during staging")
    inventory = {"schemaVersion": 1, "kind": "fruitctl-runtime-stage", "status": "passed",
                 "sourceRevision": source_revision,
                 "dependencyEntriesSha256": lock_digest, "sourceFiles": source_files, "productionPackages": installed,
                 "files": {path.relative_to(stage).as_posix(): inputs.file_sha(path) for path in sorted(stage.rglob("*")) if path.is_file()}}
    path = output / "runtime-stage.json"
    path.write_text(json.dumps(inventory, indent=2, sort_keys=True) + "\n")
    inputs.verify_stage(ROOT, stage, path, archives)
    print(json.dumps({"status": "passed", "stage": str(stage), "inventory": str(path), "productionPackages": len(installed)}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("Runtime stage refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
