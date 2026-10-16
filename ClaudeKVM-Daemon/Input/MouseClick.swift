import Foundation

extension InputController {

    /// Left click: press → 50ms hold → release.
    /// Modifiers press in order (10ms each) before the press and release in
    /// reverse after it, inside the same failure release.
    func mouseClick(x: Int, y: Int, button: MouseButton = .left, modifiers: [UInt32] = []) async throws {
        try await releasingOnFailure {
            for modifier in modifiers {
                try await emitKey(key: modifier, down: true)
                try await pause(timing.comboModUs)
            }
            try await emitPointer(x: x, y: y, buttonMask: button.rawValue)
            cursorX = x
            cursorY = y
            try await pause(timing.clickHoldUs)
            try await emitPointer(x: x, y: y, buttonMask: 0)
            for modifier in modifiers.reversed() {
                try await pause(timing.comboModUs)
                try await emitKey(key: modifier, down: false)
            }
        }
    }

    /// Double click: click → 50ms gap → click.
    func mouseDoubleClick(x: Int, y: Int) async throws {
        try await mouseClick(x: x, y: y, button: .left)
        try await pause(timing.doubleClickGapUs)
        try await mouseClick(x: x, y: y, button: .left)
    }

    /// Triple click: click → gap → click → gap → click (same double-click gap).
    func mouseTripleClick(x: Int, y: Int) async throws {
        try await mouseDoubleClick(x: x, y: y)
        try await pause(timing.doubleClickGapUs)
        try await mouseClick(x: x, y: y, button: .left)
    }

    /// Right click: press(mask=4) → 50ms → release.
    func mouseRightClick(x: Int, y: Int) async throws {
        try await mouseClick(x: x, y: y, button: .right)
    }
}
