import Foundation

/// Private helper-mode authorization. All timestamps originate here, before
/// the broker asks the helper to echo the native-issued challenge.
final class NativeInputPermit: @unchecked Sendable {
    static let protocolVersion = "fruitctl.native-input-permit.v1"
    static let durationMilliseconds = 1_000
    static let maximumRoundTripMilliseconds = 500

    struct Binding: Equatable, Sendable {
        let instanceID: String
        let sessionID: String
        let displayID: Int
        let displayGeneration: Int
        let context: VNCInputContext
        let scaledWidth: Int
        let scaledHeight: Int
    }

    struct Receipt: Sendable {
        let binding: Binding
        let sequence: Int
        let challenge: String
        let remainingMilliseconds: Int
    }

    private struct Challenge {
        let binding: Binding
        let sequence: Int
        let token: String
        let began: UInt64
    }

    private let lock = NSLock()
    private let now: () -> UInt64
    private let watchdogEnabled: Bool
    private var watchdog: DispatchSourceTimer?
    private var watchdogStopped = false
    private var required = false
    private var failed = false
    private var owner: Binding?
    private var qualifiedContext: VNCInputContext?
    private var qualifiedScaledWidth = 0
    private var qualifiedScaledHeight = 0
    private var pending: Challenge?
    private var lastSequence = 0
    private var expires: UInt64?
    private var onFailure: (() -> Void)?

    init(now: (() -> UInt64)? = nil, watchdogEnabled: Bool = true) {
        let clock = ContinuousClock()
        let origin = clock.now
        self.now = now ?? {
            let duration = origin.duration(to: clock.now).components
            return UInt64(max(0, duration.seconds)) * 1_000_000_000
                + UInt64(max(0, duration.attoseconds) / 1_000_000_000)
        }
        self.watchdogEnabled = watchdogEnabled
    }

    deinit { watchdog?.cancel() }

    func setFailureHandler(_ handler: @escaping () -> Void) {
        lock.lock()
        onFailure = handler
        let notify = failed
        lock.unlock()
        if notify { handler() }
    }

    private func error(_ detail: String) -> VNCError {
        .sendFailed("Native input permit \(detail)")
    }

    /// Every invalid control or expired grant is sticky for this owned child.
    /// A screenshot or a fresh adoption never clears this state.
    private func synchronized<T>(_ operation: () throws -> T) throws -> T {
        lock.lock()
        do {
            let result = try operation()
            lock.unlock()
            return result
        } catch {
            required = true
            let notify = !failed
            failed = true
            pending = nil
            expires = nil
            watchdog?.cancel()
            watchdog = nil
            let handler = notify ? onFailure : nil
            lock.unlock()
            handler?()
            throw error
        }
    }

    private func checkExpiryLocked(at instant: UInt64) throws {
        guard !failed else { throw error("is terminal; reconcile this owned session") }
        if let expires, instant >= expires { throw error("expired") }
        if expires == nil, let pending,
           instant > pending.began + UInt64(Self.maximumRoundTripMilliseconds) * 1_000_000 {
            throw error("challenge deadline exceeded")
        }
    }

    private func scheduleWatchdogLocked() {
        guard watchdogEnabled, !watchdogStopped else { return }
        let deadline = expires ?? pending.map {
            $0.began + UInt64(Self.maximumRoundTripMilliseconds) * 1_000_000 + 1
        }
        guard let deadline else { return }
        if watchdog == nil {
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInteractive))
            timer.setEventHandler { [weak self] in self?.watchdogFired() }
            watchdog = timer
            timer.resume()
        }
        let instant = now()
        watchdog?.schedule(deadline: .now() + .nanoseconds(Int(min(UInt64(Int.max),
            deadline > instant ? deadline - instant : 0))), leeway: .nanoseconds(0))
    }

    private func watchdogFired() {
        do {
            try synchronized {
                try checkExpiryLocked(at: now())
                scheduleWatchdogLocked() // ContinuousClock also advances during sleep.
            }
        } catch { /* synchronized has cancelled the active owned operation. */ }
    }

    func begin(binding: Binding, sequence: Int) throws -> Receipt {
        try synchronized {
            let instant = now()
            try checkExpiryLocked(at: instant)
            guard sequence > lastSequence, pending == nil else {
                throw error("challenge sequence was replayed or remains pending")
            }
            guard owner == nil || owner == binding else { throw error("owner or geometry changed") }
            guard qualifiedContext == binding.context,
                  qualifiedScaledWidth == binding.scaledWidth,
                  qualifiedScaledHeight == binding.scaledHeight else {
                throw error("does not match the adopted coordinate mapping")
            }
            required = true
            owner = binding
            lastSequence = sequence
            let challenge = Challenge(binding: binding, sequence: sequence,
                                      token: UUID().uuidString, began: instant)
            pending = challenge
            scheduleWatchdogLocked()
            return Receipt(binding: binding, sequence: sequence, challenge: challenge.token,
                           remainingMilliseconds: Self.durationMilliseconds)
        }
    }

    func qualifyObservation(context: VNCInputContext, scaledWidth: Int, scaledHeight: Int) throws {
        try synchronized {
            try checkExpiryLocked(at: now())
            if let owner {
                guard owner.context == context, owner.scaledWidth == scaledWidth,
                      owner.scaledHeight == scaledHeight else {
                    throw error("adopted coordinate mapping changed")
                }
            }
            qualifiedContext = context
            qualifiedScaledWidth = scaledWidth
            qualifiedScaledHeight = scaledHeight
        }
    }

    func grant(binding: Binding, sequence: Int, challenge: String,
               leaseRemainingMilliseconds: Int) throws -> Receipt {
        try synchronized {
            let instant = now()
            try checkExpiryLocked(at: instant)
            guard let pending, pending.binding == binding, pending.sequence == sequence,
                  pending.token == challenge, (1...3_000).contains(leaseRemainingMilliseconds),
                  instant - pending.began <= UInt64(Self.maximumRoundTripMilliseconds) * 1_000_000 else {
                throw error("grant binding or challenge deadline failed")
            }
            let deadline = pending.began
                + UInt64(min(Self.durationMilliseconds, leaseRemainingMilliseconds)) * 1_000_000
            guard instant < deadline else { throw error("expired before grant") }
            expires = deadline
            self.pending = nil
            scheduleWatchdogLocked()
            // Round up only the receipt duration; admission compares nanoseconds.
            let remaining = Int((deadline - instant + 999_999) / 1_000_000)
            return Receipt(binding: binding, sequence: sequence, challenge: challenge,
                           remainingMilliseconds: remaining)
        }
    }

    /// Called both at the controller and on the native queue immediately before
    /// each non-release Send*. This closes expiry while waiting behind decoding.
    func check(context: VNCInputContext?) throws {
        try synchronized {
            guard required else { return } // Compatible ordinary raw-VNC mode.
            try checkExpiryLocked(at: now())
            guard expires != nil, let context, context == owner?.context else {
                throw error("is ungranted or does not match the observed allocation")
            }
        }
    }

    func invalidate() {
        do { try synchronized { throw error("was revoked") } } catch {}
    }

    func invalidateIfRequired() {
        do {
            try synchronized {
                if required { throw error("was revoked") }
            }
        } catch {}
    }

    func stopWatchdog() {
        lock.lock()
        watchdogStopped = true
        watchdog?.cancel()
        watchdog = nil
        lock.unlock()
    }
}
