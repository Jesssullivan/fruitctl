import Foundation

/// ContinuousClock progresses during system sleep. Its origin remains private
/// to this process. Health diagnostics expose process-relative milliseconds
/// for Stop correlation; clients cannot compare clocks across Host instances.
final class HostClock {
    private let clock = ContinuousClock()
    private let origin: ContinuousClock.Instant

    init() { origin = clock.now }

    func milliseconds() -> UInt64 {
        let duration = origin.duration(to: clock.now).components
        guard duration.seconds >= 0 else { return 0 }
        return UInt64(duration.seconds) * 1_000 + UInt64(max(0, duration.attoseconds) / 1_000_000_000_000_000)
    }
}
