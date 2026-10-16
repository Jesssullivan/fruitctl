// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const fixture = new URL('./fruitctl-rfb-integration.py', import.meta.url).pathname;

// Drive the fixture's request models with an owned loopback client that
// writes LibVNC 0.9.15's request pattern: the initial and missing-pixel full
// requests, then, in stream mode, an incremental re-arm after every update
// (rfbclient.c:2564) plus 50 ms incremental polls. On-demand writes neither.
// No native binary, desktop or non-loopback socket is involved (TIN-5509).
const models = String.raw`
import importlib.util, json, pathlib, select, socket, struct, sys, time
spec = importlib.util.spec_from_file_location('owned_model_fixture', pathlib.Path(sys.argv[1]))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
W, H = fixture.WIDTH, fixture.HEIGHT

class EmulatedClient:
    def __init__(self, port, on_demand):
        self.on_demand = on_demand
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=5)
        assert self.read(12) == b'RFB 003.008\n'
        self.sock.sendall(b'RFB 003.008\n')
        count = self.read(1)[0]
        assert 1 in self.read(count)
        self.sock.sendall(b'\x01')
        assert struct.unpack('!I', self.read(4))[0] == 0
        self.sock.sendall(b'\x01')  # ClientInit shared=1, LibVNC's default
        assert struct.unpack('!HH', self.read(4)) == (W, H)
        self.read(16)
        self.read(struct.unpack('!I', self.read(4))[0])
        self.sock.sendall(b'\x00' + b'\x00' * 3 + fixture.PIXEL_FORMAT.pack(32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
        self.sock.sendall(b'\x02\x00' + struct.pack('!Hi', 1, 0))
        self.request(False)  # rfbInitConnection's own request
        self.request(False)  # the daemon's missing-pixel request
        self.updates = 0

    def read(self, count):
        return fixture.exact_read(self.sock, count)

    def request(self, incremental):
        self.sock.sendall(b'\x03' + struct.pack('!BHHHH', int(incremental), 0, 0, W, H))

    def pump(self, seconds):
        received, deadline = 0, time.monotonic() + seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return received
            readable, _, _ = select.select([self.sock], [], [], remaining)
            if not readable:
                return received
            kind, rects = struct.unpack('!BxH', self.read(4))
            assert kind == 0
            for _ in range(rects):
                x, y, width, height, encoding = struct.unpack('!HHHHi', self.read(12))
                assert encoding == 0
                self.read(width * height * 4)
            received += 1
            self.updates += 1
            if not self.on_demand:
                self.request(True)  # LibVNC re-arms before FinishedFrameBufferUpdate

    def idle(self, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self.pump(0.05)
            if not self.on_demand:
                self.request(True)

    def capture(self, timeout):
        self.request(False)
        return self.pump(timeout) > 0

results = []
for model in fixture.MODEL_SCENARIOS:
    for mode in ('stream', 'on-demand'):
        server = fixture.RfbFixture(request_model=model)
        client = EmulatedClient(server.port, mode == 'on-demand')
        initial = client.pump(0.3) > 0
        client.idle(0.3)
        fresh = client.capture(0.6)
        client.sock.close()
        server.finished.wait(3)
        server.close()
        snapshot = server.snapshot()
        results.append({'model': model, 'mode': mode, 'initial': initial, 'fresh': fresh,
            'incremental': sum(1 for r in snapshot['requests'] if r['incremental']),
            'shared': [c['shared'] for c in snapshot['connections']],
            'models': [c['requestModel'] for c in snapshot['connections']],
            'errors': snapshot['errors']})
print(json.dumps(results))
`;

test('fixture request models separate stream and on-demand outcomes for a LibVNC-shaped client', () => {
  const result = spawnSync('python3', ['-I', '-S', '-B', '-c', models, fixture], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 65536,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const outcomes = Object.fromEntries(JSON.parse(result.stdout)
    .map(outcome => [`${outcome.model}/${outcome.mode}`, outcome]));
  const expected = {
    'latest-wins/stream': true, 'latest-wins/on-demand': true,
    'first-wins/stream': false, 'first-wins/on-demand': true,
    'session-start-only/stream': false, 'session-start-only/on-demand': false,
    'silent/stream': false, 'silent/on-demand': false,
  };
  assert.deepEqual(Object.fromEntries(Object.entries(outcomes).map(([key, outcome]) => [key, outcome.fresh])),
    expected);
  for (const [key, outcome] of Object.entries(outcomes)) {
    assert.deepEqual(outcome.errors, [], key);
    assert.deepEqual(outcome.shared, [1], key);
    assert.deepEqual(outcome.models, [outcome.model], key);
    // A silent server never supplies even the connect-time frame.
    assert.equal(outcome.initial, outcome.model !== 'silent', key);
    if (outcome.mode === 'on-demand') assert.equal(outcome.incremental, 0, key);
    else assert.ok(outcome.incremental > 0, key);
  }
});
