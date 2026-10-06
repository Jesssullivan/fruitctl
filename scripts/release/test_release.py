#!/usr/bin/env python3
"""Exercise actual archive validation against safe and malicious release structures."""
import hashlib
import copy
import json
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import shutil
import zipfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release_verifier", ROOT / "scripts/verify-release.py")
release = importlib.util.module_from_spec(spec); spec.loader.exec_module(release)
apple_spec = importlib.util.spec_from_file_location("apple_distribution", ROOT / "scripts/release/apple_distribution.py")
apple = importlib.util.module_from_spec(apple_spec); apple_spec.loader.exec_module(apple)
source_spec = importlib.util.spec_from_file_location("source_packager", ROOT / "scripts/release/package_source.py")
source = importlib.util.module_from_spec(source_spec); source_spec.loader.exec_module(source)


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


class PrivateHostSourceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.products = self.root / "build/derived/Build/Products/Release"
        self.original = self.products / "FruitctlHost.app"
        (self.original / "Contents/MacOS").mkdir(parents=True)
        (self.original / "Contents/Info.plist").write_bytes(b"fixture original plist")
        (self.original / "Contents/MacOS/FruitctlHost").write_bytes(b"fixture original executable")
        self.built = {"artifacts": {"FruitctlHost.app": {"files": source.app_inventory(self.original)}}}
        self.build_receipt = self.write("build-receipt.json", self.built)
        self.app = self.root / "private/FruitctlHost.app"
        shutil.copytree(self.original, self.app)
        self.binary = self.app / "Contents/MacOS/FruitctlHost"
        self.binary.write_bytes(b"fixture signature changes executable bytes")
        (self.app / "Contents/_CodeSignature").mkdir()
        (self.app / "Contents/_CodeSignature/CodeResources").write_bytes(b"fixture sealed resources")
        signature = {"teamIdentifier": "QP994XQKNH", "certificateSha1": "6" * 40,
            "identifier": "com.xoxd.fruitctl.host", "description": "\n".join((
                "CodeDirectory v=20500 flags=0x10000(runtime)", "Timestamp=Oct 5, 2026",
                "Authority=Developer ID Application: Fixture (QP994XQKNH)"))}
        self.sign_value = self.receipt("fruitctl-apple-sign", buildReceiptSha256=self.sha(self.build_receipt),
            unsignedFiles=source.app_inventory(self.original), files=source.app_inventory(self.app), signature=signature)
        self.sign = self.write("sign.json", self.sign_value)
        self.zip = self.root / "submission.zip"
        with zipfile.ZipFile(self.zip, "w") as archive:
            for path in self.app.rglob("*"):
                if path.is_file():
                    archive.write(path, "FruitctlHost.app/" + path.relative_to(self.app).as_posix())
        self.archive_value = self.receipt("fruitctl-apple-submission-archive", signReceiptSha256=self.sha(self.sign),
            archiveSha256=self.sha(self.zip), archiveBytes=self.zip.stat().st_size)
        self.archive = self.write("archive.json", self.archive_value)
        self.notary_value = self.receipt("fruitctl-apple-notarization", archiveReceiptSha256=self.sha(self.archive),
            submittedArchiveSha256=self.sha(self.zip), apple={"status": "Accepted", "id": "00000000-0000-0000-0000-000000000000"})
        self.notary = self.write("notary.json", self.notary_value)
        self.staple_value = self.receipt("fruitctl-apple-staple", buildReceiptSha256=self.sha(self.build_receipt),
            signReceiptSha256=self.sha(self.sign), notarizationReceiptSha256=self.sha(self.notary),
            submissionId=self.notary_value["apple"]["id"], signature=copy.deepcopy(signature), files=source.app_inventory(self.app))
        self.staple = self.write("staple.json", self.staple_value)

    def tearDown(self):
        self.temporary.cleanup()

    def sha(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def receipt(self, kind, **fields):
        return {"kind": kind, "schemaVersion": 1, "status": "passed", "appName": "FruitctlHost.app", **fields}

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value, sort_keys=True))
        return path

    def approved(self, sign=None, archive=None, notary=None, staple=None, submissions=None):
        return source.private_app_receipts([sign or self.sign], [archive or self.archive], [notary or self.notary],
            [staple or self.staple], submissions or [self.zip], self.built, self.build_receipt)

    def descriptor(self, approved):
        return source.binary_descriptor(self.binary, self.products, self.built, {}, approved)

    def test_exact_private_bundle_with_complete_chain(self):
        self.assertEqual(self.descriptor(self.approved()), {"sha256": self.sha(self.binary), "bytes": self.binary.stat().st_size})

    def test_original_build_output_needs_no_distribution_chain(self):
        approved = source.private_app_receipts([], [], [], [], [], self.built, self.build_receipt)
        original = self.original / "Contents/MacOS/FruitctlHost"
        self.assertEqual(source.binary_descriptor(original, self.products, self.built, {}, approved),
            self.built["artifacts"]["FruitctlHost.app"]["files"]["Contents/MacOS/FruitctlHost"])

    def test_separate_publication_copy_keeps_identity_despite_path_metadata(self):
        self.sign_value["signature"]["description"] += "\nExecutable=/private/signed/FruitctlHost.app/Contents/MacOS/FruitctlHost"
        self.write("sign.json", self.sign_value)
        self.archive_value["signReceiptSha256"] = self.sha(self.sign)
        self.write("archive.json", self.archive_value)
        self.notary_value["archiveReceiptSha256"] = self.sha(self.archive)
        self.write("notary.json", self.notary_value)
        self.staple_value["signReceiptSha256"] = self.sha(self.sign)
        self.staple_value["notarizationReceiptSha256"] = self.sha(self.notary)
        self.staple_value["signature"]["description"] += "\nExecutable=/private/publication/FruitctlHost.app/Contents/MacOS/FruitctlHost"
        self.write("staple.json", self.staple_value)
        self.assertEqual(self.descriptor(self.approved())["sha256"], self.sha(self.binary))

    def test_staple_cannot_replace_signed_executable(self):
        self.staple_value["files"]["Contents/MacOS/FruitctlHost"]["sha256"] = "0" * 64
        self.write("staple.json", self.staple_value)
        with self.assertRaisesRegex(ValueError, "original signed bundle bytes"):
            self.approved()

    def test_empty_signed_inventory_is_refused(self):
        self.sign_value["files"] = {}
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "inventory is malformed"):
            self.approved()

    def test_signed_inventory_cannot_omit_an_original_resource(self):
        del self.sign_value["files"]["Contents/Info.plist"]
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "omits original bundle files"):
            self.approved()

    def test_private_path_alone_is_refused(self):
        with self.assertRaisesRegex(ValueError, "actual build output"):
            self.descriptor({})

    def test_partial_receipt_chain_is_refused(self):
        with self.assertRaisesRegex(ValueError, "sign, archive, Accepted"):
            source.private_app_receipts([self.sign], [], [], [self.staple], [self.zip], self.built, self.build_receipt)

    def test_changed_unselected_resource_is_refused(self):
        approved = self.approved()
        (self.app / "Contents/Info.plist").write_bytes(b"substituted plist despite unchanged executable")
        with self.assertRaisesRegex(ValueError, "bundle differs"):
            self.descriptor(approved)

    def test_extra_file_is_refused(self):
        approved = self.approved()
        (self.app / "Contents/unreviewed-helper").write_bytes(b"extra executable")
        with self.assertRaisesRegex(ValueError, "bundle differs"):
            self.descriptor(approved)

    def test_escaping_resource_symlink_is_refused(self):
        approved = self.approved()
        target = self.app / "Contents/Info.plist"
        target.unlink(); target.symlink_to(self.original / "Contents/Info.plist")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.descriptor(approved)

    def test_wrong_unsigned_bundle_is_refused(self):
        self.sign_value["unsignedFiles"]["Contents/Info.plist"]["sha256"] = "0" * 64
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "exact unsigned"):
            self.approved()

    def test_wrong_build_receipt_is_refused(self):
        self.sign_value["buildReceiptSha256"] = "0" * 64
        self.write("sign.json", self.sign_value)
        with self.assertRaisesRegex(ValueError, "tested build"):
            self.approved()

    def test_duplicate_receipt_is_refused(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            source.private_app_receipts([self.sign, self.sign], [self.archive], [self.notary], [self.staple],
                [self.zip], self.built, self.build_receipt)

    def test_malformed_receipt_is_refused(self):
        malformed = self.write("malformed.json", [])
        with self.assertRaisesRegex(ValueError, "passing distribution"):
            self.approved(sign=malformed)

    def test_changed_archive_receipt_is_refused(self):
        self.archive_value["signReceiptSha256"] = "0" * 64
        self.write("archive.json", self.archive_value)
        with self.assertRaisesRegex(ValueError, "signing receipt chain"):
            self.approved()

    def test_changed_submission_zip_is_refused(self):
        self.zip.write_bytes(b"substituted submission archive")
        with self.assertRaisesRegex(ValueError, "submission archive chain"):
            self.approved()

    def test_not_accepted_submission_is_refused(self):
        self.notary_value["apple"]["status"] = "Invalid"
        self.write("notary.json", self.notary_value)
        with self.assertRaisesRegex(ValueError, "actual Accepted"):
            self.approved()

    def test_wrong_stapled_submission_is_refused(self):
        self.staple_value["submissionId"] = "11111111-1111-1111-1111-111111111111"
        self.write("staple.json", self.staple_value)
        with self.assertRaisesRegex(ValueError, "Accepted/staple"):
            self.approved()

    def test_absent_developer_id_metadata_is_refused(self):
        self.sign_value["signature"]["certificateSha1"] = ""
        self.staple_value["signature"] = copy.deepcopy(self.sign_value["signature"])
        self.write("sign.json", self.sign_value); self.write("staple.json", self.staple_value)
        with self.assertRaisesRegex(ValueError, "lacks verified Developer ID"):
            self.approved()


if __name__ == "__main__":
    unittest.main()
