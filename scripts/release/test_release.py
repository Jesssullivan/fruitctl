#!/usr/bin/env python3
"""Exercise actual archive validation against safe and malicious release structures."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_verifier", ROOT / "scripts/verify-release.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
apple_spec = importlib.util.spec_from_file_location("apple_distribution", ROOT / "scripts/release/apple_distribution.py")
apple = importlib.util.module_from_spec(apple_spec); apple_spec.loader.exec_module(apple)


class AppleCertificateTests(unittest.TestCase):
    description = "\n".join(("Identifier=com.xoxd.fruitctl.host", "TeamIdentifier=QP994XQKNH",
        "CodeDirectory v=20500 flags=0x10000(runtime)", "Timestamp=Oct 5, 2026",
        "Authority=Developer ID Application: Test (QP994XQKNH)"))
    certificate = b"public leaf certificate fixture"

    def fake_codesign(self, command):
        if any(str(value).startswith("--extract-certificates") for value in command):
            # Model codesign's optional argument parsing: the separate-prefix
            # form selects a nonexistent signed-code path instead of a prefix.
            self.assertEqual(len(command), 4)
            self.assertTrue(str(command[2]).startswith("--extract-certificates="))
            Path(str(command[2]).split("=", 1)[1] + "0").write_bytes(self.certificate)
            return ""
        return self.description if "--display" in command else ""

    def test_signature_leaf_is_extracted_with_explicit_option_value(self):
        expected = hashlib.sha1(self.certificate).hexdigest().upper()
        with patch.object(apple, "run", self.fake_codesign):
            result = apple.metadata(Path("/reviewed/FruitctlHost.app"), "QP994XQKNH", expected)
        self.assertEqual(result["certificateSha1"], expected)

    def test_other_leaf_certificate_is_refused(self):
        with patch.object(apple, "run", self.fake_codesign), self.assertRaisesRegex(ValueError, "leaf certificate"):
            apple.metadata(Path("/reviewed/FruitctlHost.app"), "QP994XQKNH", "0" * 40)


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
