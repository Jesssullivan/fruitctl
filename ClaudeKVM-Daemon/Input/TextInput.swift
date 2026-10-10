import Foundation

extension InputController {

    /// Validate and plan the whole text before input or failure cleanup can
    /// mutate held state. Execution keeps cancellation/observation checks on
    /// every key and pause, and never substitutes a clipboard operation.
    func typeText(_ text: String) async throws {
        let plan = try TextInputPlan(text, timing: timing)
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

    /// Explicit VNC clipboard + combo operation; typing never selects it automatically.
    /// clientCutText → 30ms → cmd+v (macOS) or ctrl+v (other).
    func pasteText(_ text: String) async throws {
        try checkInputAdmission()
        try await vnc.sendClipboardText(text, context: context, inputPermit: inputPermit)
        try await pause(timing.pasteSettleUs)
        if vnc.isMacOS {
            try await keyCombo("cmd+v")
        } else {
            try await keyCombo("ctrl+v")
        }
    }
}
