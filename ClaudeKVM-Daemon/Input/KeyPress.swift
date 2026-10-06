import Foundation

extension InputController {

    /// Single key: press → 30ms → release.
    func keyTap(_ keysym: UInt32) async throws {
        try await releasingOnFailure {
            try await emitKey(key: keysym, down: true)
            try await pause(timing.keyHoldUs)
            try await emitKey(key: keysym, down: false)
        }
    }

    /// Key combo from keysym array. LIFO modifier order.
    /// Modifiers press (10ms each) → key press-release (30ms) → modifiers release reversed (10ms each).
    func keyCombo(_ keysyms: [UInt32]) async throws {
        try await releasingOnFailure {
            guard keysyms.count >= 2 else {
                if let single = keysyms.first {
                    try await keyTap(single)
                }
                return
            }

            let modifiers = Array(keysyms.dropLast())
            guard let key = keysyms.last else { return }

            // Press modifiers in order
            for mod in modifiers {
                try await emitKey(key: mod, down: true)
                try await pause(timing.comboModUs)
            }

            // Press-release main key
            try await emitKey(key: key, down: true)
            try await pause(timing.keyHoldUs)
            try await emitKey(key: key, down: false)
            try await pause(timing.comboModUs)

            // Release modifiers in reverse (LIFO)
            for mod in modifiers.reversed() {
                try await emitKey(key: mod, down: false)
                try await pause(timing.comboModUs)
            }
        }
    }

    /// Parse combo string like "cmd+c" → keysyms → execute.
    func keyCombo(_ combo: String) async throws {
        let parts = combo.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        let syms = parts.compactMap { namedKeyToKeysym($0) }
        guard syms.count == parts.count else {
            throw VNCError.sendFailed("Unknown key in combo: \(combo)")
        }
        try await keyCombo(syms)
    }
}
