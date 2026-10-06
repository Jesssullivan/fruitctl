import Foundation

enum CommandValidationError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let field): "Invalid or missing parameter: \(field)" }
    }
}

extension PCRequest {
    static let inputMethods: Set<String> = [
        "mouse_move", "hover", "nudge", "mouse_click", "mouse_double_click", "mouse_drag", "scroll",
        "key_tap", "key_combo", "key_type", "paste",
    ]

    /// Native callers do not necessarily pass through the MCP schema.
    /// Validate the entire request before mutating configuration or emitting input.
    func validate(scaling: DisplayScaling) throws {
        let p = params
        if method == "adopt_observation" { _ = try externalObservation(scaling: scaling) }
        func check(_ value: Int?, _ name: String, _ range: ClosedRange<Int>, required: Bool = false) throws {
            guard let value else {
                if required { throw CommandValidationError.invalid(name) }; return
            }
            guard range.contains(value) else { throw CommandValidationError.invalid(name) }
        }
        if ["mouse_move", "hover", "mouse_click", "mouse_double_click", "mouse_drag", "scroll"].contains(method) {
            try check(p?.x, "x", 0...(scaling.scaledWidth - 1), required: true)
            try check(p?.y, "y", 0...(scaling.scaledHeight - 1), required: true)
        }
        if method == "mouse_drag" {
            try check(p?.toX, "toX", 0...(scaling.scaledWidth - 1), required: true)
            try check(p?.toY, "toY", 0...(scaling.scaledHeight - 1), required: true)
        }
        if method == "nudge" {
            try check(p?.dx, "dx", -50...50, required: true)
            try check(p?.dy, "dy", -50...50, required: true)
        }
        if method == "scroll" {
            guard let direction = p?.direction, ScrollDirection(rawValue: direction) != nil else {
                throw CommandValidationError.invalid("direction")
            }
            try check(p?.amount, "amount", 1...20)
        }
        if method == "mouse_click", let button = p?.button, !["left", "right", "middle"].contains(button) {
            throw CommandValidationError.invalid("button")
        }
        if method == "wait" { try check(p?.ms, "ms", 50...10_000) }
        if method == "key_tap" {
            guard let key = p?.key, namedKeyToKeysym(key) != nil else { throw CommandValidationError.invalid("key") }
        }
        if method == "key_combo" {
            let keys = p?.key.map { $0.split(separator: "+", omittingEmptySubsequences: false)
                .map { String($0).trimmingCharacters(in: .whitespaces) } } ?? p?.keys ?? []
            guard !keys.isEmpty, keys.count <= 16, keys.allSatisfy({ namedKeyToKeysym($0) != nil }) else {
                throw CommandValidationError.invalid("key/keys")
            }
        }
        if method == "key_type" || method == "paste" {
            guard let text = p?.text, text.utf8.count <= 1_048_576 else { throw CommandValidationError.invalid("text") }
        }
        guard method == "configure" else { return }
        try check(p?.maxDimension, "max_dimension", 320...3840)
        try check(p?.cursorCropRadius, "cursor_crop_radius", 50...500)
        try check(p?.clickHoldMs, "click_hold_ms", 1...500)
        try check(p?.doubleClickGapMs, "double_click_gap_ms", 1...500)
        try check(p?.hoverSettleMs, "hover_settle_ms", 1...2000)
        try check(p?.dragPositionMs, "drag_position_ms", 1...500)
        try check(p?.dragPressMs, "drag_press_ms", 1...500)
        try check(p?.dragStepMs, "drag_step_ms", 1...100)
        try check(p?.dragSettleMs, "drag_settle_ms", 1...500)
        if let density = p?.dragPixelsPerStep, !density.isFinite || !(1...100).contains(density) {
            throw CommandValidationError.invalid("drag_pixels_per_step")
        }
        try check(p?.dragMinSteps, "drag_min_steps", 1...100)
        try check(p?.scrollPressMs, "scroll_press_ms", 1...200)
        try check(p?.scrollTickMs, "scroll_tick_ms", 1...200)
        try check(p?.keyHoldMs, "key_hold_ms", 1...500)
        try check(p?.comboModMs, "combo_mod_ms", 1...200)
        try check(p?.typeKeyMs, "type_key_ms", 1...200)
        try check(p?.typeInterKeyMs, "type_inter_key_ms", 1...200)
        try check(p?.typeShiftMs, "type_shift_ms", 1...200)
        try check(p?.pasteSettleMs, "paste_settle_ms", 1...500)
    }

    /// Validate geometry independently of the previous native observation.
    /// The broker owns SCK provenance/mapping qualification; native owns the
    /// exact live VNC allocation and the coordinate transform used for input.
    func externalObservation(scaling: DisplayScaling) throws -> VNCInputContext {
        guard ["adopt_observation", "begin_input_permit", "grant_input_permit"].contains(method), let p = params,
              let width = p.nativeWidth, let height = p.nativeHeight,
              (1...65535).contains(width), (1...65535).contains(height),
              let scaledWidth = p.scaledWidth, let scaledHeight = p.scaledHeight,
              let generation = p.connectionGeneration, generation > 0,
              let allocation = p.allocation, allocation > 0 else {
            throw CommandValidationError.invalid("external observation binding")
        }
        let mapped = DisplayScaling(nativeWidth: width, nativeHeight: height, maxDimension: scaling.maxDimension)
        guard scaledWidth == mapped.scaledWidth, scaledHeight == mapped.scaledHeight else {
            throw CommandValidationError.invalid("external observation scaled geometry")
        }
        return VNCInputContext(width: width, height: height,
                               connectionGeneration: generation, allocation: allocation)
    }

    static let inputPermitMethods: Set<String> = ["begin_input_permit", "grant_input_permit"]

    func inputPermitBinding(scaling: DisplayScaling) throws -> NativeInputPermit.Binding {
        func token(_ value: String?) -> Bool {
            guard let value, !value.isEmpty, value.utf8.count <= 256 else { return false }
            return value.unicodeScalars.allSatisfy {
                CharacterSet.alphanumerics.contains($0) || "_.:-".unicodeScalars.contains($0)
            }
        }
        guard Self.inputPermitMethods.contains(method), let p = params,
              token(p.instanceID), token(p.sessionID),
              let instanceID = p.instanceID, let sessionID = p.sessionID,
              let displayID = p.displayID, displayID > 0,
              let displayGeneration = p.displayGeneration, displayGeneration >= 0,
              let sequence = p.sequence, sequence > 0,
              let scaledWidth = p.scaledWidth, let scaledHeight = p.scaledHeight else {
            throw CommandValidationError.invalid("native input permit owner")
        }
        if method == "grant_input_permit" {
            guard let challenge = p.challenge, UUID(uuidString: challenge) != nil,
                  let remaining = p.leaseRemainingMilliseconds, (1...3_000).contains(remaining) else {
                throw CommandValidationError.invalid("native input permit challenge")
            }
        }
        return NativeInputPermit.Binding(instanceID: instanceID, sessionID: sessionID,
            displayID: displayID, displayGeneration: displayGeneration,
            context: try externalObservation(scaling: scaling),
            scaledWidth: scaledWidth, scaledHeight: scaledHeight)
    }
}
