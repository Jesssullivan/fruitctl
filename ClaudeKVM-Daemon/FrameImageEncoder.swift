import Foundation
import CoreGraphics
import AppKit

/// Shared geometry seam for capture encoding and offline dimension qualification.
enum FrameImageEncoder {
    static func validRGBA(_ buffer: UnsafeRawBufferPointer, width: Int, height: Int) -> Bool {
        let (pixels, overflow) = width.multipliedReportingOverflow(by: height)
        let (bytes, byteOverflow) = pixels.multipliedReportingOverflow(by: 4)
        return width > 0 && height > 0 && !overflow && !byteOverflow && bytes == buffer.count
    }

    static func encode(
        buffer: UnsafeRawBufferPointer,
        width: Int,
        height: Int,
        scaling: DisplayScaling
    ) -> Data? {
        guard validRGBA(buffer, width: width, height: height),
              width == scaling.nativeWidth, height == scaling.nativeHeight,
              let baseAddress = buffer.baseAddress else { return nil }
        let bytesPerRow = width * 4

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let context = CGContext(
                  data: UnsafeMutableRawPointer(mutating: baseAddress),
                  width: width,
                  height: height,
                  bitsPerComponent: 8,
                  bytesPerRow: bytesPerRow,
                  space: colorSpace,
                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
              ),
              let cgImage = context.makeImage() else {
            return nil
        }

        let finalImage: CGImage
        if width != scaling.scaledWidth || height != scaling.scaledHeight {
            // Exactly the geometry returned to callers and used for input/OCR.
            let newW = scaling.scaledWidth
            let newH = scaling.scaledHeight

            guard let scaleCtx = CGContext(
                data: nil,
                width: newW,
                height: newH,
                bitsPerComponent: 8,
                bytesPerRow: newW * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return nil }

            scaleCtx.interpolationQuality = .high
            scaleCtx.draw(cgImage, in: CGRect(x: 0, y: 0, width: newW, height: newH))

            guard let scaled = scaleCtx.makeImage() else { return nil }
            finalImage = scaled
        } else {
            finalImage = cgImage
        }

        let rep = NSBitmapImageRep(cgImage: finalImage)
        return rep.representation(using: .png, properties: [:])
    }
}
