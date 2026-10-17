import Foundation

/// Detected text element from OCR with bounding box in scaled coordinates.
struct TextElement: Encodable {
    let text: String
    let elX: Int
    let elY: Int
    let elW: Int
    let elH: Int
    let confidence: Double

    enum CodingKeys: String, CodingKey {
        case text
        case elX = "x"
        case elY = "y"
        case elW = "w"
        case elH = "h"
        case confidence
    }
}

/// PC (Procedure Call) response over stdout NDJSON.
/// {"result":{"detail":"OK"},"id":1}
struct PCResponse: Encodable {
    let result: ResultPayload?
    let error: ErrorPayload?
    let id: PCId?

    struct ResultPayload: Encodable {
        var detail: String?
        var image: String?
        var x: Int?
        var y: Int?
        var scaledWidth: Int?
        var scaledHeight: Int?
        var timing: [String: Double]?
        var elements: [TextElement]?
        var nativeWidth: Int?
        var nativeHeight: Int?
        var connectionGeneration: Int?
        var allocation: Int?
        var instance_id: String?
        var session_id: String?
        var display_id: Int?
        var displayGeneration: Int?
        var sequence: Int?
        var challenge: String?
        var native_permit_protocol: String?
        var input_permit_ms: Int?
        var maximum_round_trip_ms: Int?
        var native_permit_remaining_ms: Int?
        var capabilities: [String]?
        /// How an observation's pixels were obtained (screen observations only).
        var provenance: VNCCaptureProvenance?
        /// Health only: whether input would be written now, and how long
        /// the connection's settle time still holds it (see VNCInputSettle).
        var input_ready: Bool?
        var input_settle_remaining_ms: Int?
        var input_settle_ms: Int?
        /// diff_check and expect_change: what changed against the baseline.
        var diff: FrameDiffSummary?
        /// zoom: the region the image shows and its pixel dimensions.
        var zoom: ZoomSummary?
        /// wait_for_stable: how long the screen stayed unchanged.
        var stable: StableSummary?
        /// clipboard_read: the target clipboard text (D8). The broker bounds
        /// and redacts it before any client sees it; never journalled.
        var clipboard: ClipboardSummary?
        /// key_type: "paste" when D29 routing pasted any of the text.
        var kind: String?
    }

    struct ErrorPayload: Encodable {
        var code: Int
        var message: String
        var data: ErrorData?
    }

    /// Typed `error.data`: stale_screen (-32010), an input refusal (-32011),
    /// an unmet observation condition (-32012), input_not_ready (-32013) or
    /// an unavailable clipboard_read (-32014).
    enum ErrorData: Encodable {
        case staleScreen(StaleScreenData)
        case inputRefusal(InputRefusalData)
        case inputNotReady(InputNotReadyData)
        case observationUnmet(ObservationUnmetData)
        case clipboardUnavailable(InputRefusalData)

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .staleScreen(let data): try container.encode(data)
            case .inputRefusal(let data): try container.encode(data)
            case .inputNotReady(let data): try container.encode(data)
            case .observationUnmet(let data): try container.encode(data)
            case .clipboardUnavailable(let data): try container.encode(data)
            }
        }
    }

    /// `error.data` for code -32011: a stable reason only.
    struct InputRefusalData: Encodable {
        var reason: String
    }

    /// `error.data` for code -32013: the stable reason and the settle time
    /// still remaining when the request gave up. No event was written.
    struct InputNotReadyData: Encodable {
        var reason: String
        var remaining_ms: Int
    }

    /// `error.data` for code -32010: a stable reason plus bounded control-flow
    /// diagnostics. Never pixels, clipboard, credentials or server text.
    struct StaleScreenData: Encodable {
        var reason: String
        var diagnostics: VNCFramebufferDiagnostics
    }

    /// `error.data` for code -32012: a stable reason plus bounded counters.
    struct ObservationUnmetData: Encodable {
        var reason: String
        var elapsedMilliseconds: Int
        var captures: Int

        // swiftlint:disable nesting
        enum CodingKeys: String, CodingKey {
            case reason, captures
            case elapsedMilliseconds = "elapsed_ms"
        }
        // swiftlint:enable nesting
    }

    static func success(
        id: PCId?,
        detail: String? = nil,
        image: String? = nil,
        x: Int? = nil,
        y: Int? = nil,
        scaledWidth: Int? = nil,
        scaledHeight: Int? = nil,
        timing: [String: Double]? = nil,
        elements: [TextElement]? = nil,
        frameContext: VNCInputContext? = nil,
        capabilities: [String]? = nil,
        provenance: VNCCaptureProvenance? = nil,
        diff: FrameDiffSummary? = nil,
        zoom: ZoomSummary? = nil,
        stable: StableSummary? = nil,
        clipboard: ClipboardSummary? = nil,
        kind: String? = nil
    ) -> PCResponse {
        PCResponse(
            result: ResultPayload(
                detail: detail, image: image, x: x, y: y,
                scaledWidth: scaledWidth, scaledHeight: scaledHeight,
                timing: timing, elements: elements,
                nativeWidth: frameContext?.width, nativeHeight: frameContext?.height,
                connectionGeneration: frameContext?.connectionGeneration,
                allocation: frameContext?.allocation, capabilities: capabilities,
                provenance: provenance, diff: diff, zoom: zoom, stable: stable,
                clipboard: clipboard, kind: kind
            ),
            error: nil, id: id
        )
    }

    static func error(id: PCId?, code: Int = -32000, message: String) -> PCResponse {
        PCResponse(result: nil, error: ErrorPayload(code: code, message: message), id: id)
    }

    /// The typed observation failure, or nil for any other error.
    static func staleScreen(id: PCId?, error: Error) -> PCResponse? {
        guard let typed = error as? VNCError, case let .staleScreen(reason, data) = typed else { return nil }
        return PCResponse(result: nil, error: ErrorPayload(
            code: VNCError.staleScreenCode, message: data.message,
            data: .staleScreen(StaleScreenData(reason: reason.rawValue, diagnostics: data.diagnostics))), id: id)
    }

    /// The typed input-readiness failure, or nil for any other error.
    static func inputNotReady(id: PCId?, error: Error) -> PCResponse? {
        guard let typed = error as? VNCError, case let .inputNotReady(remaining) = typed else { return nil }
        return PCResponse(result: nil, error: ErrorPayload(
            code: VNCError.inputNotReadyCode, message: typed.localizedDescription,
            data: .inputNotReady(InputNotReadyData(reason: VNCError.inputNotReadyReason,
                                                   remaining_ms: remaining))), id: id)
    }

    /// Health: input readiness of the current connection generation.
    func withInputSettle(_ status: VNCInputSettle.Status) -> PCResponse {
        guard var result else { return self }
        result.input_ready = status.ready
        result.input_settle_remaining_ms = status.remainingMilliseconds
        result.input_settle_ms = status.settleMilliseconds
        return PCResponse(result: result, error: error, id: id)
    }

    /// The typed input refusal, or nil for any other error.
    static func inputRefusal(id: PCId?, error: Error) -> PCResponse? {
        guard let refusal = error as? NativeInputRefusal else { return nil }
        return PCResponse(result: nil, error: ErrorPayload(
            code: NativeInputRefusal.code, message: refusal.localizedDescription,
            data: .inputRefusal(InputRefusalData(reason: refusal.rawValue))), id: id)
    }

    /// The typed unmet observation condition, or nil for any other error.
    static func observationUnmet(id: PCId?, error: Error) -> PCResponse? {
        guard let typed = error as? ObservationUnmetError else { return nil }
        return PCResponse(result: nil, error: ErrorPayload(
            code: ObservationUnmetError.code, message: typed.message,
            data: .observationUnmet(ObservationUnmetData(reason: typed.reason.rawValue,
                elapsedMilliseconds: typed.elapsedMilliseconds, captures: typed.captures))), id: id)
    }

    /// The typed clipboard_read failure, or nil for any other error.
    static func clipboardUnavailable(id: PCId?, error: Error) -> PCResponse? {
        guard let typed = error as? ClipboardReadError else { return nil }
        return PCResponse(result: nil, error: ErrorPayload(
            code: ClipboardReadError.code, message: typed.localizedDescription,
            data: .clipboardUnavailable(InputRefusalData(reason: typed.rawValue))), id: id)
    }

    static func inputPermit(id: PCId?, receipt: NativeInputPermit.Receipt) -> PCResponse {
        let binding = receipt.binding
        return PCResponse(result: ResultPayload(detail: "OK", scaledWidth: binding.scaledWidth,
            scaledHeight: binding.scaledHeight, nativeWidth: binding.context.width,
            nativeHeight: binding.context.height, connectionGeneration: binding.context.connectionGeneration,
            allocation: binding.context.allocation, instance_id: binding.instanceID,
            session_id: binding.sessionID, display_id: binding.displayID,
            displayGeneration: binding.displayGeneration, sequence: receipt.sequence,
            challenge: receipt.challenge, native_permit_protocol: NativeInputPermit.protocolVersion,
            input_permit_ms: NativeInputPermit.durationMilliseconds,
            maximum_round_trip_ms: NativeInputPermit.maximumRoundTripMilliseconds,
            native_permit_remaining_ms: receipt.remainingMilliseconds), error: nil, id: id)
    }
}

/// zoom: the region an image shows. Map an image pixel (u, v) back to the
/// display as `region.x + u * region.width / image_width` (likewise y).
struct ZoomSummary: Encodable, Equatable {
    /// The requested region, clamped to the current display, in scaled pixels.
    let region: FrameRect
    /// The native framebuffer pixels the image was cropped from.
    let native: FrameRect
    let imageWidth: Int
    let imageHeight: Int

    enum CodingKeys: String, CodingKey {
        case region, native
        case imageWidth = "image_width"
        case imageHeight = "image_height"
    }
}

/// clipboard_read: the text and where it came from. `fresh` is the server's
/// answer to this request (ExtendedClipboard); otherwise the last text the
/// connection received or wrote, `age_ms` old.
struct ClipboardSummary: Encodable, Equatable {
    let text: String
    let encoding: String
    let ageMilliseconds: Int
    let fresh: Bool

    enum CodingKeys: String, CodingKey {
        case text, encoding, fresh
        case ageMilliseconds = "age_ms"
    }
}

/// wait_for_stable: the unchanged run that satisfied the request.
struct StableSummary: Encodable, Equatable {
    let stableMilliseconds: Int
    let stableForMilliseconds: Int
    let elapsedMilliseconds: Int
    let captures: Int

    enum CodingKeys: String, CodingKey {
        case captures
        case stableMilliseconds = "stable_ms"
        case stableForMilliseconds = "stable_for_ms"
        case elapsedMilliseconds = "elapsed_ms"
    }
}

/// An observation condition that fresh captures did not meet within its
/// bound. Every capture was fresh; a capture failure stays stale_screen.
struct ObservationUnmetError: LocalizedError, Equatable {
    enum Reason: String, CaseIterable {
        /// wait_for_stable: the compared pixels kept changing until timeout_ms.
        case stableTimeout = "stable_timeout"
        /// expect_change: the region never differed from its pre-step frame.
        case changeNotObserved = "change_not_observed"
    }

    /// JSON-RPC error code for every unmet observation condition.
    static let code = -32012

    let reason: Reason
    let message: String
    let elapsedMilliseconds: Int
    let captures: Int

    var errorDescription: String? { message }
}

/// PC (Procedure Call) notification — no id, server->caller.
/// {"method":"vnc_state","params":{"state":"connected"}}
struct PCNotification: Encodable {
    let method: String
    let params: [String: PCValue]?
}

/// PC value type for notification params.
enum PCValue: Encodable {
    case string(String)
    case int(Int)
    case bool(Bool)
    case strings([String])

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .int(let n): try container.encode(n)
        case .bool(let b): try container.encode(b)
        case .strings(let values): try container.encode(values)
        }
    }
}
