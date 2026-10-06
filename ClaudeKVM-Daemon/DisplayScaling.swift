import Foundation

final class DisplayScaling {
    private(set) var nativeWidth: Int
    private(set) var nativeHeight: Int
    private(set) var scaledWidth: Int
    private(set) var scaledHeight: Int
    private(set) var maxDimension: Int
    let initialMaxDimension: Int

    init(nativeWidth: Int, nativeHeight: Int, maxDimension: Int = 1280) {
        self.nativeWidth = max(1, nativeWidth)
        self.nativeHeight = max(1, nativeHeight)
        self.maxDimension = max(1, maxDimension)
        self.initialMaxDimension = self.maxDimension
        self.scaledWidth = 1
        self.scaledHeight = 1
        recalculate()
    }

    private func recalculate() {
        let ratio = min(
            Double(maxDimension) / Double(nativeWidth),
            Double(maxDimension) / Double(nativeHeight),
            1.0
        )
        self.scaledWidth = max(1, Int((Double(nativeWidth) * ratio).rounded()))
        self.scaledHeight = max(1, Int((Double(nativeHeight) * ratio).rounded()))
    }

    func reconfigure(maxDimension: Int) {
        self.maxDimension = max(1, maxDimension)
        recalculate()
    }

    /// Call only from an admitted owned frame, never an independently read size.
    func updateGeometry(width: Int, height: Int) {
        nativeWidth = max(1, width)
        nativeHeight = max(1, height)
        recalculate()
    }

    func reset() {
        reconfigure(maxDimension: initialMaxDimension)
    }

    func toNative(x: Int, y: Int) -> (x: Int, y: Int) {
        let sx = Double(nativeWidth) / Double(scaledWidth)
        let sy = Double(nativeHeight) / Double(scaledHeight)
        let boundedX = min(scaledWidth - 1, max(0, x))
        let boundedY = min(scaledHeight - 1, max(0, y))
        return (x: min(nativeWidth - 1, Int((Double(boundedX) * sx).rounded())),
                y: min(nativeHeight - 1, Int((Double(boundedY) * sy).rounded())))
    }

    func toScaled(x: Int, y: Int) -> (x: Int, y: Int) {
        let sx = Double(scaledWidth) / Double(nativeWidth)
        let sy = Double(scaledHeight) / Double(nativeHeight)
        let boundedX = min(nativeWidth - 1, max(0, x))
        let boundedY = min(nativeHeight - 1, max(0, y))
        return (x: min(scaledWidth - 1, Int((Double(boundedX) * sx).rounded())),
                y: min(scaledHeight - 1, Int((Double(boundedY) * sy).rounded())))
    }
}
