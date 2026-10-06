#!/usr/bin/env python3
"""Exercise actual archive validation against safe and malicious release structures."""
import hashlib
import copy
import json
import subprocess
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
runtime_spec = importlib.util.spec_from_file_location("runtime_inputs", ROOT / "scripts/release/runtime_inputs.py")
runtime = importlib.util.module_from_spec(runtime_spec); runtime_spec.loader.exec_module(runtime)
notice_spec = importlib.util.spec_from_file_location("notice_producer", ROOT / "LICENSES/refresh-npm-notices.py")
notice_producer = importlib.util.module_from_spec(notice_spec); notice_spec.loader.exec_module(notice_producer)


class NpmInventoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "LICENSES").mkdir()
        self.entries = {
            "node_modules/runtime-fixture": {"version": "1.0.0", "resolved": "https://example.invalid/runtime.tgz",
                                             "integrity": "sha512-runtime-fixture", "license": "MIT"},
            "node_modules/dev-fixture": {"version": "2.0.0", "resolved": "https://example.invalid/dev.tgz",
                                         "integrity": "sha512-dev-fixture", "license": "MIT", "dev": True},
        }
        self.digest = runtime.sha(json.dumps(self.entries, sort_keys=True, separators=(",", ":")).encode())
        self.packages = [self.notice((name, value)) for name, value in self.entries.items()]
        self.inventory = {"dependency_entries_sha256": self.digest, "package_count": len(self.entries),
                          "packages": self.packages}
        self.provenance = {
            "components": [{"name": "preserved-native-fixture", "revision": "unchanged"}],
            "legacy_prebuilt_libvncclient": {"source_correspondence": "unestablished"},
            "npm_inventory": {"path": "LICENSES/npm-dependencies.json", "source": "package-lock.json",
                              "dependency_entries_sha256": self.digest, "package_count": 2,
                              "runtime_package_count": 1, "development_package_count": 1},
        }
        self.write("package-lock.json", {"packages": {"": {"name": "fixture"}, **self.entries}})
        self.write("LICENSES/npm-dependencies.json", self.inventory)
        self.write("LICENSES/dependency-provenance.json", self.provenance)

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    @staticmethod
    def notice(entry):
        name, package = entry
        return {"lock_path": name, "name": name.removeprefix("node_modules/"), "version": package["version"],
                "scope": "development" if package.get("dev", False) else "runtime",
                "license_expression": package["license"], "source_archive_url": package["resolved"],
                "source_archive_integrity": package["integrity"], "notices": []}

    def test_matching_inventory_returns_only_production_inputs(self):
        packages, digest = runtime.locked_dependencies(self.root)
        self.assertEqual(set(packages), {"node_modules/runtime-fixture"})
        self.assertEqual(digest, self.digest)

    def test_repository_inventory_matches_actual_lock_and_exact_sdk_dependency(self):
        lock = json.loads((ROOT / "package-lock.json").read_text())
        entries = {name: value for name, value in lock["packages"].items() if name}
        packages, digest = runtime.locked_dependencies(ROOT)
        self.assertEqual(set(packages), {name for name, value in entries.items() if not value.get("dev", False)})
        self.assertEqual(digest, runtime.sha(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()))
        manifest = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(packages["node_modules/@modelcontextprotocol/sdk"]["version"],
                         manifest["dependencies"]["@modelcontextprotocol/sdk"])

    def test_stale_provenance_digest_counts_and_identity_are_refused(self):
        mutations = {"dependency_entries_sha256": "0" * 64, "package_count": 3,
                     "runtime_package_count": 2, "development_package_count": 0,
                     "path": "LICENSES/other.json", "source": "other-lock.json"}
        for key, value in mutations.items():
            with self.subTest(key=key):
                changed = copy.deepcopy(self.provenance)
                changed["npm_inventory"][key] = value
                self.write("LICENSES/dependency-provenance.json", changed)
                with self.assertRaisesRegex(ValueError, "npm provenance inventory differs"):
                    runtime.locked_dependencies(self.root)

    def test_wrong_declared_inventory_count_is_refused(self):
        changed = copy.deepcopy(self.inventory); changed["package_count"] = 3
        self.write("LICENSES/npm-dependencies.json", changed)
        with self.assertRaisesRegex(ValueError, "npm notice inventory package count differs"):
            runtime.locked_dependencies(self.root)

    def test_duplicate_inventory_record_is_refused_without_losing_coverage(self):
        changed = copy.deepcopy(self.inventory); changed["packages"].append(copy.deepcopy(self.packages[0]))
        self.write("LICENSES/npm-dependencies.json", changed)
        with self.assertRaisesRegex(ValueError, "duplicate npm notice inventory lock paths"):
            runtime.locked_dependencies(self.root)

    def test_producer_refreshes_provenance_and_preserves_other_components(self):
        # Change a runtime input while both old receipts are still consistent
        # with each other. The producer must refresh both for the new lock.
        changed = copy.deepcopy(self.entries)
        changed["node_modules/runtime-fixture"]["version"] = "1.1.0"
        changed["node_modules/second-runtime-fixture"] = {
            "version": "3.0.0", "resolved": "https://example.invalid/second-runtime.tgz",
            "integrity": "sha512-second-runtime-fixture", "license": "MIT",
        }
        self.write("package-lock.json", {"packages": {"": {"name": "fixture"}, **changed}})
        with self.assertRaisesRegex(ValueError, "npm notice inventory differs"):
            runtime.locked_dependencies(self.root)
        with patch.object(notice_producer, "ROOT", self.root), patch.object(notice_producer, "fetch_notices", self.notice):
            notice_producer.main()
        packages, digest = runtime.locked_dependencies(self.root)
        self.assertEqual(packages["node_modules/runtime-fixture"]["version"], "1.1.0")
        self.assertEqual(set(packages), {"node_modules/runtime-fixture", "node_modules/second-runtime-fixture"})
        self.assertNotEqual(digest, self.digest)
        refreshed = json.loads((self.root / "LICENSES/dependency-provenance.json").read_text())
        self.assertEqual({key: value for key, value in refreshed.items() if key != "npm_inventory"},
                         {key: value for key, value in self.provenance.items() if key != "npm_inventory"})
        self.assertEqual((refreshed["npm_inventory"]["package_count"],
                          refreshed["npm_inventory"]["runtime_package_count"],
                          refreshed["npm_inventory"]["development_package_count"]), (3, 2, 1))


class NativeBuildPrivacyTests(unittest.TestCase):
    def configured(self):
        return {"dependencyBuildConfiguration": source.builder.dependency_build_configuration(),
                "dependencyBuildConfigurationSha256": source.builder.dependency_configuration_sha256()}

    def test_compiled_configuration_literals_are_rejected_without_debug_symbols(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"
            # Ten ordinary runtime string constants, rather than DWARF data.
            path.write_bytes(b"\xcf\xfa\xed\xfe" + b"\x00".join(
                b"/Users/build-user/private-stage/ssl/default" + str(index).encode() for index in range(10)))
            with self.assertRaisesRegex(ValueError, "private workspace paths"):
                source.builder.verify_public_native_binary(path)

    def test_private_debug_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "host"
            for value in (b"/Users/build-user/source.swift", b"/home/build-user/source.swift", b"fruitctl-builds/source.swift"):
                with self.subTest(value=value):
                    path.write_bytes(b"fixture debug symbols\x00" + value)
                    with self.assertRaisesRegex(ValueError, "private workspace paths"):
                        source.builder.verify_public_native_binary(path)

    def test_public_config_defaults_are_admitted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"
            path.write_bytes(b"/opt/fruitctl/ssl\x00/opt/fruitctl/lib/ossl-modules\x00/fruitctl/source/Input.swift")
            value = source.builder.verify_public_native_binary(path)
            self.assertTrue(value["privateWorkspacePathsAbsent"])
            self.assertEqual(value["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())

    def test_empty_native_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"; path.write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "empty"):
                source.builder.verify_public_native_binary(path)

    def test_symlink_native_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "controller"; path.write_bytes(b"public bytes")
            alias = Path(directory).resolve() / "alias"; alias.symlink_to(path)
            with self.assertRaisesRegex(ValueError, "canonical regular"):
                source.builder.verify_public_native_binary(alias)

    def test_old_source_only_cache_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "public dependency build configuration"):
            source.builder.verify_reusable_dependency_configuration({"sourceLockSha256": "a" * 64}, {})

    def test_changed_manifest_configuration_is_rejected(self):
        built, manifest = self.configured(), self.configured()
        manifest["dependencyBuildConfiguration"]["openssl"]["prefix"] = "/private/staging"
        with self.assertRaisesRegex(ValueError, "public dependency build configuration"):
            source.builder.verify_reusable_dependency_configuration(built, manifest)

    def test_changed_build_receipt_configuration_hash_is_rejected(self):
        built = self.configured(); built["dependencyBuildConfigurationSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "public dependency build configuration"):
            source.builder.verify_reusable_dependency_configuration(built, self.configured())

    def test_matching_public_cache_ignores_executable_strip_policy(self):
        built = self.configured(); built["nativeArtifactPolicy"] = {"stripDebugArguments": ["-S", "-x"]}
        source.builder.verify_reusable_dependency_configuration(built, self.configured())

    def test_generated_and_historical_native_manifest_use_actual_json_schema(self):
        schema = json.loads((ROOT / "release/native-input-manifest.schema.json").read_text())
        historical = {"schemaVersion": 1, "kind": "fruitctl-native-inputs", "platform": "darwin",
                      "architecture": "arm64", "minimumMacOS": "15.0", "sourceLockSha256": "a" * 64,
                      "files": {"include/file" + str(index): {"sha256": "b" * 64, "bytes": 1} for index in range(7)}}
        generated = {**historical, **self.configured()}
        fixtures = [{"name": "historical-v1", "value": historical, "expected": True},
                    {"name": "generated-public-configuration", "value": generated, "expected": True}]
        mutations = [("lone-config", {**historical, "dependencyBuildConfiguration": self.configured()["dependencyBuildConfiguration"]}),
                     ("lone-hash", {**historical, "dependencyBuildConfigurationSha256": "a" * 64}),
                     ("malformed-hash", {**generated, "dependencyBuildConfigurationSha256": "not-a-sha256"}),
                     ("extra-top-field", {**generated, "unsupported": True})]
        changed = copy.deepcopy(generated); changed["dependencyBuildConfiguration"]["openssl"]["openssldir"] = "/private/config"
        mutations.append(("changed-config-default", changed))
        changed = copy.deepcopy(generated); changed["dependencyBuildConfiguration"]["version"] = "1"
        mutations.append(("wrong-config-type", changed))
        changed = copy.deepcopy(generated); changed["dependencyBuildConfiguration"]["unsupported"] = True
        mutations.append(("extra-config-field", changed))
        fixtures.extend({"name": name, "value": value, "expected": False} for name, value in mutations)
        # AJV is an existing pinned SDK dependency, not a new host package.
        script = """const fs = require('node:fs');
const Ajv = require('ajv/dist/2020.js').default;
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const validate = new Ajv({strict:true,allErrors:true}).compile(input.schema);
for (const fixture of input.fixtures) {
  if (validate(fixture.value) !== fixture.expected) {
    console.error(JSON.stringify({name:fixture.name,errors:validate.errors})); process.exit(1);
  }
}
process.stdout.write(JSON.stringify({fixtures:input.fixtures.length,status:'passed'}));"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT,
                                input=json.dumps({"schema": schema, "fixtures": fixtures}),
                                text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"fixtures": len(fixtures), "status": "passed"})

    def test_openssl_installs_only_inside_destdir_with_path_free_flags(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory).resolve(); calls = []
            def capture(command, cwd, label):
                calls.append((command, cwd, label))
            prefix = source.builder.build_openssl(output / "source", output, capture, 2)
            self.assertEqual(prefix, output / "openssl-stage/opt/fruitctl")
            self.assertTrue(prefix.is_relative_to(output))
            self.assertEqual(len(calls), 3)
            configure = calls[0][0]
            self.assertIn("--prefix=/opt/fruitctl", configure)
            self.assertIn("--openssldir=/opt/fruitctl/ssl", configure)
            self.assertIn("--libdir=lib", configure)
            self.assertFalse(any("prefix-map" in str(value) for value in configure))
            self.assertEqual(calls[1][0], ["make", "-j2", "build_sw"])
            self.assertEqual(calls[2][0], ["make", "DESTDIR=" + str(output / "openssl-stage"), "install_sw"])
            self.assertFalse(prefix.exists())  # capture never wrote the public or staged prefix


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
