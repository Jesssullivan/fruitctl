// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const fixture = new URL('./fruitctl-rfb-integration.py', import.meta.url).pathname;
const commandSource = readFileSync(new URL('../ClaudeKVM-Daemon/Protocol/Command.swift', import.meta.url), 'utf8');
const currentMethods = [...commandSource.match(/static let supportedMethods = \[([\s\S]*?)\]/)[1]
  .matchAll(/"([a-z][a-z0-9_]*)"/g)].map(match => match[1]);

// Exercise NativeSession's real startup reader with an owned pipe and a fake
// process constructor. No server, native binary or desktop is started.
const startup = String.raw`
import importlib.util, json, os, pathlib, queue, sys
spec = importlib.util.spec_from_file_location('owned_ready_fixture', pathlib.Path(sys.argv[1]))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
def forbidden(*args, **kwargs):
    raise AssertionError('offline ready test attempted a process or socket')
fixture.subprocess.Popen = forbidden
fixture.socket.socket = forbidden
fixture.os.kill = forbidden
results = []
for params in json.loads(sys.stdin.read()):
    closed = []
    def fake_init(self, args, env=None, pass_fds=()):
        assert args[-9:] == ['--host', '127.0.0.1', '--port', '12345', '--password-fd', '3',
                            '--no-reconnect', '--connect-timeout', '2']
        self.retained_fd = os.dup(pass_fds[0])
        self.messages = queue.Queue()
        self.notifications = []
        self.messages.put({'method': 'vnc_state', 'params': {'state': 'connected'}})
        self.messages.put({'method': 'ready', 'params': params})
    def fake_close(self):
        os.close(self.retained_fd)
        closed.append(True)
    fixture.JsonProcess.__init__ = fake_init
    fixture.JsonProcess.close = fake_close
    try:
        session = fixture.NativeSession(pathlib.Path('/owned/offline-controller'), 12345)
    except AssertionError as error:
        results.append({'error': str(error), 'closed': closed == [True]})
    else:
        assert session.notifications[-1] == {'method': 'ready', 'params': params}
        session.close()
        results.append({'error': None, 'closed': closed == [True]})
print(json.dumps(results))
`;

function readReady(cases) {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', startup, fixture], {
    input: JSON.stringify(cases), encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const responses = JSON.parse(result.stdout);
  assert.equal(responses.length, cases.length);
  assert.ok(responses.every(response => response.closed), 'owned startup pipe closed on every outcome');
  return responses;
}

const geometry = { scaledWidth: 96, scaledHeight: 53 };

test('native fixture accepts legacy and actual current ready metadata without discarding the notification', () => {
  assert.ok(currentMethods.length > 0);
  assert.ok(currentMethods.includes('screenshot') && currentMethods.includes('shutdown'));
  const responses = readReady([geometry, { ...geometry, capabilities: currentMethods },
    { ...geometry, capabilities: [], futureMetadata: 'additive' }]);
  assert.deepEqual(responses.map(response => response.error), [null, null, null]);
});

test('native fixture refuses wrong, missing and noninteger ready geometry before input', () => {
  const cases = [null, [], {}, { ...geometry, scaledWidth: 95 }, { ...geometry, scaledHeight: 52 },
    { ...geometry, scaledWidth: true }, { ...geometry, scaledHeight: '53' },
    { ...geometry, scaledWidth: 96.5 }];
  assert.ok(readReady(cases).every(response => response.error === 'unexpected native ready geometry'));
});

test('native fixture rejects malformed capability advertisements while accepting valid additive names', () => {
  const malformed = [null, {}, 'screenshot', [1], [[]], ['Screenshot'], ['screenshot', 'screenshot'],
    [''], ['a'.repeat(65)], ['key-tap'], ['screenshot\n'],
    Array.from({ length: 65 }, (_, index) => `action_${index}`)];
  assert.ok(readReady(malformed.map(capabilities => ({ ...geometry, capabilities })))
    .every(response => response.error === 'invalid native ready capabilities'));
  assert.equal(readReady([{ ...geometry, capabilities: ['future_action_2'] }])[0].error, null);
});
