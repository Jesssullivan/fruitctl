import Foundation

extension InputController {

    /// Teleport. Single pointerEvent, no wait.
    func mouseMove(x: Int, y: Int) async throws {
        try await emitPointer(x: x, y: y, buttonMask: 0)
        cursorX = x
        cursorY = y
    }

    /// Move + settle wait for hover recognition.
    func mouseHover(x: Int, y: Int) async throws {
        try await mouseMove(x: x, y: y)
        try await pause(timing.hoverSettleUs)
    }

    /// Relative cursor nudge from current position.
    func mouseNudge(dx: Int, dy: Int) async throws {
        let newX = min((context?.width ?? Int(Int32.max)) - 1, max(0, cursorX + dx))
        let newY = min((context?.height ?? Int(Int32.max)) - 1, max(0, cursorY + dy))
        try await mouseMove(x: newX, y: newY)
    }
}
