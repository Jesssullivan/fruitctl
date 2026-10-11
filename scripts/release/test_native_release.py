#!/usr/bin/env python3
"""Run the real file-only CLIs against independently assembled synthetic bundles.

These fixtures have no Apple signatures. They prove structural refusals and
receipt linking, never Apple trust, notarization, installation or runtime use.
"""
import copy
import hashlib
import io
import json
from pathlib import Path
import plistlib
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import unittest
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HOST = "FruitctlHost.app"
TOOL = "claude-kvm-daemon"
OUTPUTS = ("fruitctl-release.json", "native-evidence.json", "THIRD_PARTY_NOTICES.md", "SHA256SUMS")
STOCK_0600_PATHS = {"build-evidence/build-receipt.json", "build-evidence/native-input-manifest.json",
                    "corresponding-source.json", "upstream-inputs/009008e2f4d5a54dd71f422070df3af7b3dbc931.patch",
                    "upstream-inputs/540332be3e0acc566fa64da6f1b4680c72c724dd.patch",
                    "upstream-inputs/5b270544b85233668b98161323297d418a8f5fd1.patch",
                    "upstream-inputs/libvnc.tar.gz", "upstream-inputs/node-source.tar.xz",
                    "upstream-inputs/openssl.tar.gz", "upstream-inputs/swift-argument-parser.tar.gz"}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def descriptor(data):
    return {"sha256": sha(data), "bytes": len(data)}


def replace_roots(value, replacements):
    # Independent fixture implementation of the stock portable-source format.
    if isinstance(value, dict):
        return {key: replace_roots(entry, replacements) for key, entry in value.items()}
    if isinstance(value, list):
        return [replace_roots(entry, replacements) for entry in value]
    if isinstance(value, str):
        for key, replacement in sorted(replacements.items(), key=lambda entry: len(entry[0]), reverse=True):
            value = value.replace(key, replacement)
    return value


class NativeBundle:
    def __init__(self, base):
        self.assets = base / "assets"; self.assets.mkdir()
        self.private = base / "private"; self.private.mkdir()
        self.receipts = {}; self.inputs = {}; self.source_files = {}
        self.notices = b"Synthetic fixture notices: Host MIT; linked controller GPL-3.0-or-later.\n"
        for component, letter in ((HOST, "1"), (TOOL, "2")):
            self.component(component, letter)

    def receipt_path(self, component, kind):
        return self.private / component / (kind + ".json")

    def save(self, component, kind):
        path = self.receipt_path(component, kind)
        path.write_bytes(encoded(self.receipts[component][kind]))
        return sha(path.read_bytes())

    @staticmethod
    def zip_write(path, members):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
                for name, data, mode in members:
                    entry = zipfile.ZipInfo(name); entry.create_system = 3
                    entry.external_attr = mode << 16
                    archive.writestr(entry, data)

    @staticmethod
    def zip_entries(path):
        with zipfile.ZipFile(path) as archive:
            return [(entry.filename, archive.read(entry), entry.external_attr >> 16) for entry in archive.infolist()]

    @staticmethod
    def zip_observations(path, component):
        payloads = {}; sidecars = []; directories = []
        with zipfile.ZipFile(path) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    # The actual stock Host distribution receipt keeps '/'.
                    directories.append(entry.filename)
                elif entry.filename.startswith("__MACOSX/"):
                    sidecars.append({"name": entry.filename, **descriptor(archive.read(entry))})
                else:
                    name = entry.filename if component == TOOL else entry.filename[len(HOST) + 1:]
                    payloads[name] = descriptor(archive.read(entry))
        return {"payloads": payloads, "AppleDoubleSidecars": sorted(sidecars, key=lambda row: row["name"]),
                "directories": sorted(directories)}

    @staticmethod
    def host_zip_members(files):
        # Model ditto --sequesterRsrc: sidecars accompany files and directories
        # under __MACOSX, including the Contents directory itself.
        # Match the observed163-byte layout, including its empty resource fork.
        # The synthetic metadata bytes do not constitute Apple trust evidence.
        sidecar = struct.pack(">II16sHIIIIII", 0x00051607, 0x00020000, b"\0" * 16,
                              2, 9, 50, 113, 2, 163, 0) + b"\0" * 113
        members = [(HOST + "/" + name, data, stat.S_IFREG | (0o700 if name == "Contents/MacOS/FruitctlHost" else 0o600))
                   for name, data in files.items()]
        ordinary_dirs = {HOST}
        for name in files:
            ordinary_dirs.update(parent.as_posix() for parent in Path(HOST + "/" + name).parents
                                 if parent.as_posix() != ".")
        counterparts = {HOST + "/" + name for name in files} | (ordinary_dirs - {HOST})
        for name in sorted(counterparts):
            path = Path(name)
            members.append(("__MACOSX/" + path.parent.as_posix() + "/._" + path.name,
                            sidecar, stat.S_IFREG | 0o600))
        directories = set(ordinary_dirs)
        for name, _, _ in members:
            directories.update(parent.as_posix() for parent in Path(name).parents if parent.as_posix() != ".")
        return [(name + "/", b"", stat.S_IFDIR | (0o775 if name == "__MACOSX" or name.startswith("__MACOSX/") else 0o700))
                for name in sorted(directories)] + members

    def component(self, component, letter):
        folder = self.private / component; folder.mkdir()
        host = component == HOST
        stem = "host" if host else "controller"
        source_root = "/Users/fixture/" + stem + "-source"
        dependency_root = "/Users/fixture/dependencies"
        unsigned = b"unsigned fixture " + component.encode()
        signed = b"signed fixture " + component.encode()
        info = plistlib.dumps({"CFBundleIdentifier": "com.xoxd.fruitctl.host", "CFBundleVersion": "1"})
        host_files = {"Contents/Info.plist": info, "Contents/MacOS/FruitctlHost": unsigned,
                      "Contents/PkgInfo": b"APPL????", "Contents/Resources/README.md": b"Host MIT fixture\n",
                      "Contents/Resources/ATTENDED-QUALIFICATION.md": b"Not runtime qualified\n"}
        unsigned_map = {name: descriptor(data) for name, data in host_files.items()}
        if host:
            host_files["Contents/MacOS/FruitctlHost"] = signed
            host_files["Contents/_CodeSignature/CodeResources"] = b"synthetic signature resources"
            signed_map = {name: descriptor(data) for name, data in host_files.items()}
        else:
            signed_map = {TOOL: descriptor(signed)}
        native = {"project.yml": b"fixture project\n", "FruitctlHost/App.swift": b"fixture host source\n" + letter.encode(),
                  "ClaudeKVM-Daemon/Main.swift": b"fixture controller source\n" + letter.encode()}
        native_map = {name: sha(data) for name, data in native.items()}
        tree = sha(json.dumps(native_map, sort_keys=True).encode())
        lock = b"fixture source lock\n"
        build = {"kind": "fruitctl-native-build", "schemaVersion": 1, "status": "passed",
                 "architecture": "arm64",
                 "sourceRevision": letter * 40, "sourceTreeSha256": tree, "sourceFiles": native_map,
                 "artifacts": {component: {"files": unsigned_map} if host else descriptor(unsigned)},
                 "dependencyBuildDir": dependency_root,
                 "dependencySourceFiles": {"openssl-source": {"crypto.c": sha(b"openssl fixture")},
                                           "libvnc-source": {"client.c": sha(b"libvnc fixture")}},
                 "swiftPackageSourceFiles": {"Package.swift": sha(b"swift fixture")},
                 "sourceLockSha256": sha(lock), "inputManifestSha256": sha(b"original native input fixture"),
                 "tools": {"swift": "fixture Swift"},
                 "commands": [[source_root + "/scripts/build-native.sh", str(folder / "derived"), dependency_root]]}
        sig = {"identifier": "com.xoxd.fruitctl.host" if host else "dev.tinyland.pzm-computer-use",
               "teamIdentifier": "QP994XQKNH", "certificateSha1": "A" * 40,
               "description": "Executable=/Users/fixture/private-native\nCodeDirectory v=20500 flags=0x10000(runtime)\n"
                              "Authority=Developer ID Application: Synthetic fixture\nTimestamp=Oct 11, 2026\n"}
        sign = {"kind": "fruitctl-apple-sign" if host else "fruitctl-apple-tool-sign", "schemaVersion": 1,
                "status": "passed", "appName": component, "signature": sig}
        sign.update({"unsignedFiles": unsigned_map, "files": signed_map} if host else
                    {"unsignedArtifact": descriptor(unsigned), "artifactSha256": sha(signed), "artifactBytes": len(signed)})
        archive = self.assets / (stem + "-submitted.zip")
        members = self.host_zip_members(host_files) if host else [(TOOL, signed, stat.S_IFREG | 0o755)]
        self.zip_write(archive, members)
        submission = {"kind": "fruitctl-apple-submission-archive", "schemaVersion": 1, "status": "passed", "appName": component}
        notary = {"kind": "fruitctl-apple-notarization", "schemaVersion": 1, "status": "passed", "appName": component,
                  "apple": {"id": "11111111-1111-4111-8111-" + letter * 12, "status": "Accepted", "message": "synthetic fixture"}}
        values = {"build": build, "sign": sign, "archive": submission, "notary": notary}
        final_archive = archive
        if host:
            host_files["Contents/CodeResources"] = b"synthetic stapled ticket"
            final = {name: descriptor(data) for name, data in host_files.items()}
            final_archive = self.assets / "host-stapled.zip"
            self.zip_write(final_archive, self.host_zip_members(host_files))
            requirement = 'identifier "com.xoxd.fruitctl.host" and anchor apple generic and certificate leaf[subject.OU] = QP994XQKNH'
            observed = {"designatedRequirement": requirement, "identifier": sig["identifier"], "team": sig["teamIdentifier"],
                        "certificatePinValidatedByStockSignReceipt": sig["certificateSha1"], "strictVerification": True}
            values["staple"] = {"kind": "fruitctl-apple-staple", "schemaVersion": 1, "status": "passed",
                                "appName": component, "signature": sig, "files": final}
            values["distribution"] = {"kind": "fruitctl-private-stapled-host-distribution", "schemaVersion": 1,
                                      "status": "passed", "appName": component, "actualPostStapleFiles": final,
                                      "archivePayloadAndMetadataValidation": self.zip_observations(final_archive, component),
                                      "currentSignature": observed, "reextractedSignature": copy.deepcopy(observed),
                                      "reextractedTicketValidated": True, "actualGatekeeperAssessment": {"numericExit": 0}}
        portable_build = replace_roots(build, {source_root: "${SOURCE_ROOT}", str(folder): "${BUILD_ROOT}",
                                              dependency_root: "${DEPENDENCY_BUILD_ROOT}"})
        files = {"fruitctl/" + name: data for name, data in native.items()}
        files.update({"fruitctl/LICENSE": b"MIT fixture license\n", "fruitctl/THIRD_PARTY_NOTICES.md": self.notices,
                      "fruitctl/LICENSES/dependency-provenance.json": b'{}\n',
                      "fruitctl/release/native-dependencies.lock.json": lock,
                      "dependencies/openssl/crypto.c": b"openssl fixture",
                      "dependencies/libvncclient-patched/client.c": b"libvnc fixture",
                      "dependencies/swift-argument-parser/Package.swift": b"swift fixture",
                      "build-evidence/build-receipt.json": encoded(portable_build),
                      "build-evidence/native-input-manifest.json": b'{"portable":"synthetic native input"}\n'})
        for script in ("build-native.sh", "build-host.sh", "install.sh", "uninstall.sh"):
            files["fruitctl/scripts/" + script] = b"#!/bin/sh\n# fixture only\n"
        for name in STOCK_0600_PATHS - {"corresponding-source.json", "build-evidence/build-receipt.json",
                                      "build-evidence/native-input-manifest.json"}:
            files[name] = b"synthetic upstream input: " + name.encode()
        provenance = {"schemaVersion": 1, "mode": "strict", "selectedBinaries": ["FruitctlHost" if host else TOOL],
                      "testedSourceFiles": native_map, "publicNativeSourceFiles": native_map,
                      "testedSourceTreeSha256": tree, "publicNativeSourceTreeSha256": tree, "resourceDocs": []}
        manifest = {"kind": "fruitctl-corresponding-source", "schemaVersion": 1, "fruitctl_revision": letter * 40,
                    "build_snapshot_base_revision": letter * 40, "sourceTreeSha256": tree,
                    "nativeSourceProvenance": provenance, "nativeInputManifestSha256": build["inputManifestSha256"],
                    "publicSourceInventorySha256": "3" * 64, "native_distribution_license_expression": "GPL-3.0-or-later",
                    "componentLicenses": {HOST: "MIT", TOOL: "GPL-3.0-or-later"},
                    "build_configuration": {"tools": portable_build["tools"], "commands": portable_build["commands"]},
                    "binary_sha256": {"FruitctlHost" if host else TOOL: descriptor(signed)},
                    "files": {name: sha(data) for name, data in files.items()}}
        files["corresponding-source.json"] = encoded(manifest)
        self.source_files[component] = files
        source_archive = self.assets / (stem + "-source.tar.gz")
        self.tar_write(source_archive, files)
        values["source"] = {"kind": "fruitctl-corresponding-source-package", "schemaVersion": 1, "status": "passed",
                            "binary_sha256": manifest["binary_sha256"], "publicSourceRevision": manifest["fruitctl_revision"],
                            "sourceTreeSha256": tree, "nativeSourceProvenance": provenance,
                            "nativeInputManifestSha256": build["inputManifestSha256"], "publicSourceInventorySha256": "3" * 64}
        self.receipts[component] = values
        config = {"kind": "fruitctl-native-release-input", "schemaVersion": 1, "component": component,
                  "archive": str(final_archive), "submissionArchive": str(archive), "sourceArchive": str(source_archive),
                  "sourceRoot": source_root, "buildRoot": str(folder)}
        config.update({kind + "Receipt": str(self.receipt_path(component, kind)) for kind in values})
        input_path = folder / "input.json"; input_path.write_bytes(encoded(config))
        self.inputs[component] = input_path
        self.refresh(component)

    @staticmethod
    def tar_write(path, files, extras=()):
        with tarfile.open(path, "w:gz") as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name); entry.mode = 0o600 if name in STOCK_0600_PATHS else 0o644; entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            for entry, data in extras:
                archive.addfile(entry, io.BytesIO(data) if data is not None else None)

    def refresh(self, component):
        value = self.receipts[component]; config = json.loads(self.inputs[component].read_bytes())
        build_sha = self.save(component, "build")
        value["source"].update(buildReceiptSha256=build_sha, source_archive_sha256=sha(Path(config["sourceArchive"]).read_bytes()),
                               sourceArchiveBytes=Path(config["sourceArchive"]).stat().st_size)
        self.save(component, "source")
        value["sign"]["buildReceiptSha256"] = build_sha
        sign_sha = self.save(component, "sign")
        value["archive"].update(signReceiptSha256=sign_sha, archiveSha256=sha(Path(config["submissionArchive"]).read_bytes()),
                                archiveBytes=Path(config["submissionArchive"]).stat().st_size)
        archive_sha = self.save(component, "archive")
        value["notary"].update(archiveReceiptSha256=archive_sha, submittedArchiveSha256=value["archive"]["archiveSha256"])
        notary_sha = self.save(component, "notary")
        if component == HOST:
            value["staple"].update(buildReceiptSha256=build_sha, signReceiptSha256=sign_sha, notarizationReceiptSha256=notary_sha,
                                   submissionId=value["notary"]["apple"]["id"])
            staple_sha = self.save(component, "staple")
            value["distribution"].update(signReceiptSha256=sign_sha, stapleReceiptSha256=staple_sha,
                                         acceptedNotarizationReceiptSha256=notary_sha, submissionArchiveReceiptSha256=archive_sha,
                                         submittedArchiveSha256=value["archive"]["archiveSha256"], submissionId=value["notary"]["apple"]["id"],
                                         archiveSha256=sha(Path(config["archive"]).read_bytes()), archiveBytes=Path(config["archive"]).stat().st_size)
            self.save(component, "distribution")


class NativeReleaseTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.bundle = NativeBundle(Path(self.directory.name).resolve())

    def writer(self, *extra):
        return subprocess.run([sys.executable, "-I", "-B", str(ROOT / "scripts/release/write_manifest.py"),
                               "--native-only", "--version", "v0.0.0-fixture", "--output-dir", str(self.bundle.assets),
                               *[item for path in self.bundle.inputs.values() for item in ("--native-input", str(path))], *extra],
                              capture_output=True, text=True, timeout=30)

    def verifier(self, native=True):
        return subprocess.run([sys.executable, "-I", "-B", str(ROOT / "scripts/verify-release.py"),
                               str(self.bundle.assets / "fruitctl-release.json"), "--assets-dir", str(self.bundle.assets),
                               *( ["--native-only"] if native else [])], capture_output=True, text=True, timeout=30)

    def assert_refused(self, result, phrase=None):
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        if phrase:
            self.assertIn(phrase, result.stderr)
        self.assertTrue(all(not (self.bundle.assets / name).exists() for name in OUTPUTS))

    def publish_fixture(self):
        result = self.writer(); self.assertEqual(result.returncode, 0, result.stderr)
        result = self.verifier(); self.assertEqual(result.returncode, 0, result.stderr)

    def reseal_public(self, change):
        root = self.bundle.assets
        evidence = json.loads((root / "native-evidence.json").read_bytes()); change(evidence)
        # An untrusted caller can reseal JSON/checksums; verifier must still check edges/maps.
        for row in evidence["components"]:
            for projection in row["receipts"].values():
                data = json.dumps(projection["value"], sort_keys=True).encode()
                projection["projectionSha256"] = sha(data); projection["projectionBytes"] = len(data)
        (root / "native-evidence.json").write_bytes(encoded(evidence))
        manifest = json.loads((root / "fruitctl-release.json").read_bytes())
        for asset in manifest["assets"]:
            asset["sha256"] = sha((root / asset["name"]).read_bytes())
        (root / "fruitctl-release.json").write_bytes(encoded(manifest))
        lines = [asset["sha256"] + "  " + asset["name"] for asset in manifest["assets"]]
        lines.append(sha((root / "fruitctl-release.json").read_bytes()) + "  fruitctl-release.json")
        (root / "SHA256SUMS").write_text("\n".join(lines) + "\n")

    def test_two_original_producers_roundtrip_with_separate_portable_hashes_and_identity_gaps(self):
        self.publish_fixture()
        evidence = json.loads((self.bundle.assets / "native-evidence.json").read_bytes())
        self.assertEqual({row["producerRevision"] for row in evidence["components"]}, {"1" * 40, "2" * 40})
        self.assertEqual({row["license"] for row in evidence["components"]}, {"MIT", "GPL-3.0-or-later"})
        for row in evidence["components"]:
            self.assertNotEqual(row["portableBuildSha256"], row["receipts"]["build"]["originalSha256"])
            self.assertEqual(row["identityEvidence"]["signedEntitlements"], {"status": "not-recorded"})
            self.assertEqual(row["identityEvidence"]["designatedRequirement"]["status"], "recorded" if row["component"] == HOST else "not-recorded")
        public = b"".join((self.bundle.assets / name).read_bytes() for name in OUTPUTS)
        self.assertNotIn(b"/Users/fixture", public)
        self.assertNotIn(str(self.bundle.private).encode(), public)
        result = json.loads(self.verifier().stdout)
        self.assertEqual(result["runtimeCount"], 0)
        self.assertEqual(result["appleAuthentication"], "not-performed")

    def test_native_bundle_is_not_accepted_as_default_runtime(self):
        self.publish_fixture(); result = self.verifier(native=False)
        self.assertEqual(result.returncode, 1); self.assertIn("explicit --native-only", result.stderr)

    def test_operator_version_and_separate_mode_are_required(self):
        self.assert_refused(self.writer("--version", ""), "explicit release tag")
        self.assert_refused(self.writer("--runtime-receipt", "unused"), "cannot be mixed")

    def test_original_build_root_still_binds_exact_portable_bytes_after_receipt_relocation(self):
        original_hashes = {}
        for component in (HOST, TOOL):
            config = json.loads(self.bundle.inputs[component].read_bytes())
            original = Path(config["buildReceipt"])
            original_hashes[component] = sha(original.read_bytes())
            relocated = self.bundle.private / ("relocated-" + component); relocated.mkdir()
            destination = relocated / "copied-original-build-receipt.json"
            destination.write_bytes(original.read_bytes())
            config["buildReceipt"] = str(destination)
            # The original locator is intentionally not the copied file's parent.
            self.assertNotEqual(config["buildRoot"], str(destination.parent))
            self.bundle.inputs[component].write_bytes(encoded(config))
        self.publish_fixture()
        evidence = json.loads((self.bundle.assets / "native-evidence.json").read_bytes())
        for row in evidence["components"]:
            self.assertEqual(row["receipts"]["build"]["originalSha256"], original_hashes[row["component"]])
            self.assertNotEqual(row["portableBuildSha256"], original_hashes[row["component"]])

    def test_original_build_root_cannot_relabel_portable_evidence_or_use_noncanonical_syntax(self):
        input_path = self.bundle.inputs[TOOL]
        config = json.loads(input_path.read_bytes())
        for value, phrase in (("/Users/fixture/unrelated-build", "portable source build differs"),
                              ("/Users/fixture/../build", "canonical absolute syntax"),
                              ("/Users/fixture//build", "canonical absolute syntax"),
                              ("relative/build", "canonical absolute syntax")):
            with self.subTest(value=value):
                config["buildRoot"] = value; input_path.write_bytes(encoded(config))
                self.assert_refused(self.writer(), phrase)

    def test_stock_host_directories_and_directory_sidecars_roundtrip(self):
        recorded = self.bundle.receipts[HOST]["distribution"]["archivePayloadAndMetadataValidation"]
        self.assertEqual(len(recorded["directories"]), 11)
        self.assertTrue(all(name.endswith("/") for name in recorded["directories"]))
        self.assertEqual(len(recorded["AppleDoubleSidecars"]), 11)
        self.assertIn("__MACOSX/" + HOST + "/._Contents", [row["name"] for row in recorded["AppleDoubleSidecars"]])
        path = Path(json.loads(self.bundle.inputs[HOST].read_bytes())["archive"])
        entries = self.bundle.zip_entries(path)
        self.assertEqual(sum(name.endswith("/") and stat.S_IMODE(mode) == 0o775 for name, _, mode in entries), 6)
        self.assertEqual(sum(name.endswith("/") and stat.S_IMODE(mode) == 0o700 for name, _, mode in entries), 5)
        self.assertEqual(next(stat.S_IMODE(mode) for name, _, mode in entries if name.endswith("/MacOS/FruitctlHost")), 0o700)
        self.publish_fixture()
        self.assertEqual(self.verifier().returncode, 0)
        evidence = json.loads((self.bundle.assets / "native-evidence.json").read_bytes())
        host = next(row for row in evidence["components"] if row["component"] == HOST)
        self.assertEqual(host["archiveMap"]["directories"], sorted(name[:-1] for name in recorded["directories"]))

    def test_host_metadata_directory_mode_exception_does_not_extend_to_app_or_files(self):
        path = Path(json.loads(self.bundle.inputs[HOST].read_bytes())["archive"])
        original = self.bundle.zip_entries(path)
        cases = [(HOST + "/", stat.S_IFDIR | 0o775),
                 ("__MACOSX/" + HOST + "/Contents/._Info.plist", stat.S_IFREG | 0o775),
                 ("__MACOSX/", stat.S_IFDIR | 0o777)]
        for target, bad_mode in cases:
            with self.subTest(target=target, mode=bad_mode):
                self.bundle.zip_write(path, [(name, data, bad_mode if name == target else mode)
                                            for name, data, mode in original])
                self.bundle.refresh(HOST)
                self.assert_refused(self.writer(), "unsafe ZIP mode")

    def test_host_directory_receipt_normalization_does_not_accept_ambiguity_or_map_changes(self):
        recorded = self.bundle.receipts[HOST]["distribution"]["archivePayloadAndMetadataValidation"]
        original = list(recorded["directories"])
        cases = [original + [original[0][:-1]], original + ["../outside/"],
                 original + ["FruitctlHost.app//"], original + [42], original[:-1],
                 original + ["FruitctlHost.app/unrecorded/"]]
        for names in cases:
            with self.subTest(names=names):
                recorded["directories"] = names; self.bundle.refresh(HOST)
                self.assert_refused(self.writer())

    def test_stock_source_0600_headers_pass_but_unsafe_mode_still_refuses(self):
        config = json.loads(self.bundle.inputs[TOOL].read_bytes()); path = Path(config["sourceArchive"])
        files = self.bundle.source_files[TOOL]
        with tarfile.open(path) as archive:
            self.assertEqual({row.name for row in archive if row.mode == 0o600}, STOCK_0600_PATHS)
        with tarfile.open(path, "w:gz") as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name); entry.mode = 0o606 if name == "build-evidence/build-receipt.json" else 0o644
                entry.size = len(data); archive.addfile(entry, io.BytesIO(data))
        self.bundle.refresh(TOOL); self.assert_refused(self.writer(), "unsafe TAR mode")
        self.bundle.tar_write(path, files); self.bundle.refresh(TOOL)
        self.publish_fixture(); self.assertEqual(self.verifier().returncode, 0)

    def test_existing_release_output_is_never_replaced(self):
        existing = self.bundle.assets / "native-evidence.json"; existing.write_bytes(b"retained original")
        result = self.writer(); self.assertEqual(result.returncode, 1)
        self.assertEqual(existing.read_bytes(), b"retained original")
        self.assertFalse((self.bundle.assets / "fruitctl-release.json").exists())

    def test_wrong_build_producer_is_rejected_even_when_raw_hash_links_are_updated(self):
        self.bundle.receipts[HOST]["build"]["sourceRevision"] = "f" * 40; self.bundle.refresh(HOST)
        self.assert_refused(self.writer(), "portable source build differs")

    def test_native_source_bytes_must_match_full_build_inventory(self):
        files = self.bundle.source_files[TOOL]; files["fruitctl/ClaudeKVM-Daemon/Main.swift"] = b"changed source"
        manifest = json.loads(files["corresponding-source.json"])
        manifest["files"]["fruitctl/ClaudeKVM-Daemon/Main.swift"] = sha(b"changed source")
        files["corresponding-source.json"] = encoded(manifest)
        path = Path(json.loads(self.bundle.inputs[TOOL].read_bytes())["sourceArchive"])
        self.bundle.tar_write(path, files); self.bundle.refresh(TOOL)
        self.assert_refused(self.writer(), "native source bytes differ")

    def test_wrong_accepted_chain_and_nonaccepted_cloud_state_are_rejected(self):
        receipt = self.bundle.receipts[TOOL]["notary"]
        receipt["archiveReceiptSha256"] = "0" * 64; self.bundle.save(TOOL, "notary")
        self.assert_refused(self.writer(), "submission chain differs")
        self.bundle.refresh(TOOL); receipt["apple"]["status"] = "Invalid"; self.bundle.save(TOOL, "notary")
        self.assert_refused(self.writer(), "Accepted submission")

    def test_staple_cannot_change_the_original_signed_binary(self):
        self.bundle.receipts[HOST]["staple"]["files"]["Contents/MacOS/FruitctlHost"] = descriptor(b"changed signed binary")
        self.bundle.refresh(HOST)
        self.assert_refused(self.writer(), "stapling changed signed Host files")

    def test_mismatched_host_requirement_roundtrip_is_rejected(self):
        self.bundle.receipts[HOST]["distribution"]["reextractedSignature"]["designatedRequirement"] = "changed"
        self.bundle.refresh(HOST)
        self.assert_refused(self.writer(), "requirement roundtrip")

    def test_zip_traversal_symlink_duplicate_and_extra_payload_are_rejected_after_digest_rebinding(self):
        config = json.loads(self.bundle.inputs[TOOL].read_bytes()); path = Path(config["archive"])
        good = self.bundle.zip_entries(path)
        cases = [("traversal", [("../outside", b"x", stat.S_IFREG | 0o644)]),
                 ("symlink", [("link", b"target", stat.S_IFLNK | 0o777)]),
                 ("duplicate", [good[0]]), ("extra", [("extra", b"x", stat.S_IFREG | 0o644)])]
        for name, additions in cases:
            with self.subTest(name=name):
                self.bundle.zip_write(path, good + additions); self.bundle.refresh(TOOL)
                self.assert_refused(self.writer())
        self.bundle.zip_write(path, [(TOOL, b"different same-sized executable", stat.S_IFREG | 0o755)])
        self.bundle.refresh(TOOL); self.assert_refused(self.writer(), "complete signed file map")

    def test_bare_controller_modes_and_inline_appledouble_are_rejected(self):
        path = Path(json.loads(self.bundle.inputs[TOOL].read_bytes())["archive"])
        good = self.bundle.zip_entries(path)
        for mode in (stat.S_IFREG | 0o644, stat.S_IFREG | 0o4755):
            self.bundle.zip_write(path, [(good[0][0], good[0][1], mode)]); self.bundle.refresh(TOOL)
            self.assert_refused(self.writer())
        self.bundle.zip_write(path, good + [("._" + TOOL, b"metadata", stat.S_IFREG | 0o644)])
        self.bundle.refresh(TOOL); self.assert_refused(self.writer(), "unexpected ZIP payload")

    def test_host_appledouble_tamper_is_refused_with_actual_new_metadata_digest(self):
        path = Path(json.loads(self.bundle.inputs[HOST].read_bytes())["archive"])
        members = self.bundle.zip_entries(path)
        bad = [(name, (b"\xff" + data[1:]) if name.startswith("__MACOSX/") else data, mode) for name, data, mode in members]
        self.bundle.zip_write(path, bad)
        self.bundle.receipts[HOST]["distribution"]["archivePayloadAndMetadataValidation"] = self.bundle.zip_observations(path, HOST)
        self.bundle.refresh(HOST); self.assert_refused(self.writer(), "AppleDouble structure")

    def test_tar_traversal_symlink_duplicate_and_missing_payload_are_rejected_after_digest_rebinding(self):
        path = Path(json.loads(self.bundle.inputs[TOOL].read_bytes())["sourceArchive"])
        files = self.bundle.source_files[TOOL]
        traversal = tarfile.TarInfo("../outside"); traversal.mode = 0o644; traversal.size = 1
        link = tarfile.TarInfo("link"); link.type = tarfile.SYMTYPE; link.linkname = "fruitctl/LICENSE"; link.mode = 0o644
        duplicate = tarfile.TarInfo("fruitctl/LICENSE"); duplicate.mode = 0o644; duplicate.size = 1
        for name, entry, data in (("traversal", traversal, b"x"), ("link", link, None), ("duplicate", duplicate, b"x")):
            with self.subTest(name=name):
                self.bundle.tar_write(path, files, [(entry, data)]); self.bundle.refresh(TOOL)
                self.assert_refused(self.writer())
        self.bundle.tar_write(path, {name: data for name, data in files.items() if name != "dependencies/openssl/crypto.c"})
        self.bundle.refresh(TOOL); self.assert_refused(self.writer(), "complete file map")

    def test_portable_build_must_be_exact_substitution_of_original_not_a_relabel(self):
        files = self.bundle.source_files[TOOL]
        portable_build = json.loads(files["build-evidence/build-receipt.json"]); portable_build["commands"] = [["changed command"]]
        files["build-evidence/build-receipt.json"] = encoded(portable_build)
        manifest = json.loads(files["corresponding-source.json"])
        manifest["files"]["build-evidence/build-receipt.json"] = sha(files["build-evidence/build-receipt.json"])
        manifest["build_configuration"]["commands"] = portable_build["commands"]
        files["corresponding-source.json"] = encoded(manifest)
        path = Path(json.loads(self.bundle.inputs[TOOL].read_bytes())["sourceArchive"])
        self.bundle.tar_write(path, files); self.bundle.refresh(TOOL)
        self.assert_refused(self.writer(), "portable source build differs")

    def test_resealed_public_projection_cannot_break_original_hash_chain(self):
        self.publish_fixture()
        self.reseal_public(lambda evidence: evidence["components"][0]["receipts"]["notary"]["value"].update(archiveReceiptSha256="0" * 64))
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("hash chain differs", result.stderr)

    def test_resealed_public_projection_cannot_claim_missing_signed_entitlements(self):
        self.publish_fixture()
        self.reseal_public(lambda evidence: evidence["components"][0]["identityEvidence"].update(signedEntitlements={"status": "recorded", "value": {}}))
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("observation gaps", result.stderr)

    def test_resealed_public_projection_cannot_relabel_component_license(self):
        self.publish_fixture()
        self.reseal_public(lambda evidence: evidence["components"][1].update(license="MIT"))
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("source identity differs", result.stderr)

    def test_raw_receipt_extras_are_omitted_while_complete_original_hashes_are_preserved(self):
        opaque = "synthetic-secret-marker-never-public"
        for component in (HOST, TOOL):
            values = self.bundle.receipts[component]
            for key in ("source", "archive", "notary"):
                values[key]["unknownPrivateField"] = {"opaqueSecret": opaque}
            values["notary"]["apple"]["unknownSecret"] = opaque
            self.bundle.refresh(component)
        self.publish_fixture()
        public = b"".join((self.bundle.assets / name).read_bytes() for name in OUTPUTS)
        self.assertNotIn(opaque.encode(), public)
        self.assertNotIn(b"unknownPrivateField", public)
        self.assertNotIn(b"unknownSecret", public)
        evidence = json.loads((self.bundle.assets / "native-evidence.json").read_bytes())
        for row in evidence["components"]:
            for key in ("source", "archive", "notary"):
                self.assertEqual(row["receipts"][key]["originalSha256"],
                                 sha(self.bundle.receipt_path(row["component"], key).read_bytes()))
                self.assertNotEqual(row["receipts"][key]["originalSha256"], row["receipts"][key]["projectionSha256"])

    def test_resealed_public_manifest_cannot_add_private_path(self):
        self.publish_fixture()
        root = self.bundle.assets; path = root / "fruitctl-release.json"
        manifest = json.loads(path.read_bytes()); manifest["privateDebugPath"] = "/Users/operator/private"
        path.write_bytes(encoded(manifest))
        checksums = root / "SHA256SUMS"
        lines = [line for line in checksums.read_text().splitlines() if not line.endswith("  fruitctl-release.json")]
        lines.append(sha(path.read_bytes()) + "  fruitctl-release.json")
        checksums.write_text("\n".join(lines) + "\n")
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("private path", result.stderr)

    def test_resealed_public_projection_cannot_add_unknown_secret_field(self):
        self.publish_fixture()
        self.reseal_public(lambda evidence: evidence["components"][0]["receipts"]["notary"]["value"]["apple"].update(unknownSecret="synthetic-secret"))
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("Apple projection fields", result.stderr)

    def test_strict_source_provenance_rejects_unknown_nested_fields(self):
        component = TOOL; files = self.bundle.source_files[component]
        manifest = json.loads(files["corresponding-source.json"])
        manifest["nativeSourceProvenance"]["unknownSecret"] = "synthetic-secret"
        files["corresponding-source.json"] = encoded(manifest)
        self.bundle.receipts[component]["source"]["nativeSourceProvenance"] = manifest["nativeSourceProvenance"]
        path = Path(json.loads(self.bundle.inputs[component].read_bytes())["sourceArchive"])
        self.bundle.tar_write(path, files); self.bundle.refresh(component)
        self.assert_refused(self.writer(), "strict source provenance shape")

    def test_manifest_duplicates_and_checksum_inventory_are_refused(self):
        self.publish_fixture()
        path = self.bundle.assets / "SHA256SUMS"; path.write_text(path.read_text() + path.read_text().splitlines()[0] + "\n")
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("duplicate checksum", result.stderr)
        manifest = self.bundle.assets / "fruitctl-release.json"
        manifest.write_text(manifest.read_text().replace('{', '{"mode":"runtime",', 1))
        result = self.verifier(); self.assertEqual(result.returncode, 1); self.assertIn("duplicate JSON", result.stderr)


if __name__ == "__main__":
    unittest.main()
