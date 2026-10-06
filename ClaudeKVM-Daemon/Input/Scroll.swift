import Foundation

extension InputController {

    /// Scroll: per tick press→10ms→release→20ms.
    /// One event per tick, deterministic.
    func scroll(x: Int, y: Int, direction: ScrollDirection, amount: Int = 3) async throws {
        try await releasingOnFailure {
            try await emitPointer(x: x, y: y, buttonMask: 0)
            cursorX = x
            cursorY = y

            let mask = direction.buttonMask

            for _ in 0..<amount {
                try await emitPointer(x: x, y: y, buttonMask: mask)
                try await pause(timing.scrollPressUs)
                try await emitPointer(x: x, y: y, buttonMask: 0)
                try await pause(timing.scrollTickUs)
            }
        }
    }
}
