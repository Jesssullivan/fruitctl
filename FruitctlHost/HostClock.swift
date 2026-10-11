import Foundation
import CoreMedia

/// Capture and local Stop sample this same API clock. These raw observations
/// do not establish the clock mapping or acquisition time of captured pixels.
enum HostCoreMediaClock {
    static func sample() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }
}

/// The synchronous local Stop handler interval, not a physical-clear or input
/// release acknowledgment. Invalid samples remain diagnostic and cannot gate
/// revocation. Values and epochs serialize as decimal strings without loss.
struct HostCoreMediaStopBracket: Equatable {
    let entryHostTime: CMTime
    let completionHostTime: CMTime

    var hasValidBracket: Bool {
        HostNativeFrameTiming.usable(entryHostTime)
            && HostNativeFrameTiming.usable(completionHostTime)
            && entryHostTime.epoch == completionHostTime.epoch
            && CMTimeCompare(entryHostTime, completionHostTime) <= 0
    }

    var metadata: HostValue {
        .object([
            "schema": .string("fruitctl.human-stop-core-media.v1"),
            "source": .string("CMClockGetTime(CMClockGetHostTimeClock())"),
            "host_clock_basis": .string("core_media_host_time_mach_absolute_time"),
            "time_semantics": .string("local_stop_handler_interval"),
            "entry_host_time": HostNativeFrameTiming.timeMetadata(entryHostTime),
            "completion_host_time": HostNativeFrameTiming.timeMetadata(completionHostTime),
            "host_bracket_valid": .boolean(hasValidBracket),
            "status": .string(hasValidBracket ? "valid" : "unavailable")
        ])
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        func same(_ a: CMTime, _ b: CMTime) -> Bool {
            a.value == b.value && a.timescale == b.timescale
                && a.epoch == b.epoch && a.flags.rawValue == b.flags.rawValue
        }
        return same(lhs.entryHostTime, rhs.entryHostTime)
            && same(lhs.completionHostTime, rhs.completionHostTime)
    }
}

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
