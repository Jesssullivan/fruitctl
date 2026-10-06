#!/usr/bin/env python3
"""Record explicit public source bytes from Git; omit historical opaque native archives."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-working-tree", action="store_true", help="Explicit review candidate, not an immutable published source snapshot")
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or output.exists():
        raise ValueError("new absolute output path required")
    status = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
    if status and not args.allow_working_tree:
        raise ValueError("immutable source snapshot requires a clean Git checkout")
    files = {}
    names = subprocess.check_output(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    for name in sorted(set(names)):
        if not name or "__pycache__" in Path(name).parts:
            continue
        path = ROOT / name
        if name.startswith("vendor/libvnc/prebuilt/") and path.suffix in (".a", ".dylib", ".so"):
            continue
        if not path.is_file() or path.is_symlink():
            raise ValueError("public source inventory requires regular files: " + name)
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    output.write_text(json.dumps({"schemaVersion": 1, "kind": "fruitctl-public-source-inventory", "sourceRevision": revision,
                                 "workingTreeClean": not bool(status), "files": files}, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"status": "passed", "sourceRevision": revision, "files": len(files),
                      "inventorySha256": hashlib.sha256(output.read_bytes()).hexdigest(), "workingTreeClean": not bool(status)}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit("Source snapshot refused: " + str(error))
