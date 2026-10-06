import Foundation
import XCTest

final class FruitctlHostTests: XCTestCase {
    private let owner = UUID()
    private let other = UUID()

    private func started(at now: UInt64 = 100) throws -> HostLeaseState {
        var state = HostLeaseState()
        try state.begin(sessionID: "session-A", connectionID: owner, sequence: 1,
                        challenge: "challenge-A", displayGeneration: 7, now: now)
        return state
    }

    private func renew(_ state: inout HostLeaseState, at now: UInt64, pulse: UInt64?,
                       connection: UUID? = nil, sequence: UInt64 = 2,
                       generation: UInt64 = 7, capture: Bool = true, overlay: Bool = true) throws {
        try state.renew(sessionID: "session-A", connectionID: connection ?? owner,
            sequence: sequence, challenge: "challenge-B", displayGeneration: generation,
            now: now, uiHeartbeatAt: pulse, captureReady: capture, overlayReady: overlay)
    }

    func testLeaseExpiresAtDeadlineAndLateRenewalCannotResurrectIt() throws {
        var state = try started()
        XCTAssertNoThrow(try state.requireOwner(sessionID: "session-A", connectionID: owner,
                                               displayGeneration: 7, now: 3_099))
        XCTAssertThrowsError(try renew(&state, at: 3_100, pulse: 3_100)) {
            XCTAssertEqual($0 as? HostLeaseError, .expired)
        }
        XCTAssertTrue(state.expire(at: 3_100))
        XCTAssertNil(state.active)
        XCTAssertFalse(state.expire(at: 3_101))
    }

    func testASecondConnectionCannotAcquireRenewOrReleaseAnotherLease() throws {
        var state = try started()
        XCTAssertThrowsError(try state.begin(sessionID: "session-B", connectionID: other,
            sequence: 1, challenge: "challenge-C", displayGeneration: 7, now: 101)) {
            XCTAssertEqual($0 as? HostLeaseError, .busy)
        }
        XCTAssertThrowsError(try renew(&state, at: 102, pulse: 102, connection: other)) {
            XCTAssertEqual($0 as? HostLeaseError, .wrongOwner)
        }
        XCTAssertFalse(state.release(connectionID: other, sessionID: "session-A"))
        XCTAssertFalse(state.release(connectionID: owner, sessionID: "wrong-session"))
        XCTAssertEqual(state.active?.sessionID, "session-A")
        XCTAssertTrue(state.release(connectionID: owner))
        XCTAssertNil(state.active)
    }

    func testRenewalRequiresIncreasingSequenceAndFreshMainThreadPulse() throws {
        var state = try started()
        let original = state.active
        XCTAssertThrowsError(try renew(&state, at: 350, pulse: 100, sequence: 1)) {
            XCTAssertEqual($0 as? HostLeaseError, .staleSequence)
        }
        XCTAssertEqual(state.active, original)
        XCTAssertThrowsError(try renew(&state, at: 351, pulse: 100)) {
            XCTAssertEqual($0 as? HostLeaseError, .notReady)
        }
        XCTAssertEqual(state.active, original)
        try renew(&state, at: 350, pulse: 100)
        XCTAssertEqual(state.active?.sequence, 2)
        XCTAssertEqual(state.active?.challenge, "challenge-B")
        XCTAssertEqual(state.active?.expiresAtMilliseconds, 3_350)
    }

    func testDisplayChangesAndCaptureOrOverlayFailureFailClosed() throws {
        for values in [(UInt64(8), true, true), (7, false, true), (7, true, false)] {
            var state = try started()
            XCTAssertThrowsError(try renew(&state, at: 101, pulse: 101,
                generation: values.0, capture: values.1, overlay: values.2))
            XCTAssertEqual(state.active?.expiresAtMilliseconds, 3_100)
        }
        var state = try started()
        state.invalidate()
        XCTAssertThrowsError(try renew(&state, at: 101, pulse: 101))
    }

    func testMissingFutureOrStaleHeartbeatsAreNeverReadinessProof() {
        for pulse in [nil, UInt64(301), UInt64(0)] as [UInt64?] {
            XCTAssertFalse(HostLeaseState.isReady(now: 300, uiHeartbeatAt: pulse,
                                                 captureReady: true, overlayReady: true))
        }
        XCTAssertTrue(HostLeaseState.isReady(now: 300, uiHeartbeatAt: 50,
                                            captureReady: true, overlayReady: true))
        XCTAssertFalse(HostLeaseState.isReady(now: 301, uiHeartbeatAt: 50,
                                             captureReady: true, overlayReady: true))
    }

    func testInvalidLeaseTokensAndDeadlineOverflowAreRejected() throws {
        for token in ["", "has space", "has\nnewline", "purple💜", String(repeating: "a", count: 257)] {
            var state = HostLeaseState()
            XCTAssertThrowsError(try state.begin(sessionID: token, connectionID: owner,
                sequence: 1, challenge: "valid", displayGeneration: 1, now: 0))
            XCTAssertNil(state.active)
        }
        var state = HostLeaseState()
        XCTAssertThrowsError(try state.begin(sessionID: "valid", connectionID: owner,
            sequence: 1, challenge: "valid", displayGeneration: 1, now: UInt64.max - 2_999))
        XCTAssertNil(state.active)
    }

    func testInactiveOrNonDrawableLaunchCannotStartActivityWithoutNotifications() {
        let state = HostAvailabilityState()
        XCTAssertFalse(state.allowsActivity(onConsole: false, ownedSession: true, displaysDrawable: true))
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: false, displaysDrawable: true))
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: false))
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testWakeCannotClearIndependentSessionAndDisplayHolds() {
        var state = HostAvailabilityState()
        state.apply(.sessionResigned)
        state.apply(.screensSlept)
        state.apply(.systemSlept)
        state.apply(.systemWoke)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.screensWoke)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.sessionActivated)
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testHumanStopSurvivesAllNonHumanWakeAndActivationEvents() {
        var state = HostAvailabilityState()
        state.apply(.humanStopped)
        for event in [HostAvailabilityState.Event.sessionResigned, .screensSlept, .systemSlept,
                      .systemWoke, .screensWoke, .sessionActivated] {
            state.apply(event)
            XCTAssertFalse(state.humanAllowed)
            XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        }
        state.apply(.humanResumed)
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testHumanAllowDoesNotOverrideAnInactiveSessionOrSleepingDisplay() {
        var state = HostAvailabilityState()
        state.apply(.humanStopped)
        state.apply(.sessionResigned)
        state.apply(.screensSlept)
        state.apply(.humanResumed)
        XCTAssertTrue(state.humanAllowed)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.sessionActivated)
        XCTAssertFalse(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
        state.apply(.screensWoke)
        XCTAssertTrue(state.allowsActivity(onConsole: true, ownedSession: true, displaysDrawable: true))
    }

    func testProtocolAcceptsActionAndLegacyMethodButPreservesTypedIdentifiers() throws {
        let action = try JSONDecoder().decode(HostRequest.self, from:
            Data(#"{"action":"renew_activity","id":"r-7","params":{"session_id":"s","sequence":2}}"#.utf8))
        XCTAssertEqual(action.action, "renew_activity")
        XCTAssertEqual(action.id, .string("r-7"))
        XCTAssertEqual(try action.requiredSequence(), 2)
        let legacy = try JSONDecoder().decode(HostRequest.self, from:
            Data(#"{"method":"health","id":7}"#.utf8))
        XCTAssertEqual(legacy.action, "health")
        XCTAssertEqual(legacy.id, .integer(7))
        for value in ["true", "1.5", "[]", "{}"] {
            XCTAssertThrowsError(try JSONDecoder().decode(HostRequest.self, from:
                Data("{\"action\":\"health\",\"id\":\(value)}".utf8)))
        }
        let response = try HostResponse.ok(action, ["raw_vnc_exclusion": .boolean(false)]).line()
        XCTAssertEqual(response.last, 10)
        let object = try JSONSerialization.jsonObject(with: response) as? [String: Any]
        XCTAssertEqual(object?["id"] as? String, "r-7")
        XCTAssertEqual(object?["success"] as? Bool, true)
    }

    func testFramingHandlesFragmentationAndRejectsOversizedOrUnterminatedInput() throws {
        var framer = HostLineFramer()
        XCTAssertEqual(try framer.append(Data("{\"action\":\"he".utf8)), [])
        XCTAssertTrue(framer.hasIncompleteLine)
        let lines = try framer.append(Data("alth\"}\n\n{\"action\":\"capture\"}\n".utf8))
        XCTAssertEqual(lines.count, 2)
        XCTAssertFalse(framer.hasIncompleteLine)
        XCTAssertEqual(try JSONDecoder().decode(HostRequest.self, from: lines[0]).action, "health")
        var oversized = HostLineFramer()
        XCTAssertThrowsError(try oversized.append(Data(repeating: 65,
                                               count: HostLineFramer.maximumRequestBytes + 1)))
        var unterminated = HostLineFramer()
        _ = try unterminated.append(Data(#"{"action":"health"}"#.utf8))
        XCTAssertTrue(unterminated.hasIncompleteLine)
    }
}
