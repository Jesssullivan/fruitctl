import Foundation
import CoreGraphics
import AppKit
import Vision

extension ClaudeKVMDaemon {

    // MARK: - Baselines

    /// The public diff_check baseline, replaced by every diff_check.
    static var framebufferBaseline = FramebufferBaseline()
    /// action_queue's private expect change_in baseline: set before a step,
    /// consumed by the expect_change after it. Never the public baseline.
    static var expectationBaseline = FramebufferBaseline()

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

    /// Crop native framebuffer pixels without resampling, then downscale only
    /// when the crop's longer side exceeds `maxDimension`. Never upscales.
    func cropRegionToPNG(
        buffer: UnsafeRawBufferPointer,
        fbWidth: Int, fbHeight: Int,
        region: FrameRect, maxDimension: Int
    ) -> (png: Data, width: Int, height: Int)? {
        guard FrameImageEncoder.validRGBA(buffer, width: fbWidth, height: fbHeight),
              region.isInside(width: fbWidth, height: fbHeight), maxDimension > 0,
              let source = buffer.baseAddress else { return nil }
        let cropW = region.width
        let cropH = region.height
        let rowBytes = cropW * 4
        var cropData = [UInt8](repeating: 0, count: cropH * rowBytes)
        cropData.withUnsafeMutableBytes { destination in
            guard let base = destination.baseAddress else { return }
            for row in 0..<cropH {
                let srcOffset = ((region.y + row) * fbWidth + region.x) * 4
                (base + row * rowBytes).copyMemory(from: source + srcOffset, byteCount: rowBytes)
            }
        }

        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let ratio = min(1.0, Double(maxDimension) / Double(max(cropW, cropH)))
        let outW = max(1, Int((Double(cropW) * ratio).rounded()))
        let outH = max(1, Int((Double(cropH) * ratio).rounded()))
        return cropData.withUnsafeMutableBytes { rawPtr -> (png: Data, width: Int, height: Int)? in
            guard let ctx = CGContext(
                data: rawPtr.baseAddress,
                width: cropW, height: cropH,
                bitsPerComponent: 8, bytesPerRow: rowBytes,
                space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ), let cgImage = ctx.makeImage() else { return nil }
            var finalImage = cgImage
            if outW != cropW || outH != cropH {
                guard let scaleCtx = CGContext(
                    data: nil, width: outW, height: outH,
                    bitsPerComponent: 8, bytesPerRow: outW * 4,
                    space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
                ) else { return nil }
                scaleCtx.interpolationQuality = .high
                scaleCtx.draw(cgImage, in: CGRect(x: 0, y: 0, width: outW, height: outH))
                guard let scaled = scaleCtx.makeImage() else { return nil }
                finalImage = scaled
            }
            let rep = NSBitmapImageRep(cgImage: finalImage)
            guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
            return (png, outW, outH)
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
