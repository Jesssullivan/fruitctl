import Foundation
import os
import CLibVNCClient

/// Swift bridge over LibVNCClient (C). Manages a persistent VNC connection
/// with queue-scoped zero-copy framebuffer readers.
final class VNCBridge: @unchecked Sendable {

    /// Fixed allocation ceiling: 256 MiB accommodates an 8K 32-bit desktop
    /// (7680 × 4320 × 4 bytes) without trusting server dimensions as a budget.
    static let maximumFramebufferBytes = 256 * 1024 * 1024

    // MARK: Public Properties

    var verbose = false
    /// Whether the VNC server is macOS Apple VNC (detected from RFB version 003.889 or --macos flag)
    var isMacOS: Bool = false
    var onStateChange: ((VNCConnectionState) -> Void)?

    // MARK: Internal Properties (accessed by VNCCallbacks)

    let config: VNCConfiguration
    private let frameStreamStorage = OSAllocatedUnfairLock<AsyncStream<Void>.Continuation?>(initialState: nil)
    var framebufferUpdateContinuation: AsyncStream<Void>.Continuation? {
        get { frameStreamStorage.withLock { $0 } }
        set { frameStreamStorage.withLock { $0 = newValue } }
    }

    // MARK: Private Properties

    private var client: UnsafeMutablePointer<rfbClient>?
    // Buffer allocation can precede a failed native handshake. Only a successful
    // initialize call makes the client available to readers, input and observers.
    private var clientReady = false
    // One bit per pixel, bounded by the checked framebuffer allocation (at
    // most 32 MiB even for one-byte pixels). Discarded after initial coverage.
    // A rectangle count or summed area cannot detect overlap and holes.
    private var initialFramebufferCoverage: [UInt64] = []
    private var framebufferPixelsRemaining = 0
    private var nativeCopyRectangle: GotCopyRectProc?
    private var copyRectanglePending = false
    private var framebufferHasUpdate = false
    private var ownedFramebuffer: UnsafeMutablePointer<UInt8>?
    private var ownedFramebufferBytes = 0
    private final class FrameWaiter {
        let id = UUID()
        var continuation: CheckedContinuation<Void, Error>?
        var cancelled = false
        var deadline: DispatchWorkItem?
    }
    private struct FrameReadiness {
        var available = false
        var complete = false
        var waiters: [UUID: FrameWaiter] = [:]
    }
    private let frameReadiness = OSAllocatedUnfairLock(initialState: FrameReadiness())
    /// An owned copy, made on the native queue after fresh admission. Encoding
    /// it cannot race a later disconnect, reconnect or framebuffer allocation.
    struct FrameCapture {
        let pixels: Data
        let width: Int
        let height: Int
        let connectionGeneration: Int
        let allocation: Int
        var inputContext: VNCInputContext {
            VNCInputContext(width: width, height: height,
                            connectionGeneration: connectionGeneration, allocation: allocation)
        }
        func withFramebuffer<T>(_ body: (UnsafeRawBufferPointer, Int, Int) -> T) -> T {
            pixels.withUnsafeBytes { body($0, width, height) }
        }
    }
    private final class FreshFrameWaiter {
        let session: UUID?
        var continuation: CheckedContinuation<FrameCapture, Error>?
        var deadline: DispatchWorkItem?
        var cancelled = false
        // Remaining fields are touched only on messageQueue.
        var requestStarted = false
        var generation = 0
        var allocation = 0
        var width = 0
        var height = 0
        var bytesPerPixel = 0
        var byteCount = 0
        var coverage: [UInt64] = []
        var pixelsRemaining = 0
        var copyRectanglePending = false
        init(session: UUID?) { self.session = session }
    }
    // Single flight bounds additional coverage storage to one allocation.
    private let freshFrameWaiter = OSAllocatedUnfairLock<FreshFrameWaiter?>(initialState: nil)
    private struct FrameDiagnosticsState {
        var snapshot = VNCFramebufferDiagnostics()
        var lastCallbackNs: UInt64?
    }
    private let frameDiagnostics = OSAllocatedUnfairLock(initialState: FrameDiagnosticsState())
    private let stateStorage = OSAllocatedUnfairLock(initialState: VNCConnectionState.disconnected)
    // Desired connection identity is independently cancellable while a bounded
    // native call occupies the queue. Every C client access belongs to the queue.
    private let desiredSession = OSAllocatedUnfairLock<UUID?>(initialState: nil)
    private var clientSession: UUID?
    private var pendingWork: DispatchWorkItem?
    private let queueKey = DispatchSpecificKey<UInt8>()
    private let operations: VNCClientOperations
    private let schedule: VNCWorkScheduler
    private let scheduleFrameDeadline: VNCWorkScheduler
    private let monotonicNanoseconds: () -> UInt64
    private let messageQueue = DispatchQueue(label: "vnc.message-loop", qos: .userInteractive)
    /// Only touched on messageQueue (message loop).
    private var lastUpdateRequestNs: UInt64 = 0
    private var lastFullUpdateRequestNs: UInt64?
    private static let incompleteFrameRefreshIntervalNs: UInt64 = 1_000_000_000
    private var reconnectCount = 0
    private let stateStreamStorage = OSAllocatedUnfairLock<AsyncStream<VNCConnectionState>.Continuation?>(initialState: nil)
    private var stateStreamContinuation: AsyncStream<VNCConnectionState>.Continuation? {
        get { stateStreamStorage.withLock { $0 } }
        set { stateStreamStorage.withLock { $0 = newValue } }
    }

    // MARK: Init / Deinit

    init(config: VNCConfiguration = .init(),
         operations: VNCClientOperations = .native,
         schedule: @escaping VNCWorkScheduler = scheduleVNCWork,
         scheduleFrameDeadline: @escaping VNCWorkScheduler = scheduleVNCWork,
         monotonicNanoseconds: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds }) {
        self.config = config
        self.operations = operations
        self.schedule = schedule
        self.scheduleFrameDeadline = scheduleFrameDeadline
        self.monotonicNanoseconds = monotonicNanoseconds
        messageQueue.setSpecific(key: queueKey, value: 1)
    }

    deinit {
        // A queued native call retains self until it returns; scheduled work
        // uses weak captures. Deinit can therefore only free an idle client.
        onMessageQueue {
            pendingWork?.cancel()
            cleanupClient()
        }
    }

    private func onMessageQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil { return body() }
        return messageQueue.sync(execute: body)
    }

    private func wants(_ session: UUID) -> Bool {
        desiredSession.withLock { $0 == session }
    }

    private var activeClient: UnsafeMutablePointer<rfbClient>? {
        guard clientReady, let session = clientSession, wants(session) else { return nil }
        return client
    }

    private func releaseFramebuffer() {
        refuseFreshCapture(VNCError.sendFailed("Framebuffer allocation changed during fresh capture"))
        lastFullUpdateRequestNs = nil
        initialFramebufferCoverage = []
        framebufferPixelsRemaining = 0
        copyRectanglePending = false
        framebufferHasUpdate = false
        ownedFramebufferBytes = 0
        if let buffer = ownedFramebuffer {
            ownedFramebuffer = nil
            operations.freeFramebuffer(buffer)
        }
    }

    private func cleanupClient() {
        refuseFreshCapture(VNCError.notConnected)
        clientReady = false
        frameDiagnostics.withLock {
            $0.snapshot.phase = .disconnected
            $0.snapshot.complete = false
        }
        publishFrameReadiness(available: false, complete: false)
        if let owned = client {
            client = nil
            owned.pointee.frameBuffer = nil
            releaseFramebuffer()
            operations.cleanup(owned)
        } else {
            releaseFramebuffer()
        }
        nativeCopyRectangle = nil
    }

    /// Only invoked synchronously by the C allocation callback on messageQueue.
    func allocateFramebuffer(for native: UnsafeMutablePointer<rfbClient>) -> rfbBool {
        guard DispatchQueue.getSpecific(key: queueKey) != nil, client == native else { return 0 }
        let width = Int(native.pointee.width)
        let height = Int(native.pointee.height)
        let bpp = Int(native.pointee.format.bitsPerPixel) / 8
        let (pixels, pixelOverflow) = width.multipliedReportingOverflow(by: height)
        let (size, byteOverflow) = pixels.multipliedReportingOverflow(by: bpp)
        // Refuse before freeing/clearing the current buffer or invoking an
        // allocator. Checked arithmetic alone is not a finite resource bound.
        guard width > 0, height > 0, bpp > 0, !pixelOverflow, !byteOverflow,
              size <= Self.maximumFramebufferBytes else { return 0 }
        native.pointee.frameBuffer = nil
        releaseFramebuffer()
        // Publish the accepted allocation attempt before allocator/zeroing can
        // block or fail. Never retain an old complete frame in deadline evidence.
        frameDiagnostics.withLock { state in
            let previous = state.snapshot
            state.snapshot = VNCFramebufferDiagnostics()
            state.snapshot.connectionGeneration = previous.connectionGeneration
            state.snapshot.allocations = previous.allocations &+ 1
            state.snapshot.phase = previous.phase
            state.snapshot.width = width
            state.snapshot.height = height
            state.snapshot.pixelsRemaining = pixels
            state.lastCallbackNs = DispatchTime.now().uptimeNanoseconds
        }
        publishFrameReadiness(available: activeClient != nil, complete: false)
        guard let buffer = operations.allocateFramebuffer(size) else { return 0 }
        memset(buffer, 0, size)
        ownedFramebuffer = buffer
        ownedFramebufferBytes = size
        native.pointee.frameBuffer = buffer
        initialFramebufferCoverage = Array(repeating: 0, count: (pixels + 63) / 64)
        framebufferPixelsRemaining = pixels
        if clientReady { updateState(.connected(width: width, height: height)) }
        return -1
    }

    /// LibVNCClient skips this rectangle callback for cursor/size pseudo-encodings.
    /// Never inspect pixel color: an actually received black rectangle is valid.
    func receivedFramebufferRectangle(for native: UnsafeMutablePointer<rfbClient>,
                                      x: Int32, y: Int32, width: Int32, height: Int32) {
        guard DispatchQueue.getSpecific(key: queueKey) != nil, client == native,
              native.pointee.frameBuffer != nil,
              let session = clientSession, wants(session) else { return }
        frameDiagnostics.withLock {
            $0.snapshot.rectangles &+= 1
            $0.lastCallbackNs = DispatchTime.now().uptimeNanoseconds
        }
        defer { frameDiagnostics.withLock { $0.snapshot.pixelsRemaining = framebufferPixelsRemaining } }
        // LibVNCClient emits GotFrameBufferUpdate after GotCopyRect too. The
        // copy callback has already propagated validity from its source region.
        if copyRectanglePending {
            copyRectanglePending = false
            freshFrameWaiter.withLock { $0 }?.copyRectanglePending = false
            frameDiagnostics.withLock { $0.snapshot.skippedCopyRectangles &+= 1 }
            return
        }
        guard x >= 0, y >= 0, width > 0, height > 0,
              Int64(x) + Int64(width) <= Int64(native.pointee.width),
              Int64(y) + Int64(height) <= Int64(native.pointee.height) else {
            frameDiagnostics.withLock { $0.snapshot.rejectedRectangles &+= 1 }
            return
        }
        if let fresh = currentFreshCapture(for: native) {
            if fresh.copyRectanglePending { fresh.copyRectanglePending = false }
            else {
                for row in Int(y)..<(Int(y) + Int(height)) {
                    var offset = row * fresh.width + Int(x)
                    let end = offset + Int(width)
                    while offset < end {
                        let word = offset / 64, bit = offset % 64
                        let count = min(64 - bit, end - offset)
                        let mask = (UInt64.max >> (64 - count)) << bit
                        let unseen = mask & ~fresh.coverage[word]
                        fresh.coverage[word] |= mask
                        fresh.pixelsRemaining -= unseen.nonzeroBitCount
                        offset += count
                    }
                }
            }
        }
        guard !framebufferHasUpdate else { return }
        // Track the union, including rectangles split across update messages.
        // Work is bounded by rectangle area; duplicate rectangles add no bits.
        let stride = Int(native.pointee.width)
        for row in Int(y)..<(Int(y) + Int(height)) {
            var offset = row * stride + Int(x)
            let end = offset + Int(width)
            while offset < end {
                let word = offset / 64
                let bit = offset % 64
                let count = min(64 - bit, end - offset)
                let mask = (UInt64.max >> (64 - count)) << bit
                let unseen = mask & ~initialFramebufferCoverage[word]
                initialFramebufferCoverage[word] |= mask
                framebufferPixelsRemaining -= unseen.nonzeroBitCount
                offset += count
            }
        }
    }

    /// Preserve LibVNCClient's renderer and copy validity in the same overlap
    /// order. CopyRect transmits no pixels: copying an unreceived source cannot
    /// fill a hole, and can invalidate a previously received destination.
    func receivedCopyRectangle(for native: UnsafeMutablePointer<rfbClient>,
                               sourceX: Int32, sourceY: Int32, width: Int32, height: Int32,
                               destinationX: Int32, destinationY: Int32) {
        guard DispatchQueue.getSpecific(key: queueKey) != nil, client == native,
              native.pointee.frameBuffer != nil,
              let session = clientSession, wants(session) else { return }
        frameDiagnostics.withLock {
            $0.snapshot.copyRectangles &+= 1
            $0.lastCallbackNs = DispatchTime.now().uptimeNanoseconds
        }
        defer { frameDiagnostics.withLock { $0.snapshot.pixelsRemaining = framebufferPixelsRemaining } }
        copyRectanglePending = true
        // CopyRect can copy historical pixels. It never supplies fresh pixels.
        freshFrameWaiter.withLock { $0 }?.copyRectanglePending = true
        let stride = Int(native.pointee.width), rows = Int(native.pointee.height)
        guard let render = nativeCopyRectangle,
              sourceX >= 0, sourceY >= 0, destinationX >= 0, destinationY >= 0,
              width > 0, height > 0,
              Int64(sourceX) + Int64(width) <= Int64(stride),
              Int64(destinationX) + Int64(width) <= Int64(stride),
              Int64(sourceY) + Int64(height) <= Int64(rows),
              Int64(destinationY) + Int64(height) <= Int64(rows) else {
            frameDiagnostics.withLock { $0.snapshot.rejectedRectangles &+= 1 }
            return
        }
        render(native, sourceX, sourceY, width, height, destinationX, destinationY)
        if let fresh = currentFreshCapture(for: native) {
            // A copy preserves freshness only when its source was received
            // after this request. Match renderer overlap order, including
            // invalidating a fresh destination copied from historical pixels.
            for rowIndex in 0..<Int(height) {
                let row = destinationY > sourceY ? Int(height) - 1 - rowIndex : rowIndex
                for columnIndex in 0..<Int(width) {
                    let column = destinationX > sourceX ? Int(width) - 1 - columnIndex : columnIndex
                    let source = (Int(sourceY) + row) * stride + Int(sourceX) + column
                    let destination = (Int(destinationY) + row) * stride + Int(destinationX) + column
                    let received = fresh.coverage[source / 64] & (UInt64(1) << (source % 64)) != 0
                    let mask = UInt64(1) << (destination % 64)
                    let wasReceived = fresh.coverage[destination / 64] & mask != 0
                    if received != wasReceived {
                        fresh.coverage[destination / 64] ^= mask
                        fresh.pixelsRemaining += received ? -1 : 1
                    }
                }
            }
        }
        guard !framebufferHasUpdate else { return }
        for rowIndex in 0..<Int(height) {
            let row = destinationY > sourceY ? Int(height) - 1 - rowIndex : rowIndex
            for columnIndex in 0..<Int(width) {
                let column = destinationX > sourceX ? Int(width) - 1 - columnIndex : columnIndex
                let source = (Int(sourceY) + row) * stride + Int(sourceX) + column
                let destination = (Int(destinationY) + row) * stride + Int(destinationX) + column
                let received = initialFramebufferCoverage[source / 64] & (UInt64(1) << (source % 64)) != 0
                let mask = UInt64(1) << (destination % 64)
                let wasReceived = initialFramebufferCoverage[destination / 64] & mask != 0
                if received != wasReceived {
                    initialFramebufferCoverage[destination / 64] ^= mask
                    framebufferPixelsRemaining += received ? -1 : 1
                }
            }
        }
    }

    /// Completion alone also fires for partial, empty or cursor-only messages.
    /// Require every pixel in this allocation and a fully processed message.
    /// Once initialized, later incremental updates need not cover the screen.
    func finishedFramebufferUpdate(for native: UnsafeMutablePointer<rfbClient>) {
        guard DispatchQueue.getSpecific(key: queueKey) != nil, client == native,
              native.pointee.frameBuffer != nil,
              let session = clientSession, wants(session) else { return }
        frameDiagnostics.withLock {
            $0.snapshot.finishedUpdates &+= 1
            $0.lastCallbackNs = DispatchTime.now().uptimeNanoseconds
        }
        if let fresh = currentFreshCapture(for: native),
           fresh.pixelsRemaining == 0 {
            let diagnostics = framebufferDiagnostics
            guard fresh.session == clientSession,
                  fresh.generation == diagnostics.connectionGeneration,
                  fresh.allocation == diagnostics.allocations,
                  fresh.width == Int(native.pointee.width), fresh.height == Int(native.pointee.height) else {
                finishFreshCapture(fresh, .failure(VNCError.notConnected))
                return
            }
            let capture = FrameCapture(pixels: Data(bytes: native.pointee.frameBuffer!, count: fresh.byteCount),
                                       width: fresh.width, height: fresh.height,
                                       connectionGeneration: fresh.generation, allocation: fresh.allocation)
            finishFreshCapture(fresh, .success(capture))
        }
        guard framebufferPixelsRemaining == 0 else { return }
        framebufferHasUpdate = true
        frameDiagnostics.withLock { $0.snapshot.complete = true }
        initialFramebufferCoverage = []
        if clientReady { publishFrameReadiness(available: true, complete: true) }
        framebufferUpdateContinuation?.yield(())
    }

    // MARK: - Connection Lifecycle

    func connect() async throws {
        let session = UUID()
        guard desiredSession.withLock({ desired in
            guard desired == nil else { return false }
            desired = session
            return true
        }) else { throw VNCError.alreadyConnected }

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                messageQueue.async { [self] in
                    guard wants(session) else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    pendingWork?.cancel()
                    pendingWork = nil
                    cleanupClient()
                    clientSession = session
                    reconnectCount = 0
                    do {
                        try attemptConnection(session)
                        continuation.resume()
                    } catch {
                        if wants(session) {
                            desiredSession.withLock { if $0 == session { $0 = nil } }
                            updateState(.error("Connection refused or handshake failed"))
                        }
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            cancel(session)
        }
    }

    func disconnect() {
        let session = desiredSession.withLock { desired -> UUID? in
            let old = desired
            desired = nil
            return old
        }
        guard let session else { return }
        enqueueCleanup(session)
    }

    private func cancel(_ session: UUID) {
        desiredSession.withLock { if $0 == session { $0 = nil } }
        enqueueCleanup(session)
    }

    private func enqueueCleanup(_ session: UUID) {
        // Never free from a C callback, nor concurrently with native handshake,
        // message handling, input or a framebuffer reader. A stale cancellation
        // cannot clear a later session or destroy its client.
        messageQueue.async { [weak self] in
            guard let self, self.clientSession == session else { return }
            self.pendingWork?.cancel()
            self.pendingWork = nil
            self.cleanupClient()
            self.clientSession = nil
            if self.desiredSession.withLock({ $0 == nil }) {
                self.updateState(.disconnected)
            }
        }
    }

    private func attemptConnection(_ session: UUID) throws {
        guard wants(session) else { throw CancellationError() }
        updateState(.connecting)
        guard wants(session) else { throw CancellationError() }
        guard let newClient = operations.make(config) else {
            throw VNCError.connectionFailed("rfbGetClient returned nil")
        }
        client = newClient
        clientReady = false
        frameDiagnostics.withLock { state in
            let generation = state.snapshot.connectionGeneration &+ 1
            state = FrameDiagnosticsState()
            state.snapshot.connectionGeneration = generation
            state.snapshot.phase = .initializing
        }
        newClient.pointee.serverPort = Int32(config.port)
        newClient.pointee.serverHost = strdup(config.host)
        rfbClientSetClientData(newClient, &vncBridgeTag,
                              Unmanaged.passUnretained(self).toOpaque())
        newClient.pointee.MallocFrameBuffer = vncMallocFrameBuffer
        newClient.pointee.GotFrameBufferUpdate = vncGotFrameBufferUpdate
        newClient.pointee.FinishedFrameBufferUpdate = vncFinishedFrameBufferUpdate
        nativeCopyRectangle = newClient.pointee.GotCopyRect
        newClient.pointee.GotCopyRect = vncGotCopyRect
        newClient.pointee.GetPassword = vncGetPassword
        newClient.pointee.GetCredential = vncGetCredential
        newClient.pointee.GotXCutText = vncGotXCutText
        // A zero upstream default meant unbounded connect/read waits. These
        // are native per-operation limits, not a whole-handshake deadline.
        let timeout = config.connectTimeout > 0 ? min(config.connectTimeout, 30) : 10
        newClient.pointee.connectTimeout = UInt32(timeout)
        newClient.pointee.readTimeout = UInt32(timeout)
        // On failure LibVNCClient consumes the client. Do not clean it twice.
        guard operations.initialize(newClient) else {
            frameDiagnostics.withLock { $0.snapshot.phase = .disconnected }
            client = nil // the C pointer has already been consumed
            releaseFramebuffer()
            if !wants(session) { throw CancellationError() }
            throw VNCError.connectionFailed("Connection refused or handshake failed")
        }
        guard wants(session) else {
            cleanupClient()
            throw CancellationError()
        }
        clientReady = true
        frameDiagnostics.withLock { $0.snapshot.phase = .idle }
        publishFrameReadiness(available: true, complete: framebufferHasUpdate)
        updateState(.connected(width: Int(newClient.pointee.width), height: Int(newClient.pointee.height)))
        // A connected callback may request disconnect; never schedule work or
        // report connect success after that callback cancels this generation.
        guard wants(session) else {
            cleanupClient()
            throw CancellationError()
        }
        reconnectCount = 0
        lastUpdateRequestNs = 0
        requestMissingFramebufferPixels()
        enqueuePoll(session)
    }

    // MARK: - State

    var connectionState: VNCConnectionState {
        stateStorage.withLock { $0 }
    }

    func stateStream() -> AsyncStream<VNCConnectionState> {
        AsyncStream { continuation in
            self.stateStreamContinuation = continuation
            continuation.yield(self.connectionState)
            continuation.onTermination = { @Sendable _ in
                self.stateStreamContinuation = nil
            }
        }
    }

    func updateState(_ newState: VNCConnectionState) {
        if newState.isConnected {
            guard clientReady, let session = clientSession, wants(session) else { return }
        }
        stateStorage.withLock { $0 = newState }
        onStateChange?(newState)
        stateStreamContinuation?.yield(newState)
        log("State: \(newState)")
    }

    // MARK: - Framebuffer Access (Zero-Copy)

    // Callers complete framebuffer reads inside this queued closure. The queue
    // also owns resize callbacks and cleanup; the raw-pointer property is removed.
    var framebufferWidth: Int { onMessageQueue { activeClient.map { Int($0.pointee.width) } ?? 0 } }
    var framebufferHeight: Int { onMessageQueue { activeClient.map { Int($0.pointee.height) } ?? 0 } }
    var framebufferBytesPerRow: Int {
        onMessageQueue {
            guard let client = activeClient else { return 0 }
            return Int(client.pointee.width) * Int(client.pointee.format.bitsPerPixel) / 8
        }
    }

    func withFramebuffer<T>(_ body: (UnsafeRawBufferPointer, Int, Int) -> T) -> T? {
        onMessageQueue {
            guard framebufferHasUpdate, let client = activeClient,
                  let pointer = client.pointee.frameBuffer else { return nil }
            let width = Int(client.pointee.width)
            let height = Int(client.pointee.height)
            let bpp = Int(client.pointee.format.bitsPerPixel) / 8
            let buffer = UnsafeRawBufferPointer(start: UnsafeRawPointer(pointer), count: width * height * bpp)
            return body(buffer, width, height)
        }
    }

    private func publishFrameReadiness(available: Bool, complete: Bool) {
        let continuations = frameReadiness.withLock { state -> [CheckedContinuation<Void, Error>] in
            state.available = available
            state.complete = complete
            guard !available || complete else { return [] }
            let waiting = state.waiters.values.compactMap { waiter -> CheckedContinuation<Void, Error>? in
                waiter.deadline?.cancel()
                let continuation = waiter.continuation
                waiter.continuation = nil
                return continuation
            }
            state.waiters.removeAll()
            return waiting
        }
        for continuation in continuations {
            if available { continuation.resume() }
            else { continuation.resume(throwing: VNCError.notConnected) }
        }
    }

    private func finishFrameWait(_ waiter: FrameWaiter, cancelled: Bool) {
        let continuation = frameReadiness.withLock { state -> CheckedContinuation<Void, Error>? in
            if cancelled { waiter.cancelled = true }
            guard state.waiters.removeValue(forKey: waiter.id) != nil else { return nil }
            waiter.deadline?.cancel()
            let continuation = waiter.continuation
            waiter.continuation = nil
            return continuation
        }
        guard let continuation else { return }
        if cancelled { continuation.resume(throwing: CancellationError()) }
        else {
            let evidence = framebufferDiagnostics.encoded
            continuation.resume(throwing: VNCError.sendFailed(
                "No complete framebuffer update within 5 seconds; diagnostics=\(evidence)"))
        }
    }

    /// Never dispatch to the native queue here: HandleRFBServerMessage may be
    /// blocked waiting for bytes when the independent five-second deadline fires.
    var framebufferDiagnostics: VNCFramebufferDiagnostics {
        frameDiagnostics.withLock { state in
            var snapshot = state.snapshot
            if let lastCallbackNs = state.lastCallbackNs {
                snapshot.lastCallbackAgeMilliseconds =
                    (DispatchTime.now().uptimeNanoseconds &- lastCallbackNs) / 1_000_000
            }
            return snapshot
        }
    }

    /// Wait without occupying the native queue: it must keep receiving pixels.
    /// The independent deadline also completes while a native read is occupied.
    func waitForFramebuffer() async throws {
        let waiter = FrameWaiter()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let deadline = DispatchWorkItem { [weak self, weak waiter] in
                    guard let self, let waiter else { return }
                    self.finishFrameWait(waiter, cancelled: false)
                }
                let immediate = frameReadiness.withLock { state -> Result<Void, Error>? in
                    if waiter.cancelled { return .failure(CancellationError()) }
                    if !state.available { return .failure(VNCError.notConnected) }
                    if state.complete { return .success(()) }
                    waiter.continuation = continuation
                    waiter.deadline = deadline
                    state.waiters[waiter.id] = waiter
                    return nil
                }
                if let immediate { continuation.resume(with: immediate) }
                else { scheduleFrameDeadline(.global(qos: .userInitiated), 5, deadline) }
            }
            try Task.checkCancellation()
        } onCancel: {
            self.finishFrameWait(waiter, cancelled: true)
        }
    }

    /// Cached completeness is insufficient for a current screenshot. Register
    /// the independent deadline before queueing a full request, then require
    /// newly received pixels and FinishedUpdate on that same allocation.
    func captureFreshFramebuffer() async throws -> FrameCapture {
        try Task.checkCancellation()
        let waiter = FreshFrameWaiter(session: desiredSession.withLock { $0 })
        return try await withTaskCancellationHandler {
            let capture = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<FrameCapture, Error>) in
                let deadline = DispatchWorkItem { [weak self, weak waiter] in
                    guard let self, let waiter else { return }
                    self.finishFreshCapture(waiter, .failure(VNCError.sendFailed(
                        "No fresh complete framebuffer update within 5 seconds; diagnostics=\(self.framebufferDiagnostics.encoded)")))
                }
                let refusal = freshFrameWaiter.withLock { current -> Error? in
                    if waiter.cancelled { return CancellationError() }
                    if current != nil { return VNCError.sendFailed("Fresh framebuffer capture already in progress") }
                    waiter.continuation = continuation
                    waiter.deadline = deadline
                    current = waiter
                    return nil
                }
                if let refusal { continuation.resume(throwing: refusal); return }
                scheduleFrameDeadline(.global(qos: .userInitiated), 5, deadline)
                messageQueue.async { [self] in
                    guard freshFrameWaiter.withLock({ $0 === waiter }) else { return }
                    guard let client = activeClient, waiter.session == clientSession else {
                        finishFreshCapture(waiter, .failure(VNCError.notConnected)); return
                    }
                    let diagnostics = framebufferDiagnostics
                    let width = Int(client.pointee.width), height = Int(client.pointee.height)
                    let bpp = Int(client.pointee.format.bitsPerPixel) / 8
                    let (pixels, pixelOverflow) = width.multipliedReportingOverflow(by: height)
                    let (bytes, byteOverflow) = pixels.multipliedReportingOverflow(by: bpp)
                    guard client.pointee.frameBuffer != nil,
                          client.pointee.frameBuffer == ownedFramebuffer,
                          width > 0, height > 0, bpp == 4,
                          diagnostics.width == width, diagnostics.height == height,
                          !pixelOverflow, !byteOverflow, bytes <= Self.maximumFramebufferBytes,
                          bytes == ownedFramebufferBytes else {
                        finishFreshCapture(waiter, .failure(VNCError.sendFailed("Fresh framebuffer allocation is unavailable or invalid"))); return
                    }
                    waiter.generation = diagnostics.connectionGeneration
                    waiter.allocation = diagnostics.allocations
                    waiter.width = width
                    waiter.height = height
                    waiter.bytesPerPixel = bpp
                    waiter.byteCount = bytes
                    waiter.pixelsRemaining = pixels
                    waiter.coverage = Array(repeating: 0, count: (waiter.pixelsRemaining + 63) / 64)
                    guard operations.fullUpdate(client) else {
                        finishFreshCapture(waiter, .failure(VNCError.sendFailed("fresh framebuffer update request"))); return
                    }
                    waiter.requestStarted = true
                }
            }
            try Task.checkCancellation()
            return capture
        } onCancel: {
            self.finishFreshCapture(waiter, .failure(CancellationError()), cancelled: true)
        }
    }

    private func finishFreshCapture(_ waiter: FreshFrameWaiter,
                                    _ result: Result<FrameCapture, Error>, cancelled: Bool = false) {
        let continuation = freshFrameWaiter.withLock { current -> CheckedContinuation<FrameCapture, Error>? in
            if cancelled { waiter.cancelled = true }
            guard current === waiter else { return nil }
            current = nil
            waiter.deadline?.cancel()
            let continuation = waiter.continuation
            waiter.continuation = nil
            return continuation
        }
        continuation?.resume(with: result)
    }

    private func refuseFreshCapture(_ error: Error) {
        if let waiter = freshFrameWaiter.withLock({ $0 }) { finishFreshCapture(waiter, .failure(error)) }
    }

    private func currentFreshCapture(for native: UnsafeMutablePointer<rfbClient>) -> FreshFrameWaiter? {
        guard let fresh = freshFrameWaiter.withLock({ $0 }), fresh.requestStarted else { return nil }
        let diagnostics = framebufferDiagnostics
        guard fresh.session == clientSession, fresh.generation == diagnostics.connectionGeneration,
              fresh.allocation == diagnostics.allocations,
              fresh.width == Int(native.pointee.width), fresh.height == Int(native.pointee.height),
              fresh.bytesPerPixel == Int(native.pointee.format.bitsPerPixel) / 8,
              fresh.byteCount == ownedFramebufferBytes, native.pointee.frameBuffer == ownedFramebuffer else {
            finishFreshCapture(fresh, .failure(VNCError.sendFailed("Framebuffer allocation changed during fresh capture")))
            return nil
        }
        return fresh
    }

    func frameUpdates() -> AsyncStream<Void> {
        AsyncStream { continuation in
            self.framebufferUpdateContinuation = continuation
            continuation.onTermination = { @Sendable _ in
                self.framebufferUpdateContinuation = nil
            }
        }
    }

    // MARK: - Input

    private func admitsInput(_ context: VNCInputContext?, releaseOnly: Bool) -> Bool {
        guard let context else { return true }
        let current = VNCInputContext(framebufferDiagnostics)
        guard context.connectionGeneration == current.connectionGeneration else { return false }
        return releaseOnly || context == current
    }

    /// A qualified external capture can seed input without requesting or
    /// reading an RFB image. Recheck its binding on the same queue as input.
    func validateExternalObservation(_ expected: VNCInputContext) async throws -> VNCInputContext {
        try await sendOnNativeQueue { [self] in
            guard let client = activeClient, let session = clientSession, wants(session) else {
                throw VNCError.notConnected
            }
            let current = VNCInputContext(framebufferDiagnostics)
            let width = Int(client.pointee.width), height = Int(client.pointee.height)
            let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
            let (bytes, byteOverflow) = pixels.multipliedReportingOverflow(by: 4)
            guard expected == current, width == expected.width, height == expected.height,
                  width > 0, height > 0, !overflow, !byteOverflow,
                  Int(client.pointee.format.bitsPerPixel) == 32,
                  client.pointee.frameBuffer != nil, client.pointee.frameBuffer == ownedFramebuffer,
                  bytes == ownedFramebufferBytes else {
                throw VNCError.sendFailed("External observation does not match the current VNC allocation")
            }
        }
        return expected
    }

    /// Cancellation can arrive while this operation is behind a blocked RFB
    /// decoder. Check again on the native queue before emitting any input.
    private func sendOnNativeQueue(releaseOnly: Bool = false,
                                   _ operation: @escaping () throws -> Void) async throws {
        let cancelled = OSAllocatedUnfairLock(initialState: false)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                messageQueue.async {
                    guard !cancelled.withLock({ $0 }) else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    do { try operation(); continuation.resume() }
                    catch { continuation.resume(throwing: error) }
                }
            }
        } onCancel: {
            if !releaseOnly { cancelled.withLock { $0 = true } }
        }
    }

    func sendMouseEvent(x: Int, y: Int, buttonMask: Int = 0,
                        context: VNCInputContext? = nil, releaseOnly: Bool = false,
                        inputPermit: NativeInputPermit? = nil) async throws {
        try await sendOnNativeQueue(releaseOnly: releaseOnly) { [self] in
            if !releaseOnly { try inputPermit?.check(context: context) }
            guard let client = activeClient else { throw VNCError.notConnected }
            guard admitsInput(context, releaseOnly: releaseOnly),
                  buttonMask >= 0, buttonMask <= 255, !releaseOnly || buttonMask == 0 else {
                throw VNCError.sendFailed("Observed display changed; take a new screenshot before input")
            }
            let width = Int(client.pointee.width), height = Int(client.pointee.height)
            let pointerX = releaseOnly ? min(max(0, x), max(0, width - 1)) : x
            let pointerY = releaseOnly ? min(max(0, y), max(0, height - 1)) : y
            guard width > 0, height > 0, pointerX >= 0, pointerX < width,
                  pointerY >= 0, pointerY < height,
                  let nativeX = Int32(exactly: pointerX), let nativeY = Int32(exactly: pointerY) else {
                throw VNCError.sendFailed("Pointer coordinates outside current framebuffer")
            }
            if !releaseOnly { try inputPermit?.check(context: context) }
            guard SendPointerEvent(client, nativeX, nativeY, Int32(buttonMask)) != 0 else {
                throw VNCError.sendFailed("pointer event")
            }
        }
    }

    func sendKeyEvent(key: UInt32, down: Bool,
                      context: VNCInputContext? = nil, releaseOnly: Bool = false,
                      inputPermit: NativeInputPermit? = nil) async throws {
        try await sendOnNativeQueue(releaseOnly: releaseOnly) { [self] in
            if !releaseOnly { try inputPermit?.check(context: context) }
            guard let client = activeClient else { throw VNCError.notConnected }
            guard admitsInput(context, releaseOnly: releaseOnly), !releaseOnly || !down else {
                throw VNCError.sendFailed("Observed display changed; take a new screenshot before input")
            }
            // macOS Apple VNC expects Super_L/R for Command, not Meta_L/R.
            var remappedKey = key
            if isMacOS {
                if key == 0xFFE7 { remappedKey = 0xFFEB }
                if key == 0xFFE8 { remappedKey = 0xFFEC }
            }
            let rfbDown: rfbBool = down ? -1 : 0
            if !releaseOnly { try inputPermit?.check(context: context) }
            guard SendKeyEvent(client, remappedKey, rfbDown) != 0 else { throw VNCError.sendFailed("key event") }
        }
    }

    func sendClipboardText(_ text: String, context: VNCInputContext? = nil,
                           inputPermit: NativeInputPermit? = nil) async throws {
        try await sendOnNativeQueue { [self] in
            try inputPermit?.check(context: context)
            guard let client = activeClient else { throw VNCError.notConnected }
            guard admitsInput(context, releaseOnly: false), text.utf8.count <= 1_048_576 else {
                throw VNCError.sendFailed("Clipboard input is unavailable for the observed display")
            }
            var cStr = Array(text.utf8CString)
            let len = Int32(cStr.count - 1)
            try inputPermit?.check(context: context)
            guard SendClientCutText(client, &cStr, len) != 0 else { throw VNCError.sendFailed("clipboard text") }
        }
    }

    func requestFullUpdate() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            messageQueue.async { [self] in
                guard let client = activeClient else {
                    continuation.resume(throwing: VNCError.notConnected)
                    return
                }
                if operations.fullUpdate(client) {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: VNCError.sendFailed("framebuffer update request"))
                }
            }
        }
    }

    // MARK: - Message Loop

    /// Incremental updates may repeat changed regions forever without filling
    /// an initial/reconnected/resized allocation. Ask for the whole screen,
    /// at most once a second, until actual complete pixel coverage arrives.
    /// A request never marks a frame ready or extends a reader's deadline.
    private func requestMissingFramebufferPixels() {
        guard !framebufferHasUpdate, framebufferPixelsRemaining > 0,
              let client = activeClient else { return }
        let now = monotonicNanoseconds()
        if let previous = lastFullUpdateRequestNs,
           now &- previous < Self.incompleteFrameRefreshIntervalNs { return }
        lastFullUpdateRequestNs = now
        _ = operations.fullUpdate(client)
    }

    private func enqueuePoll(_ session: UUID) {
        guard wants(session) else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.clientSession == session, self.wants(session),
                  let client = self.client else { return }
            self.pendingWork = nil
            guard self.operations.poll(client, min(max(self.config.messageLoopInterval, 500), 250_000), {
                phase in self.frameDiagnostics.withLock { $0.snapshot.phase = phase }
            }) else {
                self.cleanupClient()
                guard self.wants(session) else { return }
                self.updateState(.error("Connection lost"))
                self.scheduleReconnect(session)
                return
            }
            guard self.wants(session) else { return }
            let now = self.monotonicNanoseconds()
            if !self.framebufferHasUpdate {
                self.requestMissingFramebufferPixels()
            } else if now &- self.lastUpdateRequestNs > 50_000_000 {
                self.frameDiagnostics.withLock { $0.snapshot.phase = .requestingIncrementalUpdate }
                self.operations.incrementalUpdate(client)
                self.frameDiagnostics.withLock { $0.snapshot.phase = .idle }
                self.lastUpdateRequestNs = now
            }
            self.enqueuePoll(session)
        }
        pendingWork = item
        schedule(messageQueue, 0, item)
    }

    private func scheduleReconnect(_ session: UUID) {
        guard wants(session) else { return }
        let attempts = min(max(config.maxReconnectAttempts, 0), 100)
        guard config.autoReconnect, reconnectCount < attempts else {
            desiredSession.withLock { if $0 == session { $0 = nil } }
            clientSession = nil
            updateState(.disconnected)
            return
        }
        reconnectCount += 1
        let base = config.reconnectDelay.isFinite ? min(max(config.reconnectDelay, 0.1), 30) : 2
        let delay = min(base * Double(min(reconnectCount, 5)), 30)
        log("Reconnecting (\(reconnectCount)/\(attempts)) in \(delay)s")
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.clientSession == session, self.wants(session) else { return }
            self.pendingWork = nil
            do {
                try self.attemptConnection(session)
            } catch {
                // The desired session survives failed attempts; only explicit
                // cancellation or exhausted policy disables further retries.
                guard self.wants(session) else { return }
                self.updateState(.error("Reconnect failed"))
                self.scheduleReconnect(session)
            }
        }
        pendingWork = item
        schedule(messageQueue, delay, item)
    }

    // MARK: - Logging

    func log(_ message: String) {
        guard verbose else { return }
        FileHandle.standardError.write(Data("[VNC \(timestamp())] \(message)\n".utf8))
    }

    private func timestamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: Date())
    }
}
