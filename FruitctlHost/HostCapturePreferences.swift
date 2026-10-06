import Foundation

/// Persists explicit operator intent independently of the OS recording grant.
/// Only attended startup arguments and local AppKit menu actions write it;
/// the IPC request handler has no preference mutation path.
final class HostCapturePreferences {
    private static let optInKey = "fruitctl.capture.explicitOptIn.v1"
    private let defaults: UserDefaults
    private(set) var isEnabled: Bool

    init(defaults: UserDefaults = .standard, startupChoice: Bool? = nil) {
        self.defaults = defaults
        if let startupChoice {
            isEnabled = startupChoice
            defaults.set(startupChoice, forKey: Self.optInKey)
        } else {
            isEnabled = defaults.bool(forKey: Self.optInKey)
        }
    }

    func setEnabled(_ enabled: Bool) {
        isEnabled = enabled
        defaults.set(enabled, forKey: Self.optInKey)
    }

    func permitsCapture(permissionGranted: Bool) -> Bool {
        isEnabled && permissionGranted
    }
}
