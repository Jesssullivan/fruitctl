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
    }

    struct ErrorPayload: Encodable {
        var code: Int
        var message: String
        var data: ErrorData?
    }

    /// Typed `error.data`: stale_screen (-32010), an input refusal (-32011)
    /// or input_not_ready (-32013).
    enum ErrorData: Encodable {
        case staleScreen(StaleScreenData)
        case inputRefusal(InputRefusalData)
        case inputNotReady(InputNotReadyData)

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self {
            case .staleScreen(let data): try container.encode(data)
            case .inputRefusal(let data): try container.encode(data)
            case .inputNotReady(let data): try container.encode(data)
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
        provenance: VNCCaptureProvenance? = nil
    ) -> PCResponse {
        PCResponse(
            result: ResultPayload(
                detail: detail, image: image, x: x, y: y,
                scaledWidth: scaledWidth, scaledHeight: scaledHeight,
                timing: timing, elements: elements,
                nativeWidth: frameContext?.width, nativeHeight: frameContext?.height,
                connectionGeneration: frameContext?.connectionGeneration,
                allocation: frameContext?.allocation, capabilities: capabilities,
                provenance: provenance
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
