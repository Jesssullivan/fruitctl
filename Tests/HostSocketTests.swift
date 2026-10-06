import Foundation
import XCTest
import Darwin

@MainActor
private final class SocketReferenceFixture {
    let root: URL
    var server: HostSocketServer!
    var pending: CheckedContinuation<HostReferenceCapture, Error>?
    var connectionIDs: [UUID] = []
    var disconnectedIDs: [UUID] = []
    var deliverDisconnect = true
    var responseFinished = false
    var failure: HostIdleReferenceError?
    var persisted = 0
    private let revision = UUID()

    lazy var permission = HostCapturePermission(preflight: { true }, request: {
        XCTFail("An offline socket fixture requested permission")
        return false
    })
    lazy var coordinator = HostIdleReferenceCoordinator(permission: permission, clock: { 100 },
        conditions: { [unowned self] in
            HostIdleReferenceConditions(captureEnabled: true, activityEligible: true,
                activeLease: false, captureReady: false, overlayReady: false,
                anyVisiblePanel: false, otherCaptureInProgress: false,
                lifecycleRevision: self.revision, displayGeneration: 1)
        }, capture: { [unowned self] in
            try await withCheckedThrowingContinuation { self.pending = $0 }
        }, connectionLive: { [unowned self] in self.server.connectionIsLive($0) },
        persist: { [unowned self] _, _ in
            self.persisted += 1
            return HostReferenceExport(directory: "/owned/private/socket-fixture",
                imageSHA256: "synthetic", receiptSHA256: "synthetic")
        })

    init() throws {
        // Darwin sockaddr_un has a short path limit. This new UUID directory
        // belongs only to the test; no product socket or desktop app is used.
        root = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath()
            .appendingPathComponent(".local/state/fctl-sock-" + String(UUID().uuidString.prefix(8)))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        server = HostSocketServer(path: root.appendingPathComponent("s").path,
            handler: { [weak self] request, id, reply in
                Task { @MainActor in await self?.handle(request, id: id, reply: reply) }
            }, disconnected: { [weak self] id in
                Task { @MainActor in
                    guard let self else { return }
                    self.disconnectedIDs.append(id)
                    if self.deliverDisconnect { self.coordinator.disconnected(id) }
                }
            })
        try server.start()
    }

    func cleanUp() throws {
        server.stop()
        try FileManager.default.removeItem(at: root)
    }

    private func handle(_ request: HostRequest, id: UUID,
                        reply: @escaping (HostResponse) -> Void) async {
        connectionIDs.append(id)
        do {
            let output = try await coordinator.export(
                armedID: try request.requiredString("reference_id"), connectionID: id,
                binding: ["instance_id": .string("offline-socket-fixture")])
            reply(.ok(request, output.metadata))
        } catch {
            failure = error as? HostIdleReferenceError
            reply(.failure(id: request.id, message: failure?.rawValue ?? "offline_fixture_failure"))
        }
        responseFinished = true
    }

    func connectAndRequest() throws -> Int32 {
        let id = try coordinator.armFromHuman()
        responseFinished = false; failure = nil
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HostIPCError.ioFailure }
        HostIPC.configure(fd)
        do {
            var address = try HostIPC.address(root.appendingPathComponent("s").path)
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard result == 0 else { throw HostIPCError.unavailable }
            let data = try JSONSerialization.data(withJSONObject: ["action": "export_idle_reference",
                "id": "offline", "params": ["reference_id": id]])
            try HostIPC.write(data + Data([10]), to: fd)
            return fd
        } catch { close(fd); throw error }
    }

    func finishCapture() {
        let continuation = pending; pending = nil
        continuation?.resume(returning: HostReferenceCapture(png: Data([1]), metadata: [:]))
    }
}

@MainActor
final class HostSocketTests: XCTestCase {
    private func waitUntil(_ condition: () -> Bool,
                           file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(1_000))
        while !condition() && ContinuousClock.now < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertTrue(condition(), "Offline socket did not reach the expected state", file: file, line: line)
    }

    private func response(_ fd: Int32) throws -> [String: Any] {
        let deadline = ContinuousClock.now.advanced(by: .seconds(1))
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4_096)
        while ContinuousClock.now < deadline {
            var item = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let result = poll(&item, 1, 20)
            if result < 0 && errno == EINTR { continue }
            guard result >= 0 else { throw HostIPCError.ioFailure }
            if item.revents & Int16(POLLIN | POLLHUP) == 0 { continue }
            let count = recv(fd, &buffer, buffer.count, MSG_DONTWAIT)
            if count < 0 && (errno == EINTR || errno == EAGAIN) { continue }
            guard count > 0 else { throw HostIPCError.ioFailure }
            data.append(contentsOf: buffer.prefix(count))
            if let end = data.firstIndex(of: 10) {
                return try JSONSerialization.jsonObject(with: data.prefix(upTo: end)) as! [String: Any]
            }
        }
        throw HostIPCError.requestTimeout
    }

    func testClosedTransportRejectsReturnedCaptureWithoutDisconnectCallback() async throws {
        let fixture = try SocketReferenceFixture()
        defer { try? fixture.cleanUp() }
        fixture.deliverDisconnect = false // Model a queued main-actor callback.
        let fd = try fixture.connectAndRequest()
        try await waitUntil { fixture.pending != nil }
        let id = try XCTUnwrap(fixture.connectionIDs.first)
        close(fd)
        try await waitUntil { !fixture.server.connectionIsLive(id) }
        fixture.finishCapture()
        try await waitUntil { fixture.responseFinished }
        XCTAssertEqual(fixture.failure, .connectionClosed)
        XCTAssertEqual(fixture.persisted, 0)
        XCTAssertFalse(fixture.coordinator.isExporting)
        try await waitUntil { fixture.disconnectedIDs.contains(id) }
    }

    func testPendingReplyDetectsFullCloseWhileCaptureIsStillSuspended() async throws {
        let fixture = try SocketReferenceFixture()
        defer { try? fixture.cleanUp() }
        let fd = try fixture.connectAndRequest()
        try await waitUntil { fixture.pending != nil }
        let id = try XCTUnwrap(fixture.connectionIDs.first)
        let closedAt = ContinuousClock.now
        close(fd)
        try await waitUntil { fixture.disconnectedIDs.contains(id) }
        XCTAssertLessThan(closedAt.duration(to: ContinuousClock.now), .milliseconds(500))
        XCTAssertNotNil(fixture.pending)
        XCTAssertEqual(fixture.persisted, 0)
        fixture.finishCapture()
        try await waitUntil { fixture.responseFinished }
        XCTAssertEqual(fixture.failure, .lifecycleChanged)
        XCTAssertEqual(fixture.persisted, 0)
    }

    func testInputHalfCloseStillReceivesSuspendedExportReply() async throws {
        let fixture = try SocketReferenceFixture()
        defer { try? fixture.cleanUp() }
        let fd = try fixture.connectAndRequest()
        defer { close(fd) }
        XCTAssertEqual(shutdown(fd, SHUT_WR), 0)
        try await waitUntil { fixture.pending != nil }
        let id = try XCTUnwrap(fixture.connectionIDs.first)
        XCTAssertTrue(fixture.server.connectionIsLive(id))
        fixture.finishCapture()
        try await waitUntil { fixture.responseFinished }
        let reply = try response(fd)
        XCTAssertEqual(reply["success"] as? Bool, true)
        XCTAssertEqual((reply["result"] as? [String: Any])?["ready"] as? Bool, false)
        XCTAssertEqual(fixture.persisted, 1)
        XCTAssertNil(fixture.failure)
    }

    func testOldConnectionIdentityCannotBecomeLiveForLaterClient() async throws {
        let fixture = try SocketReferenceFixture()
        defer { try? fixture.cleanUp() }
        let first = try fixture.connectAndRequest()
        try await waitUntil { fixture.pending != nil }
        let oldID = try XCTUnwrap(fixture.connectionIDs.first)
        close(first)
        try await waitUntil { fixture.disconnectedIDs.contains(oldID) }
        fixture.finishCapture()
        try await waitUntil { fixture.responseFinished }
        let second = try fixture.connectAndRequest()
        defer { close(second) }
        try await waitUntil { fixture.pending != nil && fixture.connectionIDs.count == 2 }
        let newID = fixture.connectionIDs[1]
        XCTAssertNotEqual(oldID, newID)
        XCTAssertFalse(fixture.server.connectionIsLive(oldID))
        XCTAssertTrue(fixture.server.connectionIsLive(newID))
        fixture.finishCapture()
        try await waitUntil { fixture.responseFinished }
        XCTAssertEqual(try response(second)["success"] as? Bool, true)
        XCTAssertEqual(fixture.persisted, 1)
    }

    func testWriteDirectionProbeDistinguishesHalfCloseFromFullClose() throws {
        var descriptors: [Int32] = [-1, -1]
        XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors), 0)
        guard descriptors.allSatisfy({ $0 >= 0 }) else { return }
        defer { close(descriptors[0]) }
        HostIPC.configure(descriptors[0]); HostIPC.configure(descriptors[1])
        XCTAssertTrue(HostIPC.peerCanReceive(descriptors[0]))
        XCTAssertEqual(shutdown(descriptors[1], SHUT_WR), 0)
        XCTAssertTrue(HostIPC.peerCanReceive(descriptors[0]))
        close(descriptors[1])
        XCTAssertFalse(HostIPC.peerCanReceive(descriptors[0]))
    }
}
