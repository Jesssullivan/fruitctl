import XCTest
import Foundation
import CLibVNCClient

private func completePixelUpdate(_ client: VNCClientOperations.Client) {
    vncGotFrameBufferUpdate(client, 0, 0, client.pointee.width, client.pointee.height)
    vncFinishedFrameBufferUpdate(client)
}

private final class RecordedEvents {
    private let lock = NSLock()
    private var events: [String] = []
    func append(_ event: String) { lock.lock(); events.append(event); lock.unlock() }
    var values: [String] { lock.lock(); defer { lock.unlock() }; return events }
}

private final class ManualTime {
    private let lock = NSLock()
    private var value: UInt64 = 1_000_000_000
    func now() -> UInt64 { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ nanoseconds: UInt64) { lock.lock(); value += nanoseconds; lock.unlock() }
}

private final class ManualScheduler {
    struct Job { let queue: DispatchQueue; let delay: TimeInterval; let work: DispatchWorkItem }
    private let lock = NSLock()
    private var jobs: [Job] = []
    var onSchedule: (() -> Void)?
    var delays: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return jobs.map(\.delay) }
    func schedule(_ queue: DispatchQueue, _ delay: TimeInterval, _ work: DispatchWorkItem) {
        lock.lock()
        jobs.append(Job(queue: queue, delay: delay, work: work))
        lock.unlock()
        onSchedule?()
    }
    @discardableResult func take() -> Job {
        lock.lock(); defer { lock.unlock() }
        precondition(!jobs.isEmpty, "expected one owned scheduled item")
        return jobs.removeFirst()
    }
    func runNext() {
        let job = take()
        job.queue.sync { job.work.perform() }
    }
}

/// Static-screen request handling hypotheses for Apple's server (TIN-5509).
/// None is a qualified Apple model; each pins one predicted behavior.
private enum FakeServerModel {
    /// Only the newest outstanding request counts; a full one is answered.
    case latestWins
    /// The oldest outstanding request absorbs later ones; a static screen
    /// never answers an outstanding incremental, so a full one behind it waits.
    case firstWins
    /// Only the first full request on the connection is ever answered.
    case sessionStartOnly
    /// Nothing is ever answered.
    case silent
}

private final class FakeNative {
    private let lock = NSLock()
    private var outcomes: [Bool]
    private var polls: [Bool]
    private var live: Set<UInt> = []
    private var allocations = 0
    private var releases = 0
    private var failedInitReleases = 0
    private var duplicateReleases = 0
    private var peakLive = 0
    private var timeouts: [(UInt32, UInt32)] = []
    private var pollIntervals: [UInt32] = []
    private var buffers: Set<UInt> = []
    private var buffersAllocated = 0
    private var buffersReleased = 0
    private var duplicateBufferReleases = 0
    private var allocationRequests: [Int] = []
    private var fullUpdateRequests = 0
    private var incrementalUpdateRequests = 0
    // Modeled wire state, per connection. LibVNC returns success without
    // writing while its FramebufferUpdateRequest gate is closed.
    private var outstandingRequests: [Bool] = [] // true = incremental
    private var writtenFullRequests = 0
    private var writtenIncrementalRequests = 0
    private var autoRearmWrites = 0
    private var suppressedRequests = 0
    private var answeredFullRequests = 0
    private var serverFrames = 0
    private var inputWrites: [String] = []
    /// When set, every poll lets this server model answer outstanding
    /// requests with a complete frame (after beforePoll runs).
    var serverModel: FakeServerModel?
    /// The next model answer also carries a SupportedMessages rectangle.
    var reopenGateOnNextUpdate = false
    var allocateBeforeFailure = false
    // Existing lifecycle cases model a complete initial update during init.
    // First-frame cases turn this off and deliver the actual callback later.
    var completeDuringInitialize = true
    var beforeInitialize: (() -> Void)?
    var afterFramebufferAllocation: (() -> Void)?
    var beforePoll: ((VNCClientOperations.Client) -> Void)?
    var beforeFullUpdate: ((VNCClientOperations.Client) -> Bool)?
    /// Receives every RFB KeyEvent exactly as the bridge would write it.
    var onKey: ((UInt32, Bool) -> Void)?

    init(outcomes: [Bool] = [true], polls: [Bool] = [false]) {
        self.outcomes = outcomes; self.polls = polls
    }
    var counts: (allocations: Int, releases: Int, failed: Int, duplicate: Int, live: Int, peak: Int) {
        lock.lock(); defer { lock.unlock() }
        return (allocations, releases, failedInitReleases, duplicateReleases, live.count, peakLive)
    }
    var observedTimeouts: [(UInt32, UInt32)] { lock.lock(); defer { lock.unlock() }; return timeouts }
    var observedPollIntervals: [UInt32] { lock.lock(); defer { lock.unlock() }; return pollIntervals }
    var observedAllocationRequests: [Int] { lock.lock(); defer { lock.unlock() }; return allocationRequests }
    var observedFullUpdates: Int { lock.lock(); defer { lock.unlock() }; return fullUpdateRequests }
    var observedIncrementalUpdates: Int { lock.lock(); defer { lock.unlock() }; return incrementalUpdateRequests }
    /// Requests that reached the modeled wire, including LibVNC's own.
    var wire: (full: Int, incremental: Int, autoRearm: Int, suppressed: Int, outstanding: [Bool], frames: Int) {
        lock.lock(); defer { lock.unlock() }
        return (writtenFullRequests, writtenIncrementalRequests, autoRearmWrites, suppressedRequests,
                outstandingRequests, serverFrames)
    }
    /// Every pointer, key and clipboard write, in order.
    var observedInputWrites: [String] { lock.lock(); defer { lock.unlock() }; return inputWrites }

    /// rfbclient.c:1497-1502: no bytes while the gate is closed or a client
    /// resize is pending, yet the call still reports success.
    private func requestGateOpen(_ client: VNCClientOperations.Client) -> Bool {
        SupportsClient2Server(client, VNCBridge.framebufferUpdateRequestType) != 0
            && client.pointee.requestedResize == 0
    }

    /// Also models LibVNC's own resize request (rfbclient.c:2143, :2699).
    func writeRequest(_ client: VNCClientOperations.Client, incremental: Bool, autoRearm: Bool = false) {
        let open = requestGateOpen(client)
        lock.lock(); defer { lock.unlock() }
        guard open else { suppressedRequests += 1; return }
        outstandingRequests.append(incremental)
        if incremental { writtenIncrementalRequests += 1 } else { writtenFullRequests += 1 }
        if autoRearm { autoRearmWrites += 1 }
    }

    /// One server FramebufferUpdate as HandleRFBServerMessage processes it:
    /// rectangle callbacks, then LibVNC's own incremental re-arm
    /// (rfbclient.c:2564) unless the gate is closed, then FinishedUpdate.
    /// An empty list is a metadata-only update. `reopenGate` models a
    /// SupportedMessages pseudo-rectangle rewriting the request bitmap in
    /// the same message (rfbclient.c:2184-2186), before the re-arm.
    func deliverUpdate(_ client: VNCClientOperations.Client, rects: [(Int32, Int32, Int32, Int32)],
                       reopenGate: Bool = false) {
        lock.lock(); serverFrames += 1; let marker = UInt8(truncatingIfNeeded: serverFrames); lock.unlock()
        if let pixels = client.pointee.frameBuffer, !rects.isEmpty {
            memset(pixels, Int32(marker), Int(client.pointee.width) * Int(client.pointee.height) * 4)
        }
        for (x, y, width, height) in rects { vncGotFrameBufferUpdate(client, x, y, width, height) }
        if reopenGate { Self.setDefaultSupportedMessages(client) }
        writeRequest(client, incremental: true, autoRearm: true)
        vncFinishedFrameBufferUpdate(client)
    }

    /// DefaultSupportedMessages (rfbclient.c:226-238), run during the real
    /// protocol handshake; rfbGetClient alone leaves the bitmap zeroed.
    static func setDefaultSupportedMessages(_ client: VNCClientOperations.Client) {
        // SetPixelFormat 0, SetEncodings 2, FramebufferUpdateRequest 3,
        // KeyEvent 4, PointerEvent 5, ClientCutText 6.
        client.pointee.supportedMessages.client2server.0 |= 0b0111_1101
    }

    private func serverStep(_ client: VNCClientOperations.Client) {
        guard let model = serverModel else { return }
        lock.lock()
        let answer: Bool
        switch model {
        case .latestWins: answer = outstandingRequests.last == false
        case .firstWins: answer = outstandingRequests.first == false
        case .sessionStartOnly: answer = answeredFullRequests == 0 && outstandingRequests.contains(false)
        case .silent: answer = false
        }
        if answer { outstandingRequests.removeAll(); answeredFullRequests += 1 }
        let reopen = answer && reopenGateOnNextUpdate
        if reopen { reopenGateOnNextUpdate = false }
        lock.unlock()
        if answer {
            deliverUpdate(client, rects: [(0, 0, client.pointee.width, client.pointee.height)], reopenGate: reopen)
        }
    }
    var bufferCounts: (allocated: Int, released: Int, live: Int, duplicate: Int) {
        lock.lock(); defer { lock.unlock() }
        return (buffersAllocated, buffersReleased, buffers.count, duplicateBufferReleases)
    }
    private func release(_ client: VNCClientOperations.Client, failed: Bool) {
        lock.lock()
        let owned = live.remove(UInt(bitPattern: client)) != nil
        if !owned { duplicateReleases += 1 }
        if owned { releases += 1; if failed { failedInitReleases += 1 } }
        lock.unlock()
        // Refuse a duplicate before dereferencing freed memory. XCTest checks
        // this observable counter; the fixture never deliberately double-frees.
        if owned { VNCClientOperations.release(client) }
    }
    var operations: VNCClientOperations {
        VNCClientOperations(make: { [self] config in
            // Allocation/tag cleanup is real LibVNCClient; no native connect,
            // socket, input, server message or external target is ever called.
            guard let client = rfbGetClient(config.bitsPerSample, config.samplesPerPixel, config.bytesPerPixel) else { return nil }
            lock.lock()
            allocations += 1; live.insert(UInt(bitPattern: client)); peakLive = max(peakLive, live.count)
            outstandingRequests = []; answeredFullRequests = 0 // a new server connection
            lock.unlock()
            return client
        }, initialize: { [self] client in
            beforeInitialize?()
            lock.lock()
            timeouts.append((client.pointee.connectTimeout, client.pointee.readTimeout))
            let success = outcomes.isEmpty ? true : outcomes.removeFirst()
            lock.unlock()
            if success || allocateBeforeFailure {
                Self.setDefaultSupportedMessages(client)
                client.pointee.width = 2; client.pointee.height = 2
                client.pointee.format.bitsPerPixel = 32
                if vncMallocFrameBuffer(client) == 0 {
                    release(client, failed: true)
                    return false
                }
                // rfbInitConnection's own whole-screen request (vncviewer.c:423).
                writeRequest(client, incremental: false)
                afterFramebufferAllocation?()
                if completeDuringInitialize { completePixelUpdate(client) }
            }
            if !success {
                release(client, failed: true) // C consumes client but NOT frameBuffer
                return false
            }
            return true
        }, cleanup: { [self] in release($0, failed: false) },
        poll: { [self] client, interval, phase in
            phase(.handlingServerMessage)
            beforePoll?(client)
            serverStep(client)
            phase(.idle)
            lock.lock(); defer { lock.unlock() }
            pollIntervals.append(interval)
            return polls.isEmpty ? true : polls.removeFirst()
        }, incrementalUpdate: { [self] client in
            lock.lock(); incrementalUpdateRequests += 1; lock.unlock()
            writeRequest(client, incremental: true)
            return true
        }, fullUpdate: { [self] client in
            lock.lock(); fullUpdateRequests += 1; lock.unlock()
            let sent = beforeFullUpdate?(client) ?? true
            if sent { writeRequest(client, incremental: false) }
            return sent
        }, allocateFramebuffer: { [self] size in
            lock.lock(); allocationRequests.append(size); lock.unlock()
            // The owned fixture never allocates a server-sized large buffer,
            // even if a regression incorrectly reaches the allocation seam.
            guard size <= 1024 else { return nil }
            guard let buffer = malloc(size)?.assumingMemoryBound(to: UInt8.self) else { return nil }
            lock.lock(); buffers.insert(UInt(bitPattern: buffer)); buffersAllocated += 1; lock.unlock()
            return buffer
        }, freeFramebuffer: { [self] buffer in
            lock.lock()
            let owned = buffers.remove(UInt(bitPattern: buffer)) != nil
            if owned { buffersReleased += 1 } else { duplicateBufferReleases += 1 }
            lock.unlock()
            if owned { free(buffer) }
        }, sendKey: { [self] _, key, down in
            lock.lock(); inputWrites.append("key"); lock.unlock()
            onKey?(key, down)
            return true
        }, sendPointer: { [self] _, _, _, _ in
            lock.lock(); inputWrites.append("pointer"); lock.unlock()
            return true
        }, sendClientCutText: { [self] _, _ in
            lock.lock(); inputWrites.append("clipboard"); lock.unlock()
            return true
        })
    }
}

final class VNCReconnectTests: XCTestCase {
    private func assertSingleClientAndBufferReleased(_ native: FakeNative,
                                                     file: StaticString = #filePath, line: UInt = #line) {
        let clients = native.counts, buffers = native.bufferCounts
        XCTAssertEqual(clients.allocations, 1, file: file, line: line)
        XCTAssertEqual(clients.releases, 1, file: file, line: line)
        XCTAssertEqual(clients.failed, 0, file: file, line: line)
        XCTAssertEqual(clients.duplicate, 0, file: file, line: line)
        XCTAssertEqual(clients.live, 0, file: file, line: line)
        XCTAssertEqual(buffers.allocated, 1, file: file, line: line)
        XCTAssertEqual(buffers.released, 1, file: file, line: line)
        XCTAssertEqual(buffers.live, 0, file: file, line: line)
        XCTAssertEqual(buffers.duplicate, 0, file: file, line: line)
    }

    func testPermitExpiryRefusesInputWaitingBehindAnOccupiedNativeDecoder() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler()
        let time = ManualTime()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule)
        try await bridge.connect()
        let context = VNCInputContext(bridge.framebufferDiagnostics)
        let permit = NativeInputPermit(now: time.now, watchdogEnabled: false)
        let binding = NativeInputPermit.Binding(instanceID: "owned-helper", sessionID: "owned-session",
            displayID: 1, displayGeneration: 1, context: context, scaledWidth: 2, scaledHeight: 2)
        try permit.qualifyObservation(context: context, scaledWidth: 2, scaledHeight: 2)
        let challenge = try permit.begin(binding: binding, sequence: 1)
        _ = try permit.grant(binding: binding, sequence: 1, challenge: challenge.challenge,
                             leaseRemainingMilliseconds: 3_000)
        let occupied = expectation(description: "owned decoder holds the native queue")
        let release = DispatchSemaphore(value: 0)
        native.beforePoll = { _ in
            occupied.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        }
        let polling = Task.detached { scheduler.runNext() }
        await fulfillment(of: [occupied], timeout: 2)
        XCTAssertNoThrow(try permit.check(context: context))
        let entered = expectation(description: "all producer requests entered")
        entered.expectedFulfillmentCount = 3
        let sends = ["pointer", "key", "clipboard"].map { kind in
            Task { () -> String in
                entered.fulfill()
                do {
                    switch kind {
                    case "pointer": try await bridge.sendMouseEvent(x: 1, y: 1, context: context, inputPermit: permit)
                    case "key": try await bridge.sendKeyEvent(key: 97, down: true, context: context, inputPermit: permit)
                    default: try await bridge.sendClipboardText("owned fixture", context: context, inputPermit: permit)
                    }
                    return "unexpected success"
                } catch VNCError.sendFailed(let reason) { return reason }
                catch { return "wrong failure: \(error)" }
            }
        }
        await fulfillment(of: [entered], timeout: 2)
        // Let each entered async call suspend on the occupied native queue.
        try await Task.sleep(nanoseconds: 20_000_000)
        time.advance(1_000_000_000)
        release.signal()
        await polling.value
        for sending in sends {
            let reason = await sending.value
            XCTAssertTrue(reason.contains("Native input permit"), reason)
        }
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testExternalObservationAdoptsIncompleteAllocationWithoutCapturingPixels() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let scheduler = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule)
        try await bridge.connect()
        let expected = VNCInputContext(bridge.framebufferDiagnostics)
        let requestsBefore = native.observedFullUpdates
        XCTAssertFalse(bridge.framebufferDiagnostics.complete)
        let admitted = try await bridge.validateExternalObservation(expected)
        XCTAssertEqual(admitted, expected)
        XCTAssertEqual(native.observedFullUpdates, requestsBefore)
        XCTAssertEqual(bridge.framebufferDiagnostics.rectangles, 0)
        XCTAssertEqual(bridge.framebufferDiagnostics.finishedUpdates, 0)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testExternalObservationRefusesReallocationWithUnchangedDimensions() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let scheduler = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule)
        try await bridge.connect()
        let previous = VNCInputContext(bridge.framebufferDiagnostics)
        native.beforePoll = { client in XCTAssertNotEqual(vncMallocFrameBuffer(client), 0) }
        scheduler.runNext()
        let current = VNCInputContext(bridge.framebufferDiagnostics)
        XCTAssertEqual(previous.width, current.width)
        XCTAssertEqual(previous.height, current.height)
        XCTAssertNotEqual(previous.allocation, current.allocation)
        do { _ = try await bridge.validateExternalObservation(previous); XCTFail("stale allocation admitted") }
        catch VNCError.sendFailed {} catch { XCTFail("unexpected error: \(error)") }
        let admitted = try await bridge.validateExternalObservation(current)
        XCTAssertEqual(admitted, current)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testExternalObservationRefusesReconnectedGenerationWithIdenticalGeometry() async throws {
        let native = FakeNative(outcomes: [true, true], polls: [false, true])
        native.completeDuringInitialize = false
        let scheduler = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule)
        try await bridge.connect()
        let previous = VNCInputContext(bridge.framebufferDiagnostics)
        scheduler.runNext() // connection loss
        scheduler.runNext() // reconnect into another generation
        let current = VNCInputContext(bridge.framebufferDiagnostics)
        XCTAssertEqual(previous.width, current.width)
        XCTAssertEqual(previous.height, current.height)
        XCTAssertEqual(previous.allocation, current.allocation)
        XCTAssertNotEqual(previous.connectionGeneration, current.connectionGeneration)
        do { _ = try await bridge.validateExternalObservation(previous); XCTFail("stale generation admitted") }
        catch VNCError.sendFailed {} catch { XCTFail("unexpected error: \(error)") }
        let admitted = try await bridge.validateExternalObservation(current)
        XCTAssertEqual(admitted, current)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFreshCaptureRefusesHistoricalCompletionAndMetadataUntilOriginalDeadline() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler()
        let registered = expectation(description: "fresh deadline registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect(); try await bridge.waitForFramebuffer()
        // A callback during the send operation precedes completed request dispatch.
        native.beforeFullUpdate = { completePixelUpdate($0); return true }
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2) // flush the queued request
        XCTAssertEqual(native.observedFullUpdates, 1)
        native.beforePoll = { vncFinishedFrameBufferUpdate($0) } // cursor/empty message
        scheduler.runNext()
        XCTAssertEqual(deadline.delays, [5])
        deadline.runNext()
        do { _ = try await waiting.value; XCTFail("historical pixels admitted as fresh") }
        catch VNCError.staleScreen(let staleReason, let data) {
            XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
            XCTAssertEqual(staleReason, .metadataOnly)
        } catch { XCTFail("unexpected error") }
        // Existing cached consumers retain their original semantics.
        try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFreshBlackCaptureOwnsPixelsAcrossLaterDisconnect() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler()
        let registered = expectation(description: "fresh request registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0, 16)
            completePixelUpdate(client)
        }
        scheduler.runNext()
        let captured = try await waiting.value
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(captured.connectionGeneration, 1)
        XCTAssertEqual(captured.allocation, 1)
        XCTAssertTrue(captured.withFramebuffer { buffer, width, height in
            width == 2 && height == 2 && buffer.count == 16 && buffer.allSatisfy { $0 == 0 }
        })
        deadline.runNext()
    }

    func testFreshCopyRectInvalidatesDestinationCopiedFromHistoricalSource() async throws {
        let native = FakeNative(polls: [true, true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler()
        let registered = expectation(description: "fresh copy coverage registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let events = RecordedEvents()
        let waiting = Task { let frame = try await bridge.captureFreshFramebuffer(); events.append("fresh"); return frame }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        native.beforePoll = { client in
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1) // fresh top row
            vncGotCopyRect(client, 0, 1, 2, 1, 0, 0) // historical bottom overwrites it
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1) // CopyRect's pixel callback
            vncGotFrameBufferUpdate(client, 0, 1, 2, 1) // now fresh bottom only
            vncFinishedFrameBufferUpdate(client)
        }
        scheduler.runNext()
        XCTAssertEqual(events.values, [])
        native.beforePoll = { client in
            vncGotCopyRect(client, 0, 1, 2, 1, 0, 0) // received source may supply top
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
        }
        scheduler.runNext(); _ = try await waiting.value
        XCTAssertEqual(events.values, ["fresh"])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFreshCaptureRefusesFailedSendAndConcurrentCapture() async throws {
        let native = FakeNative(polls: [])
        let scheduler = ManualScheduler(), deadline = ManualScheduler()
        let registered = expectation(description: "single fresh reader registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        do { _ = try await bridge.captureFreshFramebuffer(); XCTFail("overlapping capture admitted") }
        catch VNCError.staleScreen(let reason, let data) {
            XCTAssertEqual(reason, .captureBusy)
            XCTAssertEqual(data.message, "Fresh framebuffer capture already in progress")
        }
        catch { XCTFail("unexpected error") }
        waiting.cancel()
        do { _ = try await waiting.value; XCTFail("cancelled capture admitted") }
        catch is CancellationError {} catch { XCTFail("unexpected error") }
        deadline.onSchedule = nil
        native.beforeFullUpdate = { _ in false }
        do { _ = try await bridge.captureFreshFramebuffer(); XCTFail("failed send admitted") }
        catch VNCError.staleScreen(let reason, let data) {
            XCTAssertEqual(reason, .requestFailed)
            XCTAssertEqual(data.message, "Fresh framebuffer update request failed")
        }
        catch { XCTFail("unexpected error") }
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFreshCaptureRefusesResizeAndDisconnectInsteadOfRebinding() async throws {
        for resize in [true, false] {
            let native = FakeNative(polls: [true])
            let scheduler = ManualScheduler(), deadline = ManualScheduler()
            let registered = expectation(description: "fresh capture bound before lifecycle change")
            deadline.onSchedule = { registered.fulfill() }
            let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                                   scheduleFrameDeadline: deadline.schedule)
            try await bridge.connect()
            let waiting = Task { try await bridge.captureFreshFramebuffer() }
            await fulfillment(of: [registered], timeout: 3)
            XCTAssertEqual(bridge.framebufferWidth, 2)
            if resize {
                native.beforePoll = { client in
                    client.pointee.width = 3; client.pointee.height = 3
                    XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
                    completePixelUpdate(client)
                }
                scheduler.runNext()
            } else { bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0) }
            do { _ = try await waiting.value; XCTFail("capture rebound to another allocation") }
            catch VNCError.staleScreen(let reason, let data) {
                XCTAssertTrue(resize)
                XCTAssertEqual(reason, .allocationChanged)
                XCTAssertEqual(data.message, "Framebuffer allocation changed during fresh capture")
            } catch VNCError.notConnected { XCTAssertFalse(resize) }
            catch { XCTFail("unexpected error") }
            bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        }
    }

    func testFreshDeadlineRunsBeforeOccupiedNativeQueueCanSend() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let entered = expectation(description: "native read occupied")
        let release = DispatchSemaphore(value: 0)
        native.beforePoll = { _ in entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let polling = Task.detached { scheduler.runNext() }
        await fulfillment(of: [entered], timeout: 3)
        let registered = expectation(description: "fresh deadline precedes request queue")
        deadline.onSchedule = { registered.fulfill() }
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        deadline.runNext()
        do { _ = try await waiting.value; XCTFail("occupied queue admitted stale pixels") }
        catch VNCError.staleScreen(let staleReason, let data) { XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds")); XCTAssertEqual(staleReason, .requestFailed) }
        catch { XCTFail("unexpected error") }
        release.signal(); await polling.value
        XCTAssertEqual(bridge.framebufferWidth, 2)
        XCTAssertEqual(native.observedFullUpdates, 0) // expired queued request abandoned
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFreshCaptureCancellationBetweenLookupAndAdmissionSendsNothing() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let entered = expectation(description: "fresh coverage ready before admission")
        let finished = expectation(description: "cancellation completes while admission is paused")
        let release = DispatchSemaphore(value: 0)
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now,
                               beforeFreshCaptureAdmission: {
            entered.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        })
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task {
            defer { finished.fulfill() }
            do { _ = try await waiting.value; XCTFail("cancelled fresh capture succeeded") }
            catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(deadline.delays, [5])
        let cancelling = Task.detached { waiting.cancel() }
        // Release even when this expectation fails, so a lock regression can unwind.
        await fulfillment(of: [finished], timeout: 2)
        release.signal(); await cancelling.value; await outcome.value
        XCTAssertEqual(bridge.framebufferWidth, 2) // flush the abandoned queued request
        XCTAssertEqual(native.observedFullUpdates, 0)
        XCTAssertEqual(deadline.delays, [5]) // no renewed deadline
        deadline.runNext() // stale deadline cannot resume the completed continuation
        native.beforePoll = { completePixelUpdate($0) }
        scheduler.runNext()
        XCTAssertEqual(native.observedFullUpdates, 0)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCaptureDeadlineBetweenLookupAndAdmissionSendsNothing() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let entered = expectation(description: "fresh coverage ready before deadline refusal")
        let finished = expectation(description: "original deadline completes before admission resumes")
        let release = DispatchSemaphore(value: 0)
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now,
                               beforeFreshCaptureAdmission: {
            entered.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        })
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task {
            defer { finished.fulfill() }
            do { _ = try await waiting.value; XCTFail("expired fresh capture succeeded") }
            catch VNCError.staleScreen(let staleReason, let data) {
                XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
                XCTAssertEqual(staleReason, .requestFailed)
            } catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [entered], timeout: 3)
        let originalDeadline = deadline.take()
        XCTAssertEqual(originalDeadline.delay, 5)
        let firing = Task.detached { originalDeadline.queue.sync { originalDeadline.work.perform() } }
        await fulfillment(of: [finished], timeout: 2)
        release.signal(); await firing.value; await outcome.value
        XCTAssertEqual(bridge.framebufferWidth, 2)
        XCTAssertEqual(native.observedFullUpdates, 0)
        XCTAssertTrue(originalDeadline.work.isCancelled)
        XCTAssertEqual(deadline.delays, [])
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        native.beforePoll = { completePixelUpdate($0) }
        scheduler.runNext()
        XCTAssertEqual(native.observedFullUpdates, 0)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCaptureDisconnectBetweenLookupAndAdmissionSendsNothing() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let entered = expectation(description: "fresh coverage ready before session retirement")
        let retired = expectation(description: "desired session retires without waiting for native queue")
        let finished = expectation(description: "fresh capture refuses retired session")
        let release = DispatchSemaphore(value: 0)
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now,
                               beforeFreshCaptureAdmission: {
            entered.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        })
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task {
            defer { finished.fulfill() }
            do { _ = try await waiting.value; XCTFail("retired session supplied fresh pixels") }
            catch VNCError.notConnected {} catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(deadline.delays, [5])
        let disconnecting = Task.detached { bridge.disconnect(); retired.fulfill() }
        await fulfillment(of: [retired], timeout: 2)
        // Cleanup is queued behind the paused request; do not synchronously flush it yet.
        release.signal(); await disconnecting.value
        await fulfillment(of: [finished], timeout: 3)
        await outcome.value
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.observedFullUpdates, 0)
        XCTAssertEqual(deadline.delays, [5])
        deadline.runNext()
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCaptureAbsoluteDeadlineRefusesSendWhenTimerCallbackIsDelayed() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "original fresh deadline registered before final admission")
        let entered = expectation(description: "fresh coverage ready before absolute deadline claim")
        let finished = expectation(description: "absolute cutoff refuses send without timer callback")
        let release = DispatchSemaphore(value: 0)
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now,
                               beforeFreshCaptureAdmission: {
            entered.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        })
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task {
            defer { finished.fulfill() }
            do { _ = try await waiting.value; XCTFail("exact-cutoff request admitted") }
            catch VNCError.staleScreen(let staleReason, let data) {
                XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
                XCTAssertEqual(staleReason, .requestFailed)
            } catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [registered, entered], timeout: 3)
        let originalDeadline = deadline.take()
        XCTAssertEqual(originalDeadline.delay, 5)
        // Expire after lookup and coverage setup, not merely before queue entry.
        time.advance(5_000_000_000) // exactly the original cutoff; timer has not run
        release.signal()
        await fulfillment(of: [finished], timeout: 2)
        // A missing clock check may leave the reader pending. Fire its old deadline
        // after the assertion to unwind, without allowing that callback to prove admission.
        let sendsBeforeTimer = native.observedFullUpdates
        let refusedBeforeTimer = originalDeadline.work.isCancelled
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        await outcome.value
        XCTAssertEqual(sendsBeforeTimer, 0)
        XCTAssertTrue(refusedBeforeTimer)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        XCTAssertEqual(native.observedFullUpdates, 0)
        XCTAssertEqual(deadline.delays, [])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCaptureBeforeCutoffStillRequiresReceivedPixels() async throws {
        let native = FakeNative(polls: [true, true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "fresh positive original deadline registered")
        let finished = expectation(description: "received pixels complete the fresh positive capture")
        deadline.onSchedule = { registered.fulfill() }
        let events = RecordedEvents()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now,
                               beforeFreshCaptureAdmission: {
            time.advance(4_999_999_999)
            events.append("admission before cutoff")
        })
        try await bridge.connect()
        native.beforeFullUpdate = { client in
            events.append("native send")
            completePixelUpdate(client) // synchronous callback still precedes requestStarted
            return true
        }
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task { () -> VNCBridge.FrameCapture? in
            defer { finished.fulfill() }
            do { return try await waiting.value }
            catch { XCTFail("fresh received pixels refused: \(error)"); return nil }
        }
        await fulfillment(of: [registered], timeout: 3)
        let originalDeadline = deadline.take()
        XCTAssertEqual(originalDeadline.delay, 5)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertEqual(events.values, ["admission before cutoff", "native send"])
        XCTAssertFalse(originalDeadline.work.isCancelled)
        native.beforePoll = { vncFinishedFrameBufferUpdate($0) }
        scheduler.runNext() // metadata cannot complete the current fresh request
        XCTAssertFalse(originalDeadline.work.isCancelled)
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0x5a, 16)
            completePixelUpdate(client)
        }
        scheduler.runNext()
        await fulfillment(of: [finished], timeout: 2)
        let completedBeforeTimer = originalDeadline.work.isCancelled
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        let captured = await outcome.value
        XCTAssertTrue(completedBeforeTimer)
        XCTAssertTrue(originalDeadline.work.isCancelled)
        XCTAssertEqual(deadline.delays, [])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        if let captured {
            XCTAssertEqual(captured.connectionGeneration, 1)
            XCTAssertEqual(captured.allocation, 1)
            XCTAssertTrue(captured.withFramebuffer { buffer, width, height in
                width == 2 && height == 2 && buffer.count == 16 && buffer.allSatisfy { $0 == 0x5a }
            })
        }
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        XCTAssertEqual(native.observedFullUpdates, 1)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCaptureCancellationAfterAdmissionDoesNotHoldLocksAcrossNativeSend() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let entered = expectation(description: "already-admitted native send occupied")
        let finished = expectation(description: "cancelled caller completes before admitted send returns")
        let release = DispatchSemaphore(value: 0)
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect()
        native.beforeFullUpdate = { client in
            entered.fulfill() // FakeNative counted this one admitted request before the hook
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
            completePixelUpdate(client) // cancelled/synchronous callback cannot supply a capture
            return true
        }
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task {
            defer { finished.fulfill() }
            do { _ = try await waiting.value; XCTFail("cancelled admitted request supplied pixels") }
            catch is CancellationError {} catch { XCTFail("unexpected error: \(error)") }
        }
        await fulfillment(of: [entered], timeout: 3)
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertEqual(deadline.delays, [5])
        let cancelling = Task.detached { waiting.cancel() }
        await fulfillment(of: [finished], timeout: 2)
        release.signal(); await cancelling.value; await outcome.value
        XCTAssertEqual(bridge.framebufferWidth, 2)
        deadline.runNext()
        native.beforePoll = { completePixelUpdate($0) }
        scheduler.runNext()
        XCTAssertEqual(native.observedFullUpdates, 1) // cancellation does not replay or undo an admitted send
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCompleteResultBeforeAbsoluteCutoffOwnsReceivedPixels() async throws {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "fresh completion deadline registered")
        let finished = expectation(description: "owned fresh result resolves before cutoff")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect()
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task { () -> VNCBridge.FrameCapture? in
            defer { finished.fulfill() }
            do { return try await waiting.value }
            catch { XCTFail("before-cutoff fresh result refused: \(error)"); return nil }
        }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2) // requestStarted after the queued send
        let originalDeadline = deadline.take()
        XCTAssertEqual(native.observedFullUpdates, 1)
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0x7c, 16)
            vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
            // Advance at completion, not at request admission. The last nanosecond
            // before the original cutoff remains eligible for an owned result.
            time.advance(4_999_999_999)
            vncFinishedFrameBufferUpdate(client)
        }
        scheduler.runNext()
        await fulfillment(of: [finished], timeout: 2)
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        let captured = await outcome.value
        XCTAssertTrue(originalDeadline.work.isCancelled)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        if let captured {
            XCTAssertEqual(captured.connectionGeneration, 1)
            XCTAssertEqual(captured.allocation, 1)
            XCTAssertTrue(captured.withFramebuffer { buffer, width, height in
                width == 2 && height == 2 && buffer.count == 16 && buffer.allSatisfy { $0 == 0x7c }
            })
        }
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        XCTAssertEqual(native.observedFullUpdates, 1)
        assertSingleClientAndBufferReleased(native)
    }

    /// One fresh capture whose pixels complete `completeAfterNs` after its
    /// full request (nil: the server stays silent and the deadline fires).
    /// Returns the scheduled deadline delay and the capture outcome.
    private func timedFreshCapture(config: VNCConfiguration = .init(), appleServer: Bool,
                                   budgetNs: UInt64? = nil, completeAfterNs: UInt64?) async throws
        -> (delay: TimeInterval, result: Result<VNCBridge.FrameCapture, Error>) {
        let native = FakeNative(polls: [true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "fresh capture deadline registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(config: config, operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect()
        bridge.isMacOS = appleServer
        let deadlineNs = budgetNs.map { time.now() + $0 }
        let waiting = Task { try await bridge.captureFreshFramebuffer(deadlineNs: deadlineNs) }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2) // flush the queued admission and send
        XCTAssertEqual(native.observedFullUpdates, 1)
        let job = deadline.take()
        if let completeAfterNs {
            native.beforePoll = { client in
                memset(client.pointee.frameBuffer, 0x5a, 16)
                vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
                time.advance(completeAfterNs)
                vncFinishedFrameBufferUpdate(client)
            }
            scheduler.runNext()
        } else {
            job.queue.sync { job.work.perform() }
        }
        let result: Result<VNCBridge.FrameCapture, Error>
        do { result = .success(try await waiting.value) } catch { result = .failure(error) }
        job.queue.sync { job.work.perform() } // a retired deadline is a no-op
        XCTAssertTrue(job.work.isCancelled)
        XCTAssertEqual(native.observedFullUpdates, 1) // never replayed
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
        return (job.delay, result)
    }

    /// Measured on PZM: screensharingd paused ~4.7 s mid-answer after
    /// UI-heavy input, and one capture completed at 4939 ms. On Apple the
    /// same fresh pixels now arrive inside the 10 s deadline.
    func testAppleCaptureDeadlineAdmitsFreshPixelsAfterFiveSeconds() async throws {
        let (delay, result) = try await timedFreshCapture(appleServer: true, completeAfterNs: 7_000_000_000)
        XCTAssertEqual(delay, 10)
        let capture = try result.get()
        XCTAssertTrue(capture.withFramebuffer { buffer, _, _ in buffer.allSatisfy { $0 == 0x5a } })
        XCTAssertEqual(capture.provenance.coverage, "complete_received_after_request")
        // The same arrival on a server not detected as Apple keeps the 5 s cutoff.
        let (otherDelay, other) = try await timedFreshCapture(appleServer: false, completeAfterNs: 7_000_000_000)
        XCTAssertEqual(otherDelay, 5)
        guard case .failure(VNCError.staleScreen(let reason, let data)) = other else {
            return XCTFail("late pixels admitted on a 5 s deadline")
        }
        XCTAssertEqual(reason, .lateComplete)
        XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
    }

    /// The longer deadline is still a deadline: nothing cached is returned.
    func testAppleCaptureDeadlineStillFailsClosedWithItsOwnDuration() async throws {
        let (lateDelay, late) = try await timedFreshCapture(appleServer: true, completeAfterNs: 10_000_000_000)
        XCTAssertEqual(lateDelay, 10)
        guard case .failure(VNCError.staleScreen(let lateReason, let lateData)) = late else {
            return XCTFail("pixels at the 10 s cutoff admitted")
        }
        XCTAssertEqual(lateReason, .lateComplete)
        XCTAssertTrue(lateData.message.hasPrefix("No fresh complete framebuffer update within 10 seconds;"))
        let (_, silent) = try await timedFreshCapture(appleServer: true, completeAfterNs: nil)
        guard case .failure(VNCError.staleScreen(let silentReason, let silentData)) = silent else {
            return XCTFail("silent Apple server returned pixels")
        }
        XCTAssertEqual(silentReason, .serverSilent)
        XCTAssertTrue(silentData.message.hasPrefix(VNCError.staleScreenDeadlinePrefix))
    }

    func testExplicitCaptureTimeoutAndRequestBudgetBoundTheDeadline() async throws {
        var config = VNCConfiguration(); config.captureTimeoutMilliseconds = 7_500
        // An explicit flag applies to any server, Apple included.
        let (configuredDelay, configured) = try await timedFreshCapture(config: config, appleServer: true,
                                                                        completeAfterNs: nil)
        XCTAssertEqual(configuredDelay, 7.5)
        guard case .failure(VNCError.staleScreen(_, let configuredData)) = configured else {
            return XCTFail("silent capture succeeded")
        }
        XCTAssertTrue(configuredData.message.hasPrefix("No fresh complete framebuffer update within 7500 ms;"))
        // A request budget shorter than the capture deadline caps it, so the
        // capture fails typed before the executor's tool deadline.
        let (cappedDelay, capped) = try await timedFreshCapture(appleServer: true, budgetNs: 2_000_000_000,
                                                                completeAfterNs: 2_000_000_000)
        XCTAssertEqual(cappedDelay, 2)
        guard case .failure(VNCError.staleScreen(let cappedReason, let cappedData)) = capped else {
            return XCTFail("pixels after the request budget admitted")
        }
        XCTAssertEqual(cappedReason, .lateComplete)
        XCTAssertTrue(cappedData.message.hasPrefix("No fresh complete framebuffer update within 2 seconds;"))
        // A budget longer than the capture deadline never extends it.
        let (longDelay, long) = try await timedFreshCapture(appleServer: false, budgetNs: 25_000_000_000,
                                                            completeAfterNs: 1_000_000_000)
        XCTAssertEqual(longDelay, 5)
        XCTAssertNoThrow(try long.get())
    }

    func testFreshCompleteResultAtOrAfterCutoffRefusesWithDelayedTimer() async throws {
        for elapsed in [UInt64(5_000_000_000), UInt64(5_000_000_001)] {
            let native = FakeNative(polls: [true])
            let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
            let registered = expectation(description: "late completion original deadline registered")
            let finished = expectation(description: "late complete result refused without timer")
            let events = RecordedEvents()
            deadline.onSchedule = { registered.fulfill() }
            let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                                   scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
            try await bridge.connect()
            let waiting = Task { try await bridge.captureFreshFramebuffer() }
            let outcome = Task {
                defer { finished.fulfill() }
                do { _ = try await waiting.value; events.append("success") }
                catch VNCError.staleScreen(let staleReason, let data) {
                    XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
                    XCTAssertEqual(staleReason, .lateComplete) // fully covered, only late
                    events.append("timeout")
                } catch { XCTFail("unexpected late result error: \(error)"); events.append("unexpected error") }
            }
            await fulfillment(of: [registered], timeout: 3)
            XCTAssertEqual(bridge.framebufferWidth, 2)
            let originalDeadline = deadline.take()
            native.beforePoll = { client in
                vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
                time.advance(elapsed)
                vncFinishedFrameBufferUpdate(client)
            }
            scheduler.runNext()
            await fulfillment(of: [finished], timeout: 2)
            let resolvedWithoutTimer = events.values
            // A bad implementation may leave the reader pending; this fallback
            // unwinds after the assertion, never supplies the deadline proof.
            originalDeadline.queue.sync { originalDeadline.work.perform() }
            await outcome.value
            XCTAssertEqual(resolvedWithoutTimer, ["timeout"])
            XCTAssertTrue(originalDeadline.work.isCancelled)
            XCTAssertEqual(native.observedFullUpdates, 1) // elapsed completion never replays its request
            try await bridge.waitForFramebuffer() // cached pixels retain their separate semantics
            originalDeadline.queue.sync { originalDeadline.work.perform() }
            XCTAssertEqual(events.values, ["timeout"])
            bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
            assertSingleClientAndBufferReleased(native)
        }
    }

    func testExpiredFreshResultCannotRetireExplicitSuccessorOrCorruptCachedFrame() async throws {
        let native = FakeNative(polls: [true, true])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "first result deadline registered")
        let refused = expectation(description: "first complete result expired")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect()
        let first = Task { try await bridge.captureFreshFramebuffer() }
        let firstOutcome = Task {
            defer { refused.fulfill() }
            do { _ = try await first.value; XCTFail("expired first capture succeeded") }
            catch VNCError.staleScreen(let staleReason, let data) {
                XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
                XCTAssertEqual(staleReason, .lateComplete)
            } catch { XCTFail("unexpected first result error: \(error)") }
        }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        let staleDeadline = deadline.take()
        native.beforePoll = { client in
            time.advance(5_000_000_000)
            completePixelUpdate(client)
        }
        scheduler.runNext()
        await fulfillment(of: [refused], timeout: 2)
        staleDeadline.queue.sync { staleDeadline.work.perform() }
        await firstOutcome.value
        XCTAssertTrue(staleDeadline.work.isCancelled)
        try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        XCTAssertEqual(native.observedFullUpdates, 1)

        // This is a new explicit fixture call, never an automatic replay.
        let successorRegistered = expectation(description: "new explicit reader has its own deadline")
        let completed = expectation(description: "successor completes with new received pixels")
        deadline.onSchedule = { successorRegistered.fulfill() }
        let successor = Task { try await bridge.captureFreshFramebuffer() }
        let successorOutcome = Task { () -> VNCBridge.FrameCapture? in
            defer { completed.fulfill() }
            do { return try await successor.value }
            catch { XCTFail("old deadline retired new capture: \(error)"); return nil }
        }
        await fulfillment(of: [successorRegistered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        let newDeadline = deadline.take()
        XCTAssertFalse(newDeadline.work.isCancelled)
        staleDeadline.queue.sync { staleDeadline.work.perform() }
        XCTAssertFalse(newDeadline.work.isCancelled)
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0x35, 16)
            time.advance(4_999_999_999)
            completePixelUpdate(client)
        }
        scheduler.runNext()
        await fulfillment(of: [completed], timeout: 2)
        newDeadline.queue.sync { newDeadline.work.perform() }
        let captured = await successorOutcome.value
        if let captured { XCTAssertTrue(captured.pixels.allSatisfy { $0 == 0x35 }) }
        XCTAssertTrue(newDeadline.work.isCancelled)
        XCTAssertEqual(native.observedFullUpdates, 2)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testCancellationOrDisconnectAfterFreshCoverageCannotSupplyResult() async throws {
        for cancelTask in [true, false] {
            let native = FakeNative(polls: [true])
            let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
            let registered = expectation(description: "cancellable complete-result reader registered")
            let finished = expectation(description: "coverage cannot promote refused reader")
            let events = RecordedEvents()
            deadline.onSchedule = { registered.fulfill() }
            let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                                   scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
            try await bridge.connect()
            let waiting = Task { try await bridge.captureFreshFramebuffer() }
            let outcome = Task {
                defer { finished.fulfill() }
                do { _ = try await waiting.value; events.append("success") }
                catch is CancellationError { XCTAssertTrue(cancelTask); events.append("cancelled") }
                catch VNCError.notConnected { XCTAssertFalse(cancelTask); events.append("disconnected") }
                catch { XCTFail("unexpected refusal: \(error)"); events.append("unexpected error") }
            }
            await fulfillment(of: [registered], timeout: 3)
            XCTAssertEqual(bridge.framebufferWidth, 2)
            let originalDeadline = deadline.take()
            native.beforePoll = { [weak bridge] client in
                guard let bridge else { XCTFail("owned bridge unavailable before completion"); return }
                vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
                if cancelTask { waiting.cancel() } else { bridge.disconnect() }
                vncFinishedFrameBufferUpdate(client)
            }
            scheduler.runNext()
            if !cancelTask { XCTAssertEqual(bridge.framebufferWidth, 0) } // flush queued native cleanup
            await fulfillment(of: [finished], timeout: 2)
            originalDeadline.queue.sync { originalDeadline.work.perform() }
            await outcome.value
            XCTAssertEqual(events.values, [cancelTask ? "cancelled" : "disconnected"])
            XCTAssertEqual(native.observedFullUpdates, 1)
            bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
            assertSingleClientAndBufferReleased(native)
        }
    }

    func testFailedFreshSendAfterClockExpiryKeepsOriginalCause() async throws {
        let native = FakeNative(polls: [])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "failed send reader registered")
        let finished = expectation(description: "original native send error retained")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect()
        native.beforeFullUpdate = { _ in time.advance(5_000_000_001); return false }
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task {
            defer { finished.fulfill() }
            do { _ = try await waiting.value; XCTFail("failed send supplied a capture") }
            catch VNCError.staleScreen(let reason, let data) {
                XCTAssertEqual(reason, .requestFailed)
                XCTAssertEqual(data.message, "Fresh framebuffer update request failed")
            }
            catch { XCTFail("unexpected failed-send error: \(error)") }
        }
        await fulfillment(of: [registered, finished], timeout: 3)
        let originalDeadline = deadline.take()
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        await outcome.value
        XCTAssertTrue(originalDeadline.work.isCancelled)
        XCTAssertEqual(native.observedFullUpdates, 1)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    func testFreshCaptureRefusesOversizedOrFailedAllocationBeforeCoverageStorageOrSend() async throws {
        for failedAllocation in [false, true] {
            let native = FakeNative(polls: [true])
            let scheduler = ManualScheduler(), deadline = ManualScheduler()
            let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                                   scheduleFrameDeadline: deadline.schedule)
            try await bridge.connect()
            native.beforePoll = { client in
                if failedAllocation {
                    client.pointee.width = 17; client.pointee.height = 17
                    XCTAssertEqual(vncMallocFrameBuffer(client), 0) // fixture allocator refuses
                } else {
                    // Malformed dimensions without any replacement allocation:
                    // checked byte arithmetic overflows before coverage storage.
                    client.pointee.width = .max; client.pointee.height = .max
                }
            }
            scheduler.runNext()
            do { _ = try await bridge.captureFreshFramebuffer(); XCTFail("invalid allocation admitted") }
            catch VNCError.staleScreen(let reason, let data) {
                XCTAssertEqual(reason, .allocationChanged)
                XCTAssertEqual(data.message, "Fresh framebuffer allocation is unavailable or invalid")
            } catch { XCTFail("unexpected error") }
            XCTAssertEqual(native.observedFullUpdates, 0)
            XCTAssertEqual(native.observedAllocationRequests, failedAllocation ? [16, 1156] : [16])
            bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        }
    }

    func testStagnantPartialCoverageRecoversOnlyAfterFullFrameRequest() async throws {
        let native = FakeNative(polls: [true, true, true])
        native.completeDuringInitialize = false
        let scheduler = ManualScheduler(), time = ManualTime()
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               monotonicNanoseconds: time.now)
        try await bridge.connect()
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        native.beforePoll = { client in
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
        }
        time.advance(500_000_000); scheduler.runNext()
        XCTAssertEqual(bridge.framebufferDiagnostics.pixelsRemaining, 2)
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        native.beforeFullUpdate = { [weak bridge] client in
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            completePixelUpdate(client)
            return true
        }
        time.advance(500_000_000); scheduler.runNext()
        try await bridge.waitForFramebuffer()
        XCTAssertEqual(native.observedFullUpdates, 2)
        XCTAssertEqual(native.observedIncrementalUpdates, 0)
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        native.beforePoll = nil
        time.advance(100_000_000); scheduler.runNext()
        XCTAssertEqual(native.observedFullUpdates, 2)
        XCTAssertEqual(native.observedIncrementalUpdates, 1)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFailedFullFrameRequestsAreRateBoundedWithoutInventingCoverageOrRenewingDeadline() async throws {
        let native = FakeNative(polls: []); native.completeDuringInitialize = false
        native.beforeFullUpdate = { _ in false }
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "full-frame retries keep the original reader deadline")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule,
                               monotonicNanoseconds: time.now)
        try await bridge.connect()
        let waiting = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        for _ in 0..<99 {
            time.advance(10_000_000); scheduler.runNext()
        }
        XCTAssertEqual(native.observedFullUpdates, 1)
        time.advance(10_000_000); scheduler.runNext()
        XCTAssertEqual(native.observedFullUpdates, 2)
        XCTAssertEqual(native.observedIncrementalUpdates, 0)
        XCTAssertEqual(bridge.framebufferDiagnostics.pixelsRemaining, 4)
        XCTAssertFalse(bridge.framebufferDiagnostics.complete)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        XCTAssertEqual(deadline.delays, [5])
        deadline.runNext()
        do { try await waiting.value; XCTFail("failed full-frame request admitted an empty frame") }
        catch VNCError.sendFailed(let reason) {
            let diagnostic = try timeoutDiagnostics(reason)
            XCTAssertEqual(diagnostic["pixels_remaining"] as? Int, 4)
            XCTAssertEqual(diagnostic["complete"] as? Bool, false)
        } catch { XCTFail("unexpected error") }
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    private func timeoutDiagnostics(_ reason: String,
                                    file: StaticString = #filePath, line: UInt = #line) throws -> [String: Any] {
        let prefix = "No complete framebuffer update within 5 seconds; diagnostics="
        XCTAssertTrue(reason.hasPrefix(prefix), file: file, line: line)
        let payload = String(reason.dropFirst(prefix.count))
        XCTAssertLessThanOrEqual(payload.utf8.count, 1024, file: file, line: line)
        let data = Data(payload.utf8)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any],
                                   file: file, line: line)
        let required: Set<String> = [
            "connection_generation", "allocations", "width", "height", "pixels_remaining",
            "rectangles", "copy_rectangles", "finished_updates", "rejected_rectangles",
            "skipped_copy_rectangles", "complete", "phase",
            "unanswered_full_requests", "unanswered_incremental_requests", "auto_rearm_observed",
            "request_gate_leaks"
        ]
        let keys = Set(object.keys)
        XCTAssertTrue(required.isSubset(of: keys), file: file, line: line)
        XCTAssertTrue(keys.isSubset(of: required.union(["last_callback_age_milliseconds"])),
                      file: file, line: line)
        for key in required.subtracting(["complete", "phase"]) {
            XCTAssertNotNil(object[key] as? Int, "non-numeric diagnostic: \(key)", file: file, line: line)
        }
        XCTAssertNotNil(object["complete"] as? Bool, file: file, line: line)
        let phases: Set<String> = ["initializing", "idle", "waitingForMessage",
                                   "handlingServerMessage", "requestingIncrementalUpdate", "disconnected"]
        XCTAssertTrue(phases.contains(object["phase"] as? String ?? ""), file: file, line: line)
        if let age = object["last_callback_age_milliseconds"], !(age is NSNull) {
            XCTAssertNotNil(age as? UInt64, file: file, line: line)
        }
        XCTAssertEqual(try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), data,
                       "diagnostics must be compact, sorted JSON", file: file, line: line)
        return object
    }

    // MARK: - Static server and Apple modifier mapping (TIN-5008)

    private func wire(_ key: UInt32, _ down: Bool) -> String {
        (down ? "down 0x" : "up 0x") + String(key, radix: 16, uppercase: true)
    }

    /// A previously complete mirror cannot satisfy a new request, even when
    /// the server sends nothing for the whole original deadline.
    func testSilentServerKeepsOriginalFreshDeadlineWithoutIncrementalPolls() async throws {
        let native = FakeNative(polls: [])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "fresh deadline registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect(); try await bridge.waitForFramebuffer()
        // A is complete, but predates the new full request.
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0x44, 16)
            completePixelUpdate(client)
        }
        time.advance(100_000_000); scheduler.runNext()
        native.beforePoll = nil
        let incrementalBefore = native.observedIncrementalUpdates
        XCTAssertEqual(incrementalBefore, 1)
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2) // flush the queued admission and send
        let originalDeadline = deadline.take()
        XCTAssertEqual(native.observedFullUpdates, 1)
        time.advance(1_100_000_000); scheduler.runNext()
        XCTAssertFalse(originalDeadline.work.isCancelled)
        XCTAssertEqual(native.observedIncrementalUpdates, incrementalBefore)
        time.advance(3_899_999_999); scheduler.runNext()
        XCTAssertFalse(originalDeadline.work.isCancelled)
        XCTAssertEqual(native.observedIncrementalUpdates, incrementalBefore)
        time.advance(1) // the immutable five-second cutoff, not a renewed window
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        do { _ = try await waiting.value; XCTFail("silent server returned historical pixels") }
        catch VNCError.staleScreen(let staleReason, let data) {
            XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
            XCTAssertEqual(staleReason, .serverSilent)
        } catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(originalDeadline.work.isCancelled)
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertEqual(native.observedIncrementalUpdates, incrementalBefore)
        originalDeadline.queue.sync { originalDeadline.work.perform() } // no second retirement
        time.advance(100_000_000); scheduler.runNext() // ordinary pacing resumes
        XCTAssertEqual(native.observedIncrementalUpdates, incrementalBefore + 1)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    /// A partial reply is a reply: the mirror never completes a capture then.
    func testAnyServerReplyAfterNonIncrementalRequestKeepsFullCoverageRequirement() async throws {
        for reply in ["partial", "metadata"] {
            let native = FakeNative(polls: [])
            let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
            let registered = expectation(description: "fresh deadline registered")
            deadline.onSchedule = { registered.fulfill() }
            let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                                   scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
            try await bridge.connect(); try await bridge.waitForFramebuffer()
            let waiting = Task { try await bridge.captureFreshFramebuffer() }
            await fulfillment(of: [registered], timeout: 3)
            XCTAssertEqual(bridge.framebufferWidth, 2)
            let originalDeadline = deadline.take()
            native.beforePoll = { client in
                if reply == "partial" { vncGotFrameBufferUpdate(client, 0, 0, 2, 1) }
                vncFinishedFrameBufferUpdate(client)
            }
            time.advance(10_000_000); scheduler.runNext()
            native.beforePoll = nil
            time.advance(2_000_000_000); scheduler.runNext()
            XCTAssertFalse(originalDeadline.work.isCancelled)
            originalDeadline.queue.sync { originalDeadline.work.perform() }
            do { _ = try await waiting.value; XCTFail("\(reply) reply completed a fresh capture") }
            catch VNCError.staleScreen(let staleReason, let data) {
                XCTAssertTrue(data.message.hasPrefix("No fresh complete framebuffer update within 5 seconds"))
                XCTAssertEqual(staleReason, reply == "partial" ? VNCStaleScreenReason.incompleteCoverage : VNCStaleScreenReason.metadataOnly)
            } catch { XCTFail("unexpected error: \(error)") }
            XCTAssertEqual(native.observedFullUpdates, 1)
            bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
            assertSingleClientAndBufferReleased(native)
        }
    }

    /// A local input write followed by client silence cannot prove the target
    /// stayed at A. Hold B's actual pixels past one second, then deliver them
    /// inside the original deadline; only B may complete the observation.
    func testDelayedFullPixelsAfterInputNeverResolveFromCachedMirror() async throws {
        let native = FakeNative(polls: [])
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let registered = expectation(description: "fresh deadline registered")
        let finished = expectation(description: "delayed B completes the fresh capture")
        deadline.onSchedule = { registered.fulfill() }
        let keys = RecordedEvents()
        native.onKey = { key, down in keys.append(self.wire(key, down)) }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect(); try await bridge.waitForFramebuffer()
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0x44, 16)
            completePixelUpdate(client)
        }
        time.advance(100_000_000); scheduler.runNext()
        native.beforePoll = nil
        let incrementalBefore = native.observedIncrementalUpdates
        try await bridge.sendKeyEvent(key: 0x61, down: true)
        try await bridge.sendKeyEvent(key: 0x61, down: false)
        // The connection's first input is preceded by the modifier release sync.
        XCTAssertEqual(keys.values, VNCBridge.modifierKeysyms.map { wire($0, false) } + ["down 0x61", "up 0x61"])
        let waiting = Task { try await bridge.captureFreshFramebuffer() }
        let outcome = Task { () -> VNCBridge.FrameCapture? in
            defer { finished.fulfill() }
            do { return try await waiting.value }
            catch { XCTFail("delayed full B refused: \(error)"); return nil }
        }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        let originalDeadline = deadline.take()
        time.advance(2_000_000_000); scheduler.runNext() // B is delayed, not unchanged
        XCTAssertFalse(originalDeadline.work.isCancelled)
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertEqual(native.observedIncrementalUpdates, incrementalBefore)
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0x99, 16)
            completePixelUpdate(client)
        }
        time.advance(100_000_000); scheduler.runNext()
        await fulfillment(of: [finished], timeout: 2)
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        let captured = await outcome.value
        XCTAssertTrue(originalDeadline.work.isCancelled)
        XCTAssertEqual(native.observedFullUpdates, 1) // no replay while B was delayed
        if let captured {
            XCTAssertEqual(captured.connectionGeneration, 1)
            XCTAssertEqual(captured.allocation, 1)
            XCTAssertTrue(captured.withFramebuffer { buffer, width, height in
                width == 2 && height == 2 && buffer.count == 16 && buffer.allSatisfy { $0 == 0x99 }
            })
        }
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(native)
    }

    // MARK: - Apple static-screen request models (TIN-5509)

    private struct ModelHarness {
        let native: FakeNative
        let scheduler: ManualScheduler
        let deadline: ManualScheduler
        let time: ManualTime
        let bridge: VNCBridge
    }

    /// Connect under one server model, take the initial frame from that
    /// model, then idle so the stream loop stacks its incremental polls.
    private func connectModel(_ model: FakeServerModel, config: VNCConfiguration = .init(),
                              idlePolls: Int = 3) async throws -> ModelHarness {
        let native = FakeNative(polls: []); native.completeDuringInitialize = false
        native.serverModel = model
        let scheduler = ManualScheduler(), deadline = ManualScheduler(), time = ManualTime()
        let bridge = VNCBridge(config: config, operations: native.operations, schedule: scheduler.schedule,
                               scheduleFrameDeadline: deadline.schedule, monotonicNanoseconds: time.now)
        try await bridge.connect()
        time.advance(100_000_000); scheduler.runNext() // the model answers the connect requests
        try await bridge.waitForFramebuffer()
        for _ in 0..<idlePolls { time.advance(100_000_000); scheduler.runNext() }
        return ModelHarness(native: native, scheduler: scheduler, deadline: deadline, time: time, bridge: bridge)
    }

    /// Start one fresh capture and flush its admission and request.
    private func startCapture(_ harness: ModelHarness) async
        -> (Task<VNCBridge.FrameCapture, Error>, ManualScheduler.Job) {
        let registered = expectation(description: "fresh deadline registered")
        harness.deadline.onSchedule = { registered.fulfill() }
        let waiting = Task { try await harness.bridge.captureFreshFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        harness.deadline.onSchedule = nil
        XCTAssertEqual(harness.bridge.framebufferWidth, 2) // flush the queued admission and send
        return (waiting, harness.deadline.take())
    }

    /// Latest-wins: with the daemon's own polls suppressed during a capture,
    /// its full request is the newest one the server holds, so the current
    /// stream mode already receives fresh complete pixels.
    func testLatestWinsPassesWithCurrentSuppression() async throws {
        let harness = try await connectModel(.latestWins)
        let idle = harness.native.wire
        // LibVNC's re-arm plus four stream polls are outstanding while idle.
        XCTAssertEqual(idle.outstanding, Array(repeating: true, count: 5))
        XCTAssertEqual(idle.autoRearm, 1)
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.autoRearmObserved, 1)
        // The connect-time request and its missing-pixel duplicate were both
        // answered by one update; only one is retired, so the count errs high.
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredFullRequests, 1)
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredIncrementalRequests, 5)
        let (waiting, originalDeadline) = await startCapture(harness)
        XCTAssertEqual(harness.native.wire.outstanding.last, false)
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredFullRequests, 2)
        let incrementalBefore = harness.native.observedIncrementalUpdates
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        let frame = try await waiting.value
        XCTAssertTrue(originalDeadline.work.isCancelled)
        XCTAssertEqual(harness.native.observedIncrementalUpdates, incrementalBefore)
        XCTAssertTrue(frame.withFramebuffer { buffer, width, height in
            width == 2 && height == 2 && buffer.count == 16 && buffer.allSatisfy { $0 == 2 }
        }) // the second server frame, not the cached first one
        // Stream mode: the answering update's own re-arm is on the wire too.
        // Requests written before this capture's own were outstanding at
        // admission, so stream mode never claims ordering after prior input.
        XCTAssertEqual(frame.provenance, VNCCaptureProvenance(
            requestMode: .stream, requests: .init(full: 1, incremental: 1),
            priorUnansweredRequests: .init(full: 1, incremental: 5), orderedAfterPriorInput: false,
            elapsedMilliseconds: frame.provenance.elapsedMilliseconds))
        XCTAssertEqual(frame.provenance.elapsedMilliseconds, 10)
        let diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.unansweredFullRequests, 1)
        XCTAssertEqual(diagnostics.unansweredIncrementalRequests, 1) // the answer's own re-arm
        XCTAssertEqual(diagnostics.autoRearmObserved, 2)
        let wire = harness.native.wire
        XCTAssertEqual(wire.full, 3) // connect, missing-pixel refresh, capture
        XCTAssertEqual(wire.autoRearm, 2)
        XCTAssertEqual(wire.suppressed, 0)
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(harness.native)
    }

    /// First-wins: LibVNC's own re-arm is outstanding before any capture,
    /// so stream mode's full request is absorbed and the static server
    /// stays silent. The failure is typed, never a cached mirror.
    func testFirstWinsFailsStreamPassesOnDemand() async throws {
        let harness = try await connectModel(.firstWins)
        let (waiting, originalDeadline) = await startCapture(harness)
        XCTAssertEqual(harness.native.wire.outstanding.first, true)
        XCTAssertEqual(harness.native.wire.outstanding.last, false)
        harness.time.advance(1_000_000_000); harness.scheduler.runNext()
        XCTAssertFalse(originalDeadline.work.isCancelled)
        harness.time.advance(4_000_000_000)
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        do { _ = try await waiting.value; XCTFail("first-wins answered behind an outstanding incremental") }
        catch VNCError.staleScreen(let reason, let data) {
            XCTAssertEqual(reason, .serverSilent)
            XCTAssertTrue(data.message.hasPrefix(VNCError.staleScreenDeadlineMessage(milliseconds: 5_000)))
            // The capture's own request plus the merged connect-time duplicate.
            XCTAssertEqual(data.diagnostics.unansweredFullRequests, 2)
            XCTAssertEqual(data.diagnostics.unansweredIncrementalRequests, 5)
            XCTAssertEqual(data.diagnostics.autoRearmObserved, 1)
        } catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(harness.native.wire.frames, 1)
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(harness.native)

        // On demand nothing is outstanding before the capture's own request.
        let onDemand = try await connectModel(.firstWins, config: Self.onDemandConfiguration)
        XCTAssertEqual(onDemand.native.wire.outstanding, [])
        let (succeeding, onDemandDeadline) = await startCapture(onDemand)
        XCTAssertEqual(onDemand.native.wire.outstanding, [false])
        onDemand.time.advance(10_000_000); onDemand.scheduler.runNext()
        let frame = try await succeeding.value
        XCTAssertTrue(onDemandDeadline.work.isCancelled)
        XCTAssertTrue(frame.withFramebuffer { buffer, _, _ in buffer.allSatisfy { $0 == 2 } })
        XCTAssertEqual(frame.provenance.requestMode, .onDemand)
        XCTAssertEqual(frame.provenance.requests, .init(full: 1, incremental: 0))
        XCTAssertEqual(frame.provenance.priorUnansweredRequests, .init())
        XCTAssertTrue(frame.provenance.orderedAfterPriorInput)
        XCTAssertEqual(onDemand.native.observedIncrementalUpdates, 0)
        XCTAssertEqual(onDemand.native.wire.incremental, 0)
        onDemand.bridge.disconnect(); XCTAssertEqual(onDemand.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(onDemand.native)
    }

    private static var onDemandConfiguration: VNCConfiguration {
        var configuration = VNCConfiguration()
        configuration.requestMode = .onDemand
        return configuration
    }

    /// On demand the bridge never polls, LibVNC's post-update re-arm and its
    /// own resize request are both suppressed, and the bridge's missing-pixel
    /// request takes over after a resize.
    func testOnDemandSendsZeroIncrementalAndSuppressesAutoRearmAndResizeRequests() async throws {
        let harness = try await connectModel(.latestWins, config: Self.onDemandConfiguration)
        var wire = harness.native.wire
        // rfbInitConnection's only: the missing-pixel refresh waits behind it.
        XCTAssertEqual(wire.full, 1)
        XCTAssertEqual(wire.suppressed, 1) // the first update's re-arm
        XCTAssertEqual(wire.outstanding, [])
        let (waiting, _) = await startCapture(harness)
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        let frame = try await waiting.value
        XCTAssertEqual(frame.provenance.requests, .init(full: 1, incremental: 0))
        XCTAssertEqual(frame.provenance.priorUnansweredRequests, .init())
        XCTAssertTrue(frame.provenance.orderedAfterPriorInput)
        // The server resizes; LibVNC's own full request finds the gate closed.
        harness.native.beforePoll = { client in
            client.pointee.width = 3; client.pointee.height = 3
            XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
            harness.native.writeRequest(client, incremental: false)
        }
        harness.time.advance(100_000_000); harness.scheduler.runNext()
        harness.native.beforePoll = nil
        wire = harness.native.wire
        XCTAssertEqual(wire.suppressed, 3) // two re-arms and the resize request
        XCTAssertEqual(wire.outstanding, [false]) // the bridge's own missing-pixel request
        harness.time.advance(100_000_000); harness.scheduler.runNext()
        try await harness.bridge.waitForFramebuffer()
        XCTAssertEqual(harness.bridge.framebufferWidth, 3)
        for _ in 0..<5 { harness.time.advance(100_000_000); harness.scheduler.runNext() }
        wire = harness.native.wire
        XCTAssertEqual(harness.native.observedIncrementalUpdates, 0)
        XCTAssertEqual(wire.incremental, 0)
        XCTAssertEqual(wire.autoRearm, 0)
        XCTAssertEqual(wire.suppressed, 4)
        XCTAssertEqual(wire.full, 3)
        let diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.autoRearmObserved, 0)
        XCTAssertEqual(diagnostics.requestGateLeaks, 0)
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        let clients = harness.native.counts
        XCTAssertEqual(clients.releases, 1); XCTAssertEqual(clients.live, 0)
    }

    /// A SupportedMessages rectangle reopens the gate inside the update that
    /// answers a capture; LibVNC re-arms before any callback. The leak is
    /// counted, the gate closed again and that capture's ordering tainted.
    /// The leaked re-arm stays outstanding, so the next capture is admitted
    /// behind it and is tainted too, until an update answers it. The leak
    /// count is connection-scoped and survives a framebuffer reallocation.
    func testGateLeakFromSupportedMessagesCountedReclosedTaintsOrdering() async throws {
        let harness = try await connectModel(.latestWins, config: Self.onDemandConfiguration)
        let (leaking, _) = await startCapture(harness)
        harness.native.reopenGateOnNextUpdate = true
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        let tainted = try await leaking.value
        XCTAssertFalse(tainted.provenance.orderedAfterPriorInput)
        XCTAssertEqual(tainted.provenance.requests, .init(full: 1, incremental: 1))
        XCTAssertEqual(tainted.provenance.priorUnansweredRequests, .init())
        var diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.requestGateLeaks, 1)
        XCTAssertEqual(diagnostics.autoRearmObserved, 1)
        XCTAssertEqual(diagnostics.unansweredIncrementalRequests, 1)
        XCTAssertEqual(harness.native.wire.autoRearm, 1)
        XCTAssertEqual(harness.native.wire.outstanding, [true]) // the leaked re-arm
        // Closed again: idle polls write nothing and are not counted twice.
        for _ in 0..<3 { harness.time.advance(100_000_000); harness.scheduler.runNext() }
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.requestGateLeaks, 1)
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredIncrementalRequests, 1)
        let (behind, _) = await startCapture(harness)
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        let admittedBehindLeak = try await behind.value
        XCTAssertEqual(admittedBehindLeak.provenance.priorUnansweredRequests, .init(full: 0, incremental: 1))
        XCTAssertFalse(admittedBehindLeak.provenance.orderedAfterPriorInput)
        XCTAssertEqual(admittedBehindLeak.provenance.requests, .init(full: 1, incremental: 0))
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredIncrementalRequests, 0)
        // That update answered the leaked request; nothing is outstanding now.
        let (next, _) = await startCapture(harness)
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        let clean = try await next.value
        XCTAssertTrue(clean.provenance.orderedAfterPriorInput)
        XCTAssertEqual(clean.provenance.priorUnansweredRequests, .init())
        XCTAssertEqual(clean.provenance.requests, .init(full: 1, incremental: 0))
        diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.requestGateLeaks, 1)
        XCTAssertEqual(diagnostics.autoRearmObserved, 1)
        XCTAssertEqual(harness.native.wire.autoRearm, 1)
        XCTAssertEqual(harness.native.observedIncrementalUpdates, 0)
        // A server resize rebuilds the allocation snapshot; the leak count stays.
        let allocations = diagnostics.allocations
        harness.native.beforePoll = { client in
            client.pointee.width = 3; client.pointee.height = 3
            XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
        }
        harness.time.advance(100_000_000); harness.scheduler.runNext()
        harness.native.beforePoll = nil
        diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.allocations, allocations + 1)
        XCTAssertEqual(diagnostics.requestGateLeaks, 1)
        XCTAssertEqual(diagnostics.unansweredFullRequests, 1) // the missing-pixel request
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        let clients = harness.native.counts
        XCTAssertEqual(clients.releases, 1); XCTAssertEqual(clients.live, 0)
    }

    /// The poll-time backstop: the gate is found reopened after a poll that
    /// delivered no update, so no completion callback closed it. The leak is
    /// counted, the gate closed before the next poll, the pending capture's
    /// ordering tainted, and a possible unobserved re-arm assumed outstanding.
    func testPollTimeGateLeakCountedReclosedTaintsPendingCapture() async throws {
        let harness = try await connectModel(.latestWins, config: Self.onDemandConfiguration)
        harness.native.serverModel = .silent // hold the answer for one poll
        let (waiting, _) = await startCapture(harness)
        harness.native.beforePoll = { FakeNative.setDefaultSupportedMessages($0) }
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        var diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.requestGateLeaks, 1)
        XCTAssertEqual(diagnostics.unansweredIncrementalRequests, 1)
        XCTAssertEqual(harness.native.wire.outstanding, [false]) // nothing written while open
        harness.native.beforePoll = { client in XCTAssertFalse(VNCBridge.requestGateOpen(client)) }
        harness.native.serverModel = .latestWins
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        harness.native.beforePoll = nil
        let frame = try await waiting.value
        XCTAssertFalse(frame.provenance.orderedAfterPriorInput)
        XCTAssertEqual(frame.provenance.priorUnansweredRequests, .init())
        XCTAssertEqual(frame.provenance.requests, .init(full: 1, incremental: 0))
        diagnostics = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(diagnostics.requestGateLeaks, 1)
        XCTAssertEqual(diagnostics.unansweredIncrementalRequests, 0)
        XCTAssertEqual(diagnostics.unansweredFullRequests, 0)
        XCTAssertEqual(harness.native.wire.incremental, 0)
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(harness.native)
    }

    /// RFB requests carry no identifier. A full request is retired one at a
    /// time and only by an update covering the whole allocation: two full
    /// requests answered in order must not read as none, and a partial update
    /// cannot answer one.
    func testFullRequestsRetireOneAtATimeOnlyOnWholeAllocationUpdates() async throws {
        let harness = try await connectModel(.latestWins, config: Self.onDemandConfiguration)
        harness.native.serverModel = .silent
        let (silent, silentDeadline) = await startCapture(harness)
        harness.time.advance(5_000_000_000)
        silentDeadline.queue.sync { silentDeadline.work.perform() }
        do { _ = try await silent.value; XCTFail("silent model produced a capture") }
        catch VNCError.staleScreen(let reason, _) { XCTAssertEqual(reason, .serverSilent) }
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredFullRequests, 1)
        // A second request is written while the first is still unanswered.
        let (second, _) = await startCapture(harness)
        XCTAssertEqual(harness.native.wire.outstanding, [false, false])
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredFullRequests, 2)
        harness.native.beforePoll = { harness.native.deliverUpdate($0, rects: [(0, 0, 2, 1)]) }
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredFullRequests, 2) // partial
        // An in-order server answers the first request; the second stays counted.
        harness.native.beforePoll = { harness.native.deliverUpdate($0, rects: [(0, 0, 2, 2)]) }
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        harness.native.beforePoll = nil
        let behind = try await second.value
        XCTAssertEqual(behind.provenance.priorUnansweredRequests, .init(full: 1, incremental: 0))
        XCTAssertFalse(behind.provenance.orderedAfterPriorInput)
        XCTAssertEqual(harness.bridge.framebufferDiagnostics.unansweredFullRequests, 1)
        // The next capture is admitted behind that still-counted request.
        let (third, _) = await startCapture(harness)
        harness.native.beforePoll = { harness.native.deliverUpdate($0, rects: [(0, 0, 2, 2)]) }
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        harness.native.beforePoll = nil
        let next = try await third.value
        XCTAssertEqual(next.provenance.priorUnansweredRequests, .init(full: 1, incremental: 0))
        XCTAssertFalse(next.provenance.orderedAfterPriorInput)
        XCTAssertEqual(harness.native.wire.incremental, 0)
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(harness.native)
    }

    /// The observation entry point classifies every failure at the bridge:
    /// a connection dropped under a pending capture and a cancelled capture
    /// leave as typed stale_screen, never a bare notConnected/cancellation.
    func testCaptureFreshObservationClassifiesDisconnectAndCancellation() async throws {
        for cancelTask in [false, true] {
            let harness = try await connectModel(.latestWins)
            harness.native.serverModel = .silent
            let registered = expectation(description: "observation deadline registered")
            harness.deadline.onSchedule = { registered.fulfill() }
            let waiting = Task { try await harness.bridge.captureFreshObservation() }
            await fulfillment(of: [registered], timeout: 3)
            XCTAssertEqual(harness.bridge.framebufferWidth, 2) // flush the admission
            let originalDeadline = harness.deadline.take()
            if cancelTask { waiting.cancel() } else { harness.bridge.disconnect() }
            do { _ = try await waiting.value; XCTFail("observation succeeded without an answer") }
            catch VNCError.staleScreen(let reason, let data) {
                XCTAssertEqual(reason, cancelTask ? .cancelled : .disconnected)
                XCTAssertFalse(data.message.isEmpty)
            } catch { XCTFail("unclassified observation failure: \(error)") }
            XCTAssertTrue(originalDeadline.work.isCancelled)
            harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
            assertSingleClientAndBufferReleased(harness.native)
        }
    }

    /// The ledger never reveals input counts, timing or clipboard length: a
    /// run of input is one coalesced line before the next request line. A
    /// send LibVNC would report as successful without writing, because the
    /// server's SupportedMessages bitmap excludes it, is marked suppressed;
    /// a suppressed capture request is refused instead of being awaited.
    func testWireLedgerCoalescesInputAndMarksSuppressedWrites() async throws {
        var configuration = VNCConfiguration()
        configuration.wireLedger = true
        let harness = try await connectModel(.latestWins, config: configuration)
        func stripped(_ lines: RecordedEvents) -> [String] {
            lines.values.map { $0.replacingOccurrences(of: #"ms=\d+ "#, with: "", options: .regularExpression) }
        }
        let lines = RecordedEvents()
        harness.bridge.ledgerOutput = { lines.append($0) }
        for _ in 0..<3 {
            try await harness.bridge.sendKeyEvent(key: 0x61, down: true)
            try await harness.bridge.sendKeyEvent(key: 0x61, down: false)
        }
        try await harness.bridge.sendMouseEvent(x: 1, y: 1)
        try await harness.bridge.sendClipboardText("owned fixture text")
        XCTAssertEqual(lines.values, []) // held until the next request line
        let (waiting, _) = await startCapture(harness)
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        _ = try await waiting.value
        XCTAssertEqual(stripped(lines), [
            "[RFB-WIRE] dir=c2s type=input incremental=- length=- origin=bridge kinds=4,5,6\n",
            "[RFB-WIRE] dir=c2s type=3 incremental=0 length=10 origin=bridge\n",
            "[RFB-WIRE] dir=c2s type=3 incremental=1 length=10 origin=libvnc-rearm\n",
        ])
        // The server's bitmap now excludes FramebufferUpdateRequest and KeyEvent.
        let suppressed = RecordedEvents()
        harness.bridge.ledgerOutput = { suppressed.append($0) }
        harness.native.beforePoll = { client in
            client.pointee.supportedMessages.client2server.0 &= ~(VNCBridge.requestGateMask | (1 << 4))
        }
        harness.time.advance(100_000_000); harness.scheduler.runNext() // a stream poll
        harness.native.beforePoll = nil
        let before = harness.bridge.framebufferDiagnostics
        let fullSends = harness.native.observedFullUpdates
        try await harness.bridge.sendKeyEvent(key: 0x61, down: true)
        try await harness.bridge.sendKeyEvent(key: 0x61, down: false)
        let (refused, refusedDeadline) = await startCapture(harness)
        do { _ = try await refused.value; XCTFail("a suppressed request was awaited as sent") }
        catch VNCError.staleScreen(let reason, _) { XCTAssertEqual(reason, .requestFailed) }
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertTrue(refusedDeadline.work.isCancelled)
        XCTAssertEqual(harness.native.observedFullUpdates, fullSends)
        let after = harness.bridge.framebufferDiagnostics
        XCTAssertEqual(after.unansweredFullRequests, before.unansweredFullRequests)
        XCTAssertEqual(after.unansweredIncrementalRequests, before.unansweredIncrementalRequests)
        XCTAssertEqual(stripped(suppressed), [
            "[RFB-WIRE] dir=c2s type=3 incremental=1 length=10 origin=suppressed\n",
            "[RFB-WIRE] dir=c2s type=input incremental=- length=- origin=suppressed kinds=4\n",
            "[RFB-WIRE] dir=c2s type=3 incremental=0 length=10 origin=suppressed\n",
        ])
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(harness.native)
    }

    /// The gate is one bit in the vendored LibVNC 0.9.15 header. Pin the
    /// version, the message number, the bitmap shape and the bit that the
    /// library's own SupportsClient2Server reads, so a LibVNC bump fails here
    /// before rfbclient.c:1497 and :2564 are reviewed again.
    func testGateHeaderOffsetPinned() throws {
        XCTAssertEqual(LIBVNCSERVER_VERSION, "0.9.15")
        XCTAssertEqual(rfbFramebufferUpdateRequest, 3)
        XCTAssertEqual(VNCBridge.framebufferUpdateRequestType, 3)
        XCTAssertEqual(VNCBridge.requestGateMask, 0x08)
        XCTAssertEqual(sz_rfbSupportedMessages, 64)
        XCTAssertEqual(MemoryLayout<rfbSupportedMessages>.size, 64)
        let offset = try XCTUnwrap(MemoryLayout<rfbClient>.offset(of: \rfbClient.supportedMessages))
        let client = try XCTUnwrap(rfbGetClient(8, 3, 4))
        defer { VNCClientOperations.release(client) }
        // Write byte 0 through the raw header offset; the compiled library must
        // read the same byte and bit.
        let raw = UnsafeMutableRawPointer(client)
        raw.storeBytes(of: UInt8(0xFF), toByteOffset: offset, as: UInt8.self)
        XCTAssertNotEqual(SupportsClient2Server(client, 3), 0)
        XCTAssertTrue(VNCBridge.requestGateOpen(client))
        VNCBridge.setRequestGate(client, open: false)
        XCTAssertEqual(raw.load(fromByteOffset: offset, as: UInt8.self), 0xF7)
        XCTAssertEqual(SupportsClient2Server(client, 3), 0)
        XCTAssertFalse(VNCBridge.requestGateOpen(client))
        for others: Int32 in [0, 1, 2, 4, 5, 6, 7] {
            XCTAssertNotEqual(SupportsClient2Server(client, others), 0, "message type \(others)")
        }
        VNCBridge.setRequestGate(client, open: true)
        XCTAssertNotEqual(SupportsClient2Server(client, 3), 0)
        XCTAssertEqual(raw.load(fromByteOffset: offset, as: UInt8.self), 0xFF)
    }

    /// Observation writes requests only. Neither a successful capture, a
    /// typed stale_screen failure nor LibVNC's re-arms write any input.
    func testCapturePathEmitsZeroInput() async throws {
        let harness = try await connectModel(.latestWins)
        let (succeeding, _) = await startCapture(harness)
        harness.time.advance(10_000_000); harness.scheduler.runNext()
        _ = try await succeeding.value
        harness.native.serverModel = .silent
        let (failing, originalDeadline) = await startCapture(harness)
        harness.time.advance(5_000_000_000); harness.scheduler.runNext()
        originalDeadline.queue.sync { originalDeadline.work.perform() }
        do { _ = try await failing.value; XCTFail("silent model produced a capture") }
        catch VNCError.staleScreen(let reason, _) { XCTAssertEqual(reason, .serverSilent) }
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(harness.native.observedInputWrites, [])
        XCTAssertGreaterThan(harness.native.wire.full, 0)
        // The seam is live: one explicit pointer write is recorded, after the
        // release-only modifier sync that precedes a connection's first input.
        try await harness.bridge.sendMouseEvent(x: 1, y: 1)
        XCTAssertEqual(harness.native.observedInputWrites,
                       Array(repeating: "key", count: VNCBridge.modifierKeysyms.count) + ["pointer"])
        harness.bridge.disconnect(); XCTAssertEqual(harness.bridge.framebufferWidth, 0)
        assertSingleClientAndBufferReleased(harness.native)
    }

    /// TIN-6597: before the first input of each connection generation the
    /// bridge writes one release-only key-up per modifier, exactly once. A
    /// connection that only observes, and a release-only write, write none.
    func testModifierReleaseSyncPrecedesFirstInputOncePerConnection() async throws {
        let native = FakeNative(polls: [])
        let scheduler = ManualScheduler()
        let keys = RecordedEvents()
        native.onKey = { key, down in keys.append(self.wire(key, down)) }
        let bridge = VNCBridge(operations: native.operations, schedule: scheduler.schedule)
        try await bridge.connect()
        XCTAssertEqual(bridge.framebufferWidth, 2)
        XCTAssertEqual(native.observedInputWrites, [])
        try await bridge.sendKeyEvent(key: 0xFFE1, down: false, releaseOnly: true)
        XCTAssertEqual(keys.values, ["up 0xFFE1"])
        try await bridge.sendKeyEvent(key: 0x61, down: true)
        try await bridge.sendKeyEvent(key: 0x61, down: false)
        try await bridge.sendMouseEvent(x: 1, y: 1)
        let sync = VNCBridge.modifierKeysyms.map { wire($0, false) }
        XCTAssertEqual(Set(VNCBridge.modifierKeysyms).count, 10)
        XCTAssertEqual(keys.values, ["up 0xFFE1"] + sync + ["down 0x61", "up 0x61"])
        XCTAssertEqual(native.observedInputWrites.last, "pointer")
        // A new connection generation syncs again before its first input.
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        try await bridge.connect()
        try await bridge.sendMouseEvent(x: 1, y: 1)
        XCTAssertEqual(keys.values, ["up 0xFFE1"] + sync + ["down 0x61", "up 0x61"] + sync)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.live, 0)
    }

    func testWireKeysymMapsAppleCommandAndOptionOnly() {
        // Alt_L/R -> Meta_L/R (Option); Meta_L/R -> Super_L/R (Command).
        let apple: [(UInt32, UInt32)] = [
            (0xFFE9, 0xFFE7), (0xFFEA, 0xFFE8), (0xFFE7, 0xFFEB), (0xFFE8, 0xFFEC),
            (0xFFEB, 0xFFEB), (0xFFEC, 0xFFEC), (0xFFE1, 0xFFE1), (0xFFE3, 0xFFE3), (0x6E, 0x6E),
        ]
        for (named, wire) in apple {
            XCTAssertEqual(VNCBridge.wireKeysym(named, appleServer: true), wire)
            XCTAssertEqual(VNCBridge.wireKeysym(named, appleServer: false), named)
        }
    }

    func testFailedRetriesContinueAndRecoverWithBoundedBackoff() async throws {
        let native = FakeNative(outcomes: [true, false, false, true])
        let clock = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        try await bridge.connect()
        XCTAssertEqual(clock.delays, [0])
        clock.runNext() // actual message-loop loss
        XCTAssertEqual(clock.delays, [2])
        clock.runNext() // first failed native initialization
        XCTAssertEqual(clock.delays, [4])
        clock.runNext() // second failure must still schedule a retry
        XCTAssertEqual(clock.delays, [6])
        clock.runNext()
        XCTAssertTrue(bridge.connectionState.isConnected)
        XCTAssertEqual(bridge.framebufferWidth, 2)
        XCTAssertEqual(clock.delays, [0])
        XCTAssertEqual(native.counts.allocations, 4)
        XCTAssertEqual(native.counts.failed, 2)
        XCTAssertEqual(native.counts.peak, 1)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.releases, 4)
        XCTAssertEqual(native.counts.duplicate, 0)
        XCTAssertEqual(native.bufferCounts.live, 0)
        XCTAssertEqual(native.bufferCounts.allocated, native.bufferCounts.released)
        XCTAssertEqual(native.bufferCounts.duplicate, 0)
    }

    func testExhaustionCleansClientAndDoesNotScheduleAnotherAttempt() async throws {
        var config = VNCConfiguration(); config.maxReconnectAttempts = 2
        let native = FakeNative(outcomes: [true, false, false]); let clock = ManualScheduler()
        let bridge = VNCBridge(config: config, operations: native.operations, schedule: clock.schedule)
        try await bridge.connect()
        clock.runNext(); clock.runNext(); clock.runNext()
        XCTAssertEqual(clock.delays, [])
        XCTAssertEqual(bridge.connectionState.description, "disconnected")
        XCTAssertEqual(native.counts.allocations, 3)
        XCTAssertEqual(native.counts.live, 0)
        XCTAssertEqual(native.counts.duplicate, 0)
    }

    func testDisabledReconnectStillReleasesLostClient() async throws {
        var config = VNCConfiguration(); config.autoReconnect = false
        let native = FakeNative(); let clock = ManualScheduler()
        let bridge = VNCBridge(config: config, operations: native.operations, schedule: clock.schedule)
        try await bridge.connect(); clock.runNext()
        XCTAssertEqual(clock.delays, [])
        XCTAssertEqual(native.counts.releases, 1)
        XCTAssertEqual(native.counts.live, 0)
    }

    func testExplicitDisconnectCancelsBackoffAndStaleWorkCannotDestroyNewSession() async throws {
        let native = FakeNative(); let clock = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        try await bridge.connect(); clock.runNext()
        let stale = clock.take()
        XCTAssertEqual(stale.delay, 2)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        try await bridge.connect()
        stale.queue.sync { stale.work.perform() }
        XCTAssertEqual(native.counts.allocations, 2)
        XCTAssertEqual(native.counts.live, 1)
        XCTAssertEqual(native.counts.peak, 1)
        XCTAssertTrue(bridge.connectionState.isConnected)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.releases, 2)
        XCTAssertEqual(native.counts.duplicate, 0)
    }

    func testOverlappingConnectIsRefusedBeforeSecondNativeAllocation() async throws {
        let native = FakeNative(); let clock = ManualScheduler()
        let entered = expectation(description: "owned init entered")
        let release = DispatchSemaphore(value: 0)
        native.beforeInitialize = { entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        let first = Task { try await bridge.connect() }
        await fulfillment(of: [entered], timeout: 3)
        do { try await bridge.connect(); XCTFail("overlapping connect accepted") }
        catch VNCError.alreadyConnected {} catch { XCTFail("unexpected error") }
        XCTAssertEqual(native.counts.allocations, 1)
        release.signal(); try await first.value
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.releases, 1)
    }

    func testConnectCancellationWaitsForNativeOwnershipAndDoesNotReconnect() async throws {
        let native = FakeNative(); let clock = ManualScheduler()
        let entered = expectation(description: "owned init entered")
        let release = DispatchSemaphore(value: 0)
        native.beforeInitialize = { entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        let connecting = Task { try await bridge.connect() }
        await fulfillment(of: [entered], timeout: 3)
        connecting.cancel()
        XCTAssertEqual(native.counts.releases, 0) // native init still owns the pointer
        release.signal()
        do { try await connecting.value; XCTFail("cancelled connect succeeded") }
        catch is CancellationError {} catch { XCTFail("unexpected error") }
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(clock.delays, [])
        XCTAssertEqual(native.counts.releases, 1)
        XCTAssertEqual(native.counts.duplicate, 0)
    }

    func testDisconnectDuringNativeFailureDoesNotDoubleCleanup() async throws {
        let native = FakeNative(outcomes: [false]); let clock = ManualScheduler()
        let entered = expectation(description: "owned failing init entered")
        let release = DispatchSemaphore(value: 0)
        native.beforeInitialize = { entered.fulfill(); XCTAssertEqual(release.wait(timeout: .now() + 5), .success) }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        let connecting = Task { try await bridge.connect() }
        await fulfillment(of: [entered], timeout: 3)
        bridge.disconnect(); release.signal()
        do { try await connecting.value; XCTFail("disconnected connect succeeded") }
        catch is CancellationError {} catch { XCTFail("unexpected error") }
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.failed, 1)
        XCTAssertEqual(native.counts.releases, 1)
        XCTAssertEqual(native.counts.duplicate, 0)
        XCTAssertEqual(clock.delays, [])
    }

    func testFramebufferReadOwnsStorageUntilClosureReturns() async throws {
        let native = FakeNative(); let clock = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        try await bridge.connect()
        let entered = expectation(description: "framebuffer reader owns storage")
        let release = DispatchSemaphore(value: 0)
        let reading = Task.detached {
            bridge.withFramebuffer { buffer, width, height -> Int in
                XCTAssertEqual(width, 2); XCTAssertEqual(height, 2)
                entered.fulfill()
                XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
                return buffer.count
            }
        }
        await fulfillment(of: [entered], timeout: 3)
        bridge.disconnect()
        XCTAssertEqual(native.counts.releases, 0)
        release.signal()
        let size = await reading.value
        XCTAssertEqual(size, 16)
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.releases, 1)
    }

    func testCallbackCanReadFramebufferAndRequestDisconnectWithoutQueueDeadlock() async throws {
        let native = FakeNative(); let clock = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        let callback = expectation(description: "connected callback reenters reader")
        bridge.onStateChange = { [weak bridge] state in
            guard state.isConnected, let bridge else { return }
            XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
            bridge.disconnect()
            callback.fulfill()
        }
        do { try await bridge.connect(); XCTFail("callback-disconnected connect succeeded") }
        catch is CancellationError {} catch { XCTFail("unexpected error") }
        await fulfillment(of: [callback], timeout: 3)
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.releases, 1)
        XCTAssertEqual(native.counts.duplicate, 0)
    }

    func testFailedInitializationAfterFramebufferAllocationReleasesBothOwnersOnce() async throws {
        let native = FakeNative(outcomes: [false]); native.allocateBeforeFailure = true
        let clock = ManualScheduler()
        let events = RecordedEvents()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        bridge.onStateChange = { events.append($0.isConnected ? "connected" : $0.description) }
        native.afterFramebufferAllocation = { [weak bridge] in
            XCTAssertFalse(bridge?.connectionState.isConnected ?? true)
            XCTAssertEqual(bridge?.framebufferWidth, 0)
            events.append("allocated-during-handshake")
        }
        do { try await bridge.connect(); XCTFail("failed initialization accepted") }
        catch VNCError.connectionFailed(_) {} catch { XCTFail("unexpected error") }
        XCTAssertEqual(events.values, ["connecting", "allocated-during-handshake",
                                      "error: Connection refused or handshake failed"])
        XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.failed, 1)
        XCTAssertEqual(native.counts.releases, 1)
        XCTAssertEqual(native.counts.duplicate, 0)
        XCTAssertEqual(native.bufferCounts.allocated, 1)
        XCTAssertEqual(native.bufferCounts.released, 1)
        XCTAssertEqual(native.bufferCounts.duplicate, 0)
        XCTAssertEqual(clock.delays, [])
    }

    func testConnectedEventRequiresCompletedInitialization() async throws {
        let native = FakeNative(); let clock = ManualScheduler(); let events = RecordedEvents()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        bridge.onStateChange = { events.append($0.isConnected ? "connected" : $0.description) }
        native.afterFramebufferAllocation = { [weak bridge] in
            XCTAssertFalse(bridge?.connectionState.isConnected ?? true)
            XCTAssertEqual(bridge?.framebufferWidth, 0)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            events.append("allocated-during-handshake")
        }
        try await bridge.connect()
        XCTAssertEqual(events.values, ["connecting", "allocated-during-handshake", "connected"])
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.allocated, native.bufferCounts.released)
    }

    func testOversizedResizeRefusesBeforeAllocationOrClearingExistingBuffer() async throws {
        let native = FakeNative(polls: [true]); let clock = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        try await bridge.connect()
        native.beforePoll = { [weak native] client in
            guard let native, let original = client.pointee.frameBuffer else {
                XCTFail("expected owned initialized framebuffer"); return
            }
            let width = client.pointee.width; let height = client.pointee.height
            defer { client.pointee.width = width; client.pointee.height = height }
            let before = native.bufferCounts
            let requests = native.observedAllocationRequests
            original[0] = 0xA5
            // 512 MiB at 32 bpp: valid integer arithmetic, above the fixed cap.
            client.pointee.width = 16_384; client.pointee.height = 8192
            XCTAssertEqual(vncMallocFrameBuffer(client), 0)
            XCTAssertEqual(client.pointee.frameBuffer, original)
            XCTAssertEqual(native.observedAllocationRequests, requests)
            XCTAssertEqual(native.bufferCounts.allocated, before.allocated)
            XCTAssertEqual(native.bufferCounts.released, before.released)
            // Read only if ownership survived, so a failing guard fixture does
            // not itself dereference a buffer the candidate already released.
            if client.pointee.frameBuffer == original, native.bufferCounts.released == before.released {
                XCTAssertEqual(original[0], 0xA5)
            }
        }
        clock.runNext(); native.beforePoll = nil
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer[0] }, 0xA5)
        XCTAssertEqual(native.observedAllocationRequests, [16])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.allocated, native.bufferCounts.released)
        XCTAssertEqual(native.bufferCounts.duplicate, 0)
    }

    func testAllocatedFramebufferCannotBeReadUntilCompleteUpdate() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "first-frame wait registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        XCTAssertTrue(bridge.connectionState.isConnected)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        let events = RecordedEvents()
        let waiting = Task { try await bridge.waitForFramebuffer(); events.append("ready") }
        await fulfillment(of: [registered], timeout: 3)
        XCTAssertEqual(events.values, [])
        XCTAssertEqual(deadline.delays, [5])
        native.beforePoll = { [weak bridge] client in
            client.pointee.frameBuffer?[0] = 0x5A
            vncGotFrameBufferUpdate(client, 0, 0, 2, 2)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await waiting.value
        XCTAssertEqual(events.values, ["ready"])
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer[0] }, 0x5A)
        deadline.runNext() // stale timeout must not resume the continuation twice
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.live, 0)
    }

    func testCompletedBlackFrameIsValidWithoutPixelColorHeuristic() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        native.beforePoll = { client in
            memset(client.pointee.frameBuffer, 0, 16) // real decoded black pixels
            completePixelUpdate(client)
        }
        clock.runNext()
        try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.allSatisfy { $0 == 0 } }, true)
        XCTAssertEqual(deadline.delays, [])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testPartialInitialUpdatesOverlapAndHolesCannotAdmitOrRenewDeadline() async throws {
        let native = FakeNative(polls: [true, true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "partial initial screen retains original deadline")
        deadline.onSchedule = { registered.fulfill() }
        var config = VNCConfiguration()
        config.host = "fixture-private-host.invalid"
        config.username = "fixture-private-user"
        config.password = "fixture-private-password"
        let bridge = VNCBridge(config: config, operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let waiting = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        native.beforePoll = { [weak bridge] client in
            // Neither pixels nor configured connection secrets belong in a
            // coverage/control-flow diagnostic.
            _ = Array("PIXEL_PRIVATE".utf8).withUnsafeBytes { bytes in
                memcpy(client.pointee.frameBuffer!, bytes.baseAddress!, bytes.count)
            }
            // Summed area exceeds the screen; the bottom-right pixel is still
            // absent. Completion of each message cannot bless that hole.
            let rectangles: [(Int32, Int32, Int32, Int32)] =
                [(0, 0, 2, 1), (0, 0, 2, 1), (0, 0, 1, 2)]
            for (x, y, w, h) in rectangles {
                vncGotFrameBufferUpdate(client, x, y, w, h)
                vncFinishedFrameBufferUpdate(client)
                XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            }
        }
        clock.runNext()
        let partial = bridge.framebufferDiagnostics
        XCTAssertEqual(partial.connectionGeneration, 1)
        XCTAssertEqual(partial.allocations, 1)
        XCTAssertEqual(partial.width, 2)
        XCTAssertEqual(partial.height, 2)
        XCTAssertEqual(partial.pixelsRemaining, 1)
        XCTAssertEqual(partial.rectangles, 3)
        XCTAssertEqual(partial.finishedUpdates, 3)
        XCTAssertEqual(partial.copyRectangles, 0)
        XCTAssertEqual(partial.rejectedRectangles, 0)
        XCTAssertEqual(partial.skippedCopyRectangles, 0)
        XCTAssertFalse(partial.complete)
        XCTAssertNotNil(partial.lastCallbackAgeMilliseconds)
        XCTAssertEqual(deadline.delays, [5])
        deadline.runNext()
        do { try await waiting.value; XCTFail("partial screen admitted") }
        catch VNCError.sendFailed(let reason) {
            let diagnostic = try timeoutDiagnostics(reason)
            XCTAssertEqual(diagnostic["pixels_remaining"] as? Int, 1)
            XCTAssertEqual(diagnostic["rectangles"] as? Int, 3)
            XCTAssertEqual(diagnostic["finished_updates"] as? Int, 3)
            XCTAssertEqual(diagnostic["complete"] as? Bool, false)
            for privateValue in [config.host, config.username!, config.password!, "PIXEL_PRIVATE"] {
                XCTAssertFalse(reason.contains(privateValue))
            }
        } catch { XCTFail("unexpected error") }
        native.beforePoll = { [weak bridge] client in
            vncGotFrameBufferUpdate(client, 1, 1, 1, 1)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        XCTAssertEqual(bridge.framebufferDiagnostics.pixelsRemaining, 0)
        XCTAssertTrue(bridge.framebufferDiagnostics.complete)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.live, 0)
    }

    func testCoverageAcrossWordAndRowBoundariesRequiresLastPixel() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let bridge = VNCBridge(operations: native.operations,
                                                              schedule: clock.schedule)
        try await bridge.connect()
        native.beforePoll = { [weak bridge] client in
            client.pointee.width = 67; client.pointee.height = 2
            XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
            // A 67-pixel stride exercises both word boundaries and a partial
            // final word. Duplicate top-right coverage cannot fill bottom-right.
            let rectangles: [(Int32, Int32, Int32, Int32)] =
                [(0, 0, 64, 2), (64, 0, 3, 1), (64, 0, 3, 1), (64, 1, 2, 1)]
            for (x, y, w, h) in rectangles {
                vncGotFrameBufferUpdate(client, x, y, w, h)
                vncFinishedFrameBufferUpdate(client)
                XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            }
            vncGotFrameBufferUpdate(client, 66, 1, 1, 1)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, width, height in
            XCTAssertEqual(width, 67); XCTAssertEqual(height, 2); return buffer.count
        }, 536)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.allocated, native.bufferCounts.released)
    }

    func testResizeDiscardsPartialCoverageEvenWhenDimensionsStayEqual() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let bridge = VNCBridge(operations: native.operations,
                                                              schedule: clock.schedule)
        try await bridge.connect()
        let generation = bridge.framebufferDiagnostics.connectionGeneration
        native.beforePoll = { [weak bridge] client in
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
            if let diagnostic = bridge?.framebufferDiagnostics {
                XCTAssertEqual(diagnostic.connectionGeneration, generation)
                XCTAssertEqual(diagnostic.allocations, 2)
                XCTAssertEqual(diagnostic.pixelsRemaining, 4)
                XCTAssertEqual(diagnostic.rectangles, 0)
                XCTAssertEqual(diagnostic.finishedUpdates, 0)
                XCTAssertFalse(diagnostic.complete)
            }
            vncGotFrameBufferUpdate(client, 0, 1, 2, 1)
            vncFinishedFrameBufferUpdate(client)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        XCTAssertEqual(bridge.framebufferDiagnostics.rectangles, 2)
        XCTAssertEqual(bridge.framebufferDiagnostics.finishedUpdates, 2)
        XCTAssertEqual(bridge.framebufferDiagnostics.pixelsRemaining, 0)
        XCTAssertTrue(bridge.framebufferDiagnostics.complete)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.allocated, 2)
        XCTAssertEqual(native.bufferCounts.released, 2)
    }

    func testInitializedFramebufferStillAcceptsSmallIncrementalUpdates() async throws {
        let native = FakeNative(polls: [true]); let clock = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule)
        try await bridge.connect(); try await bridge.waitForFramebuffer()
        native.beforePoll = { client in
            client.pointee.frameBuffer?[12] = 0x7F
            vncGotFrameBufferUpdate(client, 1, 1, 1, 1)
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer[12] }, 0x7F)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.live, 0)
    }

    func testCopyRectPropagatesUnknownAndReceivedPixelsWithoutInventingCoverage() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let bridge = VNCBridge(operations: native.operations,
                                                              schedule: clock.schedule)
        try await bridge.connect()
        native.beforePoll = { [weak bridge] client in
            client.pointee.frameBuffer?[0] = 0x6A
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
            // Copy unreceived bottom pixels over the received top row. The
            // subsequent generic callback must not mark that row as received.
            vncGotCopyRect(client, 0, 1, 2, 1, 0, 0)
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            client.pointee.frameBuffer?[8] = 0x4B
            vncGotFrameBufferUpdate(client, 0, 1, 2, 1)
            vncFinishedFrameBufferUpdate(client)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncGotCopyRect(client, 0, 1, 2, 1, 0, 0)
            vncGotFrameBufferUpdate(client, 0, 0, 2, 1)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer[0] }, 0x4B)
        XCTAssertEqual(bridge.framebufferDiagnostics.copyRectangles, 2)
        XCTAssertEqual(bridge.framebufferDiagnostics.skippedCopyRectangles, 2)
        XCTAssertEqual(bridge.framebufferDiagnostics.rectangles, 4)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.live, 0)
    }

    func testOverlappingCopyRectCannotSpreadOneKnownPixelAcrossUnknownSource() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let bridge = VNCBridge(operations: native.operations,
                                                              schedule: clock.schedule)
        try await bridge.connect()
        native.beforePoll = { [weak bridge] client in
            client.pointee.width = 4; client.pointee.height = 1
            XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
            vncGotFrameBufferUpdate(client, 0, 0, 1, 1)
            vncFinishedFrameBufferUpdate(client)
            // memmove order: only positions 0 and 1 can become valid. A
            // left-to-right validity copy would incorrectly fill all four.
            vncGotCopyRect(client, 0, 0, 3, 1, 1, 0)
            vncGotFrameBufferUpdate(client, 1, 0, 3, 1)
            vncFinishedFrameBufferUpdate(client)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            vncGotFrameBufferUpdate(client, 2, 0, 2, 1)
            vncFinishedFrameBufferUpdate(client)
        }
        clock.runNext(); try await bridge.waitForFramebuffer()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.allocated, native.bufferCounts.released)
    }

    func testEmptyOrMetadataOnlyCompletionDoesNotAdmitUntouchedPixels() async throws {
        let native = FakeNative(polls: [true, true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "reader waits through metadata-only messages")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let events = RecordedEvents()
        let waiting = Task { try await bridge.waitForFramebuffer(); events.append("ready") }
        await fulfillment(of: [registered], timeout: 3)
        native.beforePoll = { [weak bridge] client in
            // 0.9.15 sends only Finished for empty and cursor pseudo-rectangles.
            vncFinishedFrameBufferUpdate(client)
            XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            let invalidRectangles: [(Int32, Int32, Int32, Int32)] =
                [(0, 0, 0, 2), (0, 0, 2, 0), (-1, 0, 1, 1), (0, -1, 1, 1),
                 (1, 0, 2, 2), (0, 1, 2, 2), (0, 0, .max, .max)]
            for (x, y, width, height) in invalidRectangles {
                vncGotFrameBufferUpdate(client, x, y, width, height)
                vncFinishedFrameBufferUpdate(client)
                XCTAssertNil(bridge?.withFramebuffer { buffer, _, _ in buffer.count })
            }
        }
        clock.runNext()
        XCTAssertEqual(events.values, [])
        XCTAssertEqual(bridge.framebufferDiagnostics.rejectedRectangles, 7)
        XCTAssertEqual(bridge.framebufferDiagnostics.rectangles, 7)
        XCTAssertEqual(bridge.framebufferDiagnostics.finishedUpdates, 8)
        XCTAssertEqual(bridge.framebufferDiagnostics.pixelsRemaining, 4)
        XCTAssertEqual(deadline.delays, [5]) // metadata never renews the deadline
        native.beforePoll = { completePixelUpdate($0) }
        clock.runNext(); try await waiting.value
        deadline.runNext()
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testFirstFrameDeadlineCompletesWhileNativeReadIsOccupied() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "first-frame deadline registered")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let waiting = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        let entered = expectation(description: "owned native read occupied")
        let release = DispatchSemaphore(value: 0)
        native.beforePoll = { _ in
            entered.fulfill()
            XCTAssertEqual(release.wait(timeout: .now() + 5), .success)
        }
        let polling = Task.detached { clock.runNext() }
        await fulfillment(of: [entered], timeout: 3)
        let snapshotFinished = expectation(description: "diagnostic snapshot bypasses occupied native queue")
        let snapshot = Task.detached {
            let value = bridge.framebufferDiagnostics
            snapshotFinished.fulfill()
            return value
        }
        let timeoutFinished = expectation(description: "diagnostic timeout bypasses occupied native queue")
        let timeout = Task { () -> String? in
            defer { timeoutFinished.fulfill() }
            do { try await waiting.value; XCTFail("missing update accepted") }
            catch VNCError.sendFailed(let reason) { return reason }
            catch { XCTFail("unexpected error") }
            return nil
        }
        let firing = Task.detached { deadline.runNext() }
        // A regression may fail these expectations, but releasing the owned
        // barrier still lets all test tasks unwind instead of hanging XCTest.
        await fulfillment(of: [snapshotFinished, timeoutFinished], timeout: 2)
        release.signal(); await polling.value
        await firing.value
        let occupied = await snapshot.value
        XCTAssertEqual(occupied.phase, .handlingServerMessage)
        XCTAssertEqual(occupied.allocations, 1)
        XCTAssertEqual(occupied.pixelsRemaining, 4)
        XCTAssertEqual(occupied.rectangles, 0)
        XCTAssertEqual(occupied.finishedUpdates, 0)
        XCTAssertFalse(occupied.complete)
        let reason = await timeout.value
        let diagnostic = try timeoutDiagnostics(try XCTUnwrap(reason))
        XCTAssertEqual(diagnostic["phase"] as? String, "handlingServerMessage")
        XCTAssertEqual(diagnostic["pixels_remaining"] as? Int, 4)
        XCTAssertEqual(diagnostic["rectangles"] as? Int, 0)
        XCTAssertEqual(diagnostic["finished_updates"] as? Int, 0)
        XCTAssertEqual(diagnostic["complete"] as? Bool, false)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        // A timeout neither invents a frame nor disables a later real update.
        native.beforePoll = { completePixelUpdate($0) }
        clock.runNext(); try await bridge.waitForFramebuffer()
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testCancellingOneFrameWaitDoesNotCancelAnotherReader() async throws {
        let native = FakeNative(polls: [true]); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "two independent readers registered")
        registered.expectedFulfillmentCount = 2
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let cancelled = Task { try await bridge.waitForFramebuffer() }
        let remaining = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        cancelled.cancel()
        do { try await cancelled.value; XCTFail("cancelled reader accepted") }
        catch is CancellationError {} catch { XCTFail("unexpected error") }
        native.beforePoll = { completePixelUpdate($0) }
        clock.runNext(); try await remaining.value
        deadline.runNext(); deadline.runNext()
        XCTAssertEqual(bridge.withFramebuffer { buffer, _, _ in buffer.count }, 16)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testAlreadyCancelledFrameWaitCannotRegisterOrSucceed() async throws {
        let native = FakeNative(); let clock = ManualScheduler(); let deadline = ManualScheduler()
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            try await bridge.waitForFramebuffer()
        }
        do { try await cancelled.value; XCTFail("already-cancelled reader accepted") }
        catch is CancellationError {} catch { XCTFail("unexpected error") }
        XCTAssertEqual(deadline.delays, [])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
    }

    func testDisconnectRefusesPendingFirstFrameAndReleasesOwnership() async throws {
        let native = FakeNative(); native.completeDuringInitialize = false
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "reader registered before disconnect")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect()
        let waiting = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        do { try await waiting.value; XCTFail("disconnected reader accepted") }
        catch VNCError.notConnected {} catch { XCTFail("unexpected error") }
        deadline.runNext()
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        XCTAssertEqual(native.counts.live, 0)
        XCTAssertEqual(native.bufferCounts.live, 0)
        XCTAssertEqual(native.bufferCounts.duplicate, 0)
    }

    func testReconnectRequiresItsOwnCompletedFramebufferUpdate() async throws {
        let native = FakeNative(polls: [false, true])
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "new connection waits for its own frame")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect(); try await bridge.waitForFramebuffer()
        let original = bridge.framebufferDiagnostics
        XCTAssertEqual(native.observedFullUpdates, 0)
        XCTAssertTrue(original.complete)
        XCTAssertEqual(original.rectangles, 1)
        native.completeDuringInitialize = false
        clock.runNext() // loss of the previously complete frame
        do { try await bridge.waitForFramebuffer(); XCTFail("lost connection accepted") }
        catch VNCError.notConnected {} catch { XCTFail("unexpected error") }
        clock.runNext() // successful reconnect, only allocated so far
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertTrue(bridge.connectionState.isConnected)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        let reconnected = bridge.framebufferDiagnostics
        XCTAssertEqual(reconnected.connectionGeneration, original.connectionGeneration + 1)
        XCTAssertEqual(reconnected.allocations, 1)
        XCTAssertEqual(reconnected.width, 2)
        XCTAssertEqual(reconnected.height, 2)
        XCTAssertEqual(reconnected.pixelsRemaining, 4)
        XCTAssertEqual(reconnected.rectangles, 0)
        XCTAssertEqual(reconnected.copyRectangles, 0)
        XCTAssertEqual(reconnected.finishedUpdates, 0)
        XCTAssertEqual(reconnected.rejectedRectangles, 0)
        XCTAssertEqual(reconnected.skippedCopyRectangles, 0)
        XCTAssertFalse(reconnected.complete)
        let waiting = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        native.beforePoll = { completePixelUpdate($0) }
        clock.runNext(); try await waiting.value
        XCTAssertEqual(bridge.framebufferDiagnostics.connectionGeneration, reconnected.connectionGeneration)
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertEqual(bridge.framebufferDiagnostics.rectangles, 1)
        XCTAssertEqual(bridge.framebufferDiagnostics.finishedUpdates, 1)
        XCTAssertEqual(bridge.framebufferDiagnostics.pixelsRemaining, 0)
        XCTAssertTrue(bridge.framebufferDiagnostics.complete)
        deadline.runNext()
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.peak, 1)
        XCTAssertEqual(native.bufferCounts.allocated, native.bufferCounts.released)
    }

    func testResizeInvalidatesReadinessUntilNewSizeCompletes() async throws {
        let native = FakeNative(polls: [true, true])
        let clock = ManualScheduler(); let deadline = ManualScheduler()
        let registered = expectation(description: "resized buffer waits for complete update")
        deadline.onSchedule = { registered.fulfill() }
        let bridge = VNCBridge(operations: native.operations, schedule: clock.schedule,
                               scheduleFrameDeadline: deadline.schedule)
        try await bridge.connect(); try await bridge.waitForFramebuffer()
        native.beforePoll = { client in
            client.pointee.width = 3; client.pointee.height = 3
            XCTAssertNotEqual(vncMallocFrameBuffer(client), 0)
        }
        clock.runNext()
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        let resized = bridge.framebufferDiagnostics
        XCTAssertEqual(native.observedFullUpdates, 1)
        XCTAssertEqual(resized.allocations, 2)
        XCTAssertEqual(resized.width, 3)
        XCTAssertEqual(resized.height, 3)
        XCTAssertEqual(resized.pixelsRemaining, 9)
        XCTAssertEqual(resized.rectangles, 0)
        XCTAssertEqual(resized.finishedUpdates, 0)
        XCTAssertFalse(resized.complete)
        let waiting = Task { try await bridge.waitForFramebuffer() }
        await fulfillment(of: [registered], timeout: 3)
        native.beforePoll = { completePixelUpdate($0) }
        clock.runNext(); try await waiting.value
        XCTAssertEqual(bridge.withFramebuffer { buffer, width, height in
            XCTAssertEqual(width, 3); XCTAssertEqual(height, 3)
            return buffer.count
        }, 36)
        // The owned allocator refuses this 1156-byte request before malloc.
        // Diagnostics must describe the failed new attempt, not the old frame.
        native.beforePoll = { client in
            client.pointee.width = 17; client.pointee.height = 17
            XCTAssertEqual(vncMallocFrameBuffer(client), 0)
        }
        clock.runNext()
        let refused = bridge.framebufferDiagnostics
        XCTAssertEqual(refused.allocations, 3)
        XCTAssertEqual(refused.width, 17)
        XCTAssertEqual(refused.height, 17)
        XCTAssertEqual(refused.pixelsRemaining, 289)
        XCTAssertEqual(refused.rectangles, 0)
        XCTAssertEqual(refused.copyRectangles, 0)
        XCTAssertEqual(refused.finishedUpdates, 0)
        XCTAssertEqual(refused.rejectedRectangles, 0)
        XCTAssertEqual(refused.skippedCopyRectangles, 0)
        XCTAssertFalse(refused.complete)
        XCTAssertNil(bridge.withFramebuffer { buffer, _, _ in buffer.count })
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.bufferCounts.allocated, 2)
        XCTAssertEqual(native.bufferCounts.released, 2)
        XCTAssertEqual(native.bufferCounts.duplicate, 0)
    }

    func testNativeTimeoutAndRetryDelayBoundsAreAppliedToActualOperations() async throws {
        var config = VNCConfiguration(); config.connectTimeout = 1000; config.reconnectDelay = .infinity
        config.messageLoopInterval = .max
        let native = FakeNative(); let clock = ManualScheduler()
        let bridge = VNCBridge(config: config, operations: native.operations, schedule: clock.schedule)
        try await bridge.connect()
        XCTAssertEqual(native.observedTimeouts[0].0, 30)
        XCTAssertEqual(native.observedTimeouts[0].1, 30)
        clock.runNext(); XCTAssertEqual(clock.delays, [2])
        XCTAssertEqual(native.observedPollIntervals, [250_000])
        bridge.disconnect(); XCTAssertEqual(bridge.framebufferWidth, 0)
        XCTAssertEqual(native.counts.live, 0)
    }
}
