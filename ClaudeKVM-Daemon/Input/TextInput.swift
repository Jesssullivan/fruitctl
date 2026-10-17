import Foundation

/// Per-target text policy, fixed at launch from the profile.
struct TextRouting: Equatable {
    /// D29 `input.pasteUnmappable`: text the US keymap cannot type goes
    /// through the clipboard (save, set, Cmd+V, restore). Off by default.
    var pasteUnmappable = false
    /// False when the profile declares an input source that is not
    /// US-compatible: then no printable character is typed as a key.
    var usCompatibleInputSource = true

    enum Segment: Equatable {
        case keys(String)
        case paste(String)
    }

    /// Split text into keyed and pasted runs, preserving scalar order. A US
    /// keymap types printable ASCII; Return and Tab are layout-independent
    /// keys. With a non-US source every printable scalar is pasted.
    static func segments(_ text: String, usCompatible: Bool) -> [Segment] {
        var segments: [Segment] = []
        var run = String.UnicodeScalarView()
        var runIsKeys = true
        for scalar in text.unicodeScalars {
            let code = scalar.value
            let key = code == 0x09 || code == 0x0A || code == 0x0D || (usCompatible && (0x20...0x7E).contains(code))
            if key != runIsKeys, !run.isEmpty {
                segments.append(runIsKeys ? .keys(String(run)) : .paste(String(run)))
                run = String.UnicodeScalarView()
            }
            runIsKeys = key
            run.append(scalar)
        }
        if !run.isEmpty { segments.append(runIsKeys ? .keys(String(run)) : .paste(String(run))) }
        return segments
    }
}

/// How key_type reached the target; `paste` is journalled as a paste (D29).
enum TextInputKind: String {
    case keys
    case paste
}

extension InputController {

    /// Validate and plan the whole text before input or failure cleanup can
    /// mutate held state. Execution keeps cancellation/observation checks on
    /// every key and pause. The clipboard is used only when the caller asks
    /// for routing and the target opted in (D29); type_secret never asks.
    @discardableResult
    func typeText(_ text: String, routeUnmappable: Bool = false) async throws -> TextInputKind {
        let plan = try TextInputPlan(text, timing: timing)
        let routing = routeUnmappable && textRouting.pasteUnmappable
        if !textRouting.usCompatibleInputSource && !routing &&
            plan.strokes.contains(where: { $0.keysym != KeySym.returnKey && $0.keysym != KeySym.tab }) {
            throw NativeInputRefusal.inputSourceNotUS
        }
        let segments = routing
            ? TextRouting.segments(text, usCompatible: textRouting.usCompatibleInputSource) : []
        guard segments.contains(where: { if case .paste = $0 { return true } else { return false } }) else {
            try await typePlanned(plan)
            return .keys
        }
        try await typeRouted(segments)
        return .paste
    }


    /// D16: a broker-resolved secret. The whole value is planned before any
    /// event, so an untypable secret sends no click and no key. An optional
    /// left click focuses the field, then the ordinary stroke path types it.
    /// There is no clipboard path (D29), and a failure never names a
    /// character of the secret.
    func typeSecret(_ secret: String, focusAt point: (x: Int, y: Int)?) async throws {
        guard !secret.isEmpty, secret.utf8.count <= SecretTypingError.maximumUTF8Bytes else {
            throw SecretTypingError.invalidLength
        }
        let plan: TextInputPlan
        do { plan = try TextInputPlan(secret, timing: timing) } catch is TextInputPlanError {
            throw SecretTypingError.untypable
        }
        // A non-US layout would type other characters into the field; refuse
        // before the focus click. A secret is never pasted instead (D29).
        if !textRouting.usCompatibleInputSource &&
            plan.strokes.contains(where: { $0.keysym != KeySym.returnKey && $0.keysym != KeySym.tab }) {
            throw NativeInputRefusal.inputSourceNotUS
        }
        // The settle gate is waited out once, before the first event, so a
        // typed input_not_ready (-32013) still means nothing was sent.
        try await awaitInputReady()
        do {
            if let point { try await mouseClick(x: point.x, y: point.y) }
            try await typePlanned(plan)
        } catch let error as VNCError {
            // A later not-ready (a reconnect mid-secret) may follow written
            // keys; it must not read as a refusal before any key.
            if case .inputNotReady = error { throw SecretTypingError.interrupted }
            throw error
        }
    }

    private func typePlanned(_ plan: TextInputPlan) async throws {
        try await releasingOnFailure {
            try checkInputAdmission()
            for stroke in plan.strokes {
                if stroke.shift {
                    try await emitKey(key: KeySym.shiftLeft, down: true)
                    try await pause(plan.timing.typeShiftUs)
                }

                try await emitKey(key: stroke.keysym, down: true)
                try await pause(plan.timing.typeKeyUs)
                try await emitKey(key: stroke.keysym, down: false)

                if stroke.shift {
                    try await pause(plan.timing.typeShiftUs)
                    try await emitKey(key: KeySym.shiftLeft, down: false)
                }

                try await pause(plan.timing.typeInterKeyUs)
            }
        }
    }

    /// D29: keyed runs as keys, the rest pasted. Every refusal (encoding,
    /// unknown clipboard to restore) happens before the first event. The
    /// saved clipboard is written back after the last paste, and also after
    /// a failure or cancellation once a paste has replaced it.
    private func typeRouted(_ segments: [TextRouting.Segment]) async throws {
        var plans: [Int: TextInputPlan] = [:]
        for (index, segment) in segments.enumerated() {
            switch segment {
            case .keys(let run): plans[index] = try TextInputPlan(run, timing: timing)
            case .paste(let run):
                guard vnc.clipboardEncoding(for: run) != nil else {
                    throw NativeInputRefusal.clipboardUnicodeUnsupported
                }
            }
        }
        try checkInputAdmission()
        try await awaitInputReady()
        guard let saved = try await vnc.readClipboard(waitNanoseconds: Self.clipboardReadWaitNs(requestDeadlineNs,
                                                                                                now: inputSettle.now())),
              vnc.clipboardEncoding(for: saved.snapshot.text) != nil else {
            throw NativeInputRefusal.clipboardRestoreUnavailable
        }
        let restoreContext = context
        var replaced = false
        do {
            try await releasingOnFailure {
                for (index, segment) in segments.enumerated() {
                    switch segment {
                    case .keys:
                        guard let plan = plans[index] else { continue }
                        try await typePlanned(plan)
                    case .paste(let run):
                        replaced = true
                        try await pasteText(run)
                        try await pause(timing.pasteRestoreUs)
                    }
                }
            }
        } catch {
            if replaced { _ = try? await vnc.restoreClipboardText(saved.snapshot.text, context: restoreContext) }
            throw error
        }
        do { try await vnc.restoreClipboardText(saved.snapshot.text, context: restoreContext) }
        catch { throw VNCError.sendFailed("Text was pasted but the clipboard restore is unconfirmed") }
    }

    /// The wait for a server's clipboard answer: 1.5 s, inside the request budget.
    static func clipboardReadWaitNs(_ deadlineNs: UInt64?, now: UInt64) -> UInt64 {
        let wait: UInt64 = 1_500_000_000
        guard let deadlineNs else { return wait }
        return deadlineNs > now ? min(wait, (deadlineNs - now) / 2) : 0
    }

    /// Explicit VNC clipboard + combo operation; typing never selects it automatically.
    /// clientCutText → 30ms → cmd+v (macOS) or ctrl+v (other).
    func pasteText(_ text: String) async throws {
        try checkInputAdmission()
        try await awaitInputReady()
        try await vnc.sendClipboardText(text, context: context, inputPermit: inputPermit)
        try await pause(timing.pasteSettleUs)
        if vnc.isMacOS {
            try await keyCombo("cmd+v")
        } else {
            try await keyCombo("ctrl+v")
        }
    }
}

/// Fixed type_secret failures. Neither names a character or the length.
enum SecretTypingError: LocalizedError {
    static let maximumUTF8Bytes = 4096
    case invalidLength
    case untypable
    case interrupted

    var errorDescription: String? {
        switch self {
        case .invalidLength: return "Secret is empty or exceeds the 4096-byte limit"
        case .untypable: return "Secret contains a character that cannot be typed"
        case .interrupted: return "Input stopped being ready after the secret's first event"
        }
    }
}
