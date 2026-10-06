import Foundation
import CoreGraphics
import AppKit
import Vision

extension ClaudeKVMDaemon {

    // MARK: - Diff State

    static var framebufferBaseline = FramebufferBaseline()

    // MARK: - Diff Check

    /// Direct byte comparison — any pixel change returns true.
    func diffCheck(buffer: UnsafeRawBufferPointer, context: VNCInputContext) -> Bool {
        Self.framebufferBaseline.compareAndReplace(Data(buffer), context: context)
    }

    // MARK: - Cursor Crop with Crosshair

    func cropWithCrosshair(
        buffer: UnsafeRawBufferPointer,
        width: Int, height: Int,
        centerX: Int, centerY: Int, radius: Int
    ) -> Data? {
        guard FrameImageEncoder.validRGBA(buffer, width: width, height: height),
              centerX >= 0, centerX < width, centerY >= 0, centerY < height,
              (1...500).contains(radius) else { return nil }
        let left = max(0, centerX - radius)
        let top = max(0, centerY - radius)
        let right = min(width, centerX + radius)
        let bottom = min(height, centerY + radius)
        let cropW = right - left
        let cropH = bottom - top
        guard cropW > 0, cropH > 0 else { return nil }

        var cropData = [UInt8](repeating: 0, count: cropW * cropH * 4)
        let src = buffer.bindMemory(to: UInt8.self)
        for row in 0..<cropH {
            let srcOffset = ((top + row) * width + left) * 4
            let dstOffset = row * cropW * 4
            let rowBytes = cropW * 4
            for col in 0..<rowBytes {
                cropData[dstOffset + col] = src[srcOffset + col]
            }
        }

        let cx = centerX - left
        let cy = centerY - top
        let crossSize = 12
        for i in -crossSize...crossSize {
            let hx = cx + i
            if hx >= 0, hx < cropW {
                let off = (cy * cropW + hx) * 4
                cropData[off] = 255; cropData[off+1] = 0; cropData[off+2] = 0; cropData[off+3] = 255
            }
            let vy = cy + i
            if vy >= 0, vy < cropH {
                let off = (vy * cropW + cx) * 4
                cropData[off] = 255; cropData[off+1] = 0; cropData[off+2] = 0; cropData[off+3] = 255
            }
        }

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return cropData.withUnsafeMutableBytes { rawPtr -> Data? in
            guard let ctx = CGContext(
                data: rawPtr.baseAddress,
                width: cropW, height: cropH,
                bitsPerComponent: 8, bytesPerRow: cropW * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ), let cgImage = ctx.makeImage() else { return nil }
            let rep = NSBitmapImageRep(cgImage: cgImage)
            return rep.representation(using: .png, properties: [:])
        }
    }

    // MARK: - Crop Region to PNG

    func cropRegionToPNG(
        buffer: UnsafeRawBufferPointer,
        fbWidth: Int, fbHeight: Int,
        x: Int, y: Int, width cropW: Int, height cropH: Int
    ) -> Data? {
        guard FrameImageEncoder.validRGBA(buffer, width: fbWidth, height: fbHeight) else { return nil }
        let clampedX = max(0, min(x, fbWidth))
        let clampedY = max(0, min(y, fbHeight))
        let clampedW = min(cropW, fbWidth - clampedX)
        let clampedH = min(cropH, fbHeight - clampedY)
        guard clampedW > 0, clampedH > 0 else { return nil }

        var cropData = [UInt8](repeating: 0, count: clampedW * clampedH * 4)
        let src = buffer.bindMemory(to: UInt8.self)
        for row in 0..<clampedH {
            let srcOffset = ((clampedY + row) * fbWidth + clampedX) * 4
            let dstOffset = row * clampedW * 4
            let rowBytes = clampedW * 4
            for col in 0..<rowBytes {
                cropData[dstOffset + col] = src[srcOffset + col]
            }
        }

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return cropData.withUnsafeMutableBytes { rawPtr -> Data? in
            guard let ctx = CGContext(
                data: rawPtr.baseAddress,
                width: clampedW, height: clampedH,
                bitsPerComponent: 8, bytesPerRow: clampedW * 4,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ), let cgImage = ctx.makeImage() else { return nil }
            let rep = NSBitmapImageRep(cgImage: cgImage)
            return rep.representation(using: .png, properties: [:])
        }
    }

    // MARK: - OCR Element Detection

    func detectTextElements(
        buffer: UnsafeRawBufferPointer,
        width: Int, height: Int,
        scaling: DisplayScaling
    ) -> [TextElement] {
        guard FrameImageEncoder.validRGBA(buffer, width: width, height: height),
              width == scaling.nativeWidth, height == scaling.nativeHeight,
              let baseAddress = buffer.baseAddress else { return [] }
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
            return []
        }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        try? handler.perform([request])

        guard let observations = request.results else { return [] }

        let sw = CGFloat(scaling.scaledWidth)
        let sh = CGFloat(scaling.scaledHeight)

        return observations.compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox

            // Vision: normalized (0-1), bottom-left origin → scaled pixels, top-left origin
            let elX = Int((box.origin.x * sw).rounded())
            let elY = Int(((1 - box.origin.y - box.height) * sh).rounded())
            let elW = Int((box.width * sw).rounded())
            let elH = Int((box.height * sh).rounded())

            return TextElement(
                text: candidate.string,
                elX: elX, elY: elY, elW: elW, elH: elH,
                confidence: Double(candidate.confidence)
            )
        }
    }

    // MARK: - PNG Encoding

    func createPNGFromRGBA(buffer: UnsafeRawBufferPointer, width: Int, height: Int,
                           scaling: DisplayScaling) -> Data? {
        FrameImageEncoder.encode(buffer: buffer, width: width, height: height, scaling: scaling)
    }
}
