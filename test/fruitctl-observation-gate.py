#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Native observation admission regression using owned synthetic loopback only.

On Darwin, explicitly opt in and supply an already built controller:
  FRUITCTL_RUN_NATIVE_SYNTHETIC=1 python3 -I test/fruitctl-observation-gate.py \
    --daemon /path/to/claude-kvm-daemon --output-dir /path/to/new-receipts

No target arguments are accepted. The existing fixture supplies its synthetic
credential over descriptor 3 and receives all key/pointer events on its own
ephemeral IPv4 loopback connection. This does not qualify a real desktop,
authentication, GUI, capture helper, frontend, signed release or product SLO.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import time


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def metadata(response):
    return {"error": response["error"], "hasImage": bool(response["image"]),
            "metadata": {key: value for key, value in response["metadata"].items() if key != "image"}}


def close_session(session, cleanup):
    """Only this test's recorded direct child may receive a fallback signal."""
    process = session.process
    if process.poll() is None:
        process.stdin.close()
        try:
            process.wait(timeout=6)
        except subprocess.TimeoutExpired:
            cleanup["fallbackSignals"].append({"pid": process.pid, "signal": "SIGTERM"})
            process.terminate()
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                cleanup["fallbackSignals"].append({"pid": process.pid, "signal": "SIGKILL"})
                process.kill()
                process.wait(timeout=3)
    for reader in session.readers:
        reader.join(timeout=2)
    cleanup["controllerExitCode"] = process.returncode
    cleanup["controllerExitConfirmed"] = process.poll() is not None
    cleanup["readerThreadsStopped"] = all(not reader.is_alive() for reader in session.readers)


def scenario(fixture_module, daemon, refresh_failure):
    fixture = fixture_module.RfbFixture()
    session = None
    cleanup = {"fallbackSignals": []}
    report = {"scenario": "failed-refresh-then-input" if refresh_failure else "input-before-observation",
              "status": "incomplete", "loopbackPort": fixture.port, "cleanup": cleanup,
              "expected": "pointer/key refused with zero events, then full-frame recovery admits exactly three events"}
    try:
        session = fixture_module.NativeSession(daemon, fixture.port)
        report["ownedControllerPid"] = session.process.pid
        report["firstCommand"] = "screenshot" if refresh_failure else "mouse_move"
        sequence = 0
        if refresh_failure:
            good = session.action("screenshot")
            sequence, png, binding = fixture_module.inspect_capture(good, fixture)
            report["initialObservation"] = {"marker": sequence, "pngSha256": hashlib.sha256(png).hexdigest(),
                                             "binding": metadata(good)}
            fixture.set_mode("partial")
            started = time.monotonic()
            failed = session.action("screenshot")
            report["failedRefresh"] = metadata(failed)
            report["failedRefresh"]["elapsedMilliseconds"] = round((time.monotonic() - started) * 1000, 3)
            fixture_module.require(failed["error"] is not None and not failed["image"],
                                   "partial refresh unexpectedly accepted")
            current = session.action("health")
            report["healthAfterFailure"] = metadata(current)
            fixture_module.require(current["error"] is None, "health failed after incomplete refresh")
            fields = ("nativeWidth", "nativeHeight", "connectionGeneration", "allocation")
            fixture_module.require(all(binding[key] == current["metadata"][key] for key in fields),
                                   "allocation/generation changed; retained-context boundary was not exercised")
            report["sameGeometryGenerationAllocation"] = True

        before = len(fixture.snapshot()["events"])
        pointer = session.action("mouse_move", x=19, y=11)
        key = session.action("key_tap", key="a")
        report["refusalResponses"] = {"pointer": metadata(pointer), "key": metadata(key)}

        # A successful full-frame response orders server processing after both
        # attempted inputs, so zero events cannot be a delayed socket reading.
        fixture.set_mode("full")
        recovered = session.action("screenshot")
        sequence, png, _ = fixture_module.inspect_capture(recovered, fixture, sequence)
        report["recoveryObservation"] = {"marker": sequence, "pngSha256": hashlib.sha256(png).hexdigest(),
                                         "binding": metadata(recovered)}
        blocked_events = fixture.snapshot()["events"][before:]
        report["refusedInputEvents"] = blocked_events
        report["refusalPassed"] = pointer["error"] is not None and key["error"] is not None and not blocked_events

        before_recovery_input = len(fixture.snapshot()["events"])
        admitted_pointer = session.action("mouse_move", x=19, y=11)
        admitted_key = session.action("key_tap", key="a")
        report["recoveryInputResponses"] = {"pointer": metadata(admitted_pointer), "key": metadata(admitted_key)}
        ordered = session.action("screenshot")
        sequence, png, _ = fixture_module.inspect_capture(ordered, fixture, sequence, (19, 11))
        report["observationAfterRecoveryInput"] = {"marker": sequence,
                                                   "pngSha256": hashlib.sha256(png).hexdigest()}
        recovery_events = fixture.snapshot()["events"][before_recovery_input:]
        report["recoveryInputEvents"] = recovery_events
        expected_events = [{"kind": "pointer", "mask": 0, "x": 19, "y": 11},
                           {"kind": "key", "down": 1, "key": ord("a")},
                           {"kind": "key", "down": 0, "key": ord("a")}]
        report["recoveryPassed"] = (admitted_pointer["error"] is None and admitted_key["error"] is None
                                     and recovery_events == expected_events)
        shutdown = session.action("shutdown")
        report["shutdown"] = metadata(shutdown)
        fixture_module.require(shutdown["error"] is None, "owned shutdown acknowledgement failed")
        report["status"] = "passed" if report["refusalPassed"] and report["recoveryPassed"] else "failed"
    except Exception as error:
        report["status"] = "failed"
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if session is not None:
            close_session(session, cleanup)
        fixture.close()
        cleanup["fixtureThreadStopped"] = not fixture.thread.is_alive()
        cleanup["fixtureSocketClosed"] = fixture.listener.fileno() == -1
        report["fixtureErrors"] = fixture.snapshot()["errors"]
        if (report["fixtureErrors"] or (session is not None and
                (cleanup["controllerExitCode"] != 0 or not cleanup["readerThreadsStopped"]
                 or cleanup["fallbackSignals"]))):
            report["status"] = "failed"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--expected-controller-sha")
    args = parser.parse_args()
    if os.environ.get("FRUITCTL_RUN_NATIVE_SYNTHETIC") != "1" or platform.system() != "Darwin":
        parser.error("requires Darwin and explicit FRUITCTL_RUN_NATIVE_SYNTHETIC=1")
    os.umask(0o077)
    daemon = args.daemon.resolve(strict=True)
    if not daemon.is_file() or not os.access(daemon, os.X_OK):
        parser.error("controller must be an already built executable file")
    if args.expected_controller_sha and digest(daemon) != args.expected_controller_sha:
        parser.error("controller binding mismatch")
    fixture_path = Path(__file__).resolve().with_name("fruitctl-rfb-integration.py")
    if args.output_dir.exists():
        parser.error("refuse to overwrite a previous receipt directory")
    args.output_dir.mkdir(mode=0o700, parents=True)
    for variable in ("VNC_PASSWORD", "VNC_HOST", "VNC_PORT", "VNC_USERNAME",
                     "CLAUDE_KVM_DAEMON_PATH", "CLAUDE_KVM_DAEMON_PARAMETERS"):
        os.environ.pop(variable, None)
    spec = importlib.util.spec_from_file_location("owned_rfb_fixture", fixture_path)
    fixture_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture_module)
    started = time.monotonic()
    receipt = {"schema": "fruitctl.synthetic.observation-gate.v1", "route": "native-PC-direct",
               "target": "owned-ephemeral-IPv4-loopback", "credentialTransport": "synthetic FD3 only",
               "controllerSha256": digest(daemon), "fixtureSha256": digest(fixture_path),
               "testSha256": digest(Path(__file__).resolve()),
               "qualification": "synthetic observation-admission boundaries only",
               "scenarios": [scenario(fixture_module, daemon, False), scenario(fixture_module, daemon, True)]}
    receipt["elapsedMilliseconds"] = round((time.monotonic() - started) * 1000, 3)
    receipt["status"] = "passed" if all(row["status"] == "passed" for row in receipt["scenarios"]) else "failed"
    path = args.output_dir / "receipt.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps({"status": receipt["status"], "scenarios": [row["status"] for row in receipt["scenarios"]],
                      "elapsedMilliseconds": receipt["elapsedMilliseconds"], "receiptSha256": digest(path)}))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
