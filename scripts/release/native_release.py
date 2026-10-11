"""File-only native release checks; portable evidence is not Apple authentication."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import tarfile
import uuid
import zipfile

COMPONENTS = {"FruitctlHost.app": ("FruitctlHost", "com.xoxd.fruitctl.host", "MIT"),
              "claude-kvm-daemon": ("claude-kvm-daemon", "dev.tinyland.pzm-computer-use", "GPL-3.0-or-later")}
QUALIFICATION = "structural-only; no Apple authentication, public install, privacy permission or runtime qualification"
ORIGINAL_HASH_SCOPE = "Original input bytes checked by writer. Portable projection hashes are separate; originals are not reconstructed by public verification."
MAX_JSON = 32 * 1024 * 1024
MAX_ARCHIVE = 2 * 1024 * 1024 * 1024
MODES = {0o400, 0o444, 0o600, 0o644, 0o700, 0o755}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest_bytes(data):
    return hashlib.sha256(data).hexdigest()


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def hex_hash(value, length=64):
    return isinstance(value, str) and re.fullmatch("[a-f0-9]{" + str(length) + "}", value) is not None


def path_name(value):
    require(isinstance(value, str) and value and "\\" not in value
            and not any(ord(char) < 32 for char in value), "unsafe archive path")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts and path.as_posix() == value,
            "unsafe archive path")
    return path


def asset_name(value):
    require(isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]+", value), "invalid asset name")
    return value


def original_root(value):
    # Original PZM roots are byte-provenance locators, not local inputs to stat.
    require(isinstance(value, str) and value and len(value) <= 4096 and "\\" not in value
            and not any(ord(char) < 32 for char in value), "original portable root must be canonical absolute syntax")
    path = PurePosixPath(value)
    require(path.anchor == "/" and ".." not in path.parts and path.as_posix() == value and value != "/",
            "original portable root must be canonical absolute syntax")
    return value


def canonical_file(value):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path and path.is_file()
            and not path.is_symlink() and path.stat().st_nlink == 1, "canonical regular input required")
    return path


def json_bytes(data):
    require(len(data) <= MAX_JSON, "JSON input exceeds bound")
    def pairs(entries):
        result = {}
        for key, value in entries:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def read_receipt(value, kind):
    path = canonical_file(value)
    require(path.stat().st_size <= MAX_JSON, "receipt exceeds bound")
    data = path.read_bytes()
    receipt = json_bytes(data)
    require(isinstance(receipt, dict) and receipt.get("kind") == kind and receipt.get("schemaVersion") == 1
            and receipt.get("status") == "passed", "passing " + kind + " receipt required")
    return receipt, digest_bytes(data)


def file_map(value):
    require(isinstance(value, dict) and value, "complete file map required")
    for name, entry in value.items():
        path_name(name)
        require(isinstance(entry, dict) and set(entry) == {"sha256", "bytes"}
                and hex_hash(entry["sha256"]) and type(entry["bytes"]) is int
                and 0 <= entry["bytes"] <= MAX_ARCHIVE, "invalid file descriptor")
    return value


def source_map(value):
    require(isinstance(value, dict) and value, "complete source map required")
    for name, sha in value.items():
        path_name(name)
        require(hex_hash(sha), "invalid source digest")
    return value


def tree_digest(value):
    return digest_bytes(json.dumps(value, sort_keys=True).encode())


def strict_provenance(value):
    keys = {"schemaVersion", "mode", "selectedBinaries", "testedSourceTreeSha256", "publicNativeSourceTreeSha256",
            "testedSourceFiles", "publicNativeSourceFiles", "resourceDocs"}
    require(isinstance(value, dict) and set(value) == keys and value["schemaVersion"] == 1
            and value["mode"] == "strict" and value["resourceDocs"] == [], "strict source provenance shape required")
    source_map(value["testedSourceFiles"]); source_map(value["publicNativeSourceFiles"])
    return value


def build_projection(build, component):
    artifact = build["artifacts"][component]
    if component == "FruitctlHost.app":
        require(isinstance(artifact, dict) and set(artifact) == {"files"}, "Host build artifact shape differs")
        file_map(artifact["files"])
    else:
        file_map({component: artifact})
    return {"sourceRevision": build["sourceRevision"], "sourceTreeSha256": build["sourceTreeSha256"],
            "sourceFiles": source_map(build["sourceFiles"]), "artifacts": {component: artifact},
            "architecture": build["architecture"]}


def projection_fields(component):
    common = {"kind", "schemaVersion", "status", "appName"}
    fields = {"build": {"sourceRevision", "sourceTreeSha256", "sourceFiles", "artifacts", "architecture"},
              "source": {"kind", "schemaVersion", "status", "source_archive_sha256", "sourceArchiveBytes", "buildReceiptSha256",
                         "binary_sha256", "publicSourceInventorySha256", "nativeInputManifestSha256", "sourceTreeSha256",
                         "nativeSourceProvenance", "publicSourceRevision"},
              "sign": common | {"buildReceiptSha256", "signature"} | ({"unsignedFiles", "files"} if component == "FruitctlHost.app"
                         else {"unsignedArtifact", "artifactSha256", "artifactBytes"}),
              "archive": common | {"archiveSha256", "archiveBytes", "signReceiptSha256"},
              "notary": common | {"archiveReceiptSha256", "submittedArchiveSha256", "apple"}}
    if component == "FruitctlHost.app":
        fields.update(staple=common | {"buildReceiptSha256", "signReceiptSha256", "notarizationReceiptSha256", "submissionId", "files", "signature"},
                      distribution=common | {"archiveSha256", "archiveBytes", "signReceiptSha256", "stapleReceiptSha256",
                         "acceptedNotarizationReceiptSha256", "submissionArchiveReceiptSha256", "submittedArchiveSha256",
                         "submissionId", "actualPostStapleFiles", "reextractedTicketValidated", "gatekeeperNumericExit", "designatedRequirement"})
    return fields


def public_safe(value):
    text = json.dumps(value, ensure_ascii=False)
    require(not re.search(r"/(?:Users|home|srv)/|https?://linear\.app/|(?<![\d.])100\.\d+\.\d+\.\d+(?![\d.])", text),
            "public evidence contains a private path or route")


def apple_double(data):
    require(len(data) >= 26 and len(data) <= 1024 * 1024, "invalid AppleDouble size")
    magic, version = struct.unpack(">II", data[:8])
    count = struct.unpack(">H", data[24:26])[0]
    require(magic == 0x00051607 and version == 0x00020000 and count <= 32
            and 26 + count * 12 <= len(data), "invalid AppleDouble structure")
    identifiers = set(); ranges = []
    for offset in range(26, 26 + count * 12, 12):
        identifier, start, size = struct.unpack(">III", data[offset:offset + 12])
        require(identifier not in identifiers and start >= 26 + count * 12 and start + size <= len(data),
                "invalid AppleDouble entry range")
        require(not any(size and prior_size and start < prior_start + prior_size and prior_start < start + size
                        for prior_start, prior_size in ranges), "overlapping AppleDouble entries")
        identifiers.add(identifier); ranges.append((start, size))


def recorded_directories(value):
    # Stock ditto receipts retain one trailing slash; ZIP maps use normalized
    # relative names. Accept only that representational difference.
    require(isinstance(value, list), "Host ZIP directory receipt must be a list")
    names = []
    for entry in value:
        require(isinstance(entry, str), "unsafe Host ZIP directory receipt")
        name = entry[:-1] if entry.endswith("/") else entry
        path_name(name)
        require(name not in names, "duplicate Host ZIP directory receipt")
        names.append(name)
    return sorted(names)


def zip_map(path, component, expected):
    file_map(expected)
    require(path.stat().st_size <= MAX_ARCHIVE, "ZIP exceeds bound")
    payloads = {}; sidecars = []; directories = []; modes = {}; names = set()
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        require(0 < len(entries) <= 4096 and sum(entry.file_size for entry in entries) <= MAX_ARCHIVE,
                "ZIP inventory exceeds bound")
        for entry in entries:
            name = entry.filename.rstrip("/") if entry.is_dir() else entry.filename
            relative = path_name(name)
            require(name not in names and not entry.flag_bits & 1, "duplicate or encrypted ZIP entry")
            names.add(name)
            mode = entry.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "ZIP links/devices are refused")
            require(stat.S_IFMT(mode) in ((0, stat.S_IFDIR) if entry.is_dir() else (0, stat.S_IFREG)),
                    "ZIP entry type differs from its path")
            permissions = stat.S_IMODE(mode)
            host_metadata_directory = (component == "FruitctlHost.app" and entry.is_dir()
                                       and relative.parts[0] == "__MACOSX")
            require(permissions in MODES or (entry.is_dir() and permissions in (0, 0o500))
                    or (host_metadata_directory and permissions == 0o775), "unsafe ZIP mode")
            if entry.is_dir():
                directories.append(name)
                continue
            if relative.parts[0] == "__MACOSX":
                require(component == "FruitctlHost.app" and relative.name.startswith("._"), "unexpected ZIP metadata")
                data = archive.read(entry); apple_double(data)
                sidecars.append({"name": entry.filename, "bytes": entry.file_size,
                                 "sha256": digest_bytes(data)})
            else:
                require(component == "claude-kvm-daemon" or relative.parts[0] == component,
                        "unexpected ZIP payload root")
                key = relative.as_posix() if component == "claude-kvm-daemon" else PurePosixPath(*relative.parts[1:]).as_posix()
                require(key in expected, "unexpected ZIP payload")
                value = hashlib.sha256()
                with archive.open(entry) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        value.update(block)
                payloads[key] = {"bytes": entry.file_size, "sha256": value.hexdigest()}
                modes[key] = permissions
        for sidecar in sidecars:
            relative = PurePosixPath(sidecar["name"])
            counterpart = PurePosixPath(*relative.parts[1:-1], relative.name[2:]).as_posix()
            require(counterpart in names, "AppleDouble sidecar lacks counterpart")
        ancestors = set()
        for entry in entries:
            if not entry.is_dir():
                ancestors.update(parent.as_posix() for parent in PurePosixPath(entry.filename).parents if parent.as_posix() != ".")
        require(set(directories).issubset(ancestors), "unexpected empty ZIP directory")
    require(payloads == expected, "ZIP differs from complete signed file map")
    executable = COMPONENTS[component][0] if component == "claude-kvm-daemon" else "Contents/MacOS/FruitctlHost"
    require(modes.get(executable, 0) & 0o111, "ZIP native executable lacks execute permission")
    if component == "claude-kvm-daemon":
        require(not directories and not sidecars and set(payloads) == {component}
                and modes[component] == 0o755, "controller ZIP must contain one executable0755")
    return {"payloads": payloads, "AppleDoubleSidecars": sorted(sidecars, key=lambda row: row["name"]),
            "directories": sorted(directories)}


def tar_source(path, source_receipt, component):
    require(path.stat().st_size <= MAX_ARCHIVE, "source archive exceeds bound")
    files = {}; metadata = {}; seen = set(); total = 0
    wanted = {"corresponding-source.json", "build-evidence/build-receipt.json",
              "fruitctl/THIRD_PARTY_NOTICES.md", "fruitctl/LICENSE"}
    with tarfile.open(path) as archive:
        for entry in archive:
            name = entry.name.rstrip("/") if entry.isdir() else entry.name
            path_name(name)
            require(name not in seen and (entry.isfile() or entry.isdir()), "duplicate TAR entry or links/devices")
            require(stat.S_IMODE(entry.mode) in MODES or (entry.isdir() and entry.mode == 0o500), "unsafe TAR mode")
            seen.add(name); total += entry.size
            require(len(seen) <= 100000 and total <= MAX_ARCHIVE, "TAR inventory exceeds bound")
            if entry.isfile():
                value = hashlib.sha256(); data = bytearray() if name in wanted else None
                with archive.extractfile(entry) as stream:
                    for block in iter(lambda: stream.read(1024 * 1024), b""):
                        value.update(block)
                        if data is not None:
                            require(len(data) + len(block) <= MAX_JSON, "source metadata exceeds bound")
                            data.extend(block)
                files[name] = value.hexdigest()
                if data is not None:
                    metadata[name] = bytes(data)
    require(wanted.issubset(metadata), "source archive omits build evidence/notices")
    manifest = json_bytes(metadata["corresponding-source.json"])
    build = json_bytes(metadata["build-evidence/build-receipt.json"])
    require(isinstance(manifest, dict) and isinstance(build, dict)
            and manifest.get("kind") == "fruitctl-corresponding-source" and manifest.get("schemaVersion") == 1,
            "corresponding-source manifest required")
    expected_files = source_map(manifest.get("files"))
    require(set(files) == set(expected_files) | {"corresponding-source.json"}
            and all(files[name] == sha for name, sha in expected_files.items()), "source archive differs from complete file map")
    require(manifest.get("binary_sha256") == source_receipt.get("binary_sha256")
            and manifest.get("sourceTreeSha256") == source_receipt.get("sourceTreeSha256")
            and manifest.get("nativeSourceProvenance") == source_receipt.get("nativeSourceProvenance")
            and manifest.get("fruitctl_revision") == source_receipt.get("publicSourceRevision")
            and hex_hash(manifest.get("fruitctl_revision"), 40)
            and manifest.get("nativeInputManifestSha256") == source_receipt.get("nativeInputManifestSha256")
            and manifest.get("publicSourceInventorySha256") == source_receipt.get("publicSourceInventorySha256"),
            "source package receipt differs from archive")
    provenance = strict_provenance(manifest["nativeSourceProvenance"])
    strict_provenance(source_receipt["nativeSourceProvenance"])
    require(provenance.get("mode") == "strict" and provenance.get("selectedBinaries") == [COMPONENTS[component][0]],
            "native-only release requires one strict original-producer source package")
    native = source_map(build.get("sourceFiles"))
    require(build.get("kind") == "fruitctl-native-build" and build.get("status") == "passed"
            and hex_hash(build.get("sourceRevision"), 40) and build.get("sourceTreeSha256") == tree_digest(native)
            and native == provenance.get("testedSourceFiles") == provenance.get("publicNativeSourceFiles")
            and build["sourceTreeSha256"] == manifest["sourceTreeSha256"]
            and provenance.get("testedSourceTreeSha256") == provenance.get("publicNativeSourceTreeSha256") == build["sourceTreeSha256"]
            and build.get("inputManifestSha256") == manifest["nativeInputManifestSha256"]
            and manifest.get("build_snapshot_base_revision") == build["sourceRevision"], "source archive build/provenance differs")
    require(all(files.get("fruitctl/" + name) == sha for name, sha in native.items()), "native source bytes differ from tested map")
    require(manifest.get("build_configuration") == {"tools": build.get("tools"), "commands": build.get("commands")},
            "portable build configuration differs")
    for directory, mapping in build.get("dependencySourceFiles", {}).items():
        prefix = {"openssl-source": "dependencies/openssl/", "libvnc-source": "dependencies/libvncclient-patched/"}.get(directory)
        require(prefix is not None and {name[len(prefix):]: sha for name, sha in files.items() if name.startswith(prefix)} == source_map(mapping),
                "dependency source bytes differ from build")
    require(set(build.get("dependencySourceFiles", {})) == {"openssl-source", "libvnc-source"}
            and {name[len("dependencies/swift-argument-parser/"):]: sha for name, sha in files.items()
                 if name.startswith("dependencies/swift-argument-parser/")} == source_map(build.get("swiftPackageSourceFiles")),
            "complete dependency source required")
    for name in ("LICENSES/dependency-provenance.json", "scripts/build-native.sh", "scripts/build-host.sh",
                 "scripts/install.sh", "scripts/uninstall.sh", "release/native-dependencies.lock.json"):
        require("fruitctl/" + name in files, "source archive omits scripts/locks/license provenance")
    require("build-evidence/native-input-manifest.json" in files, "source archive omits portable native inputs")
    require(files["fruitctl/release/native-dependencies.lock.json"] == build.get("sourceLockSha256")
            and manifest.get("componentLicenses", {}).get(component) == COMPONENTS[component][2]
            and manifest.get("native_distribution_license_expression") == "GPL-3.0-or-later",
            "source lock or component license differs")
    public_safe(manifest); public_safe(build)
    public_safe(metadata["fruitctl/THIRD_PARTY_NOTICES.md"].decode("utf-8"))
    return {"manifest": manifest, "build": build, "portableBuildSha256": files["build-evidence/build-receipt.json"],
            "notices": metadata["fruitctl/THIRD_PARTY_NOTICES.md"], "files": files}


def signature_projection(value, component):
    identifier = COMPONENTS[component][1]
    require(value.get("identifier") == identifier and re.fullmatch(r"[A-Z0-9]{10}", value.get("teamIdentifier", ""))
            and re.fullmatch(r"[A-F0-9]{40}", value.get("certificateSha1", "")), "stable Developer ID metadata required")
    description = value.get("description", "")
    timestamp = re.search(r"^Timestamp=(.+)$", description, re.M)
    require(re.search(r"^CodeDirectory .*flags=.*\(runtime\)", description, re.M) and timestamp
            and "Authority=Developer ID Application:" in description, "Developer ID runtime/timestamp metadata required")
    result = {key: value[key] for key in ("identifier", "teamIdentifier", "certificateSha1")}
    result.update(hardenedRuntime=True, timestamp=timestamp.group(1))
    public_safe(result)
    return result


def host_requirement(distribution, signature):
    first = distribution.get("currentSignature", {})
    restored = distribution.get("reextractedSignature", {})
    expression = first.get("designatedRequirement")
    require(isinstance(expression, str) and expression and len(expression.encode()) <= 16384
            and restored.get("designatedRequirement") == expression,
            "Host designated requirement roundtrip is unrecorded or differs")
    for value in (first, restored):
        require(value.get("strictVerification") is True and value.get("identifier") == signature["identifier"]
                and value.get("team") == signature["teamIdentifier"]
                and value.get("certificatePinValidatedByStockSignReceipt") == signature["certificateSha1"],
                "Host restored signature identity differs")
    require('identifier "' + signature["identifier"] + '"' in expression
            and signature["teamIdentifier"] in expression, "Host requirement does not name its identity")
    public_safe(expression)
    return {"expression": expression, "sha256": digest_bytes(expression.encode())}


def identity_evidence(component, receipts):
    # The inspected stock receipts record no actual signed-entitlement extraction.
    # A runtime flag or a statement that no profile was added is not that evidence.
    requirement = {"status": "not-recorded"}
    if component == "FruitctlHost.app":
        value = receipts["distribution"]
        requirement = {"status": "recorded", "originalReceiptSha256": value["originalSha256"],
                       **value["value"]["designatedRequirement"]}
    return {"designatedRequirement": requirement, "signedEntitlements": {"status": "not-recorded"}}


def portable(value, replacements):
    if isinstance(value, str):
        for original, replacement in sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True):
            value = value.replace(original, replacement)
        return value
    if isinstance(value, list):
        return [portable(entry, replacements) for entry in value]
    if isinstance(value, dict):
        return {key: portable(entry, replacements) for key, entry in value.items()}
    return value


def prepare_component(input_path, root):
    config = json_bytes(canonical_file(input_path).read_bytes())
    require(isinstance(config, dict) and config.get("kind") == "fruitctl-native-release-input" and config.get("schemaVersion") == 1,
            "native input contract required")
    component = config.get("component")
    require(component in COMPONENTS, "unsupported native component")
    paths = {key: canonical_file(config[key]) for key in ("archive", "submissionArchive", "sourceArchive")}
    require(all(path.parent == root for path in paths.values()), "native/source/submission assets must be beside manifest")
    for path in paths.values():
        asset_name(path.name)
    kinds = {"build": "fruitctl-native-build", "source": "fruitctl-corresponding-source-package",
             "sign": "fruitctl-apple-sign" if component == "FruitctlHost.app" else "fruitctl-apple-tool-sign",
             "archive": "fruitctl-apple-submission-archive", "notary": "fruitctl-apple-notarization"}
    if component == "FruitctlHost.app":
        kinds.update(staple="fruitctl-apple-staple", distribution="fruitctl-private-stapled-host-distribution")
    receipts = {key: read_receipt(config[key + "Receipt"], kind) for key, kind in kinds.items()}
    values = {key: row[0] for key, row in receipts.items()}; hashes = {key: row[1] for key, row in receipts.items()}
    build, source, sign, submission, notary = (values[key] for key in ("build", "source", "sign", "archive", "notary"))
    require(build.get("architecture") == "arm64", "native release currently supports only recorded Darwin arm64 builds")
    require(source.get("source_archive_sha256") == digest(paths["sourceArchive"])
            and source.get("sourceArchiveBytes") == paths["sourceArchive"].stat().st_size
            and source.get("buildReceiptSha256") == hashes["build"] == sign.get("buildReceiptSha256"),
            "binary/source/build receipt chain differs")
    require(sign.get("appName") == submission.get("appName") == notary.get("appName") == component,
            "Apple receipts name different components")
    require(submission.get("signReceiptSha256") == hashes["sign"]
            and submission.get("archiveSha256") == digest(paths["submissionArchive"])
            and submission.get("archiveBytes") == paths["submissionArchive"].stat().st_size
            and notary.get("archiveReceiptSha256") == hashes["archive"]
            and notary.get("submittedArchiveSha256") == submission["archiveSha256"], "Apple submission chain differs")
    apple = notary.get("apple", {})
    require(apple.get("status") == "Accepted" and str(uuid.UUID(apple.get("id", ""))) == apple["id"].lower(),
            "actual Accepted submission identifier required")
    source_result = tar_source(paths["sourceArchive"], source, component)
    source_root = original_root(config["sourceRoot"])
    build_root = original_root(config["buildRoot"])
    require(all(hex_hash(source[name]) for name in ("source_archive_sha256", "buildReceiptSha256", "publicSourceInventorySha256",
                 "nativeInputManifestSha256", "sourceTreeSha256")) and hex_hash(source["publicSourceRevision"], 40),
            "source receipt hashes/revision differ")
    file_map(source["binary_sha256"])
    dependency_root = original_root(build.get("dependencyBuildDir"))
    require(len({source_root, build_root, dependency_root}) == 3, "original portable roots must be distinct")
    replacements = {source_root: "${SOURCE_ROOT}", build_root: "${BUILD_ROOT}", dependency_root: "${DEPENDENCY_BUILD_ROOT}"}
    require(portable(build, replacements) == source_result["build"], "portable source build differs from original receipt")
    sig = signature_projection(sign["signature"], component)
    if component == "FruitctlHost.app":
        require(build.get("artifacts", {}).get(component, {}).get("files") == sign.get("unsignedFiles"), "unsigned Host build differs")
        before = file_map(sign.get("files")); final = file_map(values["staple"].get("files"))
        staple, distribution = values["staple"], values["distribution"]
        require(set(before) == set(sign["unsignedFiles"]) | {"Contents/_CodeSignature/CodeResources"}
                and staple.get("appName") == distribution.get("appName") == component,
                "Host signature inventory/component differs")
        require(all(before.get(name) == entry for name, entry in sign["unsignedFiles"].items()
                    if name != "Contents/MacOS/FruitctlHost"), "signing changed unsigned Host resources")
        require(all(final.get(name) == entry for name, entry in before.items())
                and set(final) == set(before) | {"Contents/CodeResources"}, "stapling changed signed Host files")
        require(staple.get("buildReceiptSha256") == hashes["build"] and staple.get("signReceiptSha256") == hashes["sign"]
                and staple.get("notarizationReceiptSha256") == hashes["notary"] and staple.get("submissionId") == apple["id"]
                and signature_projection(staple["signature"], component) == sig, "Host staple chain/identity differs")
        require(distribution.get("signReceiptSha256") == hashes["sign"] and distribution.get("stapleReceiptSha256") == hashes["staple"]
                and distribution.get("acceptedNotarizationReceiptSha256") == hashes["notary"]
                and distribution.get("submissionArchiveReceiptSha256") == hashes["archive"]
                and distribution.get("submittedArchiveSha256") == submission["archiveSha256"]
                and distribution.get("submissionId") == apple["id"] and distribution.get("actualPostStapleFiles") == final
                and distribution.get("archiveSha256") == digest(paths["archive"])
                and distribution.get("archiveBytes") == paths["archive"].stat().st_size, "Host distribution receipt chain differs")
        require(distribution.get("reextractedTicketValidated") is True
                and distribution.get("actualGatekeeperAssessment", {}).get("numericExit") == 0, "Host ticket roundtrip/assessment required")
        requirement = host_requirement(distribution, sig)
        distribution_map = zip_map(paths["archive"], component, final)
        recorded_map = distribution.get("archivePayloadAndMetadataValidation", {})
        require(distribution_map["directories"] == recorded_directories(recorded_map.get("directories", []))
                and distribution_map["AppleDoubleSidecars"] == sorted(recorded_map.get("AppleDoubleSidecars", []), key=lambda row: row["name"])
                and distribution_map["payloads"] == recorded_map.get("payloads"), "Host ZIP metadata receipt differs")
        binary = final["Contents/MacOS/FruitctlHost"]
    else:
        require(build.get("artifacts", {}).get(component) == sign.get("unsignedArtifact"), "unsigned controller build differs")
        binary = {"sha256": sign.get("artifactSha256"), "bytes": sign.get("artifactBytes")}
        file_map({component: binary}); before = final = {component: binary}
        require(paths["archive"] == paths["submissionArchive"], "bare controller distribution must be its accepted ZIP")
        distribution_map = zip_map(paths["archive"], component, final)
    submission_map = zip_map(paths["submissionArchive"], component, before)
    require(source.get("binary_sha256") == {COMPONENTS[component][0]: binary}, "corresponding source names different binary")
    projections = {}
    allowed = projection_fields(component)
    for key, receipt in values.items():
        if key == "build":
            projected = build_projection(build, component)
        elif key == "sign":
            projected = {name: receipt[name] for name in ("kind", "schemaVersion", "status", "appName", "buildReceiptSha256")}
            projected.update(signature=sig)
            for name in ("unsignedFiles", "files") if component == "FruitctlHost.app" else ("unsignedArtifact", "artifactSha256", "artifactBytes"):
                projected[name] = receipt[name]
        elif key == "staple":
            projected = {name: receipt[name] for name in ("kind", "schemaVersion", "status", "appName", "buildReceiptSha256",
                         "signReceiptSha256", "notarizationReceiptSha256", "submissionId", "files")}
            projected["signature"] = sig
        elif key == "distribution":
            projected = {name: receipt[name] for name in ("kind", "schemaVersion", "status", "appName", "archiveSha256", "archiveBytes",
                         "signReceiptSha256", "stapleReceiptSha256", "acceptedNotarizationReceiptSha256",
                         "submissionArchiveReceiptSha256", "submittedArchiveSha256", "submissionId", "actualPostStapleFiles", "reextractedTicketValidated")}
            projected["gatekeeperNumericExit"] = 0
            projected["designatedRequirement"] = requirement
        elif key == "notary":
            projected = {name: receipt[name] for name in allowed[key] - {"apple"}}
            projected["apple"] = {name: receipt["apple"][name] for name in ("id", "status")}
        else:  # Source and submission archive have explicit portable field sets.
            projected = {name: receipt[name] for name in allowed[key]}
            if key == "source":
                strict_provenance(projected["nativeSourceProvenance"])
        public_safe(projected)
        projections[key] = {"originalKind": receipt["kind"], "originalSha256": hashes[key],
                            "projectionSha256": tree_digest(projected),
                            "projectionBytes": len(json.dumps(projected, sort_keys=True).encode()), "value": projected}
    return {"component": component, "producerRevision": build["sourceRevision"], "license": COMPONENTS[component][2],
            "archive": paths["archive"].name, "submissionArchive": paths["submissionArchive"].name,
            "sourceArchive": paths["sourceArchive"].name, "binary": binary, "receipts": projections,
            "portableBuildSha256": source_result["portableBuildSha256"], "archiveMap": distribution_map,
            "submissionMap": submission_map, "noticesSha256": digest_bytes(source_result["notices"]),
            "identityEvidence": identity_evidence(component, projections),
            "originalReceiptBytesCheckedByWriter": True}, source_result["notices"]


def assets_for(root, version, rows):
    assets = {}
    for row in rows:
        for field, kind in (("archive", "native"), ("submissionArchive", "evidence"), ("sourceArchive", "source")):
            name = row[field]
            if name not in assets:
                path = canonical_file(root / name)
                receipts = row["receipts"]
                expected = (receipts["source"]["value"]["source_archive_sha256"] if field == "sourceArchive" else
                            receipts["distribution"]["value"]["archiveSha256"] if field == "archive" and row["component"] == "FruitctlHost.app" else
                            receipts["archive"]["value"]["archiveSha256"])
                require(digest(path) == expected, "asset changed after native checks")
                assets[name] = {"kind": kind, "name": name, "sha256": digest(path),
                                "url": "https://github.com/xoxd-ai/fruitctl/releases/download/" + version + "/" + name}
                if kind == "native":
                    assets[name].update(os="darwin", arch="arm64", component=row["component"])
    return assets


def verify_native(manifest, root, evidence):
    require(isinstance(manifest, dict) and isinstance(evidence, dict)
            and manifest.get("mode") == "native-only" and manifest.get("qualification") == QUALIFICATION
            and evidence.get("kind") == "fruitctl-native-release-evidence" and evidence.get("schemaVersion") == 1
            and evidence.get("verificationScope") == QUALIFICATION, "explicit structural-only native contract required")
    public_safe(manifest)
    require(set(manifest) == {"schema", "mode", "version", "repository", "qualification", "nativeEvidence", "assets"}
            and set(evidence) == {"schemaVersion", "kind", "verificationScope", "originalReceiptHashes", "components"}
            and evidence["originalReceiptHashes"] == ORIGINAL_HASH_SCOPE, "native root metadata fields differ")
    rows = evidence.get("components", [])
    require(rows and len(rows) <= 2 and len({row["component"] for row in rows}) == len(rows), "unique native components required")
    public_safe(evidence)
    for row in rows:
        component = row["component"]; require(component in COMPONENTS, "unsupported native component")
        require(set(row) == {"component", "producerRevision", "license", "archive", "submissionArchive", "sourceArchive", "binary",
                            "receipts", "portableBuildSha256", "archiveMap", "submissionMap", "noticesSha256",
                            "identityEvidence", "originalReceiptBytesCheckedByWriter"}
                and row["originalReceiptBytesCheckedByWriter"] is True, "native component metadata fields differ")
        for key in ("archive", "submissionArchive", "sourceArchive"):
            asset_name(row[key]); canonical_file(root / row[key])
        receipts = row["receipts"]
        keys = {"build", "source", "sign", "archive", "notary"} | ({"staple", "distribution"} if component == "FruitctlHost.app" else set())
        require(set(receipts) == keys, "complete native receipt projections required")
        allowed = projection_fields(component)
        for key, receipt in receipts.items():
            require(set(receipt) == {"originalKind", "originalSha256", "projectionSha256", "projectionBytes", "value"}
                    and set(receipt["value"]) == allowed[key], "native projection fields differ")
            require(hex_hash(receipt["originalSha256"]) and receipt["projectionSha256"] == tree_digest(receipt["value"])
                    and receipt["projectionBytes"] == len(json.dumps(receipt["value"], sort_keys=True).encode()),
                    "portable receipt projection hash differs")
        v = {key: receipt["value"] for key, receipt in receipts.items()}; h = {key: receipt["originalSha256"] for key, receipt in receipts.items()}
        kinds = {"source": "fruitctl-corresponding-source-package", "archive": "fruitctl-apple-submission-archive",
                 "build": "fruitctl-native-build",
                 "notary": "fruitctl-apple-notarization", "sign": "fruitctl-apple-sign" if component == "FruitctlHost.app" else "fruitctl-apple-tool-sign",
                 "staple": "fruitctl-apple-staple", "distribution": "fruitctl-private-stapled-host-distribution"}
        require(all(receipts[key]["originalKind"] == kinds[key] for key in keys)
                and all(v[key].get("kind") == kinds[key] and v[key].get("schemaVersion") == 1 and v[key].get("status") == "passed"
                    for key in keys - {"build"}), "native projection receipt kind/status differs")
        build, source, sign, submission, notary = (v[key] for key in ("build", "source", "sign", "archive", "notary"))
        strict_provenance(source["nativeSourceProvenance"])
        require(set(notary["apple"]) == {"id", "status"}, "Apple projection fields differ")
        require(all(hex_hash(source[name]) for name in ("source_archive_sha256", "buildReceiptSha256", "publicSourceInventorySha256",
                     "nativeInputManifestSha256", "sourceTreeSha256")), "source projection hashes differ")
        require(row["producerRevision"] == build["sourceRevision"] and hex_hash(row["producerRevision"], 40)
                and build.get("architecture") == "arm64"
                and row["license"] == COMPONENTS[component][2] and build["sourceTreeSha256"] == tree_digest(source_map(build["sourceFiles"])),
                "native producer/source identity differs")
        require(source["buildReceiptSha256"] == h["build"] == sign["buildReceiptSha256"]
                and submission["signReceiptSha256"] == h["sign"] and notary["archiveReceiptSha256"] == h["archive"]
                and notary["submittedArchiveSha256"] == submission["archiveSha256"], "native receipt hash chain differs")
        require(sign["appName"] == submission["appName"] == notary["appName"] == component
                and notary["apple"]["status"] == "Accepted" and str(uuid.UUID(notary["apple"]["id"])) == notary["apple"]["id"].lower(),
                "Accepted component chain required")
        signature = sign["signature"]
        require(set(signature) == {"identifier", "teamIdentifier", "certificateSha1", "hardenedRuntime", "timestamp"},
                "signature projection fields differ")
        require(signature.get("identifier") == COMPONENTS[component][1] and signature.get("hardenedRuntime") is True
                and re.fullmatch(r"[A-Z0-9]{10}", signature.get("teamIdentifier", ""))
                and re.fullmatch(r"[A-F0-9]{40}", signature.get("certificateSha1", "")) and signature.get("timestamp"),
                "stable signature projection required")
        require(row.get("identityEvidence") == identity_evidence(component, receipts),
                "identity observation gaps differ from receipt projections")
        if component == "FruitctlHost.app":
            staple, distribution = v["staple"], v["distribution"]
            require(sign["unsignedFiles"] == build["artifacts"][component]["files"], "unsigned Host source artifact differs")
            before = sign["files"]; final = staple["files"]
            require(set(before) == set(sign["unsignedFiles"]) | {"Contents/_CodeSignature/CodeResources"}
                    and all(before.get(name) == descriptor for name, descriptor in sign["unsignedFiles"].items()
                            if name != "Contents/MacOS/FruitctlHost")
                    and all(final.get(name) == descriptor for name, descriptor in before.items())
                    and set(final) == set(before) | {"Contents/CodeResources"}, "Host signed files changed after staple")
            require(staple["buildReceiptSha256"] == h["build"] and staple["signReceiptSha256"] == h["sign"]
                    and staple["notarizationReceiptSha256"] == h["notary"] and staple["submissionId"] == notary["apple"]["id"]
                    and staple["signature"] == signature and distribution["stapleReceiptSha256"] == h["staple"]
                    and distribution["signReceiptSha256"] == h["sign"] and distribution["acceptedNotarizationReceiptSha256"] == h["notary"]
                    and distribution["submissionArchiveReceiptSha256"] == h["archive"]
                    and distribution["submittedArchiveSha256"] == submission["archiveSha256"]
                    and staple["appName"] == distribution["appName"] == component
                    and distribution["submissionId"] == notary["apple"]["id"]
                    and distribution["actualPostStapleFiles"] == final and distribution["reextractedTicketValidated"] is True
                    and distribution["gatekeeperNumericExit"] == 0, "Host distribution/staple chain differs")
            requirement = distribution["designatedRequirement"]
            require(set(requirement) == {"expression", "sha256"} and isinstance(requirement["expression"], str)
                    and 0 < len(requirement["expression"].encode()) <= 16384
                    and requirement["sha256"] == digest_bytes(requirement["expression"].encode())
                    and 'identifier "' + signature["identifier"] + '"' in requirement["expression"]
                    and signature["teamIdentifier"] in requirement["expression"], "Host requirement projection differs")
            binary = final["Contents/MacOS/FruitctlHost"]
            require(digest(root / row["archive"]) == distribution["archiveSha256"]
                    and (root / row["archive"]).stat().st_size == distribution["archiveBytes"], "Host distribution bytes differ")
        else:
            require(sign["unsignedArtifact"] == build["artifacts"][component] and row["archive"] == row["submissionArchive"],
                    "controller original artifact/submission differs")
            binary = {"sha256": sign["artifactSha256"], "bytes": sign["artifactBytes"]}; before = final = {component: binary}
        require(row["binary"] == binary and source["binary_sha256"] == {COMPONENTS[component][0]: binary}, "source links different native binary")
        require(digest(root / row["submissionArchive"]) == submission["archiveSha256"]
                and (root / row["submissionArchive"]).stat().st_size == submission["archiveBytes"]
                and digest(root / row["sourceArchive"]) == source["source_archive_sha256"]
                and (root / row["sourceArchive"]).stat().st_size == source["sourceArchiveBytes"], "native/source asset bytes differ")
        require(zip_map(root / row["archive"], component, final) == row["archiveMap"]
                and zip_map(root / row["submissionArchive"], component, before) == row["submissionMap"], "complete native ZIP map differs")
        result = tar_source(root / row["sourceArchive"], source, component)
        require(result["portableBuildSha256"] == row["portableBuildSha256"]
                and build_projection(result["build"], component) == build
                and digest_bytes(result["notices"]) == row["noticesSha256"] == digest(root / "THIRD_PARTY_NOTICES.md"),
                "portable source build/notices differs")
    expected = assets_for(root, manifest["version"], rows)
    for name in ("native-evidence.json", "THIRD_PARTY_NOTICES.md"):
        canonical_file(root / name)
        expected[name] = {"kind": "evidence", "name": name, "sha256": digest(root / name),
                          "url": "https://github.com/xoxd-ai/fruitctl/releases/download/" + manifest["version"] + "/" + name}
    require(sorted(manifest["assets"], key=lambda asset: asset["name"]) == sorted(expected.values(), key=lambda asset: asset["name"]),
            "native manifest asset allowlist differs")
    return len(rows)
