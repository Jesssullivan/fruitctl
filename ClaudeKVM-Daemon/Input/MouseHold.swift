import Foundation

extension InputController {

    /// D27: press and keep one button held for the rest of the action_queue
    /// batch named by `scope`. The press lands at (x, y); later pointer writes
    /// in the batch keep it pressed until mouse_up, batch end or abort.
    func mouseDown(x: Int, y: Int, button: MouseButton, scope: String) async throws {
        guard holdMask & button.rawValue == 0 else { throw NativeInputRefusal.buttonAlreadyHeld }
        try await releasingOnFailure {
            try await emitPointer(x: x, y: y, buttonMask: button.rawValue)
            beginHold(button, scope: scope)
        }
    }

    /// Release one held button at (x, y), or at the tracked position.
    func mouseUp(x: Int?, y: Int?, button: MouseButton) async throws {
        guard holdMask & button.rawValue != 0 else { throw NativeInputRefusal.buttonNotHeld }
        try await releasingOnFailure {
            endHold(button)
            try await emitPointer(x: x ?? cursorX, y: y ?? cursorY, buttonMask: 0)
        }
    }
}
