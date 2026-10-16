import Foundation

/// A byte count alone cannot distinguish rotated or reallocated framebuffers.
struct FramebufferBaseline {
    private var pixels: Data?
    private var identity: VNCInputContext?

    /// The owned baseline frame and the allocation it was captured from.
    var snapshot: (pixels: Data, context: VNCInputContext)? {
        guard let pixels, let identity else { return nil }
        return (pixels, identity)
    }

    mutating func set(_ data: Data, context: VNCInputContext) {
        pixels = data
        identity = context
    }

    mutating func compareAndReplace(_ data: Data, context: VNCInputContext) -> Bool {
        let changed = pixels.map { $0 != data || identity != context } ?? false
        set(data, context: context)
        return changed
    }

    mutating func clear() {
        pixels = nil
        identity = nil
    }
}
