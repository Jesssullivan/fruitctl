import Foundation
import os

/// Input readiness after ServerInit, per connection generation.
///
/// Apple Screen Sharing (screensharingd with Remote Management, ARD auth type
/// 30, measured on macOS 26.7.1) silently drops every RFB pointer and key
/// event for about 2.5 s after the viewer authenticates. Its log says
/// "ignore key event", the screen does not change, and LibVNC still reports
/// each write as sent. Input is therefore held until the settle time has
/// elapsed since this generation's ServerInit. Waiting is preferred to
/// refusing; nothing is ever written early. Observation is never gated.
final class VNCInputSettle: @unchecked Sendable {
    /// Default for a server detected as Apple (ARD credential request).
    static let appleDefaultMilliseconds = 3_000
    /// Upper bound for `--input-settle-ms`.
    static let maximumMilliseconds = 10_000

    struct Status: Equatable, Sendable {
        var connectionGeneration = 0
        /// ServerInit completed for this generation and it is not torn down.
        var connected = false
        var settleMilliseconds = 0
        var remainingNanoseconds: UInt64 = 0

        var ready: Bool { connected && remainingNanoseconds == 0 }
        /// Rounded up so a nonzero wait never reads as 0 ms.
        var remainingMilliseconds: Int { Int((remainingNanoseconds + 999_999) / 1_000_000) }
    }

    private struct State {
        var generation = 0
        var serverInitNs: UInt64?
        var settleMilliseconds = 0
    }

    /// nil selects the server-dependent default.
    let configuredMilliseconds: Int?
    private let state = OSAllocatedUnfairLock(initialState: State())
    let now: () -> UInt64
    private let sleep: (UInt64) async throws -> Void

    init(configuredMilliseconds: Int? = nil,
         now: @escaping () -> UInt64 = { DispatchTime.now().uptimeNanoseconds },
         sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) {
        self.configuredMilliseconds = configuredMilliseconds
        self.now = now
        self.sleep = sleep
    }

    /// An explicit value wins (clamped to 0...maximum); otherwise Apple's
    /// server gets the measured default and every other server none.
    static func effectiveMilliseconds(configured: Int?, appleServer: Bool) -> Int {
        if let configured { return min(max(configured, 0), maximumMilliseconds) }
        return appleServer ? appleDefaultMilliseconds : 0
    }

    /// Called once the handshake through ServerInit has succeeded. A
    /// reconnect is a new generation and restarts the settle time.
    func serverInitCompleted(generation: Int, appleServer: Bool) {
        let milliseconds = Self.effectiveMilliseconds(configured: configuredMilliseconds, appleServer: appleServer)
        let instant = now()
        state.withLock {
            $0 = State(generation: generation, serverInitNs: instant, settleMilliseconds: milliseconds)
        }
    }

    func disconnected() {
        state.withLock { $0.serverInitNs = nil }
    }

    func status() -> Status {
        let instant = now()
        return state.withLock { (current: inout State) -> Status in
            var status = Status(connectionGeneration: current.generation,
                                connected: current.serverInitNs != nil,
                                settleMilliseconds: current.settleMilliseconds)
            guard let start = current.serverInitNs else { return status }
            let settle = UInt64(current.settleMilliseconds) * 1_000_000
            let elapsed = instant >= start ? instant - start : 0
            status.remainingNanoseconds = elapsed >= settle ? 0 : settle - elapsed
            return status
        }
    }

    /// Native-queue admission for one write on `generation`. Applies to
    /// every input message, release-only and clipboard writes included.
    func admits(generation: Int) -> Bool {
        let current = status()
        return current.ready && current.connectionGeneration == generation
    }

    /// Wait out the remaining settle time of the current generation. A
    /// reconnect during the wait restarts it. Cancellation ends the wait at
    /// once. When the remaining time would pass `deadlineNs` (same clock as
    /// `now`) or `budgetNs()` (a relative bound such as a native permit
    /// lease), fail with typed `input_not_ready` instead of waiting.
    /// Without a connection, or when the input is bound to another
    /// generation, there is nothing to wait for: the write itself then fails
    /// as not connected or as a changed display.
    func waitUntilReady(generation: Int? = nil, deadlineNs: UInt64? = nil,
                        budgetNs: (() -> UInt64?)? = nil) async throws {
        while true {
            try Task.checkCancellation()
            let current = status()
            guard current.connected, current.remainingNanoseconds > 0 else { return }
            if let generation, generation != current.connectionGeneration { return }
            let remaining = current.remainingNanoseconds
            if let deadlineNs {
                let (end, overflow) = now().addingReportingOverflow(remaining)
                if overflow || end > deadlineNs {
                    throw VNCError.inputNotReady(remainingMilliseconds: current.remainingMilliseconds)
                }
            }
            if let budget = budgetNs?(), remaining > budget {
                throw VNCError.inputNotReady(remainingMilliseconds: current.remainingMilliseconds)
            }
            try await sleep(remaining)
        }
    }
}
