#!/usr/bin/env python3
"""Bind regenerated native dependencies to reviewed sources and exact input bytes.

This is a separate rail from the historical verify-openssl-input.py receipt.
Before/after checks do not make owner-controlled inputs immutable during linking;
the build owner retains exclusive custody of the task-owned staging directory.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identity(value):
    return (value.st_dev, value.st_ino, value.st_uid, value.st_gid, value.st_mode,
            value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def verify(manifest_path, input_path):
    manifest_path = Path(manifest_path)
    inputs = Path(input_path)
    require(manifest_path.is_absolute() and inputs.is_absolute(), "absolute paths are required")
    require(manifest_path.resolve(strict=True) == manifest_path, "manifest path must be canonical")
    manifest_before = manifest_path.lstat()
    require(stat.S_ISREG(manifest_before.st_mode) and manifest_before.st_nlink == 1
            and manifest_before.st_mode & 0o222 == 0, "manifest must be a read-only regular single-link file")
    require(inputs.resolve(strict=True) == inputs, "input directory must be canonical")
    require(not inputs.is_symlink(), "input directory cannot be a symlink")
    manifest = json.loads(manifest_path.read_text())
    manifest_digest = sha256(manifest_path)
    require(identity(manifest_path.lstat()) == identity(manifest_before), "manifest changed during read")
    require(manifest.get("schemaVersion") == 1 and manifest.get("kind") == "fruitctl-native-inputs",
            "unrecognized input manifest")
    require(manifest.get("platform") == "darwin" and manifest.get("architecture") == "arm64",
            "only qualified Darwin arm64 inputs are supported")
    require(manifest.get("minimumMacOS") == "15.0", "unexpected deployment floor")
    lock = Path(__file__).resolve().parents[1] / "release/native-dependencies.lock.json"
    require(manifest.get("sourceLockSha256") == sha256(lock), "reviewed source lock does not match")
    entries = manifest.get("files")
    require(isinstance(entries, dict) and entries, "input files are missing")
    for name, expected in entries.items():
        relative = Path(name)
        require(not relative.is_absolute() and ".." not in relative.parts and relative.as_posix() == name,
                "manifest file names must be normalized relative paths")
        require(isinstance(expected, dict) and set(expected) == {"sha256", "bytes"}
                and isinstance(expected["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", expected["sha256"])
                and isinstance(expected["bytes"], int) and not isinstance(expected["bytes"], bool)
                and expected["bytes"] > 0, "invalid file hash or byte count")
    required = {"lib/libvncclient.a", "lib/libssl.a", "lib/libcrypto.a", "module.modulemap",
                "include/CLibVNCClient.h", "include/rfb/rfbclient.h", "include/rfb/rfbconfig.h"}
    require(required.issubset(entries), "required native archive/module/header is missing")
    actual = set()
    for directory, subdirs, files in os.walk(inputs, followlinks=False):
        directory = Path(directory)
        require(not directory.is_symlink() and directory.stat().st_mode & 0o222 == 0,
                "input directories must be read-only")
        for name in subdirs:
            require(not (directory / name).is_symlink(), "input directory symlink refused")
        for name in files:
            path = directory / name
            relative = path.relative_to(inputs).as_posix()
            actual.add(relative)
            require(relative in entries, "unmanifested input file: " + relative)
            before = path.lstat()
            require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_mode & 0o222 == 0,
                    "inputs must be read-only, regular single-link files")
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                bound = os.fstat(descriptor)
                require(identity(bound) == identity(before), "input binding changed before verification")
                digest = hashlib.sha256()
                while True:
                    block = os.read(descriptor, 1024 * 1024)
                    if not block:
                        break
                    digest.update(block)
                expected = entries[relative]
                require(expected.get("bytes") == before.st_size and expected.get("sha256") == digest.hexdigest(),
                        "input bytes do not match manifest: " + relative)
                require(identity(os.fstat(descriptor)) == identity(before) and identity(path.lstat()) == identity(before),
                        "input changed during verification")
            finally:
                os.close(descriptor)
    require(actual == set(entries), "manifested input file is absent")
    require(identity(manifest_path.lstat()) == identity(manifest_before)
            and sha256(manifest_path) == manifest_digest, "manifest changed during verification")
    return {"kind": "fruitctl-native-input-verification", "schemaVersion": 1,
            "manifestSha256": manifest_digest, "sourceLockSha256": sha256(lock),
            "filesVerified": len(actual), "architecture": "arm64", "status": "passed"}


if __name__ == "__main__":
    try:
        require(len(sys.argv) == 4 and sys.argv[3] in ("before-link", "after-link"),
                "usage: verify-native-input.py MANIFEST INPUT_DIR before-link|after-link")
        receipt = verify(sys.argv[1], sys.argv[2])
        receipt["phase"] = sys.argv[3]
        print(json.dumps(receipt, sort_keys=True))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print("Native input refused: " + str(error), file=sys.stderr)
        raise SystemExit(1)
