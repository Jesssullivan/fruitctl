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
    // so both values are inferred: full requests written since the last update
    // that carried any rectangle, and LibVNC's own post-update incremental
    // request (rfbclient.c:2564), counted when its request gate was open.
    var unansweredFullRequests = 0
    var autoRearmObserved = 0
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
        case autoRearmObserved = "auto_rearm_observed"
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

/// Stable reasons a screen observation produced no fresh complete frame.
/// The raw values are the public JSON-RPC `data.reason` vocabulary.
enum VNCStaleScreenReason: String, CaseIterable, Sendable {
    /// The request was written and no update arrived before the deadline.
    case serverSilent = "server_silent"
    /// Updates arrived, but none carried a framebuffer rectangle.
    case metadataOnly = "metadata_only"
    /// Rectangles arrived without covering every pixel before the deadline.
    case incompleteCoverage = "incomplete_coverage"
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

    /// JSON-RPC error code for every stale_screen observation failure.
    static let staleScreenCode = -32010
    /// Deadline failures keep this compatible message prefix.
    static let staleScreenDeadlineMessage = "No fresh complete framebuffer update within 5 seconds"

    var errorDescription: String? {
        switch self {
        case .notConnected: "Not connected to VNC server."
        case .connectionFailed(let msg): "VNC connection failed: \(msg)"
        case .alreadyConnected: "Already connected to a VNC server."
        case .messageLoopFailed: "VNC message loop encountered an error."
        case .framebufferAllocationFailed: "Failed to allocate framebuffer."
        case .sendFailed(let msg): "Failed to send VNC event: \(msg)"
        case .staleScreen(_, let data): data.message
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
}
