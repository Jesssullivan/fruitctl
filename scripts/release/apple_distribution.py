#!/usr/bin/env python3
"""Explicit Apple signing phases. Never discover credentials, launch an app, or publish."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile
import time


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def inventory(app):
    files = {}
    for path in sorted(app.rglob("*")):
        # Framework symlinks are valid signed bundle structure. Bind their targets,
        # rather than dereference arbitrary paths outside the app.
        if path.is_symlink():
            require(path.resolve().is_relative_to(app), "bundle symlink escapes the app")
            files[path.relative_to(app).as_posix()] = {"symlink": str(path.readlink())}
        elif path.is_file():
            files[path.relative_to(app).as_posix()] = {"sha256": digest(path), "bytes": path.stat().st_size}
    return files


def app_path(value):
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path and path.name.endswith(".app")
            and (path / "Contents/Info.plist").is_file(), "app must be a canonical, existing application bundle")
    return path


def read_receipt(path, kind):
    value = json.loads(Path(path).read_text())
    kinds = kind if isinstance(kind, tuple) else (kind,)
    require(value.get("kind") in kinds and value.get("schemaVersion") == 1 and value.get("status") == "passed",
            "a passing receipt from the previous phase is required")
    return value


def write_receipt(path, value):
    path = Path(path)
    require(path.is_absolute() and not path.exists(), "receipt must be a new absolute path")
    value.update(schemaVersion=1, status="passed", completedAtUnix=int(time.time()))
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def run(command):
    return subprocess.check_output([str(value) for value in command], stdin=subprocess.DEVNULL,
                                   stderr=subprocess.STDOUT, text=True, timeout=930 if "notarytool" in command else 120)


def metadata(app, team, certificate_sha1=None):
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", app])
    description = run(["codesign", "--display", "--verbose=4", app])
    details = dict(line.split("=", 1) for line in description.splitlines() if "=" in line)
    require(details.get("TeamIdentifier") == team, "actual signature team differs from the explicitly expected team")
    require(bool(re.search(r"^CodeDirectory .*flags=.*\(runtime\)", description, re.M)), "hardened runtime is required")
    require("Timestamp" in details, "secure timestamp is required")
    require("Authority=Developer ID Application:" in description, "Developer ID Application authority is required")
    result = {"teamIdentifier": details["TeamIdentifier"], "identifier": details.get("Identifier"), "description": description.strip()}
    if certificate_sha1:
        with tempfile.TemporaryDirectory(prefix="fruitctl-public-certificate-") as directory:
            prefix = Path(directory) / "certificate"
            run(["codesign", "--display", "--extract-certificates", prefix, app])
            actual = hashlib.sha1(Path(str(prefix) + "0").read_bytes()).hexdigest().upper()
        require(actual == certificate_sha1.upper(), "signature leaf certificate differs from explicit expected certificate")
        result["certificateSha1"] = actual
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="phase", required=True)
    sign = commands.add_parser("sign", help="Sign on PZM using an explicitly supplied Developer ID identity")
    sign.add_argument("--app", required=True)
    sign.add_argument("--identity", required=True)
    sign.add_argument("--team", required=True)
    sign.add_argument("--receipt", required=True)
    sign.add_argument("--build-receipt", required=True)
    sign.add_argument("--existing-keychain", required=True)
    sign.add_argument("--certificate-sha1", required=True)
    tool = commands.add_parser("sign-tool", help="Sign a private copy of the tested native controller using the explicit existing keychain")
    tool.add_argument("--binary", required=True)
    tool.add_argument("--output", required=True)
    tool.add_argument("--identity", required=True)
    tool.add_argument("--team", required=True)
    tool.add_argument("--identifier", required=True)
    tool.add_argument("--existing-keychain", required=True)
    tool.add_argument("--certificate-sha1", required=True)
    tool.add_argument("--build-receipt", required=True)
    tool.add_argument("--receipt", required=True)
    archive = commands.add_parser("archive", help="Archive the verified signed app for transfer to Neo")
    archive.add_argument("--app", required=True)
    archive.add_argument("--sign-receipt", required=True)
    archive.add_argument("--zip", required=True)
    archive.add_argument("--receipt", required=True)
    notarize = commands.add_parser("notarize", help="Explicit Neo submission through an existing keychain profile")
    notarize.add_argument("--zip", required=True)
    notarize.add_argument("--archive-receipt", required=True)
    credentials = notarize.add_mutually_exclusive_group(required=True)
    credentials.add_argument("--keychain-profile")
    credentials.add_argument("--material-dir", help="Exact existing ASC carrier; no discovery, copy, profile creation or keychain modification")
    notarize.add_argument("--receipt", required=True)
    staple = commands.add_parser("staple", help="Staple on PZM after an actual Accepted receipt is transferred back")
    staple.add_argument("--app", required=True)
    staple.add_argument("--sign-receipt", required=True)
    staple.add_argument("--notarization-receipt", required=True)
    staple.add_argument("--archive-receipt", required=True)
    staple.add_argument("--receipt", required=True)
    args = parser.parse_args()
    require(platform.system() == "Darwin", "Apple distribution phases require a Darwin host")
    require(Path(args.receipt).is_absolute() and not Path(args.receipt).exists(), "receipt must be a new absolute path")
    if args.phase in ("sign", "sign-tool"):
        app = app_path(args.app) if args.phase == "sign" else Path(args.binary)
        require(re.fullmatch(r"[A-Z0-9]{10}", args.team), "explicit Developer ID team must contain 10 uppercase letters/digits")
        require(args.identity != "-", "ad-hoc signing is not a public distribution signature")
        require(re.fullmatch(r"[A-Fa-f0-9]{40}", args.certificate_sha1), "explicit signing certificate SHA-1 required")
        keychain = Path(args.existing_keychain)
        require(keychain.is_absolute() and keychain.resolve(strict=True) == keychain and keychain.is_file(), "explicit canonical existing keychain required")
        built = read_receipt(args.build_receipt, "fruitctl-native-build")
        if args.phase == "sign-tool":
            require(app.is_absolute() and app.resolve(strict=True) == app and app.is_file(), "canonical native binary required")
            original = {"sha256": digest(app), "bytes": app.stat().st_size}
            require(built.get("artifacts", {}).get(app.name) == original, "native tool differs from tested build artifact")
            require(run(["lipo", "-archs", app]).strip() == "arm64", "current native release requires exactly arm64")
            linkage = run(["otool", "-L", app])
            require("/nix/store/" not in linkage and "/opt/homebrew/" not in linkage and "/usr/local/" not in linkage,
                    "native tool depends on host-specific libraries")
            target = Path(args.output)
            require(target.is_absolute() and not target.exists() and target.name == app.name, "new private native output preserving executable name required")
            target.write_bytes(app.read_bytes()); target.chmod(0o755)
            run(["codesign", "--force", "--options", "runtime", "--timestamp", "--keychain", keychain,
                 "--identifier", args.identifier, "--sign", args.identity, target])
            signature = metadata(target, args.team, args.certificate_sha1)
            require(signature["identifier"] == args.identifier, "native signing identifier differs")
            write_receipt(args.receipt, {"kind": "fruitctl-apple-tool-sign", "appName": target.name,
                "signature": signature, "artifactSha256": digest(target), "artifactBytes": target.stat().st_size,
                "unsignedArtifact": original, "buildReceiptSha256": digest(Path(args.build_receipt)), "unattendedSigningQualified": False})
            print(json.dumps({"status": "passed", "phase": args.phase, "receipt": args.receipt, "runtimeQualification": "not-established-by-signing"}))
            return
        original = inventory(app)
        require(built.get("artifacts", {}).get(app.name, {}).get("files") == original,
                "unsigned app is not an exact artifact of the tested source build")
        # This narrow product currently has no embedded apps/frameworks/helpers.
        # Refuse a future complex bundle until its explicit signing order exists.
        require(not (app / "Contents/Frameworks").exists() and not (app / "Contents/PlugIns").exists(),
                "embedded code requires an explicit reviewed inner-to-outer signing rail")
        run(["codesign", "--force", "--options", "runtime", "--timestamp", "--keychain", keychain, "--sign", args.identity, app])
        write_receipt(args.receipt, {"kind": "fruitctl-apple-sign", "appName": app.name,
                                     "signature": metadata(app, args.team, args.certificate_sha1), "files": inventory(app),
                                     "buildReceiptSha256": digest(Path(args.build_receipt)), "unsignedFiles": original})
    elif args.phase == "archive":
        signed = read_receipt(args.sign_receipt, ("fruitctl-apple-sign", "fruitctl-apple-tool-sign"))
        app = app_path(args.app) if signed["kind"] == "fruitctl-apple-sign" else Path(args.app)
        require(app.name == signed["appName"], "signed artifact name changed")
        if signed["kind"] == "fruitctl-apple-sign":
            require(inventory(app) == signed["files"], "signed app bytes changed")
        else:
            require(app.is_file() and not app.is_symlink() and digest(app) == signed["artifactSha256"], "signed native tool bytes changed")
        metadata(app, signed["signature"]["teamIdentifier"], signed["signature"].get("certificateSha1"))
        target = Path(args.zip)
        require(target.is_absolute() and not target.exists() and target.suffix == ".zip", "submission archive must be a new absolute ZIP path")
        run(["ditto", "-c", "-k", "--keepParent", app, target])
        write_receipt(args.receipt, {"kind": "fruitctl-apple-submission-archive", "appName": app.name,
                                     "signReceiptSha256": digest(Path(args.sign_receipt)),
                                     "archiveSha256": digest(target), "archiveBytes": target.stat().st_size})
    elif args.phase == "notarize":
        previous = read_receipt(args.archive_receipt, "fruitctl-apple-submission-archive")
        target = Path(args.zip)
        require(target.is_absolute() and digest(target) == previous["archiveSha256"], "submission archive bytes changed")
        # Uses only an operator-established profile. No password, API key, token,
        # profile creation, signing identity discovery, or automatic retries.
        authentication = ["--keychain-profile", args.keychain_profile] if args.keychain_profile else None
        if args.material_dir:
            material = Path(args.material_dir)
            require(material.is_absolute() and material.resolve(strict=True) == material, "explicit canonical ASC material directory required")
            files = {name: material / name for name in ("apple_asc_api_key_id", "apple_asc_api_issuer_id", "apple_asc_api_key_p8")}
            require(all(path.is_file() for path in files.values()), "existing ASC material is unavailable")
            authentication = ["--key", files["apple_asc_api_key_p8"], "--key-id", files["apple_asc_api_key_id"].read_text().strip(),
                              "--issuer", files["apple_asc_api_issuer_id"].read_text().strip()]
        apple = json.loads(run(["xcrun", "notarytool", "submit", target, "--wait", "--timeout", "15m", *authentication, "--output-format", "json"]))
        require(apple.get("status") == "Accepted" and bool(apple.get("id")), "Apple did not return an Accepted submission")
        write_receipt(args.receipt, {"kind": "fruitctl-apple-notarization", "appName": previous["appName"],
                                     "archiveReceiptSha256": digest(Path(args.archive_receipt)),
                                     "submittedArchiveSha256": digest(target), "apple": apple})
    else:
        app = app_path(args.app)
        signed = read_receipt(args.sign_receipt, "fruitctl-apple-sign")
        archived = read_receipt(args.archive_receipt, "fruitctl-apple-submission-archive")
        accepted = read_receipt(args.notarization_receipt, "fruitctl-apple-notarization")
        require(accepted["apple"].get("status") == "Accepted" and bool(accepted["apple"].get("id")), "actual Accepted ticket is required")
        require(archived["signReceiptSha256"] == digest(Path(args.sign_receipt))
                and accepted["archiveReceiptSha256"] == digest(Path(args.archive_receipt))
                and accepted["submittedArchiveSha256"] == archived["archiveSha256"], "distribution receipt chain differs")
        require(app.name == signed["appName"] == archived["appName"] == accepted["appName"]
                and inventory(app) == signed["files"], "signed app no longer matches the notarized bytes")
        run(["xcrun", "stapler", "staple", app])
        run(["xcrun", "stapler", "validate", app])
        signature = metadata(app, signed["signature"]["teamIdentifier"], signed["signature"].get("certificateSha1"))
        write_receipt(args.receipt, {"kind": "fruitctl-apple-staple", "appName": app.name, "signature": signature,
                                     "notarizationReceiptSha256": digest(Path(args.notarization_receipt)),
                                     "submissionId": accepted["apple"]["id"], "files": inventory(app),
                                     "buildReceiptSha256": signed["buildReceiptSha256"],
                                     "signReceiptSha256": digest(Path(args.sign_receipt))})
    print(json.dumps({"status": "passed", "phase": args.phase, "receipt": args.receipt,
                      "runtimeQualification": "not-established-by-signing"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        # Avoid reproducing command arguments/output from credential-bearing tools.
        print("Apple distribution phase failed: " + (str(error) if not isinstance(error, (subprocess.CalledProcessError, subprocess.TimeoutExpired))
                                                       else "external tool returned a failure"), file=sys.stderr)
        raise SystemExit(1)
