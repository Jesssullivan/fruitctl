import Foundation

extension InputController {

    /// Drag from A to B with interpolated path.
    /// N = max(10, ceil(distance / 20)) intermediate points.
    /// Straight line, deterministic timing, zero randomness.
    func mouseDrag(fromX: Int, fromY: Int, toX: Int, toY: Int) async throws {
        try await releasingOnFailure {
            let dx = Double(toX - fromX)
            let dy = Double(toY - fromY)
            let distance = (dx * dx + dy * dy).squareRoot()
            let steps = max(timing.dragMinSteps, Int((distance / timing.dragPixelsPerStep).rounded(.up)))

            // Position at start
            try await emitPointer(x: fromX, y: fromY, buttonMask: 0)
            cursorX = fromX
            cursorY = fromY
            try await pause(timing.dragPositionUs)

            // Press — OS drag threshold
            try await emitPointer(x: fromX, y: fromY, buttonMask: MouseButton.left.rawValue)
            try await pause(timing.dragPressUs)

            // Interpolate straight line
            for i in 1...steps {
                let t = Double(i) / Double(steps)
                let ix = fromX + Int((dx * t).rounded())
                let iy = fromY + Int((dy * t).rounded())
                try await emitPointer(x: ix, y: iy, buttonMask: MouseButton.left.rawValue)
                try await pause(timing.dragStepUs)
            }

            // Final position guarantee + settle
            try await emitPointer(x: toX, y: toY, buttonMask: MouseButton.left.rawValue)
            try await pause(timing.dragSettleUs)

            // Release
            try await emitPointer(x: toX, y: toY, buttonMask: 0)
            cursorX = toX
            cursorY = toY
        }
    }
}
