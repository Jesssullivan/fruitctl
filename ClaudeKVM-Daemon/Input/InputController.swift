import Foundation

final class InputController {
    let vnc: VNCBridge
    var timing: InputTiming

    var cursorX: Int = 0
    var cursorY: Int = 0
    var context: VNCInputContext?
    private(set) var heldKeys: [UInt32] = []
    private(set) var heldButtons = false
    private var heldContext: VNCInputContext?
    typealias PointerSender = (Int, Int, Int, VNCInputContext?, Bool) async throws -> Void
    typealias KeySender = (UInt32, Bool, VNCInputContext?, Bool) async throws -> Void
    private let pointerSender: PointerSender
    private let keySender: KeySender
    private let sleeper: (UInt32) async throws -> Void

    init(vnc: VNCBridge, timing: InputTiming = .init(),
         pointerSender: PointerSender? = nil, keySender: KeySender? = nil,
         sleeper: ((UInt32) async throws -> Void)? = nil) {
        self.vnc = vnc
        self.timing = timing
        self.pointerSender = pointerSender ?? { x, y, mask, context, release in
            try await vnc.sendMouseEvent(x: x, y: y, buttonMask: mask, context: context, releaseOnly: release)
        }
        self.keySender = keySender ?? { key, down, context, release in
            try await vnc.sendKeyEvent(key: key, down: down, context: context, releaseOnly: release)
        }
        self.sleeper = sleeper ?? { microseconds in
            try await Task.sleep(nanoseconds: UInt64(microseconds) * 1000)
        }
    }

    var cursorPosition: (x: Int, y: Int) { (cursorX, cursorY) }

    func adoptObservation(_ expected: VNCInputContext, scaling: DisplayScaling) async throws {
        context = nil
        guard heldKeys.isEmpty, !heldButtons else {
            throw VNCError.sendFailed("Previous input release is unconfirmed; external adoption refused")
        }
        let admitted = try await vnc.validateExternalObservation(expected)
        try Task.checkCancellation()
        scaling.updateGeometry(width: admitted.width, height: admitted.height)
        cursorX = min(max(0, cursorX), admitted.width - 1)
        cursorY = min(max(0, cursorY), admitted.height - 1)
        context = admitted
    }

    func pause(_ microseconds: UInt32) async throws {
        try Task.checkCancellation()
        try await sleeper(microseconds)
        try Task.checkCancellation()
    }

    func emitPointer(x: Int, y: Int, buttonMask: Int = 0) async throws {
        try Task.checkCancellation()
        // A failed write may still have reached the server. Track before send.
        if buttonMask != 0 {
            if heldKeys.isEmpty && !heldButtons { heldContext = context }
            heldButtons = true
        }
        cursorX = x; cursorY = y
        try await pointerSender(x, y, buttonMask, context, false)
        if buttonMask == 0 { heldButtons = false }
    }

    func emitKey(key: UInt32, down: Bool) async throws {
        try Task.checkCancellation()
        if down && !heldKeys.contains(key) {
            if heldKeys.isEmpty && !heldButtons { heldContext = context }
            heldKeys.append(key)
        }
        try await keySender(key, down, context, false)
        if !down { heldKeys.removeAll { $0 == key } }
    }

    /// Releases do not inherit cancellation checks and never press/replay input.
    /// The bridge refuses to release into a different reconnected session.
    @discardableResult
    func releaseHeldInput() async -> Bool {
        var unreleased: [UInt32] = []
        for key in heldKeys.reversed() {
            do { try await keySender(key, false, heldContext, true) }
            catch { unreleased.append(key) }
        }
        heldKeys = Array(unreleased.reversed())
        if heldButtons {
            do {
                try await pointerSender(cursorX, cursorY, 0, heldContext, true)
                heldButtons = false
            } catch {}
        }
        let released = heldKeys.isEmpty && !heldButtons
        if released { heldContext = nil }
        return released
    }

    func releasingOnFailure(_ operation: () async throws -> Void) async throws {
        do { try await operation() }
        catch {
            guard await releaseHeldInput() else {
                throw VNCError.sendFailed("Input failed and held-state release could not be confirmed")
            }
            throw error
        }
    }
}
