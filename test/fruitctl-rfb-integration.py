#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Bounded offline RFB/PNG integration proof; never connects to a desktop.

The fixture binds an ephemeral loopback port, uses RFB 3.8 None authentication
and passes a synthetic credential to the native daemon on descriptor 3. It
checks real LibVNCClient decoding, PNG encoding and input messages. Optional
Node arguments repeat the same checks through the actual stdio MCP entrypoint
and shared broker. A legacy direct MCP route can also be selected explicitly.
These receipts qualify this synthetic fixture only, not macOS Screen Sharing,
TCC, overlay exclusion, a signed distribution or live end-to-end latency.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import queue
import socket
import statistics
import stat
import struct
import subprocess
import sys
import threading
import time
import zlib


WIDTH, HEIGHT = 96, 53  # Odd height also detects row/dimension mistakes.
POINTER_COLOR = (251, 17, 199)
SYNTHETIC_CREDENTIAL = b"fruitctl-offline-fixture-only"
PIXEL_FORMAT = struct.Struct("!BBBBHHHBBB3x")
MAX_LINE = 8 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def exact_read(connection, count):
    result = bytearray()
    while len(result) < count:
        part = connection.recv(count - len(result))
        if not part:
            raise EOFError("fixture peer closed")
        result.extend(part)
    return bytes(result)


def marker_color(sequence):
    # Carries the server's full-update ordinal in two lossless PNG channels.
    return (sequence & 255, (sequence >> 8) & 255, 73)


class RfbFixture:
    """One owned loopback connection with explicit full/partial/truncated modes."""

    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(15)
        self.port = self.listener.getsockname()[1]
        self.connection = None
        self.lock = threading.Lock()
        self.mode = "full"
        self.sequence = 0
        self.frames = {}
        self.events = []
        self.errors = []
        self.pointer = None
        self.finished = threading.Event()
        self.stopping = False
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def set_mode(self, mode):
        require(mode in ("full", "partial", "truncated"), "invalid fixture mode")
        with self.lock:
            self.mode = mode

    def snapshot(self):
        with self.lock:
            return {"frames": dict(self.frames), "events": list(self.events),
                    "errors": list(self.errors)}

    def _serve(self):
        try:
            connection, address = self.listener.accept()
            require(address[0] == "127.0.0.1", "non-loopback fixture peer")
            self.connection = connection
            connection.settimeout(15)
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            connection.sendall(b"RFB 003.008\n")
            require(exact_read(connection, 12) == b"RFB 003.008\n", "RFB version mismatch")
            connection.sendall(b"\x01\x01")  # One security type: None.
            require(exact_read(connection, 1) == b"\x01", "None-auth was not selected")
            connection.sendall(struct.pack("!I", 0))
            exact_read(connection, 1)  # ClientInit.shared
            format_bytes = PIXEL_FORMAT.pack(32, 24, 0, 1, 255, 255, 255, 0, 8, 16)
            name = b"Fruitctl owned offline RFB fixture"
            connection.sendall(struct.pack("!HH", WIDTH, HEIGHT) + format_bytes
                               + struct.pack("!I", len(name)) + name)
            self.pixel_format = PIXEL_FORMAT.unpack(format_bytes)
            while not self.stopping:
                kind = exact_read(connection, 1)[0]
                if kind == 0:  # SetPixelFormat
                    payload = exact_read(connection, 19)
                    self.pixel_format = PIXEL_FORMAT.unpack(payload[3:])
                    bits, _, _, true_color, red, green, blue, *_ = self.pixel_format
                    require(bits == 32 and true_color == 1 and (red, green, blue) == (255, 255, 255),
                            "fixture requires the supported 32-bit true-color client format")
                elif kind == 2:  # SetEncodings; raw is universally available.
                    _, count = struct.unpack("!BH", exact_read(connection, 3))
                    require(count <= 1024, "unbounded fixture encoding list")
                    exact_read(connection, count * 4)
                elif kind == 3:  # FramebufferUpdateRequest
                    incremental, x, y, width, height = struct.unpack("!BHHHH", exact_read(connection, 9))
                    require(width > 0 and height > 0 and x + width <= WIDTH and y + height <= HEIGHT,
                            "out-of-bounds framebuffer request")
                    # Incremental requests remain pending, as on an idle server.
                    # Explicit nonincremental requests each supply new pixels.
                    if not incremental:
                        require((x, y, width, height) == (0, 0, WIDTH, HEIGHT), "non-full capture request")
                        if not self._update(connection):
                            return
                elif kind == 4:  # KeyEvent
                    down, key = struct.unpack("!B2xI", exact_read(connection, 7))
                    with self.lock:
                        self.events.append({"kind": "key", "down": down, "key": key})
                elif kind == 5:  # PointerEvent
                    mask, x, y = struct.unpack("!BHH", exact_read(connection, 5))
                    require(x < WIDTH and y < HEIGHT, "out-of-bounds pointer event")
                    with self.lock:
                        self.pointer = (x, y)
                        self.events.append({"kind": "pointer", "mask": mask, "x": x, "y": y})
                elif kind == 6:  # ClientCutText (no real clipboard involved).
                    length = struct.unpack("!3xI", exact_read(connection, 7))[0]
                    require(length <= 1024 * 1024, "unbounded fixture clipboard message")
                    exact_read(connection, length)
                    with self.lock:
                        self.events.append({"kind": "clipboard", "bytes": length})
                else:
                    raise AssertionError("unsupported fixture client message type %d" % kind)
        except (EOFError, OSError) as error:
            if not self.stopping and not isinstance(error, EOFError):
                with self.lock:
                    self.errors.append(type(error).__name__ + ": " + str(error))
        except Exception as error:
            with self.lock:
                self.errors.append(type(error).__name__ + ": " + str(error))
        finally:
            if self.connection:
                self.connection.close()
            self.finished.set()

    def _pixel(self, color):
        _, _, big_endian, _, _, _, _, red_shift, green_shift, blue_shift = self.pixel_format
        value = (color[0] << red_shift) | (color[1] << green_shift) | (color[2] << blue_shift)
        return value.to_bytes(4, "big" if big_endian else "little")

    def _update(self, connection):
        with self.lock:
            self.sequence += 1
            sequence, mode, pointer = self.sequence, self.mode, self.pointer
            self.frames[sequence] = {"mode": mode, "pointer": pointer}
        width = WIDTH // 2 if mode == "partial" else WIDTH
        body = bytearray(self._pixel(marker_color(sequence)) * (width * HEIGHT))
        if pointer and pointer[0] < width:
            offset = (pointer[1] * width + pointer[0]) * 4
            body[offset:offset + 4] = self._pixel(POINTER_COLOR)
        header = b"\x00\x00" + struct.pack("!H", 1) + struct.pack("!HHHHi", 0, 0, width, HEIGHT, 0)
        if mode == "truncated":
            connection.sendall(header + body[:len(body) // 2])
            connection.shutdown(socket.SHUT_RDWR)
            return False
        connection.sendall(header + body)
        return True

    def close(self):
        self.stopping = True
        if self.connection:
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.listener.close()
        self.thread.join(timeout=3)
        require(not self.thread.is_alive(), "owned fixture thread did not stop")


def paeth(left, up, upper_left):
    estimate = left + up - upper_left
    distances = [abs(estimate - left), abs(estimate - up), abs(estimate - upper_left)]
    return (left, up, upper_left)[distances.index(min(distances))]


def decode_png(data):
    """Strict dependency-free decoder for noninterlaced 8-bit RGB/RGBA PNG."""
    require(data[:8] == b"\x89PNG\r\n\x1a\n", "capture is not PNG")
    offset, header, compressed, ended = 8, None, bytearray(), False
    while offset < len(data):
        require(offset + 12 <= len(data), "truncated PNG chunk")
        length = struct.unpack("!I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 8 + length
        require(end + 4 <= len(data), "truncated PNG payload")
        payload = data[offset + 8:end]
        crc = struct.unpack("!I", data[end:end + 4])[0]
        require(zlib.crc32(kind + payload) & 0xffffffff == crc, "PNG CRC mismatch")
        if kind == b"IHDR":
            require(header is None and offset == 8 and length == 13, "invalid PNG IHDR")
            header = struct.unpack("!IIBBBBB", payload)
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            require(length == 0 and end + 4 == len(data), "invalid PNG IEND")
            ended = True
        offset = end + 4
    require(header and ended, "incomplete PNG")
    width, height, depth, color, compression, filtering, interlace = header
    require(depth == 8 and color in (2, 6) and (compression, filtering, interlace) == (0, 0, 0),
            "unsupported PNG format for this proof")
    require(0 < width <= 3840 and 0 < height <= 3840, "unbounded PNG geometry")
    channels = 3 if color == 2 else 4
    row_bytes = width * channels
    inflater = zlib.decompressobj()
    limit = (row_bytes + 1) * height
    raw = inflater.decompress(bytes(compressed), limit + 1)
    require(len(raw) == limit and inflater.eof and not inflater.unused_data and not inflater.unconsumed_tail,
            "PNG decoded length or zlib stream mismatch")
    previous, pixels = bytearray(row_bytes), bytearray()
    for y in range(height):
        start = y * (row_bytes + 1)
        mode, row = raw[start], bytearray(raw[start + 1:start + row_bytes + 1])
        require(mode <= 4, "unknown PNG scanline filter")
        for i in range(row_bytes):
            left = row[i - channels] if i >= channels else 0
            up = previous[i]
            upper_left = previous[i - channels] if i >= channels else 0
            predictor = (0, left, up, (left + up) // 2, paeth(left, up, upper_left))[mode]
            row[i] = (row[i] + predictor) & 255
        for x in range(width):
            pixels.extend(row[x * channels:x * channels + 3])
        previous = row
    return width, height, bytes(pixels)


class JsonProcess:
    def __init__(self, arguments, *, env=None, pass_fds=()):
        self.process = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, env=env, pass_fds=pass_fds)
        self.messages = queue.Queue()
        self.stderr = bytearray()
        self.notifications = []
        self.identifier = 0
        self.readers = [threading.Thread(target=self._stdout, daemon=True),
                        threading.Thread(target=self._stderr, daemon=True)]
        for reader in self.readers:
            reader.start()

    def _stdout(self):
        try:
            while True:
                line = self.process.stdout.readline(MAX_LINE + 1)
                if not line:
                    self.messages.put(EOFError("owned process output ended"))
                    return
                require(len(line) <= MAX_LINE and line.endswith(b"\n"), "unbounded or incomplete NDJSON")
                self.messages.put(json.loads(line))
        except Exception as error:
            self.messages.put(error)

    def _stderr(self):
        while True:
            chunk = self.process.stderr.read(4096)
            if not chunk:
                return
            # Contains only fixture/server diagnostics. Keep receipts bounded.
            if len(self.stderr) < 128 * 1024:
                self.stderr.extend(chunk[:128 * 1024 - len(self.stderr)])

    def send(self, message):
        self.process.stdin.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")
        self.process.stdin.flush()

    def response(self, identifier, timeout=12):
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("owned protocol response timed out")
            message = self.messages.get(timeout=remaining)
            if isinstance(message, Exception):
                raise message
            if message.get("id") == identifier:
                return message
            require("id" not in message, "unexpected protocol response identifier")
            self.notifications.append(message)

    def rpc(self, method, params=None):
        self.identifier += 1
        request = {"method": method, "id": self.identifier}
        if params is not None:
            request["params"] = params
        self.send(request)
        return self.response(self.identifier)

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()  # EOF only to our own process tree.
            try:
                self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.process.terminate()  # Recorded fixture ownership only.
                try:
                    self.process.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        for reader in self.readers:
            reader.join(timeout=2)
        return self.process.returncode


class NativeSession(JsonProcess):
    def __init__(self, daemon, port):
        read_fd, write_fd = os.pipe()
        # The bootstrap preserves descriptor 3 without preexec_fn in a process
        # already running the fixture's server thread. The credential is never
        # placed in argv/environment, and descriptor 0 remains native NDJSON.
        bootstrap = ("import os,sys; fd=int(sys.argv[1]); os.dup2(fd,3); "
                     "os.set_inheritable(3,True); "
                     "os.close(fd) if fd!=3 else None; os.execv(sys.argv[2],sys.argv[2:])")
        env = dict(os.environ)
        env.pop("VNC_PASSWORD", None)
        try:
            super().__init__([sys.executable, "-I", "-c", bootstrap, str(read_fd), str(daemon),
                              "--host", "127.0.0.1", "--port", str(port), "--password-fd", "3",
                              "--no-reconnect", "--connect-timeout", "2"], env=env, pass_fds=(read_fd,))
            os.close(read_fd)
            read_fd = None
            os.write(write_fd, struct.pack("!I", len(SYNTHETIC_CREDENTIAL)) + SYNTHETIC_CREDENTIAL)
        finally:
            if read_fd is not None:
                os.close(read_fd)
            os.close(write_fd)
        try:
            deadline = time.monotonic() + 12
            while True:
                message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
                if isinstance(message, Exception):
                    raise message
                require(time.monotonic() < deadline, "native ready timed out")
                self.notifications.append(message)
                if message.get("method") == "ready":
                    require(message["params"] == {"scaledWidth": WIDTH, "scaledHeight": HEIGHT},
                            "unexpected native ready geometry")
                    break
        except Exception:
            self.close()
            raise

    def action(self, action, **params):
        response = self.rpc(action, params or None)
        if response.get("error"):
            return {"error": response["error"], "image": None, "metadata": {}}
        result = response.get("result", {})
        return {"error": None, "image": result.get("image"), "metadata": result}


class McpSession(JsonProcess):
    def __init__(self, daemon, port, node, source_dir, socket_path=None):
        env = dict(os.environ)
        for key in ("VNC_HOST", "VNC_PORT", "VNC_USERNAME", "VNC_PASSWORD",
                    "CLAUDE_KVM_DAEMON_PATH", "CLAUDE_KVM_DAEMON_PARAMETERS"):
            env.pop(key, None)
        if socket_path:
            command = [str(node), str(source_dir / "bin/fruitctl.mjs"), "mcp",
                       "--target", "fixture", "--socket", str(socket_path)]
        else:
            env.update(VNC_HOST="127.0.0.1", VNC_PORT=str(port),
                       VNC_PASSWORD=SYNTHETIC_CREDENTIAL.decode(),
                       CLAUDE_KVM_DAEMON_PATH=str(daemon),
                       CLAUDE_KVM_DAEMON_PARAMETERS="--no-reconnect --connect-timeout 2")
            command = [str(node), str(source_dir / "index.js")]
        super().__init__(command, env=env)
        try:
            response = self.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                               "clientInfo": {"name": "fruitctl-offline-fixture", "version": "1"}})
            require(not response.get("error"), "MCP initialize failed")
            self.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
            tools = self.rpc("tools/list")
            require(not tools.get("error") and {tool["name"] for tool in tools["result"]["tools"]}
                    == {"vnc_command", "action_queue", "task_complete", "task_failed"},
                    "MCP tool compatibility failed")
        except Exception:
            self.close()
            raise

    def send(self, message):
        super().send({"jsonrpc": "2.0", **message})

    def call_tool(self, name, arguments):
        response = self.rpc("tools/call", {"name": name, "arguments": arguments})
        require(not response.get("error"), "MCP JSON-RPC call failed")
        require(isinstance(response.get("result"), dict), "invalid MCP tool response")
        return response["result"]

    def action(self, action, **params):
        result = self.call_tool("vnc_command", {"action": action, **params})
        images = [part for part in result.get("content", []) if part.get("type") == "image"]
        require(len(images) <= 1, "MCP returned multiple capture images")
        if images:
            require(images[0].get("mimeType") == "image/png", "MCP PNG content type mismatch")
        return {"error": result.get("content") if result.get("isError") else None,
                "image": images[0]["data"] if images else None,
                "metadata": result.get("structuredContent", {})}


class BrokerMcpSession(McpSession):
    """Actual CLI MCP -> actual CLI shared broker -> actual native daemon."""

    def __init__(self, daemon, port, node, source_dir, directory):
        directory.mkdir(mode=0o700)
        self.credential_path = directory / "credential"
        socket_path = directory / "s"
        require(len(str(socket_path).encode()) <= 100, "fixture output path is too long for a Darwin Unix socket")
        credential_fd = os.open(self.credential_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(credential_fd, "wb") as credential:
            credential.write(SYNTHETIC_CREDENTIAL)
        config_path = directory / "config.json"
        config_path.write_text(json.dumps({"schema": "fruitctl.config.v1", "targets": {"fixture": {
            "vnc": {"host": "127.0.0.1", "port": port}, "daemonPath": str(daemon),
            "credentialFile": str(self.credential_path)}}}) + "\n")
        config_path.chmod(0o600)
        self.broker = JsonProcess([str(node), str(source_dir / "bin/fruitctl.mjs"), "broker",
                                   "--config", str(config_path), "--socket", str(socket_path)])
        self.broker_exit_code = None
        self.directory = directory
        try:
            deadline = time.monotonic() + 5
            while not socket_path.exists():
                require(self.broker.process.poll() is None, "owned shared broker failed to start")
                require(time.monotonic() < deadline, "owned shared broker startup timed out")
                time.sleep(0.01)
            require(stat.S_ISSOCK(socket_path.stat().st_mode), "broker did not create a socket")
            require(socket_path.stat().st_mode & 0o077 == 0, "broker socket is not private")
            super().__init__(daemon, port, node, source_dir, socket_path)
        except Exception:
            self._stop_broker()
            raise

    def _stop_broker(self):
        if self.broker.process.poll() is None:
            self.broker.process.terminate()  # Exact recorded fixture child.
        self.broker_exit_code = self.broker.close()
        (self.directory / "broker.stderr.txt").write_bytes(self.broker.stderr)
        self.credential_path.unlink(missing_ok=True)  # Only our synthetic provider.

    def close(self):
        try:
            return super().close()
        finally:
            self._stop_broker()


def inspect_capture(response, fixture, previous_sequence=0, expected_pointer=None):
    require(not response["error"] and response["image"], "capture failed or omitted PNG")
    png = base64.b64decode(response["image"], validate=True)
    width, height, pixels = decode_png(png)
    require((width, height) == (WIDTH, HEIGHT), "PNG geometry mismatch")
    metadata = response["metadata"]
    require((metadata.get("scaledWidth"), metadata.get("scaledHeight"),
             metadata.get("nativeWidth"), metadata.get("nativeHeight")) == (WIDTH, HEIGHT, WIDTH, HEIGHT),
            "capture metadata and PNG dimensions disagree")
    require(all(isinstance(metadata.get(key), int) and metadata[key] > 0
                for key in ("connectionGeneration", "allocation")), "missing native allocation binding")
    # The first pixel could be the input marker; choose another to read ordinal.
    sample = pixels[3:6] if expected_pointer == (0, 0) else pixels[:3]
    require(sample[2] == 73, "PNG background color/channel order mismatch")
    sequence = sample[0] | (sample[1] << 8)
    require(sequence > previous_sequence, "capture reused historical pixels")
    frames = fixture.snapshot()["frames"]
    require(sequence in frames and frames[sequence]["mode"] == "full", "PNG did not come from complete fixture update")
    pointer = frames[sequence]["pointer"]
    if expected_pointer is not None:
        require(pointer == expected_pointer, "captured server state predates coordinate input")
    expected = bytearray(marker_color(sequence) * (width * height))
    if pointer is not None:
        offset = (pointer[1] * width + pointer[0]) * 3
        expected[offset:offset + 3] = bytes(POINTER_COLOR)
    require(pixels == bytes(expected), "PNG pixels are incomplete, displaced or different from fixture state")
    return sequence, png, metadata


def run_scenario(kind, mode, count, args):
    fixture = RfbFixture()
    session = None
    report = {"transport": kind, "scenario": mode, "loopbackPort": fixture.port,
              "status": "failed", "captures": [], "claimedScope": "synthetic-loopback-RFB-only"}
    try:
        if kind == "native":
            session = NativeSession(args.daemon, fixture.port)
        elif args.mcp_route == "shared-broker":
            session = BrokerMcpSession(args.daemon, fixture.port, args.node, args.source_dir,
                                       args.output_dir / ("b-" + mode))
        else:
            session = McpSession(args.daemon, fixture.port, args.node, args.source_dir)
        report["route"] = "native-PC" if kind == "native" else args.mcp_route
        sequence, _, binding = inspect_capture(session.action("screenshot"), fixture)
        if mode == "full":
            latencies = []
            for i in range(count):
                # Deterministic distinct coordinates, including every boundary.
                point = ((i * 17) % WIDTH, (i * 13) % HEIGHT)
                if i == count - 1:
                    point = (WIDTH - 1, HEIGHT - 1)
                moved = session.action("mouse_move", x=point[0], y=point[1])
                require(not moved["error"], "coordinate input failed")
                start = time.monotonic()
                response = session.action("screenshot")
                elapsed = (time.monotonic() - start) * 1000
                sequence, png, metadata = inspect_capture(response, fixture, sequence, point)
                require((metadata["connectionGeneration"], metadata["allocation"]) ==
                        (binding["connectionGeneration"], binding["allocation"]), "unexpected capture allocation change")
                latencies.append(elapsed)
                filename = "%s-%s-%03d.png" % (kind, mode, i + 1)
                (args.output_dir / filename).write_bytes(png)
                report["captures"].append({"ordinal": i + 1, "serverMarker": sequence,
                                           "pointer": list(point), "pngSha256": hashlib.sha256(png).hexdigest(),
                                           "file": filename, "latencyMilliseconds": round(elapsed, 3)})
            require(not session.action("mouse_click", x=WIDTH - 1, y=HEIGHT - 1)["error"], "click failed")
            require(not session.action("key_tap", key="a")["error"], "key tap failed")
            # A subsequent fresh frame orders server processing after input.
            inspect_capture(session.action("screenshot"), fixture, sequence, (WIDTH - 1, HEIGHT - 1))
            events = fixture.snapshot()["events"]
            pointer_events = [event for event in events if event["kind"] == "pointer"]
            require(any(event["mask"] == 1 and (event["x"], event["y"]) == (WIDTH - 1, HEIGHT - 1)
                        for event in pointer_events), "button press was not transmitted")
            require(pointer_events[-1]["mask"] == 0, "button was not released")
            key_events = [event for event in events if event["kind"] == "key"]
            require(key_events == [{"kind": "key", "down": 1, "key": ord("a")},
                                   {"kind": "key", "down": 0, "key": ord("a")}], "key press/release roundtrip mismatch")
            report["fixtureCaptureLatencyMilliseconds"] = {
                "p50": round(statistics.median(latencies), 3),
                "p95": round(sorted(latencies)[max(0, (95 * len(latencies) + 99) // 100 - 1)], 3),
                "max": round(max(latencies), 3), "scope": "loopback fixture; not a live product SLO"}
            report["coordinateRoundtrips"] = count
            report["buttonAndKeyReleaseRoundtrip"] = "passed"
            if kind == "mcp":
                queue_point = (11, 13)
                queued = session.call_tool("action_queue", {"actions": [{"action": "mouse_move",
                    "x": queue_point[0], "y": queue_point[1]}, {"action": "wait", "ms": 50}]})
                require(not queued.get("isError") and queued.get("structuredContent") == {"completed": 2},
                        "MCP action_queue did not acknowledge both actions")
                inspect_capture(session.action("screenshot"), fixture, sequence, queue_point)
                summary = "Offline fixture complete"
                completed = session.call_tool("task_complete", {"summary": summary})
                require(not completed.get("isError") and completed.get("content") == [{"type": "text", "text": summary}],
                        "MCP task_complete did not acknowledge ownership release")
                require(fixture.finished.wait(3), "task_complete acknowledged before owned native connection closed")
                # The failed-task ownership-release path is tested while active
                # in its own scenario; this also checks harmless repeat release.
                failed_task = session.call_tool("task_failed", {"reason": "Offline fixture deliberate task failure"})
                require(failed_task.get("isError") is True, "MCP task_failed lost its compatible error marker")
                report["mcpTools"] = {"vnc_command": "passed", "action_queue": "passed",
                                      "task_complete": "passed; active ownership released",
                                      "task_failed": "passed; repeated release"}
        elif mode == "task-failed":
            require(kind == "mcp", "task-failed scenario requires MCP")
            reason = "Offline fixture deliberate active task failure"
            failed_task = session.call_tool("task_failed", {"reason": reason})
            require(failed_task.get("isError") is True and
                    failed_task.get("content") == [{"type": "text", "text": reason}],
                    "MCP task_failed response mismatch")
            require(fixture.finished.wait(3), "task_failed acknowledged before owned native connection closed")
            report["taskFailedOwnershipRelease"] = "passed while active"
        else:
            fixture.set_mode(mode)
            start = time.monotonic()
            failed = session.action("screenshot")
            elapsed = time.monotonic() - start
            require(failed["error"] and not failed["image"], "incomplete framebuffer returned a successful image")
            require(elapsed < 10, "incomplete capture was not refused within bounded deadline")
            modes = [frame["mode"] for frame in fixture.snapshot()["frames"].values()]
            require(mode in modes, "fixture never transmitted the intended incomplete update")
            report["refusal"] = {"error": failed["error"], "elapsedMilliseconds": round(elapsed * 1000, 3),
                                  "imageReturned": False, "priorCompleteFrameMarker": sequence}
        require(not fixture.snapshot()["errors"], "fixture protocol errors: %r" % fixture.snapshot()["errors"])
        report["status"] = "passed"
    except Exception as error:
        report["failure"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        if session:
            report["processExitCode"] = session.close()
            if kind == "mcp" and args.mcp_route == "shared-broker":
                report["brokerExitCode"] = session.broker_exit_code
            if report["status"] == "passed" and (report["processExitCode"] != 0 or report.get("brokerExitCode", 0) != 0):
                report["status"] = "failed"
                report["failure"] = "owned process cleanup was not acknowledged with zero exit"
            (args.output_dir / (kind + "-" + mode + ".stderr.txt")).write_bytes(session.stderr)
        fixture.close()
        snapshot = fixture.snapshot()
        report["serverFrames"] = len(snapshot["frames"])
        report["inputEvents"] = snapshot["events"]
        report["fixtureErrors"] = snapshot["errors"]
        (args.output_dir / (kind + "-" + mode + ".json")).write_text(json.dumps(report, indent=2) + "\n")
    require(report["status"] == "passed", report.get("failure", "fixture failed"))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, required=True, help="existing compiled unsigned native daemon")
    parser.add_argument("--output-dir", type=Path, required=True, help="new durable fixture receipt directory")
    parser.add_argument("--captures", type=int, default=100)
    parser.add_argument("--node", type=Path, help="optional existing Darwin Node runtime")
    parser.add_argument("--source-dir", type=Path, help="matching staged source with node_modules for real MCP")
    parser.add_argument("--mcp-route", choices=("shared-broker", "legacy-direct"), default="shared-broker")
    parser.add_argument("--runtime-archive", type=Path, help="optional exact runtime archive to hash into the receipt")
    args = parser.parse_args()
    require(1 <= args.captures <= 1000, "captures must be 1...1000")
    require(bool(args.node) == bool(args.source_dir), "--node and --source-dir are required together")
    args.daemon = args.daemon.resolve(strict=True)
    require(os.access(args.daemon, os.X_OK), "daemon is not executable")
    if args.node:
        args.node = args.node.resolve(strict=True)
        args.source_dir = args.source_dir.resolve(strict=True)
        require((args.source_dir / "index.js").is_file() and (args.source_dir / "node_modules").is_dir(),
                "MCP source/dependencies are not staged")
    args.output_dir = args.output_dir.resolve()
    args.output_dir.mkdir(parents=True, exist_ok=False)
    receipt = {"schemaVersion": 1, "proofKind": "offline-dynamic-RFB-fixture",
               "startedAtUnixSeconds": time.time(), "status": "failed",
               "daemonSha256": sha256_file(args.daemon), "fixtureSha256": sha256_file(__file__),
               "rfbVersion": "3.8", "authentication": "None on owned ephemeral loopback port",
               "credentialDelivery": "synthetic value via inherited native fd3",
               "frameDimensions": [WIDTH, HEIGHT], "scenarios": [],
               "excludes": ["live macOS desktop", "TCC", "overlay exclusion", "signed/notarized distribution",
                            "SSH bridge", "real VNC authentication", "live product latency/SLO"]}
    if args.node:
        receipt["nodeSha256"] = sha256_file(args.node)
        receipt["nodeVersion"] = subprocess.check_output([str(args.node), "--version"], timeout=5).decode().strip()
        receipt["mcpRoute"] = args.mcp_route
        if args.runtime_archive:
            receipt["runtimeArchiveSha256"] = sha256_file(args.runtime_archive.resolve(strict=True))
        receipt["mcpSourceSha256"] = {str(path.relative_to(args.source_dir)): sha256_file(path)
            for path in [args.source_dir / "index.js", args.source_dir / "bin/fruitctl.mjs",
                         args.source_dir / "package.json", args.source_dir / "package-lock.json",
                         *sorted((args.source_dir / "lib").rglob("*.js")),
                         *sorted((args.source_dir / "lib").rglob("*.mjs")),
                         *sorted((args.source_dir / "tools").rglob("*.js"))]}
    else:
        receipt["mcp"] = "not run; pass --node and --source-dir to include actual MCP transport"
    try:
        for kind in (["native", "mcp"] if args.node else ["native"]):
            modes = ["full", "partial", "truncated"]
            if kind == "mcp":
                modes.append("task-failed")
            for mode in modes:
                print("Running %s %s fixture" % (kind, mode), flush=True)
                receipt["scenarios"].append(run_scenario(kind, mode, args.captures, args))
        receipt["status"] = "passed"
    except Exception as error:
        receipt["failure"] = type(error).__name__ + ": " + str(error)
        print("Fixture failed: " + receipt["failure"], file=sys.stderr)
    finally:
        receipt["finishedAtUnixSeconds"] = time.time()
        (args.output_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "receipt": str(args.output_dir / "receipt.json"),
                      "scenarioCount": len(receipt["scenarios"])}), flush=True)
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
