import ApplicationServices
import CoreGraphics
import Foundation

/// The configured display's pixel framebuffer and its point-space bounds.
/// CGDisplayPixelsWide/High report the mode's point size on HiDPI displays,
/// so pixel sizes come from the display mode and the scale is derived here.
struct HostDisplayGeometry: Equatable {
    let pixelWidth: Int
    let pixelHeight: Int
    let bounds: CGRect

    /// Pixels per point. Both axes must agree to within one pixel; ScreenCaptureKit
    /// is asked for exactly pixelWidth x pixelHeight and no other scale is inferred.
    var scale: Double { Double(pixelWidth) / Double(bounds.width) }
    var pointWidth: Double { Double(bounds.width) }
    var pointHeight: Double { Double(bounds.height) }

    /// Pure geometry check. A mode without pixel sizes, an empty or infinite
    /// bounds, an oversized framebuffer or anisotropic scaling is unavailable.
    static func compute(modePixelWidth: Int, modePixelHeight: Int, bounds: CGRect) -> HostDisplayGeometry? {
        guard modePixelWidth > 0, modePixelHeight > 0, modePixelWidth <= 16_384, modePixelHeight <= 16_384,
              modePixelWidth <= 33_554_432 / modePixelHeight,
              !bounds.isNull, !bounds.isInfinite, bounds.width > 0, bounds.height > 0,
              bounds.width.isFinite, bounds.height.isFinite,
              bounds.origin.x.isFinite, bounds.origin.y.isFinite else { return nil }
        let geometry = HostDisplayGeometry(pixelWidth: modePixelWidth, pixelHeight: modePixelHeight,
                                           bounds: bounds)
        guard geometry.scale >= 1, geometry.scale <= 8,
              abs(Double(modePixelHeight) - geometry.pointHeight * geometry.scale) < 1 else { return nil }
        return geometry
    }

    static func current(_ displayID: CGDirectDisplayID) -> HostDisplayGeometry? {
        guard let mode = CGDisplayCopyDisplayMode(displayID) else { return nil }
        return compute(modePixelWidth: mode.pixelWidth, modePixelHeight: mode.pixelHeight,
                       bounds: CGDisplayBounds(displayID))
    }

    /// Maps a global point-space rectangle into this framebuffer's pixels. A
    /// rectangle with no visible area on this display maps to nil.
    func pixelRect(forGlobalPoints rect: CGRect) -> (x: Int, y: Int, width: Int, height: Int)? {
        guard !rect.isNull, !rect.isInfinite, rect.width.isFinite, rect.height.isFinite,
              rect.origin.x.isFinite, rect.origin.y.isFinite else { return nil }
        let visible = rect.standardized.intersection(bounds)
        guard !visible.isNull, visible.width > 0, visible.height > 0 else { return nil }
        let left = Int(((Double(visible.minX) - Double(bounds.minX)) * scale).rounded(.down))
        let top = Int(((Double(visible.minY) - Double(bounds.minY)) * scale).rounded(.down))
        let right = Int(((Double(visible.maxX) - Double(bounds.minX)) * scale).rounded(.up))
        let bottom = Int(((Double(visible.maxY) - Double(bounds.minY)) * scale).rounded(.up))
        let x = max(0, min(left, pixelWidth)), y = max(0, min(top, pixelHeight))
        let width = max(0, min(right, pixelWidth) - x), height = max(0, min(bottom, pixelHeight) - y)
        guard width > 0, height > 0 else { return nil }
        return (x, y, width, height)
    }

    var metadata: [String: HostValue] {
        ["pixel_width": .integer(Int64(pixelWidth)), "pixel_height": .integer(Int64(pixelHeight)),
         "point_width": .number(pointWidth), "point_height": .number(pointHeight),
         "scale": .number(scale)]
    }
}

/// Stable display identity. Display IDs can change across reconnects; the
/// CoreGraphics display UUID names the same panel across them.
enum HostDisplayIdentity {
    /// Canonical uppercase form, or nil when the text is not a UUID.
    static func canonical(_ text: String) -> String? {
        UUID(uuidString: text)?.uuidString
    }

    /// Pure resolution over a supplied online list. Exactly one online display
    /// must carry the UUID; none or several is unavailable, never a guess.
    static func resolve(_ uuid: String, online: [CGDirectDisplayID],
                        uuidOf: (CGDirectDisplayID) -> String?) -> CGDirectDisplayID? {
        guard let wanted = canonical(uuid) else { return nil }
        let matches = online.filter { display in uuidOf(display).flatMap(canonical) == wanted }
        return matches.count == 1 ? matches[0] : nil
    }

    static func uuid(of displayID: CGDirectDisplayID) -> String? {
        guard let value = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue(),
              let text = CFUUIDCreateString(kCFAllocatorDefault, value) else { return nil }
        return canonical(text as String)
    }

    static func onlineDisplays() -> [CGDirectDisplayID] {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0, count <= 64 else { return [] }
        var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetOnlineDisplayList(count, &displays, &count) == .success else { return [] }
        return Array(displays.prefix(Int(count)))
    }

    static func resolveOnline(_ uuid: String) -> CGDirectDisplayID? {
        resolve(uuid, online: onlineDisplays(), uuidOf: Self.uuid(of:))
    }
}
