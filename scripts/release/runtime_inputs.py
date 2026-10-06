"""Locked npm archive checks shared by stage preparation and runtime packaging."""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def locked_dependencies(root):
    lock = json.loads((root / "package-lock.json").read_text())
    notices = json.loads((root / "LICENSES/npm-dependencies.json").read_text())
    entries = {name: value for name, value in lock["packages"].items() if name}
    digest = sha(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode())
    require(notices["dependency_entries_sha256"] == digest, "npm notice inventory differs from current dependency lock")
    inventory = {entry["lock_path"]: entry for entry in notices["packages"]}
    require(set(inventory) == set(entries), "npm notice inventory does not cover exactly the locked packages")
    result = {}
    for name, value in entries.items():
        notice = inventory[name]
        require(value["version"] == notice["version"] and value["resolved"] == notice["source_archive_url"]
                and value["integrity"] == notice["source_archive_integrity"], "npm notice input differs from lock: " + name)
        if not value.get("dev", False):
            require(name.startswith("node_modules/") and ".." not in Path(name).parts, "unsafe dependency lock path")
            result[name] = notice
    return result, digest


def archive_name(entry):
    return entry["source_archive_sha256"] + ".tgz"


def download(entry, destination):
    request = urllib.request.Request(entry["source_archive_url"], headers={"User-Agent": "fruitctl-release/1"})
    with urllib.request.urlopen(request, timeout=90) as response, destination.open("xb") as stream:
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            stream.write(block)
    return archive_files(entry, destination)


def archive_files(entry, path):
    data = path.read_bytes()
    require(sha(data) == entry["source_archive_sha256"], "npm archive SHA-256 differs from license inventory")
    require(any(base64.b64encode(hashlib.new(value.split("-", 1)[0], data).digest()).decode() == value.split("-", 1)[1]
                for value in entry["source_archive_integrity"].split()), "npm archive differs from lock integrity")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive.getmembers():
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and ".." not in name.parts and len(name.parts) > 1
                    and name.parts[0] == "package", "unsafe npm archive path")
            require(member.isfile() or member.isdir(), "npm archive contains linked or special entries")
            if member.isfile():
                relative = PurePosixPath(*name.parts[1:]).as_posix()
                require(relative not in files, "duplicate npm archive file")
                files[relative] = {"data": archive.extractfile(member).read(), "mode": 0o755 if member.mode & 0o111 else 0o644}
    require("package.json" in files, "npm package metadata is absent")
    package = json.loads(files["package.json"]["data"])
    require(package["name"] == entry["name"] and package["version"] == entry["version"], "npm archive identity differs from locked package")
    return files


def verify_stage(root, stage, inventory_path, archives):
    dependencies, lock_digest = locked_dependencies(root)
    inventory = json.loads(inventory_path.read_text())
    require(inventory.get("kind") == "fruitctl-runtime-stage" and inventory.get("schemaVersion") == 1
            and inventory.get("status") == "passed", "passing explicit runtime stage inventory required")
    require(inventory["dependencyEntriesSha256"] == lock_digest, "runtime stage dependency lock changed")
    require(file_sha(stage / "package-lock.json") == file_sha(root / "package-lock.json"), "runtime stage carries a different dependency lock")
    actual = {}
    for path in sorted(stage.rglob("*")):
        require(not path.is_symlink(), "runtime stage symlinks are refused")
        if path.is_file():
            actual[path.relative_to(stage).as_posix()] = file_sha(path)
    require(actual == inventory["files"], "runtime stage bytes differ from reviewed inventory")
    expected = {}
    for name, entry in dependencies.items():
        for relative, file in archive_files(entry, archives / archive_name(entry)).items():
            expected[name + "/" + relative] = sha(file["data"])
    require({name: value for name, value in actual.items() if name.startswith("node_modules/")} == expected,
            "staged production dependency files differ from exact locked source archives")
    for name, value in inventory["sourceFiles"].items():
        require(file_sha(root / name) == value == actual[name], "runtime authored source changed after staging: " + name)
    return inventory
