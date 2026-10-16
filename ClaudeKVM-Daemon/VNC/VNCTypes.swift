import Foundation

/// Input is bound to the observed allocation, not just a cached display size.
struct VNCInputContext: Equatable, Sendable {
    let width: Int
    let height: Int
    let connectionGeneration: Int
    let allocation: Int

    init(width: Int, height: Int, connectionGeneration: Int, allocation: Int) {
        self.width = width; self.height = height
        self.connectionGeneration = connectionGeneration; self.allocation = allocation
    }

    init(_ diagnostics: VNCFramebufferDiagnostics) {
        self.init(width: diagnostics.width, height: diagnostics.height,
                  connectionGeneration: diagnostics.connectionGeneration,
                  allocation: diagnostics.allocations)
    }
}

/// Diagnostics describe control flow and coverage only, never framebuffer,
/// clipboard, credentials, or server-supplied text. The native queue publishes
/// bounded snapshots so a blocked decoder cannot block the frame deadline.
enum VNCDecoderPhase: String, Codable, Sendable {
    case disconnected, initializing, idle, waitingForMessage
    case handlingServerMessage, requestingIncrementalUpdate
}

struct VNCFramebufferDiagnostics: Codable, Sendable {
    var connectionGeneration = 0
    // Accepted allocation attempts, including a later allocator failure.
    var allocations = 0
    var width = 0
    var height = 0
    var pixelsRemaining = 0
    var rectangles = 0
    var copyRectangles = 0
    var finishedUpdates = 0
    var rejectedRectangles = 0
    var skippedCopyRectangles = 0
    var complete = false
    var phase = VNCDecoderPhase.disconnected
    // Connection-scoped request accounting. RFB requests carry no identifier,
    // so these values are inferred and err high, never low. A full request
    // stays counted until an update whose rectangles alone cover the whole
    // allocation retires one; a server that answers several full requests
    // with one update leaves the count high. Incremental requests (the
    // bridge's stream polls and LibVNC's re-arms) are retired by the next
    // update that carries any rectangle. autoRearmObserved counts LibVNC's
    // own post-update incremental request (rfbclient.c:2564), written while
    // its request gate was open.
    var unansweredFullRequests = 0
    var unansweredIncrementalRequests = 0
    var autoRearmObserved = 0
    // On-demand mode: times the closed request gate was found reopened by a
    // server SupportedMessages rectangle, then closed again.
    var requestGateLeaks = 0
    var lastCallbackAgeMilliseconds: UInt64?

    // Explicit wire names keep `encoded` and typed error data identical.
    enum CodingKeys: String, CodingKey {
        case connectionGeneration = "connection_generation"
        case allocations, width, height
        case pixelsRemaining = "pixels_remaining"
        case rectangles
        case copyRectangles = "copy_rectangles"
        case finishedUpdates = "finished_updates"
        case rejectedRectangles = "rejected_rectangles"
        case skippedCopyRectangles = "skipped_copy_rectangles"
        case complete, phase
        case unansweredFullRequests = "unanswered_full_requests"
        case unansweredIncrementalRequests = "unanswered_incremental_requests"
        case autoRearmObserved = "auto_rearm_observed"
        case requestGateLeaks = "request_gate_leaks"
        case lastCallbackAgeMilliseconds = "last_callback_age_milliseconds"
    }

    var encoded: String {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.sortedKeys]
        // Only finite integer, boolean, and enum values enter this payload.
        guard let data = try? encoder.encode(self) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

// MARK: - Connection State

enum VNCConnectionState: Sendable, CustomStringConvertible {
    case disconnected
    case connecting
    case connected(width: Int, height: Int)
    case error(String)

    var description: String {
        switch self {
        case .disconnected: "disconnected"
        case .connecting: "connecting"
        case let .connected(w, h): "connected (\(w)×\(h))"
        case let .error(msg): "error: \(msg)"
        }
    }

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

// MARK: - Errors

/// How the daemon asks the server for framebuffer updates.
enum VNCRequestMode: String, CaseIterable, Codable, Sendable {
    /// Default: incremental polls while idle and LibVNC's re-arm after every
    /// update. While a capture is pending the daemon's own polls pause and
    /// LibVNC's re-arm is held, so nothing is written behind its request.
    case stream
    /// Opt-in: no incremental request is ever written. LibVNC's request gate
    /// stays closed except around this daemon's own whole-screen requests.
    case onDemand = "on-demand"
}

/// How one successful observation was obtained. Every field is control flow;
/// none carries pixels, coordinates or server text.
struct VNCCaptureProvenance: Encodable, Equatable, Sendable {
    struct Requests: Encodable, Equatable, Sendable {
        var full = 0
        var incremental = 0
    }
    /// Pixels were received over this connection, not a side session.
    var source = "in_session"
    /// Every pixel arrived after this capture's own request, then FinishedUpdate.
    var coverage = "complete_received_after_request"
    var requestMode: VNCRequestMode
    /// Requests written while this capture was pending, its own included.
    var requests = Requests()
    /// Inferred requests of each kind still unanswered when this capture's
    /// own request was admitted.
    var priorUnansweredRequests = Requests()
    /// True only when no request was believed outstanding at admission and no
    /// LibVNC request leaked through the on-demand gate while pending: every
    /// update that completed this capture then answers a request written after
    /// any earlier input. Stream mode always has LibVNC's re-arm outstanding.
    var orderedAfterPriorInput = true
    var elapsedMilliseconds: UInt64 = 0

    enum CodingKeys: String, CodingKey {
        case source, coverage, requests
        case requestMode = "request_mode"
        case priorUnansweredRequests = "prior_unanswered_requests"
        case orderedAfterPriorInput = "ordered_after_prior_input"
        case elapsedMilliseconds = "elapsed_ms"
        case elicitedInput = "elicited_input"
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(source, forKey: .source)
        try container.encode(coverage, forKey: .coverage)
        try container.encode(requestMode, forKey: .requestMode)
        try container.encode(requests, forKey: .requests)
        try container.encode(priorUnansweredRequests, forKey: .priorUnansweredRequests)
        try container.encode(orderedAfterPriorInput, forKey: .orderedAfterPriorInput)
        try container.encode(elapsedMilliseconds, forKey: .elapsedMilliseconds)
        // Observation never writes input to obtain pixels.
        try container.encodeNil(forKey: .elicitedInput)
    }
}

/// Stable reasons a screen observation produced no fresh complete frame.
/// The raw values are the public JSON-RPC `data.reason` vocabulary.
enum VNCStaleScreenReason: String, CaseIterable, Sendable {
    /// The request was written and no update arrived before the deadline.
    case serverSilent = "server_silent"
    /// Updates arrived, but none carried a framebuffer rectangle.
    case metadataOnly = "metadata_only"
    /// Rectangles arrived without covering every pixel before the deadline.
    case incompleteCoverage = "incomplete_coverage"
    /// Every pixel arrived after the request, but only at or after the deadline.
    case lateComplete = "late_complete"
    case allocationChanged = "allocation_changed"
    case disconnected
    /// The request could not be written before the deadline.
    case requestFailed = "request_failed"
    case captureBusy = "capture_busy"
    case cancelled
}

/// Typed failure data: a bounded message plus control-flow diagnostics only.
struct VNCStaleScreenData: Sendable {
    let message: String
    let diagnostics: VNCFramebufferDiagnostics
}

enum VNCError: LocalizedError {
    case notConnected
    case connectionFailed(String)
    case alreadyConnected
    case messageLoopFailed
    case framebufferAllocationFailed
    case sendFailed(String)
    case staleScreen(reason: VNCStaleScreenReason, data: VNCStaleScreenData)
    /// The connection's input settle time has not elapsed and the request
    /// cannot wait for it. No event was written.
    case inputNotReady(remainingMilliseconds: Int)

    /// JSON-RPC error code for every stale_screen observation failure.
    static let staleScreenCode = -32010
    /// JSON-RPC error code for input_not_ready (`data.reason`, `data.remaining_ms`).
    static let inputNotReadyCode = -32013
    static let inputNotReadyReason = "input_not_ready"
    /// Deadline failures keep this compatible message prefix. The rest names
    /// the capture's own deadline, so a 5000 ms deadline still reads
    /// "No fresh complete framebuffer update within 5 seconds".
    static let staleScreenDeadlinePrefix = "No fresh complete framebuffer update within"
    static func staleScreenDeadlineMessage(milliseconds: Int) -> String {
        let span = milliseconds > 0 && milliseconds % 1_000 == 0
            ? "\(milliseconds / 1_000) seconds" : "\(milliseconds) ms"
        return "\(staleScreenDeadlinePrefix) \(span)"
    }

    var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to VNC server."
        case .connectionFailed(let msg): "VNC connection failed: \(msg)"
        case .alreadyConnected: "Already connected to a VNC server."
        case .messageLoopFailed: "VNC message loop encountered an error."
        case .framebufferAllocationFailed: "Failed to allocate framebuffer."
        case .sendFailed(let msg): "Failed to send VNC event: \(msg)"
        case .staleScreen(_, let data): data.message
        case .inputNotReady(let remaining):
            "Input not ready: the server ignores input for \(remaining) ms more after connecting"
        }
    }

    /// Classify a fresh-capture failure. Disconnection and cancellation keep
    /// their own Swift types inside the bridge; only the wire sees this form.
    static func classifyStaleScreen(_ error: Error,
                                    diagnostics: VNCFramebufferDiagnostics) -> VNCError? {
        if let typed = error as? VNCError {
            switch typed {
            case .staleScreen: return typed
            case .notConnected:
                return .staleScreen(reason: .disconnected, data: VNCStaleScreenData(
                    message: typed.errorDescription ?? "Not connected to VNC server.",
                    diagnostics: diagnostics))
            default: return nil
            }
        }
        guard error is CancellationError else { return nil }
        return .staleScreen(reason: .cancelled, data: VNCStaleScreenData(
            message: "Fresh framebuffer capture cancelled", diagnostics: diagnostics))
    }
}

// MARK: - Configuration

struct VNCConfiguration {
    var host: String = "127.0.0.1"
    var port: Int = 5900
    var username: String?
    var password: String?
    var bitsPerSample: Int32 = 8
    var samplesPerPixel: Int32 = 3
    var bytesPerPixel: Int32 = 4
    var connectTimeout: Int = 0
    var autoReconnect: Bool = true
    var reconnectDelay: TimeInterval = 2.0
    var maxReconnectAttempts: Int = 10
    var messageLoopInterval: UInt32 = 500
    /// Write a header-only client-to-server ledger to stderr (no payloads).
    var wireLedger: Bool = false
    var requestMode: VNCRequestMode = .stream
    /// `--input-settle-ms`: nil selects 3000 ms for an Apple server, else 0.
    var inputSettleMilliseconds: Int?
    /// `--capture-timeout-ms`: nil selects 10000 ms for an Apple server, else 5000.
    var captureTimeoutMilliseconds: Int?
}

/// The fresh full-capture deadline.
///
/// Apple Screen Sharing (screensharingd, measured on macOS 26.7.1) can pause
/// for up to about 4.7 s in the middle of its answer to a full framebuffer
/// request right after UI-heavy input, while the target redraws. With a fixed
/// 5 s deadline about one in three post-input screenshots failed as
/// stale_screen although the server was still sending. The longer Apple
/// default waits for those same fresh pixels; it never returns a cached frame,
/// and a capture that misses it still fails closed.
enum VNCCaptureDeadline {
    /// Default for any server not detected as Apple.
    static let defaultMilliseconds = 5_000
    /// Default for a server detected as Apple (ARD credential request).
    static let appleDefaultMilliseconds = 10_000
    /// Bounds for `--capture-timeout-ms`. The upper bound stays well inside
    /// the 30 s tool deadline that the MCP executor enforces.
    static let minimumMilliseconds = 1_000
    static let maximumMilliseconds = 20_000

    /// An explicit value wins (clamped); otherwise Apple's server gets the
    /// measured default and every other server the original 5 s.
    static func effectiveMilliseconds(configured: Int?, appleServer: Bool) -> Int {
        if let configured { return min(max(configured, minimumMilliseconds), maximumMilliseconds) }
        return appleServer ? appleDefaultMilliseconds : defaultMilliseconds
    }
}
