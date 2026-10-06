#!/usr/bin/env python3
"""Verify rejection of substituted, mutable, linked and unmanifested native inputs."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("native_input", ROOT / "scripts/verify-native-input.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeInputTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.inputs = self.root / "inputs"
        self.inputs.mkdir()
        self.manifest = self.root / "manifest.json"
        self.files = {}
        for name in ("lib/libvncclient.a", "lib/libssl.a", "lib/libcrypto.a", "module.modulemap",
                     "include/CLibVNCClient.h", "include/rfb/rfbclient.h", "include/rfb/rfbconfig.h"):
            path = self.inputs / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())
            self.files[name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size}
        self.write_manifest()
        for path in self.inputs.rglob("*"):
            path.chmod(0o555 if path.is_dir() else 0o444)
        self.inputs.chmod(0o555)

    def write_manifest(self):
        if self.manifest.exists():
            self.manifest.chmod(0o644)
        self.manifest.write_text(json.dumps({"schemaVersion": 1, "kind": "fruitctl-native-inputs", "platform": "darwin",
            "architecture": "arm64", "minimumMacOS": "15.0", "sourceLockSha256": module.sha256(ROOT / "release/native-dependencies.lock.json"),
            "files": self.files}))
        self.manifest.chmod(0o444)

    def tearDown(self):
        self.inputs.chmod(0o755)
        for path in self.inputs.rglob("*"):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o755)
        self.temporary.cleanup()

    def test_valid_inventory(self):
        self.assertEqual(module.verify(self.manifest, self.inputs)["filesVerified"], 7)

    def test_substitution_refused(self):
        path = self.inputs / "lib/libssl.a"
        path.chmod(0o644); path.write_bytes(b"substituted"); path.chmod(0o444)
        with self.assertRaisesRegex(ValueError, "input bytes"):
            module.verify(self.manifest, self.inputs)

    def test_writable_archive_refused(self):
        (self.inputs / "lib/libssl.a").chmod(0o644)
        with self.assertRaisesRegex(ValueError, "read-only"):
            module.verify(self.manifest, self.inputs)

    def test_hardlinked_archive_refused(self):
        (self.root / "alias").hardlink_to(self.inputs / "lib/libssl.a")
        with self.assertRaisesRegex(ValueError, "single-link"):
            module.verify(self.manifest, self.inputs)

    def test_unmanifested_file_refused(self):
        self.inputs.chmod(0o755)
        (self.inputs / "surprise").write_text("unexpected")
        (self.inputs / "surprise").chmod(0o444); self.inputs.chmod(0o555)
        with self.assertRaisesRegex(ValueError, "unmanifested"):
            module.verify(self.manifest, self.inputs)

    def test_symlink_refused(self):
        directory = self.inputs / "lib"
        directory.chmod(0o755)
        path = directory / "libssl.a"
        path.unlink(); path.symlink_to(directory / "libcrypto.a"); directory.chmod(0o555)
        with self.assertRaisesRegex(ValueError, "regular"):
            module.verify(self.manifest, self.inputs)

    def test_parent_path_manifest_refused(self):
        self.files["../escape"] = {"sha256": "0" * 64, "bytes": 1}
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "normalized"):
            module.verify(self.manifest, self.inputs)


if __name__ == "__main__":
    unittest.main()
