import Foundation

enum HostCaptureError: String, Error {
    case notEnabled = "capture_not_enabled"
    case permissionRequired = "screen_capture_permission_required"
    case displayUnavailable = "configured_display_unavailable"
    case selfApplicationUnavailable = "own_application_exclusion_unavailable"
    case incompleteImage = "incomplete_capture"
    case captureFailed = "capture_failed"
    case imageEncodingFailed = "image_encoding_failed"
}

/// Ordinary Screen Recording preflight is one prerequisite, not proof that
/// direct capture will avoid another Apple consent dialog. Requesting consent
/// is a separate operation used only by explicit startup/local human actions.
@MainActor
final class HostCapturePermission {
    private let preflight: () -> Bool
    private let request: () -> Bool

    init(preflight: @escaping () -> Bool, request: @escaping () -> Bool) {
        self.preflight = preflight; self.request = request
    }

    var isGranted: Bool { preflight() }

    func requireCapture(enabled: Bool) throws {
        guard enabled else { throw HostCaptureError.notEnabled }
        guard isGranted else { throw HostCaptureError.permissionRequired }
    }

    @discardableResult
    func requestFromHuman() -> Bool { request() }

    /// Both framework acquisition awaits use this seam. A returned frame or
    /// shareable-content list cannot certify a withdrawn grant or opt-out.
    func withCaptureAuthorization<T>(enabled: () -> Bool,
                                     operation: () async throws -> T) async throws -> T {
        try requireCapture(enabled: enabled())
        let value = try await operation()
        try requireCapture(enabled: enabled())
        return value
    }
}
