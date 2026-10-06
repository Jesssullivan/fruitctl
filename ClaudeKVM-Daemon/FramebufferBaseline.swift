import Foundation

/// A byte count alone cannot distinguish rotated or reallocated framebuffers.
struct FramebufferBaseline {
    private var pixels: Data?
    private var identity: VNCInputContext?

    mutating func set(_ data: Data, context: VNCInputContext) {
        pixels = data
        identity = context
    }

    mutating func compareAndReplace(_ data: Data, context: VNCInputContext) -> Bool {
        let changed = pixels.map { $0 != data || identity != context } ?? false
        set(data, context: context)
        return changed
    }
}
