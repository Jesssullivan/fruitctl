import Foundation

/// A rectangle in one pixel space: the scaled display for public requests and
/// results, or the native framebuffer for comparisons. Carries no pixels.
struct FrameRect: Codable, Equatable, Sendable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int

    var maxX: Int { x + width }
    var maxY: Int { y + height }

    /// Validate before arithmetic: every request rectangle must lie inside
    /// the bounds it names and have a positive area.
    func isInside(width boundsWidth: Int, height boundsHeight: Int) -> Bool {
        x >= 0 && y >= 0 && width >= 1 && height >= 1 &&
            width <= boundsWidth && height <= boundsHeight &&
            x <= boundsWidth - width && y <= boundsHeight - height
    }

    func intersection(_ other: FrameRect) -> FrameRect? {
        let left = max(x, other.x), top = max(y, other.y)
        let right = min(maxX, other.maxX), bottom = min(maxY, other.maxY)
        guard right > left, bottom > top else { return nil }
        return FrameRect(x: left, y: top, width: right - left, height: bottom - top)
    }
}

/// Native-pixel inclusion: the union of `include` rectangles (or the whole
/// frame when there are none) minus the union of `exclude` rectangles.
struct FrameMask: Equatable {
    let width: Int
    let height: Int
    let include: [FrameRect]?
    let exclude: [FrameRect]

    /// Included half-open column spans of one row, sorted and disjoint.
    func spans(row y: Int) -> [Range<Int>] {
        guard y >= 0, y < height else { return [] }
        var spans: [Range<Int>]
        if let include {
            spans = Self.merged(include.filter { $0.y <= y && y < $0.maxY }.map { $0.x..<$0.maxX })
        } else {
            spans = [0..<width]
        }
        for cut in exclude where cut.y <= y && y < cut.maxY {
            spans = spans.flatMap { span -> [Range<Int>] in
                guard cut.x < span.upperBound, cut.maxX > span.lowerBound else { return [span] }
                var kept: [Range<Int>] = []
                if span.lowerBound < cut.x { kept.append(span.lowerBound..<cut.x) }
                if cut.maxX < span.upperBound { kept.append(cut.maxX..<span.upperBound) }
                return kept
            }
        }
        return spans
    }

    /// Pixels the mask admits; zero when every requested region is ignored.
    var includedPixels: Int {
        (0..<height).reduce(0) { total, y in total + spans(row: y).reduce(0) { $0 + $1.count } }
    }

    /// The smallest rectangle around every admitted pixel.
    var bounds: FrameRect? {
        var left = Int.max, top = Int.max, right = Int.min, bottom = Int.min
        for y in 0..<height {
            let row = spans(row: y)
            guard let first = row.first, let last = row.last else { continue }
            left = min(left, first.lowerBound); right = max(right, last.upperBound)
            top = min(top, y); bottom = max(bottom, y + 1)
        }
        guard right > left, bottom > top else { return nil }
        return FrameRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    private static func merged(_ ranges: [Range<Int>]) -> [Range<Int>] {
        var result: [Range<Int>] = []
        for range in ranges.sorted(by: { $0.lowerBound < $1.lowerBound }) where !range.isEmpty {
            if let last = result.last, range.lowerBound <= last.upperBound {
                result[result.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                result.append(range)
            }
        }
        return result
    }
}

/// Changed pixels between two RGBX frames of identical geometry, restricted
/// to a mask. Boxes are native-pixel rectangles, largest change first.
struct FrameDiff: Equatable {
    var changedPixels = 0
    var comparedPixels = 0
    var boxes: [FrameRect] = []
    var boxesTruncated = false

    var ratio: Double { comparedPixels == 0 ? 0 : Double(changedPixels) / Double(comparedPixels) }
}

/// What a baseline comparison found, in the scaled display space.
struct FrameDiffSummary: Encodable, Equatable {
    enum Baseline: String, Encodable {
        /// Same connection, allocation and geometry: pixels were compared.
        case matched
        /// The display changed underneath: every admitted pixel counts as changed.
        case geometryChanged = "geometry_changed"
        /// No baseline existed; nothing was compared.
        case absent
    }

    let changed: Bool
    let changedRatio: Double
    let changedPixels: Int
    let comparedPixels: Int
    let boxes: [FrameRect]
    let boxesTruncated: Bool
    let baseline: Baseline

    enum CodingKeys: String, CodingKey {
        case changed, boxes, baseline
        case changedRatio = "changed_ratio"
        case changedPixels = "changed_pixels"
        case comparedPixels = "compared_pixels"
        case boxesTruncated = "boxes_truncated"
    }
}

enum FrameRegion {
    /// Bounds on request size; regions and ignore masks each.
    static let maximumRects = 16
    /// At most this many change boxes are returned.
    static let maximumBoxes = 16
    /// Changed pixels are grouped on this native-pixel grid; neighboring
    /// changed cells, diagonals included, join one box.
    static let cellSize = 16

    /// Scaled -> native, covering every native pixel the scaled rectangle
    /// touches, clamped to the frame. Nil when nothing remains.
    static func toNative(_ rect: FrameRect, nativeWidth: Int, nativeHeight: Int,
                         scaledWidth: Int, scaledHeight: Int) -> FrameRect? {
        guard nativeWidth > 0, nativeHeight > 0, scaledWidth > 0, scaledHeight > 0,
              rect.width > 0, rect.height > 0 else { return nil }
        let frame = FrameRect(x: 0, y: 0, width: scaledWidth, height: scaledHeight)
        guard let clamped = rect.intersection(frame) else { return nil }
        let left = clamped.x * nativeWidth / scaledWidth
        let top = clamped.y * nativeHeight / scaledHeight
        let right = min(nativeWidth, (clamped.maxX * nativeWidth + scaledWidth - 1) / scaledWidth)
        let bottom = min(nativeHeight, (clamped.maxY * nativeHeight + scaledHeight - 1) / scaledHeight)
        guard right > left, bottom > top else { return nil }
        return FrameRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// Native -> scaled, rounded outward so a box never shrinks below the
    /// change it reports, and never smaller than one scaled pixel.
    static func toScaled(_ rect: FrameRect, nativeWidth: Int, nativeHeight: Int,
                         scaledWidth: Int, scaledHeight: Int) -> FrameRect? {
        guard nativeWidth > 0, nativeHeight > 0, scaledWidth > 0, scaledHeight > 0 else { return nil }
        let frame = FrameRect(x: 0, y: 0, width: nativeWidth, height: nativeHeight)
        guard let clamped = rect.intersection(frame) else { return nil }
        let left = min(scaledWidth - 1, clamped.x * scaledWidth / nativeWidth)
        let top = min(scaledHeight - 1, clamped.y * scaledHeight / nativeHeight)
        let right = max(left + 1, min(scaledWidth, (clamped.maxX * scaledWidth + nativeWidth - 1) / nativeWidth))
        let bottom = max(top + 1, min(scaledHeight, (clamped.maxY * scaledHeight + nativeHeight - 1) / nativeHeight))
        return FrameRect(x: left, y: top, width: right - left, height: bottom - top)
    }

    /// Map scaled request rectangles onto a native frame. A nil `include`
    /// admits the whole frame; requested regions that map to nothing admit
    /// nothing rather than silently widening to the whole frame.
    static func mask(include: [FrameRect]?, exclude: [FrameRect], nativeWidth: Int, nativeHeight: Int,
                     scaledWidth: Int, scaledHeight: Int) -> FrameMask {
        func native(_ rect: FrameRect) -> FrameRect? {
            toNative(rect, nativeWidth: nativeWidth, nativeHeight: nativeHeight,
                     scaledWidth: scaledWidth, scaledHeight: scaledHeight)
        }
        return FrameMask(width: nativeWidth, height: nativeHeight,
                         include: include.map { $0.compactMap(native) }, exclude: exclude.compactMap(native))
    }

    /// Compare color channels only: the fourth byte of each RGBX pixel is
    /// padding and is never a visible change. Nil for mismatched buffers.
    static func compare(_ baseline: UnsafeRawBufferPointer, _ current: UnsafeRawBufferPointer,
                        width: Int, height: Int, mask: FrameMask) -> FrameDiff? {
        let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
        let (bytes, byteOverflow) = pixels.multipliedReportingOverflow(by: 4)
        guard width > 0, height > 0, !overflow, !byteOverflow,
              baseline.count == bytes, current.count == bytes,
              mask.width == width, mask.height == height else { return nil }
        let old = baseline.bindMemory(to: UInt8.self)
        let new = current.bindMemory(to: UInt8.self)
        let columns = (width + cellSize - 1) / cellSize
        let rows = (height + cellSize - 1) / cellSize
        var counts = [Int](repeating: 0, count: columns * rows)
        var cellLeft = [Int](repeating: 0, count: counts.count)
        var cellTop = [Int](repeating: 0, count: counts.count)
        var cellRight = [Int](repeating: 0, count: counts.count)
        var cellBottom = [Int](repeating: 0, count: counts.count)
        var diff = FrameDiff()
        for y in 0..<height {
            let rowOffset = y * width * 4
            let cellRow = (y / cellSize) * columns
            for span in mask.spans(row: y) {
                diff.comparedPixels += span.count
                for x in span {
                    let offset = rowOffset + x * 4
                    guard old[offset] != new[offset] || old[offset + 1] != new[offset + 1] ||
                          old[offset + 2] != new[offset + 2] else { continue }
                    diff.changedPixels += 1
                    let cell = cellRow + x / cellSize
                    if counts[cell] == 0 {
                        cellLeft[cell] = x; cellRight[cell] = x + 1
                        cellTop[cell] = y; cellBottom[cell] = y + 1
                    } else {
                        cellLeft[cell] = min(cellLeft[cell], x); cellRight[cell] = max(cellRight[cell], x + 1)
                        cellBottom[cell] = y + 1
                    }
                    counts[cell] += 1
                }
            }
        }
        guard diff.changedPixels > 0 else { return diff }
        // Group changed cells into connected components, each one box.
        var visited = [Bool](repeating: false, count: counts.count)
        var components: [(box: FrameRect, pixels: Int)] = []
        for start in counts.indices where counts[start] > 0 && !visited[start] {
            visited[start] = true
            var stack = [start]
            var left = Int.max, top = Int.max, right = Int.min, bottom = Int.min, changed = 0
            while let cell = stack.popLast() {
                left = min(left, cellLeft[cell]); top = min(top, cellTop[cell])
                right = max(right, cellRight[cell]); bottom = max(bottom, cellBottom[cell])
                changed += counts[cell]
                let column = cell % columns, row = cell / columns
                for neighborRow in max(0, row - 1)...min(rows - 1, row + 1) {
                    for neighborColumn in max(0, column - 1)...min(columns - 1, column + 1) {
                        let neighbor = neighborRow * columns + neighborColumn
                        if counts[neighbor] > 0 && !visited[neighbor] {
                            visited[neighbor] = true
                            stack.append(neighbor)
                        }
                    }
                }
            }
            components.append((FrameRect(x: left, y: top, width: right - left, height: bottom - top), changed))
        }
        // Largest change first; position breaks ties so results are stable.
        components.sort {
            ($0.pixels, -$0.box.y, -$0.box.x) > ($1.pixels, -$1.box.y, -$1.box.x)
        }
        diff.boxes = components.prefix(maximumBoxes).map(\.box)
        diff.boxesTruncated = components.count > maximumBoxes
        return diff
    }

    /// Compare a current owned frame against a baseline in the scaled space
    /// the caller uses. A changed connection, allocation or geometry cannot
    /// be compared pixel by pixel and reports every admitted pixel changed.
    static func evaluate(baseline: (pixels: Data, context: VNCInputContext)?, current: Data,
                         context: VNCInputContext, include: [FrameRect]?, exclude: [FrameRect],
                         scaledWidth: Int, scaledHeight: Int) -> FrameDiffSummary {
        let frameMask = Self.mask(include: include, exclude: exclude, nativeWidth: context.width,
                                  nativeHeight: context.height, scaledWidth: scaledWidth, scaledHeight: scaledHeight)
        func scaled(_ rect: FrameRect) -> FrameRect? {
            toScaled(rect, nativeWidth: context.width, nativeHeight: context.height,
                     scaledWidth: scaledWidth, scaledHeight: scaledHeight)
        }
        guard let baseline else {
            return FrameDiffSummary(changed: false, changedRatio: 0, changedPixels: 0, comparedPixels: 0,
                                    boxes: [], boxesTruncated: false, baseline: .absent)
        }
        let diff: FrameDiff? = baseline.context == context
            ? baseline.pixels.withUnsafeBytes { old in
                current.withUnsafeBytes { new in
                    compare(old, new, width: context.width, height: context.height, mask: frameMask)
                }
            }
            : nil
        guard let diff else {
            let admitted = frameMask.includedPixels
            return FrameDiffSummary(changed: admitted > 0, changedRatio: admitted > 0 ? 1 : 0,
                                    changedPixels: admitted, comparedPixels: admitted,
                                    boxes: frameMask.bounds.flatMap(scaled).map { [$0] } ?? [],
                                    boxesTruncated: false, baseline: .geometryChanged)
        }
        return FrameDiffSummary(changed: diff.changedPixels > 0,
                                changedRatio: (diff.ratio * 1_000_000).rounded() / 1_000_000,
                                changedPixels: diff.changedPixels, comparedPixels: diff.comparedPixels,
                                boxes: diff.boxes.compactMap(scaled), boxesTruncated: diff.boxesTruncated,
                                baseline: .matched)
    }
}

/// Pure timing state for wait_for_stable. A run of unchanged fresh frames
/// starts at the capture that last differed from its predecessor; the screen
/// is stable once the newest capture is at least `stableMilliseconds` after
/// that. A stable verdict reached by the last capture outranks the timeout.
struct FrameStability {
    let stableMilliseconds: UInt64
    let timeoutMilliseconds: UInt64
    let startedMilliseconds: UInt64
    private(set) var runStartMilliseconds: UInt64
    private(set) var lastCaptureMilliseconds: UInt64
    private(set) var captures = 1

    init(stableMilliseconds: Int, timeoutMilliseconds: Int, startedMilliseconds: UInt64,
         firstCaptureMilliseconds: UInt64) {
        self.stableMilliseconds = UInt64(max(0, stableMilliseconds))
        self.timeoutMilliseconds = UInt64(max(0, timeoutMilliseconds))
        self.startedMilliseconds = startedMilliseconds
        let first = max(startedMilliseconds, firstCaptureMilliseconds)
        runStartMilliseconds = first
        lastCaptureMilliseconds = first
    }

    var isStable: Bool { lastCaptureMilliseconds - runStartMilliseconds >= stableMilliseconds }

    var stableForMilliseconds: UInt64 { lastCaptureMilliseconds - runStartMilliseconds }

    func elapsed(atMilliseconds now: UInt64) -> UInt64 {
        now > startedMilliseconds ? now - startedMilliseconds : 0
    }

    func isExpired(atMilliseconds now: UInt64) -> Bool { elapsed(atMilliseconds: now) >= timeoutMilliseconds }

    mutating func observe(changed: Bool, atMilliseconds now: UInt64) {
        let at = max(now, lastCaptureMilliseconds)
        captures += 1
        lastCaptureMilliseconds = at
        if changed { runStartMilliseconds = at }
    }

    /// Spacing between captures: often enough to resolve `stableMilliseconds`,
    /// never a busy loop.
    static func pollMilliseconds(stableMilliseconds: Int) -> UInt64 {
        UInt64(min(250, max(50, stableMilliseconds / 4)))
    }
}
