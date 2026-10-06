import Foundation

/// These are local deadlines, not timestamps exchanged between machines.
enum HostLeasePolicy {
    static let durationMilliseconds: UInt64 = 3_000
    static let renewalIntervalMilliseconds: UInt64 = 500
    static let uiHeartbeatMaximumAgeMilliseconds: UInt64 = 250
    static let inputPermitMilliseconds: UInt64 = 1_000
    static let maximumChallengeRoundTripMilliseconds: UInt64 = 500
}

enum HostLeaseError: String, Error {
    case invalidParameters = "invalid_lease_parameters"
    case busy = "host_busy"
    case expired = "lease_expired"
    case wrongOwner = "lease_owner_mismatch"
    case staleSequence = "stale_sequence"
    case notReady = "helper_not_ready"
    case displayChanged = "display_generation_changed"
}

/// Notifications latch independent holds. Waking the system does not silently
/// reactivate a switched-out user session or a still-sleeping display.
struct HostAvailabilityState {
    enum Event {
        case sessionResigned, sessionActivated, screensSlept, screensWoke, systemSlept, systemWoke
        case humanStopped, humanResumed
    }
    private(set) var sessionActive = true
    private(set) var screensAwake = true
    private(set) var systemAwake = true
    private(set) var humanAllowed = true

    mutating func apply(_ event: Event) {
        switch event {
        case .sessionResigned: sessionActive = false
        case .sessionActivated: sessionActive = true
        case .screensSlept: screensAwake = false
        case .screensWoke: screensAwake = true
        case .systemSlept: systemAwake = false
        case .systemWoke: systemAwake = true
        case .humanStopped: humanAllowed = false
        case .humanResumed: humanAllowed = true
        }
    }

    func allowsActivity(onConsole: Bool, ownedSession: Bool, displaysDrawable: Bool) -> Bool {
        humanAllowed && sessionActive && screensAwake && systemAwake
            && onConsole && ownedSession && displaysDrawable
    }
}

struct HostActivityLease: Equatable {
    let sessionID: String
    let connectionID: UUID
    let displayGeneration: UInt64
    var sequence: UInt64
    var challenge: String
    var expiresAtMilliseconds: UInt64
}

/// Value-only state machine. The AppKit controller calls it on the main actor;
/// tests use an explicit clock and never start capture, sockets, or desktop UI.
struct HostLeaseState {
    private(set) var active: HostActivityLease?

    static func validToken(_ token: String) -> Bool {
        !token.isEmpty && token.utf8.count <= 256 && token.unicodeScalars.allSatisfy {
            $0.value >= 33 && $0.value <= 126
        }
    }

    @discardableResult
    mutating func expire(at now: UInt64) -> Bool {
        guard let lease = active, now >= lease.expiresAtMilliseconds else { return false }
        active = nil
        return true
    }

    mutating func begin(sessionID: String, connectionID: UUID, sequence: UInt64,
                        challenge: String, displayGeneration: UInt64, now: UInt64) throws {
        expire(at: now)
        guard Self.validToken(sessionID), Self.validToken(challenge), sequence > 0,
              now <= UInt64.max - HostLeasePolicy.durationMilliseconds else {
            throw HostLeaseError.invalidParameters
        }
        guard active == nil else { throw HostLeaseError.busy }
        active = HostActivityLease(sessionID: sessionID, connectionID: connectionID,
                                  displayGeneration: displayGeneration, sequence: sequence,
                                  challenge: challenge,
                                  expiresAtMilliseconds: now + HostLeasePolicy.durationMilliseconds)
    }

    func requireOwner(sessionID: String, connectionID: UUID,
                      displayGeneration: UInt64, now: UInt64) throws -> HostActivityLease {
        guard let lease = active, now < lease.expiresAtMilliseconds else {
            throw HostLeaseError.expired
        }
        guard lease.sessionID == sessionID, lease.connectionID == connectionID else {
            throw HostLeaseError.wrongOwner
        }
        guard lease.displayGeneration == displayGeneration else { throw HostLeaseError.displayChanged }
        return lease
    }

    mutating func renew(sessionID: String, connectionID: UUID, sequence: UInt64,
                        challenge: String, displayGeneration: UInt64, now: UInt64,
                        uiHeartbeatAt: UInt64?, captureReady: Bool, overlayReady: Bool) throws {
        var lease = try requireOwner(sessionID: sessionID, connectionID: connectionID,
                                     displayGeneration: displayGeneration, now: now)
        guard Self.validToken(challenge), sequence > lease.sequence,
              now <= UInt64.max - HostLeasePolicy.durationMilliseconds else {
            throw HostLeaseError.staleSequence
        }
        guard Self.isReady(now: now, uiHeartbeatAt: uiHeartbeatAt,
                           captureReady: captureReady, overlayReady: overlayReady) else {
            throw HostLeaseError.notReady
        }
        lease.sequence = sequence
        lease.challenge = challenge
        lease.expiresAtMilliseconds = now + HostLeasePolicy.durationMilliseconds
        active = lease
    }

    @discardableResult
    mutating func release(connectionID: UUID, sessionID: String? = nil) -> Bool {
        guard let lease = active, lease.connectionID == connectionID,
              sessionID == nil || sessionID == lease.sessionID else { return false }
        active = nil
        return true
    }

    mutating func invalidate() { active = nil }

    static func heartbeatAge(now: UInt64, uiHeartbeatAt: UInt64?) -> UInt64? {
        guard let heartbeat = uiHeartbeatAt, now >= heartbeat else { return nil }
        return now - heartbeat
    }

    static func isReady(now: UInt64, uiHeartbeatAt: UInt64?,
                        captureReady: Bool, overlayReady: Bool) -> Bool {
        guard captureReady, overlayReady,
              let age = heartbeatAge(now: now, uiHeartbeatAt: uiHeartbeatAt) else { return false }
        return age <= HostLeasePolicy.uiHeartbeatMaximumAgeMilliseconds
    }
}
