import Foundation

/// PC (Procedure Call) request over stdin NDJSON.
/// {"method":"mouse_click","params":{"x":640,"y":480},"id":1}
struct PCRequest: Decodable {
    // Additive ready/health metadata. These names match ordinary dispatch and
    // the two private permit controls; they do not assert desktop qualification.
    static let supportedMethods = [
        "screenshot", "cursor_crop", "diff_check", "set_baseline", "detect_elements",
        "zoom", "wait_for_stable", "expect_baseline", "expect_change",
        "mouse_move", "hover", "nudge", "mouse_click", "mouse_double_click", "mouse_drag", "scroll",
        "key_tap", "key_combo", "key_type", "paste", "type_secret", "clipboard_read",
        "configure", "get_timing", "wait", "health", "shutdown",
        "adopt_observation", "begin_input_permit", "grant_input_permit",
        "triple_click", "cursor_position", "hold_key", "mouse_down", "mouse_up", "release_holds",
    ]
    let method: String
    let params: Params?
    let id: PCId?

    struct Params: Decodable {
        // Action parameters
        let x: Int?
        let y: Int?
        let toX: Int?
        let toY: Int?
        let dx: Int?
        let dy: Int?
        let button: String?
        let key: String?
        let keys: [String]?
        let text: String?
        // D16: private broker -> native secret for type_secret. Not an MCP
        // field; never logged, echoed or placed on the clipboard.
        let secret: String?
        let direction: String?
        let amount: Int?
        let ms: Int?
        let modifiers: [String]?
        let durationMs: Int?

        // Private executor -> native D29 routing request for key_type
        // ("paste"). The executor sets it only for a target that opted in;
        // it is not an MCP field and type_secret never carries it.
        let unmappable: String?

        // Private executor -> native batch scope for D27 mouse holds. The
        // executor assigns it per action_queue batch; it is not an MCP field.
        let holdScope: String?

        // Observation regions (scaled display space) and bounds.
        let width: Int?
        let height: Int?
        let regions: [FrameRect]?
        let ignore: [FrameRect]?
        let stableMs: Int?
        let timeoutMs: Int?

        // Private broker -> native adoption of an owned external observation.
        // These fields are not part of the public MCP action schema.
        let nativeWidth: Int?
        let nativeHeight: Int?
        let scaledWidth: Int?
        let scaledHeight: Int?
        let connectionGeneration: Int?
        let allocation: Int?
        let instanceID: String?
        let sessionID: String?
        let displayID: Int?
        let displayGeneration: Int?
        let sequence: Int?
        let challenge: String?
        let leaseRemainingMilliseconds: Int?
        // Private executor budget for this request; bounds the input settle wait.
        let deadlineMs: Int?

        // Configure — timing (ms) + display
        let reset: Bool?
        let maxDimension: Int?
        let clickHoldMs: Int?
        let doubleClickGapMs: Int?
        let hoverSettleMs: Int?
        let dragPositionMs: Int?
        let dragPressMs: Int?
        let dragStepMs: Int?
        let dragSettleMs: Int?
        let dragPixelsPerStep: Double?
        let dragMinSteps: Int?
        let scrollPressMs: Int?
        let scrollTickMs: Int?
        let keyHoldMs: Int?
        let comboModMs: Int?
        let typeKeyMs: Int?
        let typeInterKeyMs: Int?
        let typeShiftMs: Int?
        let pasteSettleMs: Int?
        let pasteRestoreMs: Int?
        let cursorCropRadius: Int?

        // swiftlint:disable nesting
        enum CodingKeys: String, CodingKey {
            case x, y, toX, toY, dx, dy
            case button, key, keys, text, secret, direction, amount, ms, modifiers
            case durationMs = "duration_ms"
            case unmappable
            case holdScope = "hold_scope"
            case width, height, regions, ignore
            case stableMs = "stable_ms"
            case timeoutMs = "timeout_ms"
            case nativeWidth, nativeHeight, scaledWidth, scaledHeight, connectionGeneration, allocation
            case displayGeneration, sequence, challenge
            case instanceID = "instance_id"
            case sessionID = "session_id"
            case displayID = "display_id"
            case leaseRemainingMilliseconds = "lease_remaining_ms"
            case deadlineMs = "deadline_ms"
            case reset
            case maxDimension = "max_dimension"
            case clickHoldMs = "click_hold_ms"
            case doubleClickGapMs = "double_click_gap_ms"
            case hoverSettleMs = "hover_settle_ms"
            case dragPositionMs = "drag_position_ms"
            case dragPressMs = "drag_press_ms"
            case dragStepMs = "drag_step_ms"
            case dragSettleMs = "drag_settle_ms"
            case dragPixelsPerStep = "drag_pixels_per_step"
            case dragMinSteps = "drag_min_steps"
            case scrollPressMs = "scroll_press_ms"
            case scrollTickMs = "scroll_tick_ms"
            case keyHoldMs = "key_hold_ms"
            case comboModMs = "combo_mod_ms"
            case typeKeyMs = "type_key_ms"
            case typeInterKeyMs = "type_inter_key_ms"
            case typeShiftMs = "type_shift_ms"
            case pasteSettleMs = "paste_settle_ms"
            case pasteRestoreMs = "paste_restore_ms"
            case cursorCropRadius = "cursor_crop_radius"
        }
        // swiftlint:enable nesting

        /// The scaled request rectangle of zoom and expect_change.
        var rect: FrameRect? {
            guard let x, let y, let width, let height else { return nil }
            return FrameRect(x: x, y: y, width: width, height: height)
        }
    }
}

/// PC identifier — string or number, used to correlate request/response pairs.
enum PCId: Codable, Equatable {
    case string(String)
    case number(Int)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let s = try? container.decode(String.self) {
            self = .string(s)
        } else if let n = try? container.decode(Int.self) {
            self = .number(n)
        } else {
            throw DecodingError.typeMismatch(PCId.self, .init(codingPath: [], debugDescription: "Expected string or int"))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        }
    }
}
