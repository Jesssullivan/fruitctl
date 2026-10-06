#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Owned synthetic broker suspension proof, with an independent RFB observer.

Requires Darwin, opt-in, an already built daemon and Node 24. The direct Node
child uses the real NativeExecutor/HostHelperExecutor with an in-process fake
helper, complete synthetic PNG and ephemeral IPv4 loopback RFB server. Only
that recorded child is suspended/resumed; its native child remains running.
This qualifies this synthetic responsive writer, not Host UI/SCK/TCC, real
Screen Sharing or the completion of an already blocked network send.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import queue
import signal
import socket
import subprocess
import time


PRODUCER = r'''
import { NativeExecutor } from '__NATIVE__';
import { createHostHelperExecutor } from '__HELPER__';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
const [daemon, port, image, scenario] = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
const native = new NativeExecutor({ daemonPath: daemon, suppressDiagnostics: true,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, VNC_HOST: '127.0.0.1',
    VNC_PORT: port, VNC_PASSWORD: 'fruitctl-offline-fixture-only',
    CLAUDE_KVM_DAEMON_PARAMETERS: '--no-reconnect --connect-timeout 2' } });
const child = new EventEmitter();
child.stdout = new PassThrough(); child.stderr = new PassThrough();
child.exitCode = null; child.signalCode = null;
child.kill = signal => {
  if (child.signalCode !== null) return false;
  child.signalCode = signal;
  queueMicrotask(()=>{ child.emit('exit',null,signal); child.emit('close',null,signal); });
  return true; // In-process fixture only; never an OS signal.
};
let owner;
const state = () => ({ instance_id:'owned-synthetic-helper', capture_backend:'owned_sck',
  capture_enabled:true, screen_capture_permission:true, raw_vnc_exclusion:false,
  display_id:1, displayGeneration:1, renewal_interval_ms:500, input_permit_ms:1000,
  maximum_round_trip_ms:500, capture_ready:Boolean(owner), overlay_ready:Boolean(owner),
  ready:Boolean(owner), ui_heartbeat_age_ms:owner?0:null, lease_remaining_ms:owner?3000:0,
  ...(owner||{}) });
child.stdin = new Writable({ write(bytes,encoding,done) {
  const request = JSON.parse(bytes.toString());
  if (['begin_activity','renew_activity'].includes(request.action)) owner = {
    session_id:request.params.session_id,sequence:request.params.sequence,challenge:request.params.challenge };
  if (request.action==='release_activity') owner=undefined;
  let result=state();
  if(request.action==='capture') result={ ...result,image,mimeType:'image/png',
    nativeWidth:96,nativeHeight:53,scaledWidth:96,scaledHeight:53,
    display_bounds:{x:0,y:0,width:96,height:53},pixels_per_point_x:1,pixels_per_point_y:1,cursor_included:true };
  done(); queueMicrotask(()=>child.stdout.write(JSON.stringify({id:request.id,success:true,result})+'\n'));
} });
let latestBegin;
const originalControl = native.inputPermitControl.bind(native);
native.inputPermitControl = async(method,params,options) => {
  const response=await originalControl(method,params,options);
  if(method==='begin_input_permit'&&!response.error) latestBegin=params;
  emit({kind:'permit',method,result:response.result,error:response.error});
  return response;
};
try {
  await native.ready();
  emit({kind:'owned-native',pid:native.child.pid});
  await native.execute([{action:'configure',type_key_ms:200,type_inter_key_ms:1,
    drag_min_steps:100,drag_step_ms:100}]);
  const executor=await createHostHelperExecutor({nativeExecutor:native,
    hostHelper:{sshHost:'owned-fixture',command:['/owned/FruitctlHost','--stdio'],displayId:1,
      mapping:{qualificationReceipt:'owned-synthetic-fixture-only',displayId:1,
        nativeWidth:96,nativeHeight:53,scaledWidth:96,scaledHeight:53,
        displayBounds:{x:0,y:0,width:96,height:53}}},spawnImpl:()=>child});
  const action=scenario==='suspended-drag'?{action:'mouse_drag',x:5,y:5,toX:85,toY:45}:
    {action:'key_type',text:scenario==='healthy-renewal'?'abcdefgh':'abcdefghijklmnopqrstuvwxyz'.repeat(2)};
  let actionError=null;
  try { await executor.execute([action]); } catch(error) { actionError=error.message; }
  emit({kind:'action-result',error:actionError});
  if(scenario!=='healthy-renewal') {
    let successorError=null;
    try { await executor.execute([{action:'key_tap',key:'z'}]); } catch(error) { successorError=error.message; }
    emit({kind:'successor-result',error:successorError});
    // If still ready, a fresh owner attempt must be refused independently.
    if(native.isReady&&latestBegin) {
      const late=await originalControl('begin_input_permit',{...latestBegin,sequence:latestBegin.sequence+1});
      emit({kind:'late-native-begin',error:late.error});
    } else emit({kind:'late-native-begin-unexecuted',reason:'owned executor already terminal'});
    await executor.close();
  } else { await executor.release(); }
  await native.closed;
  emit({kind:'cleanup',nativeExitCode:native.child.exitCode,nativeSignal:native.child.signalCode});
} catch(error) {
  emit({kind:'fixture-error',message:error.message});
  await native.close({graceful:false}).catch(()=>{});
  process.exitCode=1;
}
'''


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wait_until(condition, seconds, message):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = condition()
        if value:
            return value
        time.sleep(0.005)
    raise TimeoutError(message)


def scenario(module, daemon, node, producer, image, name):
    class TimedEvents(list):
        def append(self, value):
            super().append({**value, "receivedMonotonicNanoseconds": time.monotonic_ns()})
    class ObservableFixture(module.RfbFixture):
        def _serve(self):
            listener = self.listener
            listener.settimeout(0.2)
            owner = self
            class BoundedAccept:
                def accept(self):
                    while not owner.stopping:
                        try:
                            return listener.accept()
                        except socket.timeout:
                            continue
                    raise EOFError("owned fixture stopping")
                def __getattr__(self, name):
                    return getattr(listener, name)
            self.listener = BoundedAccept()
            super()._serve()
    fixture = ObservableFixture()
    with fixture.lock:
        fixture.events = TimedEvents()
    broker = None
    stopped = False
    suspension_performed = False
    report = {"scenario": name, "status": "incomplete", "signals": [], "messages": [],
              "target": "owned-ephemeral-IPv4-loopback", "loopbackPort": fixture.port}
    try:
        broker = module.JsonProcess([str(node), str(producer), str(daemon), str(fixture.port), image, name])
        report["ownedBrokerPid"] = broker.process.pid
        latest_grant = None
        action_result = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                message = broker.messages.get(timeout=0.02)
                if isinstance(message, Exception):
                    if action_result is not None:
                        break
                    raise message
                observed = time.monotonic_ns()
                report["messages"].append({"observedMonotonicNanoseconds": observed, **message})
                if message["kind"] == "permit" and message["method"] == "grant_input_permit" and message.get("result"):
                    latest_grant = (observed, message["result"])
                elif message["kind"] == "action-result":
                    action_result = message
                elif message["kind"] == "fixture-error":
                    raise AssertionError(message["message"])
            except queue.Empty:
                pass
            if name != "healthy-renewal" and not suspension_performed and latest_grant and fixture.snapshot()["events"]:
                module.require(broker.process.poll() is None, "owned broker exited before suspension")
                os.kill(broker.process.pid, signal.SIGSTOP)
                stopped = True
                suspension_performed = True
                suspended = time.monotonic_ns()
                report["signals"].append({"pid": broker.process.pid, "signal": "SIGSTOP", "atNanoseconds": suspended})
                # Receipt-arrival + remaining duration is a conservative observer
                # upper bound; native compares its own earlier challenge origin.
                cutoff = latest_grant[0] + latest_grant[1]["native_permit_remaining_ms"] * 1_000_000
                report["observerExpiryUpperBoundNanoseconds"] = cutoff
                report["suspensionToObserverExpiryUpperBoundMilliseconds"] = (cutoff - suspended) / 1_000_000
                module.require(0 < cutoff - suspended <= 1_000_000_000,
                               "observer expiry exceeds one second after owned broker suspension")
                while time.monotonic_ns() < cutoff + 450_000_000:
                    time.sleep(0.005) # RFB observation thread remains running.
                suspended_events = fixture.snapshot()["events"]
                held_keys, held_pointer = set(), False
                after_expiry = []
                for event in suspended_events:
                    expired = event["receivedMonotonicNanoseconds"] >= cutoff
                    cleanup = False
                    if event["kind"] == "key":
                        cleanup = expired and event["down"] == 0 and event["key"] in held_keys
                        if event["down"]:
                            held_keys.add(event["key"])
                        else:
                            held_keys.discard(event["key"])
                    elif event["kind"] == "pointer":
                        cleanup = expired and event["mask"] == 0 and held_pointer
                        held_pointer = event["mask"] != 0
                    if expired:
                        after_expiry.append({**event, "forcedCleanupRelease": cleanup})
                report["eventsObservedWhileBrokerSuspended"] = suspended_events
                report["eventsAfterObserverExpiryUpperBound"] = after_expiry
                report["heldInputAfterExpiry"] = {"keys": sorted(held_keys), "pointer": held_pointer}
                nonrelease = [event for event in suspended_events if (event["kind"] == "key" and event["down"])
                              or (event["kind"] == "pointer" and event["mask"])]
                report["lastNonReleaseAfterSuspensionMilliseconds"] = (
                    (nonrelease[-1]["receivedMonotonicNanoseconds"] - suspended) / 1_000_000 if nonrelease else None)
                module.require(not [event for event in after_expiry if not event["forcedCleanupRelease"]],
                               "non-release input arrived after expiry while broker stopped")
                module.require(not held_keys and not held_pointer, "expiry failed to neutralize held input")
                module.require(broker.process.poll() is None, "suspended broker ownership changed")
                os.kill(broker.process.pid, signal.SIGCONT)
                stopped = False
                report["signals"].append({"pid": broker.process.pid, "signal": "SIGCONT",
                                           "atNanoseconds": time.monotonic_ns()})
        module.require(action_result is not None, "missing action result")
        if report["scenario"] == "healthy-renewal":
            module.require(action_result.get("error") is None, "healthy renewed action failed")
            grants = [message for message in report["messages"] if message["kind"] == "permit"
                      and message["method"] == "grant_input_permit" and message.get("result")]
            module.require(len(grants) >= 3, "long healthy action did not renew concurrently")
        else:
            module.require(action_result.get("error"), "expired action incorrectly succeeded")
            successors = [message for message in report["messages"] if message["kind"] == "successor-result"]
            module.require(successors and successors[0].get("error"), "successor input was accepted")
            late = [message for message in report["messages"] if message["kind"] == "late-native-begin"]
            module.require(all(message.get("error") for message in late), "late native begin was accepted")
        cleanup = [message for message in report["messages"] if message["kind"] == "cleanup"]
        module.require(len(cleanup) == 1, "native exit confirmation missing")
        if report["scenario"] == "healthy-renewal":
            module.require(cleanup[0]["nativeExitCode"] == 0 and cleanup[0]["nativeSignal"] is None,
                           "healthy native shutdown was not clean")
        else:
            # Existing NativeExecutor fail-close sends TERM to its recorded
            # child. Neutralizing RFB releases were observed before resume.
            module.require((cleanup[0]["nativeExitCode"] == 0 and cleanup[0]["nativeSignal"] is None)
                           or (cleanup[0]["nativeExitCode"] is None and cleanup[0]["nativeSignal"] == "SIGTERM"),
                           "native owned termination was unconfirmed or required KILL")
        broker.process.wait(timeout=5)
        module.require(broker.process.returncode == 0, "owned broker exited unsuccessfully")
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["failure"] = type(error).__name__ + ": " + str(error)
    finally:
        if broker is not None:
            if stopped and broker.process.poll() is None:
                os.kill(broker.process.pid, signal.SIGCONT)
                report["signals"].append({"pid": broker.process.pid, "signal": "SIGCONT", "reason": "owned cleanup"})
            report["brokerExitCode"] = broker.close()
            report["readerThreadsStopped"] = all(not thread.is_alive() for thread in broker.readers)
            report["brokerStderr"] = bytes(broker.stderr).decode(errors="replace")[-8192:]
            if not report["readerThreadsStopped"] or report["brokerExitCode"] != 0:
                report["status"] = "failed"
        try:
            fixture.close()
        except Exception as error:
            report["cleanupFailure"] = type(error).__name__ + ": " + str(error)
            report["status"] = "failed"
        report["fixtureThreadStopped"] = not fixture.thread.is_alive()
        report["fixtureErrors"] = fixture.snapshot()["errors"]
        if report["fixtureErrors"] or not report["fixtureThreadStopped"]:
            report["status"] = "failed"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, help="matching frozen source for private fixture iteration")
    args = parser.parse_args()
    if os.environ.get("FRUITCTL_RUN_NATIVE_SYNTHETIC") != "1" or platform.system() != "Darwin":
        parser.error("requires Darwin and explicit FRUITCTL_RUN_NATIVE_SYNTHETIC=1")
    os.umask(0o077)
    daemon, node = args.daemon.resolve(strict=True), args.node.resolve(strict=True)
    if args.output_dir.exists():
        parser.error("refuse to overwrite previous receipts")
    args.output_dir.mkdir(mode=0o700, parents=True)
    root = (args.source_dir or Path(__file__).resolve().parent.parent).resolve(strict=True)
    spec = importlib.util.spec_from_file_location("owned_rfb_fixture", root / "test/fruitctl-rfb-integration.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    producer = args.output_dir / "owned-producer.mjs"
    producer.write_text(PRODUCER.replace("__NATIVE__", (root / "lib/mcp/native.js").as_uri())
                        .replace("__HELPER__", (root / "lib/broker/host-helper.mjs").as_uri()))
    producer.chmod(0o600)
    # A complete PNG from the same owned synthetic dimensions; no GUI or SCK.
    import base64
    import struct
    import zlib
    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
    image = base64.b64encode(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", 96, 53, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes((96 * 4 + 1) * 53))) + chunk(b"IEND", b"")).decode()
    receipt = {"schema": "fruitctl.synthetic.native-permit.v1", "controllerSha256": digest(daemon),
        "nodeSha256": digest(node), "testSha256": digest(Path(__file__).resolve()),
        "sourceSha256": {str(path.relative_to(root)): digest(path) for path in [
            root / "lib/mcp/native.js", root / "lib/broker/host-helper.mjs", root / "test/fruitctl-rfb-integration.py"]},
        "qualification": "synthetic actual Node/native responsive-writer input expiry only; helper is in-process fake",
        "authority": "R-HOOK-CONVERGENCE-20261004 / R-N11 owned direct child suspension / R-N12 / R-N13",
        "scenarios": [scenario(module, daemon, node, producer, image, name) for name in
                      ("healthy-renewal", "suspended-text", "suspended-drag")]}
    receipt["status"] = "passed" if all(row["status"] == "passed" for row in receipt["scenarios"]) else "failed"
    path = args.output_dir / "receipt.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    path.chmod(0o600)
    print(json.dumps({"status": receipt["status"], "receiptSha256": digest(path),
                      "scenarios": [row["status"] for row in receipt["scenarios"]]}))
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
