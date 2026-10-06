import Foundation
import XCTest

final class FruitctlHostTests: XCTestCase {
    private let owner = UUID()
    private let other = UUID()
    private var defaultsSuites: [String] = []

    private func isolatedDefaults() -> UserDefaults {
        let name = "FruitctlHostTests.CaptureOptIn." + UUID().uuidString
        defaultsSuites.append(name)
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    override func tearDown() {
        for name in defaultsSuites { UserDefaults(suiteName: name)?.removePersistentDomain(forName: name) }
        defaultsSuites.removeAll()
        super.tearDown()
    }

    func testFreshCapturePreferencesStayDisabledEvenWhenOSPermissionExists() {
        let preferences = HostCapturePreferences(defaults: isolatedDefaults())
        XCTAssertFalse(preferences.isEnabled)
        XCTAssertFalse(preferences.permitsCapture(permissionGranted: true))
        XCTAssertFalse(preferences.permitsCapture(permissionGranted: false))
    }

    func testExplicitCaptureOptInSurvivesConstructorRestartWithoutArguments() {
        let defaults = isolatedDefaults()
        let first = HostCapturePreferences(defaults: defaults, startupChoice: true)
        XCTAssertTrue(first.isEnabled)
        // A distinct defaults reader simulates a new invocation with no args.
        let suite = defaultsSuites.last!
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: suite)!)
        XCTAssertTrue(reopened.isEnabled)
        XCTAssertTrue(reopened.permitsCapture(permissionGranted: true))
    }

    func testHumanDisablePersistsAndNewPermissionCannotUndoIt() {
        let defaults = isolatedDefaults()
        let enabled = HostCapturePreferences(defaults: defaults, startupChoice: true)
        enabled.setEnabled(false)
        XCTAssertFalse(enabled.permitsCapture(permissionGranted: true))
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: defaultsSuites.last!)!)
        XCTAssertFalse(reopened.isEnabled)
        XCTAssertFalse(reopened.permitsCapture(permissionGranted: true))
    }

    func testDeniedPermissionKeepsExplicitIntentButNeverAuthorizesCapture() {
        let defaults = isolatedDefaults()
        let enabled = HostCapturePreferences(defaults: defaults, startupChoice: true)
        XCTAssertFalse(enabled.permitsCapture(permissionGranted: false))
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: defaultsSuites.last!)!)
        XCTAssertTrue(reopened.isEnabled)
        XCTAssertFalse(reopened.permitsCapture(permissionGranted: false))
        XCTAssertTrue(reopened.permitsCapture(permissionGranted: true))
    }

    func testExplicitStartupDisableOverridesPriorOptInAcrossRestart() {
        let defaults = isolatedDefaults()
        _ = HostCapturePreferences(defaults: defaults, startupChoice: true)
        let disabled = HostCapturePreferences(defaults: defaults, startupChoice: false)
        XCTAssertFalse(disabled.isEnabled)
        let reopened = HostCapturePreferences(defaults: UserDefaults(suiteName: defaultsSuites.last!)!)
        XCTAssertFalse(reopened.permitsCapture(permissionGranted: true))
    }

    func testInitialCaptureTimerWaitsWithoutHeartbeatAndCannotExtendLease() throws {
        var state = try started()
        XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: true,
            captureInProgress: true, captureReady: false, overlayReady: false,
            visiblePanels: false), .awaitingInitialCapture)
        XCTAssertFalse(HostLeaseState.isReady(now: 200, uiHeartbeatAt: nil,
                                              captureReady: false, overlayReady: false))
        XCTAssertThrowsError(try renew(&state, at: 200, pulse: nil, capture: false, overlay: false)) {
            XCTAssertEqual($0 as? HostLeaseError, .notReady)
        }
        XCTAssertEqual(state.active?.expiresAtMilliseconds, 3_100)
        XCTAssertTrue(state.expire(at: 3_100))
        XCTAssertThrowsError(try state.requireOwner(sessionID: "session-A", connectionID: owner,
            displayGeneration: 7, now: 3_101)) { XCTAssertEqual($0 as? HostLeaseError, .expired) }
    }

    func testAcquisitionCannotIgnoreEligibilityOrPartialOrUnexpectedVisibleUI() {
        for flags in [(false, true, false, false, false),
                      (true, false, false, false, false),
                      (true, true, true, false, false),
                      (true, true, false, true, false),
                      (true, true, false, false, true),
                      (true, false, true, true, false)] {
            XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: flags.0,
                captureInProgress: flags.1, captureReady: flags.2, overlayReady: flags.3,
                visiblePanels: flags.4), .invalidate)
        }
    }

    func testQualifiedVisibleUIReceivesHeartbeatDuringLaterCapture() {
        for capturing in [false, true] {
            XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: true,
                captureInProgress: capturing, captureReady: true, overlayReady: true,
                visiblePanels: true), .recordVisibleHeartbeat)
        }
        XCTAssertEqual(HostLeaseState.uiHeartbeatDecision(activityEligible: false,
            captureInProgress: true, captureReady: true, overlayReady: true,
            visiblePanels: true), .invalidate)
    }

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
