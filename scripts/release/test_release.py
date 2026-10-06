#!/usr/bin/env python3
"""Exercise actual archive validation against safe and malicious release structures."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_verifier", ROOT / "scripts/verify-release.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)


class RuntimeArchiveTests(unittest.TestCase):
    files = {name: name.encode() for name in ("bin/node", "bin/fruitctl", "bin/fruitctl.mjs", "package.json",
             "lib/install/index.mjs", "integrations/agents.json", "skills/fruitctl/SKILL.md", "LICENSES/Node-24.21.0-LICENSE.txt")}

    def bundle(self, directory, extra=None, omit=None):
        path = Path(directory) / "runtime.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, data in self.files.items():
                if name == omit:
                    continue
                info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o755 if name.startswith("bin/") else 0o644
                archive.addfile(info, io.BytesIO(data))
            if extra:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size) if extra.isfile() else None)
        return path

    def validate(self, path, node_hash=None):
        return release.runtime_archive(path, node_hash or hashlib.sha256(self.files["bin/node"]).hexdigest(),
                                       hashlib.sha256(self.files["LICENSES/Node-24.21.0-LICENSE.txt"]).hexdigest())

    def test_safe_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.validate(self.bundle(directory)), 8)

    def test_node_substitution(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "Node executable"):
            self.validate(self.bundle(directory), "0" * 64)

    def test_missing_package_metadata(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "omits"):
            self.validate(self.bundle(directory, omit="package.json"))

    def test_parent_traversal(self):
        entry = tarfile.TarInfo("../escaped"); entry.size = 1
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "normalized"):
            self.validate(self.bundle(directory, entry))

    def test_symlink_refused(self):
        entry = tarfile.TarInfo("bin/alias"); entry.type = tarfile.SYMTYPE; entry.linkname = "node"
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "symlinks"):
            self.validate(self.bundle(directory, entry))

    def test_hardlink_refused(self):
        entry = tarfile.TarInfo("bin/alias"); entry.type = tarfile.LNKTYPE; entry.linkname = "bin/node"
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "hardlinks"):
            self.validate(self.bundle(directory, entry))

    def test_duplicate_file_refused(self):
        entry = tarfile.TarInfo("bin/node"); entry.size = 1
        with tempfile.TemporaryDirectory() as directory, self.assertRaisesRegex(ValueError, "duplicate"):
            self.validate(self.bundle(directory, entry))


if __name__ == "__main__":
    unittest.main()
