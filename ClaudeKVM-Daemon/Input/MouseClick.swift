import Foundation

extension InputController {

    /// Left click: press → 50ms hold → release.
    func mouseClick(x: Int, y: Int, button: MouseButton = .left) async throws {
        try await releasingOnFailure {
            try await emitPointer(x: x, y: y, buttonMask: button.rawValue)
            cursorX = x
            cursorY = y
            try await pause(timing.clickHoldUs)
            try await emitPointer(x: x, y: y, buttonMask: 0)
        }
    }

    /// Double click: click → 50ms gap → click.
    func mouseDoubleClick(x: Int, y: Int) async throws {
        try await mouseClick(x: x, y: y, button: .left)
        try await pause(timing.doubleClickGapUs)
        try await mouseClick(x: x, y: y, button: .left)
    }

    /// Right click: press(mask=4) → 50ms → release.
    func mouseRightClick(x: Int, y: Int) async throws {
        try await mouseClick(x: x, y: y, button: .right)
    }
}
