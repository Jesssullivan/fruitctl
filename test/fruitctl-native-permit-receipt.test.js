// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = new URL('./fruitctl-native-permit.py', import.meta.url).pathname;

// Compile only the real receipt checker. No candidate imports, native/Node
// producer, sockets, signals, threads or desktop actions run in these cases.
const checkSource = String.raw`
import ast, json, pathlib, sys
tree = ast.parse(pathlib.Path(sys.argv[1]).read_text())
checker = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
               and node.name == 'require_suspension_evidence')
scenario = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'scenario')
assert any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
           and node.func.id == 'require_suspension_evidence' for node in ast.walk(scenario))
namespace = {}
exec(compile(ast.Module(body=[checker], type_ignores=[]), sys.argv[1], 'exec'), namespace)
results = []
for report in json.loads(sys.stdin.read()):
    try:
        namespace['require_suspension_evidence'](report)
    except AssertionError as error:
        results.append(str(error))
    else:
        results.append(None)
print(json.dumps(results))
`;

function check(reports) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', checkSource, source], {
    input: JSON.stringify(reports), encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const errors = JSON.parse(result.stdout);
  assert.equal(errors.length, reports.length);
  return errors;
}

function boundedReceipt(kind = 'key') {
  const events = kind === 'key'
    ? [{ kind: 'key', key: 97, down: 1, receivedMonotonicNanoseconds: 990000000 },
      { kind: 'key', key: 97, down: 0, receivedMonotonicNanoseconds: 1800000000 }]
    : [{ kind: 'pointer', mask: 1, x: 5, y: 5, receivedMonotonicNanoseconds: 990000000 },
      { kind: 'pointer', mask: 0, x: 5, y: 5, receivedMonotonicNanoseconds: 1800000000 }];
  return {
    ownedBrokerPid: 123,
    signals: [{ pid: 123, signal: 'SIGSTOP', atNanoseconds: 1000000000 },
      { pid: 123, signal: 'SIGCONT', atNanoseconds: 2150000000 }],
    messages: [{ kind: 'permit', method: 'grant_input_permit',
      observedMonotonicNanoseconds: 900000000, result: { native_permit_remaining_ms: 800 } }],
    observerExpiryUpperBoundNanoseconds: 1700000000,
    eventsObservedWhileBrokerSuspended: events,
    eventsAfterObserverExpiryUpperBound: [{ ...events[1], forcedCleanupRelease: true }],
    heldInputAfterExpiry: { keys: [], pointer: false },
    brokerExitCode: 0, readerThreadsStopped: true, fixtureThreadStopped: true, fixtureErrors: [],
  };
}

test('native permit receipt refuses an error-only pre-input refusal without actual suspension', () => {
  const earlyRefusal = { ...boundedReceipt(), signals: [], messages: [
    { kind: 'action-result', error: 'Action unavailable on native backend' },
    { kind: 'successor-result', error: 'Daemon not ready' },
    { kind: 'late-native-begin-unexecuted', reason: 'owned executor already terminal' }],
  eventsObservedWhileBrokerSuspended: [] };
  assert.match(check([earlyRefusal])[0], /suspension and resume were not observed/);
});

test('native permit receipt accepts bounded actual-style key and pointer expiry with neutralization', () => {
  assert.deepEqual(check([boundedReceipt(), boundedReceipt('pointer')]), [null, null]);
});

test('native permit receipt rejects missing grants, incomplete suspension and invalid expiry intervals', () => {
  const changes = [
    receipt => { receipt.messages = []; },
    receipt => { receipt.messages[0].error = 'grant refused'; },
    receipt => { receipt.signals.pop(); },
    receipt => { receipt.signals[1].pid++; },
    receipt => { receipt.signals.reverse(); },
    receipt => { receipt.signals[1].atNanoseconds = 1700000001; },
    receipt => { receipt.messages[0].result.native_permit_remaining_ms = 0; },
    receipt => { receipt.messages[0].result.native_permit_remaining_ms = 1001; },
    receipt => { receipt.observerExpiryUpperBoundNanoseconds++; },
    receipt => { receipt.signals[0].atNanoseconds = 600000000; },
    receipt => { receipt.eventsObservedWhileBrokerSuspended = []; },
  ];
  const cases = changes.map(change => { const receipt = boundedReceipt(); change(receipt); return receipt; });
  assert.ok(check(cases).every(error => typeof error === 'string' && error.length));
});

test('native permit receipt rejects noncleanup events after expiry, held input and incomplete closure', () => {
  const changes = [
    receipt => { receipt.eventsObservedWhileBrokerSuspended.splice(1, 0,
      { kind: 'key', key: 98, down: 1, receivedMonotonicNanoseconds: 1700000001 }); },
    receipt => { receipt.eventsObservedWhileBrokerSuspended.pop(); },
    receipt => { receipt.eventsAfterObserverExpiryUpperBound = []; },
    receipt => { receipt.heldInputAfterExpiry.keys = [97]; },
    receipt => { receipt.brokerExitCode = null; },
    receipt => { receipt.readerThreadsStopped = false; },
    receipt => { receipt.fixtureThreadStopped = false; },
    receipt => { receipt.fixtureErrors = ['fixture still live']; },
  ];
  const cases = changes.map(change => { const receipt = boundedReceipt(); change(receipt); return receipt; });
  const pointerHeld = boundedReceipt('pointer');
  pointerHeld.eventsObservedWhileBrokerSuspended.pop();
  assert.ok(check([...cases, pointerHeld]).every(error => typeof error === 'string' && error.length));
});
