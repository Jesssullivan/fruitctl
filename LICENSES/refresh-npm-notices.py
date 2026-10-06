#!/usr/bin/env python3
"""Copy exact notices from integrity-verified locked npm package archives.

This does not install packages or execute package scripts. Run from the repo
root after changing package-lock.json. Obsolete notice files are retained until
the maintainer removes them after checking their consumers.
"""

import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parent.parent
NOTICE_ROOT = ROOT / "LICENSES" / "npm"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fetch_notices(entry):
    lock_path, package = entry
    name = lock_path.rsplit("node_modules/", 1)[1]
    request = urllib.request.Request(
        package["resolved"], headers={"User-Agent": "fruitctl-license-inventory/1"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        archive = response.read()
    integrity = package["integrity"]
    candidates = integrity.split()
    verified = any(
        base64.b64encode(hashlib.new(value.split("-", 1)[0], archive).digest()).decode()
        == value.split("-", 1)[1]
        for value in candidates
    )
    if not verified:
        raise ValueError(f"npm integrity mismatch: {name}@{package['version']}")
    notices = []
    slug = re.sub(r"[^a-zA-Z0-9._-]", "_", name)
    destination = NOTICE_ROOT / f"{slug}@{package['version']}"
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
        for member in sorted(bundle.getmembers(), key=lambda member: member.name):
            basename = PurePosixPath(member.name).name
            if not member.isfile() or not re.match(
                r"^(licen[cs]e|copying|notice)([._-]|$)", basename, re.IGNORECASE
            ):
                continue
            relative = PurePosixPath(member.name)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"unsafe notice archive path: {member.name}")
            extracted = bundle.extractfile(member)
            if extracted is None:
                raise ValueError(f"unreadable notice: {member.name}")
            data = extracted.read()
            # Preserve nested third-party notices, and their relative names.
            retained = destination.joinpath(*relative.parts[1:])
            retained.parent.mkdir(parents=True, exist_ok=True)
            retained.write_bytes(data)
            notices.append({
                "upstream_path": member.name,
                "path": retained.relative_to(ROOT).as_posix(),
                "sha256": digest(data),
            })
    if not notices:
        raise ValueError(f"no license/notice file found: {name}@{package['version']}")
    return {
        "name": name,
        "version": package["version"],
        "lock_path": lock_path,
        "scope": "development" if package.get("dev", False) else "runtime",
        "license_expression": package["license"],
        "source_archive_url": package["resolved"],
        "source_archive_integrity": integrity,
        "source_archive_sha256": digest(archive),
        "notices": notices,
    }


def main():
    lock = json.loads((ROOT / "package-lock.json").read_text())
    entries = sorted((path, value) for path, value in lock["packages"].items() if path)
    # Hash only dependency entries: a product-name change is not a dependency change.
    dependency_bytes = json.dumps(dict(entries), sort_keys=True, separators=(",", ":")).encode()
    with ThreadPoolExecutor(max_workers=6) as pool:
        packages = list(pool.map(fetch_notices, entries))
    inventory = {
        "schema_version": 1,
        "source": "package-lock.json",
        "dependency_entries_sha256": digest(dependency_bytes),
        "package_count": len(packages),
        "generation": "python3 LICENSES/refresh-npm-notices.py",
        "verification": "Downloaded package archives match locked npm integrity; notice bytes retained exactly.",
        "packages": packages,
    }
    target = ROOT / "LICENSES" / "npm-dependencies.json"
    target.write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({"packages": len(packages), "notices": sum(len(p['notices']) for p in packages)}))


if __name__ == "__main__":
    main()
