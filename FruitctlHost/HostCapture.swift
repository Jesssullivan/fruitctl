import AppKit
import ScreenCaptureKit
import CoreGraphics
import CoreVideo
import Darwin
import ImageIO
import UniformTypeIdentifiers

enum HostCaptureError: String, Error {
    case notEnabled = "capture_not_enabled"
    case permissionRequired = "screen_capture_permission_required"
    case displayUnavailable = "configured_display_unavailable"
    case selfApplicationUnavailable = "own_application_exclusion_unavailable"
    case incompleteImage = "incomplete_capture"
    case captureFailed = "capture_failed"
    case imageEncodingFailed = "image_encoding_failed"
}

struct HostCapturedImage {
    let png: Data
    let nativeWidth: Int
    let nativeHeight: Int
    let scaledWidth: Int
    let scaledHeight: Int
    let displayID: CGDirectDisplayID
    let bounds: CGRect

    var metadata: [String: HostValue] {
        ["image": .string(png.base64EncodedString()), "mimeType": .string("image/png"),
         "nativeWidth": .integer(Int64(nativeWidth)), "nativeHeight": .integer(Int64(nativeHeight)),
         "scaledWidth": .integer(Int64(scaledWidth)), "scaledHeight": .integer(Int64(scaledHeight)),
         "display_id": .integer(Int64(displayID)),
         "display_bounds": .object(["x": .number(Double(bounds.origin.x)), "y": .number(Double(bounds.origin.y)),
                                    "width": .number(Double(bounds.width)), "height": .number(Double(bounds.height))]),
         "pixels_per_point_x": .number(Double(nativeWidth) / Double(bounds.width)),
         "pixels_per_point_y": .number(Double(nativeHeight) / Double(bounds.height)),
         "cursor_included": .boolean(true)]
    }
}

/// Captures only the explicitly selected display, excluding this entire app.
/// Each screenshot gets a fresh filter; native VNC capture is a separate path.
@MainActor
final class HostCapture {
    private let preferences: HostCapturePreferences
    var enabled: Bool { preferences.isEnabled }
    let displayID: CGDirectDisplayID

    init(preferences: HostCapturePreferences, displayID: CGDirectDisplayID) {
        self.preferences = preferences; self.displayID = displayID
    }

    func snapshot(maximumDimension: Int) async throws -> HostCapturedImage {
        guard enabled else { throw HostCaptureError.notEnabled }
        guard preferences.permitsCapture(permissionGranted: CGPreflightScreenCaptureAccess()) else {
            throw HostCaptureError.permissionRequired
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false,
                                                                           onScreenWindowsOnly: false)
        } catch { throw HostCaptureError.captureFailed }
        guard let display = content.displays.first(where: { $0.displayID == displayID }),
              CGDisplayIsActive(displayID) != 0 else { throw HostCaptureError.displayUnavailable }
        guard let ownApp = content.applications.first(where: {
            $0.processID == getpid() && $0.bundleIdentifier == Bundle.main.bundleIdentifier
        }) else { throw HostCaptureError.selfApplicationUnavailable }
        let width = CGDisplayPixelsWide(displayID), height = CGDisplayPixelsHigh(displayID)
        let bounds = CGDisplayBounds(displayID)
        // Bound the source allocation independently of requested output scaling.
        guard width > 0, height > 0, width <= 16_384, height <= 16_384,
              width <= 33_554_432 / height,
              bounds.width > 0, bounds.height > 0, !bounds.isInfinite, !bounds.isNull else {
            throw HostCaptureError.incompleteImage
        }
        let filter = SCContentFilter(display: display, excludingApplications: [ownApp],
                                     exceptingWindows: [])
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.showsCursor = true
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.scalesToFit = false
        configuration.captureResolution = .best
        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter,
                                                               configuration: configuration)
        } catch { throw HostCaptureError.captureFailed }
        guard image.width == width, image.height == height,
              CGDisplayBounds(displayID) == bounds,
              CGDisplayPixelsWide(displayID) == width, CGDisplayPixelsHigh(displayID) == height else {
            throw HostCaptureError.incompleteImage
        }
        let ratio = min(1, Double(maximumDimension) / Double(max(width, height)))
        let scaledWidth = max(1, Int((Double(width) * ratio).rounded()))
        let scaledHeight = max(1, Int((Double(height) * ratio).rounded()))
        let output: CGImage
        if ratio == 1 { output = image }
        else {
            guard let context = CGContext(data: nil, width: scaledWidth, height: scaledHeight,
                bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw HostCaptureError.imageEncodingFailed
            }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: scaledWidth, height: scaledHeight))
            guard let resized = context.makeImage() else { throw HostCaptureError.imageEncodingFailed }
            output = resized
        }
        let png = NSMutableData()
        guard let encoder = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil)
        else { throw HostCaptureError.imageEncodingFailed }
        CGImageDestinationAddImage(encoder, output, nil)
        guard CGImageDestinationFinalize(encoder) else { throw HostCaptureError.imageEncodingFailed }
        return HostCapturedImage(png: png as Data, nativeWidth: width, nativeHeight: height,
            scaledWidth: scaledWidth, scaledHeight: scaledHeight, displayID: displayID, bounds: bounds)
    }
}
