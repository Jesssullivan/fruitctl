import Foundation

/// ContinuousClock progresses during system sleep. Its origin remains private
/// to this process; clients receive durations and echoed challenges only.
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
