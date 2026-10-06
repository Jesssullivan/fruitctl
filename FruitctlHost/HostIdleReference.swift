import Foundation
import Darwin
import CryptoKit
import ImageIO

enum HostIdleReferenceError: String, Error {
    case notArmed = "idle_reference_not_armed"
    case staleArm = "idle_reference_arm_expired"
    case notIdle = "idle_reference_requires_idle_host"
    case lifecycleChanged = "idle_reference_lifecycle_changed"
    case unsafeOutput = "idle_reference_unsafe_output"
    case outputFailed = "idle_reference_output_failed"
    case connectionClosed = "idle_reference_connection_closed"
}

struct HostIdleReferenceConditions {
    let captureEnabled: Bool
    let activityEligible: Bool
    let activeLease: Bool
    let captureReady: Bool
    let overlayReady: Bool
    let anyVisiblePanel: Bool
    let otherCaptureInProgress: Bool
    let lifecycleRevision: UUID
    let displayGeneration: UInt64

    var isIdle: Bool {
        activityEligible && !activeLease && !captureReady && !overlayReady
            && !anyVisiblePanel && !otherCaptureInProgress
    }
}

struct HostReferenceCapture {
    let png: Data
    /// Geometry/filter metadata only. The complete PNG is a separate file.
    let metadata: [String: HostValue]
}

struct HostReferenceExport {
    let directory: String
    let imageSHA256: String
    let receiptSHA256: String

    var metadata: [String: HostValue] {
        ["directory": .string(directory), "image_file": .string("reference.png"),
         "receipt_file": .string("receipt.json"), "image_sha256": .string(imageSHA256),
         "receipt_sha256": .string(receiptSHA256),
         "classification": .string("idle_reference"), "input_observation": .boolean(false),
         "ready": .boolean(false), "capture_ready": .boolean(false),
         "overlay_ready": .boolean(false), "lease_remaining_ms": .integer(0)]
    }
}

/// Same-artifact diagnostic admission. Only the local AppKit menu calls arm;
/// IPC can consume that transient human choice but cannot create one. Capture,
/// clock, permission and lifecycle are injected for offline fault tests.
@MainActor
final class HostIdleReferenceCoordinator {
    static let armDurationMilliseconds: UInt64 = 60_000
    private struct Arm {
        let id: String
        let expiresAt: UInt64
        let revision: UUID
        let generation: UInt64
    }
    private var arm: Arm?
    private var exportID: UUID?
    private var exportConnectionID: UUID?
    private let permission: HostCapturePermission
    private let clock: () -> UInt64
    private let conditions: () -> HostIdleReferenceConditions
    private let capture: () async throws -> HostReferenceCapture
    private let connectionLive: (UUID) -> Bool
    private let persist: (HostReferenceCapture, [String: HostValue]) throws -> HostReferenceExport

    init(permission: HostCapturePermission, clock: @escaping () -> UInt64,
         conditions: @escaping () -> HostIdleReferenceConditions,
         capture: @escaping () async throws -> HostReferenceCapture,
         connectionLive: @escaping (UUID) -> Bool,
         persist: @escaping (HostReferenceCapture, [String: HostValue]) throws -> HostReferenceExport) {
        self.permission = permission; self.clock = clock; self.conditions = conditions
        self.capture = capture; self.persist = persist
        self.connectionLive = connectionLive
    }

    var isExporting: Bool { exportID != nil }

    var armedID: String? {
        guard let arm, clock() < arm.expiresAt else { return nil }
        return arm.id
    }

    @discardableResult
    func armFromHuman() throws -> String {
        let current = conditions(), now = clock()
        try permission.requireCapture(enabled: current.captureEnabled)
        guard current.isIdle, !isExporting else { throw HostIdleReferenceError.notIdle }
        guard now <= UInt64.max - Self.armDurationMilliseconds else {
            throw HostIdleReferenceError.staleArm
        }
        let id = UUID().uuidString
        arm = Arm(id: id, expiresAt: now + Self.armDurationMilliseconds,
                  revision: current.lifecycleRevision, generation: current.displayGeneration)
        return id
    }

    func invalidate() {
        arm = nil
        invalidationRevision = UUID()
        // Keep isExporting true until the outstanding async task unwinds. A
        // Stop→Allow cannot overlap a new capture with that old acquisition.
    }

    func disconnected(_ connectionID: UUID) {
        if exportConnectionID == connectionID { invalidate() }
    }

    func export(armedID: String, connectionID: UUID,
                binding: [String: HostValue]) async throws -> HostReferenceExport {
        guard !isExporting else { throw HostIdleReferenceError.notIdle }
        guard let selected = arm else { throw HostIdleReferenceError.notArmed }
        // Consume before every attempted capture, including permission failure.
        arm = nil
        guard selected.id == armedID, clock() < selected.expiresAt else {
            throw HostIdleReferenceError.staleArm
        }
        guard connectionLive(connectionID) else { throw HostIdleReferenceError.connectionClosed }
        let initial = conditions()
        try permission.requireCapture(enabled: initial.captureEnabled)
        guard initial.isIdle else { throw HostIdleReferenceError.notIdle }
        guard initial.lifecycleRevision == selected.revision,
              initial.displayGeneration == selected.generation else {
            throw HostIdleReferenceError.lifecycleChanged
        }
        let operation = UUID(), startedAt = clock(), operationRevision = invalidationRevision
        guard startedAt < selected.expiresAt else { throw HostIdleReferenceError.staleArm }
        exportID = operation
        exportConnectionID = connectionID
        defer {
            if exportID == operation { exportID = nil; exportConnectionID = nil }
        }
        let image = try await capture()
        let completedAt = clock(), final = conditions()
        try permission.requireCapture(enabled: final.captureEnabled)
        guard completedAt < selected.expiresAt else { throw HostIdleReferenceError.staleArm }
        guard final.isIdle, final.lifecycleRevision == selected.revision,
              final.displayGeneration == selected.generation else {
            throw HostIdleReferenceError.lifecycleChanged
        }
        // invalidate() must revoke a task even when a dependency returns to its
        // earlier value without changing the injected lifecycle revision.
        guard invalidationRevision == operationRevision else {
            throw HostIdleReferenceError.lifecycleChanged
        }
        // Check the actual original transport, not only a queued disconnect
        // callback. A closed peer cannot commit a delayed returned image.
        guard connectionLive(connectionID) else { throw HostIdleReferenceError.connectionClosed }
        var receipt = binding
        receipt.merge(image.metadata) { _, value in value }
        receipt.merge([
            "schema": .string("fruitctl-idle-reference-v1"), "reference_id": .string(selected.id),
            "classification": .string("idle_reference"), "input_observation": .boolean(false),
            "ready": .boolean(false), "capture_ready": .boolean(false),
            "overlay_ready": .boolean(false), "lease_remaining_ms": .integer(0),
            "ordinary_permission_at_start": .boolean(true), "ordinary_permission_at_end": .boolean(true),
            "direct_capture_permission_qualified": .boolean(false),
            "started_monotonic_ms": .integer(Int64(clamping: startedAt)),
            "completed_monotonic_ms": .integer(Int64(clamping: completedAt))
        ]) { _, value in value }
        return try persist(image, receipt)
    }

    private var invalidationRevision = UUID()
}

/// Exclusive private files, no path supplied by IPC. All directory components
/// are traversed without following symlinks; an existing private root must have
/// the expected owner/mode. A partial failed export stays private and is never
/// advertised as a completed receipt.
struct HostReferenceStore {
    let root: URL

    static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath()
            .appendingPathComponent("Library/Application Support/Fruitctl/qualification")
    }

    func save(_ capture: HostReferenceCapture,
              receipt: [String: HostValue]) throws -> HostReferenceExport {
        try validateImage(capture)
        let rootFD = try openPrivateRoot()
        defer { close(rootFD) }
        let name = "reference-" + UUID().uuidString
        guard mkdirat(rootFD, name, 0o700) == 0 else { throw HostIdleReferenceError.outputFailed }
        let outputFD = openat(rootFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard outputFD >= 0 else { throw HostIdleReferenceError.unsafeOutput }
        defer { close(outputFD) }
        try validatePrivateDirectory(outputFD)
        let imageHash = Self.sha256(capture.png)
        var completed = receipt
        completed.removeValue(forKey: "image")
        completed["image_file"] = .string("reference.png")
        completed["image_sha256"] = .string(imageHash)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var record = try encoder.encode(completed); record.append(10)
        try writeExclusive(capture.png, name: "reference.png", directoryFD: outputFD)
        // The receipt is written last; consumers must require both hashes.
        try writeExclusive(record, name: "receipt.json", directoryFD: outputFD)
        return HostReferenceExport(directory: root.appendingPathComponent(name).path,
            imageSHA256: imageHash, receiptSHA256: Self.sha256(record))
    }

    private func validateImage(_ capture: HostReferenceCapture) throws {
        guard let width = capture.metadata["nativeWidth"]?.integer,
              let height = capture.metadata["nativeHeight"]?.integer,
              width > 0, height > 0, width <= 16_384, height <= 16_384,
              width <= 33_554_432 / height,
              capture.metadata["scaledWidth"]?.integer == width,
              capture.metadata["scaledHeight"]?.integer == height,
              capture.png.count <= 150_000_000,
              capture.png.prefix(8) == Data([137, 80, 78, 71, 13, 10, 26, 10]),
              capture.png.suffix(12) == Data([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]),
              let source = CGImageSourceCreateWithData(capture.png as CFData, nil),
              (CGImageSourceGetType(source) as String?) == "public.png",
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetStatus(source) == .statusComplete,
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              image.width == width, image.height == height else {
            throw HostCaptureError.incompleteImage
        }
    }

    private func openPrivateRoot() throws -> Int32 {
        let components = root.pathComponents
        guard root.isFileURL, components.first == "/", components.count > 2,
              !components.contains(".."), !components.contains(".") else {
            throw HostIdleReferenceError.unsafeOutput
        }
        var current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard current >= 0 else { throw HostIdleReferenceError.unsafeOutput }
        do {
            for component in components.dropFirst() {
                if mkdirat(current, component, 0o700) != 0 && errno != EEXIST {
                    throw HostIdleReferenceError.outputFailed
                }
                let child = openat(current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
                guard child >= 0 else { throw HostIdleReferenceError.unsafeOutput }
                close(current); current = child
                var info = stat()
                guard fstat(current, &info) == 0, (info.st_uid == 0 || info.st_uid == getuid()),
                      info.st_mode & 0o022 == 0 else { throw HostIdleReferenceError.unsafeOutput }
                try rejectExtendedAllowACL(current)
            }
            try validatePrivateDirectory(current)
            return current
        } catch { close(current); throw error }
    }

    private func validatePrivateDirectory(_ fd: Int32) throws {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(),
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_mode & 0o777 == 0o700 else {
            throw HostIdleReferenceError.unsafeOutput
        }
        try rejectExtendedAllowACL(fd)
    }

    private func writeExclusive(_ data: Data, name: String, directoryFD: Int32) throws {
        let fd = openat(directoryFD, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw HostIdleReferenceError.outputFailed }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(),
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_mode & 0o777 == 0o600 else {
            throw HostIdleReferenceError.unsafeOutput
        }
        try rejectExtendedAllowACL(fd)
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw HostIdleReferenceError.outputFailed }
                offset += written
            }
        }
        guard fsync(fd) == 0 else { throw HostIdleReferenceError.outputFailed }
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Mode bits alone do not constrain inherited macOS ACE grants. Inspect
    /// the already-open object; reject allow/unknown entries without editing
    /// anyone's ACL. Deny-only entries cannot broaden disclosure rights.
    private func rejectExtendedAllowACL(_ fd: Int32) throws {
        guard let security = filesec_init() else {
            throw HostIdleReferenceError.unsafeOutput
        }
        defer { filesec_free(security) }
        var info = stat(), present: Int32 = 0
        guard fstatx_np(fd, &info, security) == 0,
              filesec_query_property(security, FILESEC_ACL, &present) == 0 else {
            throw HostIdleReferenceError.unsafeOutput
        }
        // acl_get_fd_np can report NULL/ENOENT for an absent ACL. Distinguish
        // that proven absence from failed metadata acquisition on this fd.
        if present == 0 { return }
        var retrieved: acl_t?
        guard filesec_get_property(security, FILESEC_ACL, &retrieved) == 0,
              let acl = retrieved else { throw HostIdleReferenceError.unsafeOutput }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        guard acl_valid(acl) == 0 else { throw HostIdleReferenceError.unsafeOutput }
        for index in 0...Int(ACL_MAX_ENTRIES) {
            var entry: acl_entry_t?
            errno = 0
            let result = acl_get_entry(acl, Int32(index), &entry)
            if result == -1 && errno == EINVAL { return } // documented end of valid ACL
            guard result == 0, let entry else { throw HostIdleReferenceError.unsafeOutput }
            var tag = ACL_UNDEFINED_TAG
            guard acl_get_tag_type(entry, &tag) == 0, tag == ACL_EXTENDED_DENY else {
                throw HostIdleReferenceError.unsafeOutput
            }
        }
        throw HostIdleReferenceError.unsafeOutput
    }
}
