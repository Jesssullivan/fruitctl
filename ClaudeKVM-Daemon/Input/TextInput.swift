import Foundation

extension InputController {

    /// Type text character by character. Fixed timing, zero randomness.
    /// Per char: [shift down 10ms] → key down 20ms → key up → [10ms shift up] → 20ms inter-key.
    func typeText(_ text: String) async throws {
        try await releasingOnFailure {
            for ch in text {
                let (keysym, needsShift) = charToKeysym(ch)
                guard keysym != 0 else { continue }

                if needsShift {
                    try await emitKey(key: KeySym.shiftLeft, down: true)
                    try await pause(timing.typeShiftUs)
                }

                try await emitKey(key: keysym, down: true)
                try await pause(timing.typeKeyUs)
                try await emitKey(key: keysym, down: false)

                if needsShift {
                    try await pause(timing.typeShiftUs)
                    try await emitKey(key: KeySym.shiftLeft, down: false)
                }

                try await pause(timing.typeInterKeyUs)
            }
        }
    }

    /// Paste via VNC clipboard + combo. Always preferred over typeText.
    /// clientCutText → 30ms → cmd+v (macOS) or ctrl+v (other).
    func pasteText(_ text: String) async throws {
        try await vnc.sendClipboardText(text, context: context)
        try await pause(timing.pasteSettleUs)
        if vnc.isMacOS {
            try await keyCombo("cmd+v")
        } else {
            try await keyCombo("ctrl+v")
        }
    }
}
