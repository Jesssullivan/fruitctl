import Foundation
import XCTest
import Darwin
import CoreGraphics
import ImageIO

@MainActor
private final class IdleReferenceFixture {
    var now: UInt64 = 100
    var enabled = true
    var granted = true
    var eligible = true
    var lease = false
    var captureReady = false
    var overlayReady = false
    var visible = false
    var otherCapture = false
    var revision = UUID()
    var generation: UInt64 = 1
    var slowAdmission = false
    var requests = 0
    var captures = 0
    var persisted: [[String: HostValue]] = []
    var failCapture = false
    var suspendCapture = false
    var pending: CheckedContinuation<HostReferenceCapture, Error>?
    let connection = UUID()

    lazy var permission = HostCapturePermission(preflight: { [unowned self] in self.granted },
        request: { [unowned self] in self.requests += 1; return self.granted })
    lazy var coordinator = HostIdleReferenceCoordinator(permission: permission,
        clock: { [unowned self] in self.now }, conditions: { [unowned self] in self.conditions },
        capture: { [unowned self] in
            self.captures += 1
            if self.failCapture { throw HostCaptureError.captureFailed }
            if self.suspendCapture {
                return try await withCheckedThrowingContinuation { self.pending = $0 }
            }
            return Self.image
        }, connectionLive: { _ in true
        }, persist: { [unowned self] image, receipt in
            self.persisted.append(receipt)
            return HostReferenceExport(directory: "/owned/private/reference", imageSHA256: "png-hash",
                                       receiptSHA256: "receipt-hash")
        })

    var conditions: HostIdleReferenceConditions {
        if slowAdmission {
            slowAdmission = false
            now += HostIdleReferenceCoordinator.armDurationMilliseconds
        }
        return HostIdleReferenceConditions(captureEnabled: enabled, activityEligible: eligible,
            activeLease: lease, captureReady: captureReady, overlayReady: overlayReady,
            anyVisiblePanel: visible, otherCaptureInProgress: otherCapture,
            lifecycleRevision: revision, displayGeneration: generation)
    }

    static var image: HostReferenceCapture {
        HostReferenceCapture(png: Data([1, 2, 3]), metadata: ["nativeWidth": .integer(2),
            "nativeHeight": .integer(2), "scaledWidth": .integer(2), "scaledHeight": .integer(2)])
    }

    func finishCapture() {
        let saved = pending; pending = nil
        saved?.resume(returning: Self.image)
    }
}

@MainActor
final class HostIdleReferenceTests: XCTestCase {
    private func export(_ fixture: IdleReferenceFixture, id: String) async throws -> HostReferenceExport {
        try await fixture.coordinator.export(armedID: id, connectionID: fixture.connection,
            binding: ["instance_id": .string("instance-A"), "displayGeneration": .integer(1)])
    }

    private func awaitPending(_ fixture: IdleReferenceFixture) async {
        for _ in 0..<100 {
            if fixture.pending != nil { return }
            await Task.yield()
        }
        XCTFail("Injected capture never reached its suspension point")
    }

    func testPermissionIntentAndGrantAreIndependentAndNeverImplicitlyRequested() throws {
        let fixture = IdleReferenceFixture()
        XCTAssertThrowsError(try fixture.permission.requireCapture(enabled: false)) {
            XCTAssertEqual($0 as? HostCaptureError, .notEnabled)
        }
        fixture.granted = false
        XCTAssertThrowsError(try fixture.permission.requireCapture(enabled: true)) {
            XCTAssertEqual($0 as? HostCaptureError, .permissionRequired)
        }
        fixture.granted = true
        XCTAssertNoThrow(try fixture.permission.requireCapture(enabled: true))
        XCTAssertEqual(fixture.requests, 0)
    }

    func testIPCExportCannotCreateHumanArm() async {
        let fixture = IdleReferenceFixture()
        do { _ = try await export(fixture, id: "not-armed"); XCTFail("Unarmed capture succeeded") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .notArmed) }
        XCTAssertEqual(fixture.captures, 0)
        XCTAssertEqual(fixture.requests, 0)
    }

    func testFrameworkAuthorizationRejectsGrantWithdrawnDuringAcquisition() async {
        let fixture = IdleReferenceFixture()
        do {
            _ = try await fixture.permission.withCaptureAuthorization(enabled: { fixture.enabled }) {
                fixture.granted = false
                await Task.yield()
                return "returned framework pixels"
            }
            XCTFail("Framework completion bypassed withdrawal")
        } catch { XCTAssertEqual(error as? HostCaptureError, .permissionRequired) }
        XCTAssertEqual(fixture.requests, 0)
    }

    func testFrameworkAuthorizationRejectsHumanDisableDuringAcquisition() async {
        let fixture = IdleReferenceFixture()
        do {
            _ = try await fixture.permission.withCaptureAuthorization(enabled: { fixture.enabled }) {
                fixture.enabled = false
                await Task.yield()
                return "returned framework pixels"
            }
            XCTFail("Framework completion bypassed Disable")
        } catch { XCTAssertEqual(error as? HostCaptureError, .notEnabled) }
        XCTAssertTrue(fixture.granted)
        XCTAssertEqual(fixture.requests, 0)
    }

    func testDirectCaptureFailureDoesNotChangeOrdinaryGrantOrRequestConsent() async {
        let fixture = IdleReferenceFixture()
        do {
            let _: String = try await fixture.permission.withCaptureAuthorization(enabled: { fixture.enabled }) {
                throw HostCaptureError.captureFailed
            }
            XCTFail("Direct capture failure succeeded")
        } catch { XCTAssertEqual(error as? HostCaptureError, .captureFailed) }
        XCTAssertTrue(fixture.granted)
        XCTAssertTrue(fixture.enabled)
        XCTAssertEqual(fixture.requests, 0)
    }

    func testIdleExportConsumesArmAndNeverProducesInputReadiness() async throws {
        let fixture = IdleReferenceFixture()
        let id = try fixture.coordinator.armFromHuman()
        let exported = try await export(fixture, id: id)
        XCTAssertEqual(fixture.captures, 1)
        XCTAssertEqual(fixture.persisted.count, 1)
        XCTAssertEqual(exported.metadata["ready"], .boolean(false))
        XCTAssertEqual(exported.metadata["lease_remaining_ms"], .integer(0))
        XCTAssertEqual(exported.metadata["input_observation"], .boolean(false))
        XCTAssertEqual(fixture.persisted[0]["direct_capture_permission_qualified"], .boolean(false))
        XCTAssertNil(fixture.coordinator.armedID)
        XCTAssertFalse(fixture.coordinator.isExporting)
        do { _ = try await export(fixture, id: id); XCTFail("Arm was reused") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .notArmed) }
        XCTAssertEqual(fixture.captures, 1)
        XCTAssertEqual(fixture.requests, 0)
        XCTAssertFalse(fixture.lease)
    }

    func testEachNonIdleConditionRefusesWithoutCaptureOrPanelMutation() throws {
        let changes: [(IdleReferenceFixture) -> Void] = [
            { $0.eligible = false }, { $0.lease = true }, { $0.captureReady = true },
            { $0.overlayReady = true }, { $0.visible = true }, { $0.otherCapture = true }
        ]
        for change in changes {
            let fixture = IdleReferenceFixture(); change(fixture)
            XCTAssertThrowsError(try fixture.coordinator.armFromHuman()) {
                XCTAssertEqual($0 as? HostIdleReferenceError, .notIdle)
            }
            XCTAssertEqual(fixture.captures, 0)
            XCTAssertEqual(fixture.requests, 0)
        }
    }

    func testDeniedIntentOrPermissionRefusesLocalArmWithoutChangingEither() {
        for enabled in [false, true] {
            let fixture = IdleReferenceFixture(); fixture.enabled = enabled; fixture.granted = false
            XCTAssertThrowsError(try fixture.coordinator.armFromHuman())
            XCTAssertEqual(fixture.enabled, enabled)
            XCTAssertFalse(fixture.granted)
            XCTAssertEqual(fixture.requests, 0)
        }
    }

    func testWrongOrExpiredArmIsConsumedWithoutCapture() async throws {
        for expired in [false, true] {
            let fixture = IdleReferenceFixture()
            let id = try fixture.coordinator.armFromHuman()
            if expired { fixture.now += HostIdleReferenceCoordinator.armDurationMilliseconds }
            do { _ = try await export(fixture, id: expired ? id : "different"); XCTFail("Stale arm accepted") }
            catch { XCTAssertEqual(error as? HostIdleReferenceError, .staleArm) }
            XCTAssertNil(fixture.coordinator.armedID)
            XCTAssertEqual(fixture.captures, 0)
        }
    }

    func testCaptureFailureLeavesNoReceiptOrReusableArm() async throws {
        let fixture = IdleReferenceFixture(); fixture.failCapture = true
        let id = try fixture.coordinator.armFromHuman()
        do { _ = try await export(fixture, id: id); XCTFail("Failed capture exported") }
        catch { XCTAssertEqual(error as? HostCaptureError, .captureFailed) }
        XCTAssertTrue(fixture.persisted.isEmpty)
        XCTAssertNil(fixture.coordinator.armedID)
        XCTAssertFalse(fixture.coordinator.isExporting)
        XCTAssertEqual(fixture.requests, 0)
    }

    func testSlowAdmissionCannotStartCaptureAfterHumanArmDeadline() async throws {
        let fixture = IdleReferenceFixture()
        let id = try fixture.coordinator.armFromHuman()
        fixture.slowAdmission = true
        do { _ = try await export(fixture, id: id); XCTFail("Expired admission started capture") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .staleArm) }
        XCTAssertEqual(fixture.captures, 0)
        XCTAssertTrue(fixture.persisted.isEmpty)
        XCTAssertNil(fixture.coordinator.armedID)
    }

    func testPermissionWithdrawalDuringAwaitRefusesReturnedPixels() async throws {
        let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
        let id = try fixture.coordinator.armFromHuman()
        let operation = Task { try await self.export(fixture, id: id) }
        await awaitPending(fixture)
        fixture.granted = false; fixture.finishCapture()
        do { _ = try await operation.value; XCTFail("Withdrawn permission exported") }
        catch { XCTAssertEqual(error as? HostCaptureError, .permissionRequired) }
        XCTAssertTrue(fixture.persisted.isEmpty)
        XCTAssertEqual(fixture.requests, 0)
    }

    func testAwayAndReturnDuringCaptureStillInvalidatesEpisode() async throws {
        let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
        var availability = HostAvailabilityState()
        fixture.revision = availability.revision
        let id = try fixture.coordinator.armFromHuman()
        let operation = Task { try await self.export(fixture, id: id) }
        await awaitPending(fixture)
        availability.apply(.sessionResigned); availability.apply(.sessionActivated)
        fixture.revision = availability.revision; fixture.eligible = true
        fixture.finishCapture()
        do { _ = try await operation.value; XCTFail("Returned session reused old episode") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .lifecycleChanged) }
        XCTAssertTrue(fixture.persisted.isEmpty)
    }

    func testExplicitStopOrDisableInvalidationCannotBeUndoneDuringAwait() async throws {
        let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
        let id = try fixture.coordinator.armFromHuman()
        let operation = Task { try await self.export(fixture, id: id) }
        await awaitPending(fixture)
        fixture.coordinator.invalidate()
        // A local Allow/Enable before completion cannot revive old capture,
        // even if a faulty injected source restores all eligibility values.
        fixture.eligible = true; fixture.enabled = true
        XCTAssertThrowsError(try fixture.coordinator.armFromHuman())
        fixture.finishCapture()
        do { _ = try await operation.value; XCTFail("Invalidation was reversed") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .lifecycleChanged) }
        XCTAssertTrue(fixture.persisted.isEmpty)
    }

    func testDisplayGenerationChangeRejectsCompletedReference() async throws {
        let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
        let id = try fixture.coordinator.armFromHuman()
        let operation = Task { try await self.export(fixture, id: id) }
        await awaitPending(fixture)
        fixture.generation += 1; fixture.finishCapture()
        do { _ = try await operation.value; XCTFail("Changed display exported") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .lifecycleChanged) }
        XCTAssertTrue(fixture.persisted.isEmpty)
    }

    func testOnlyOwningConnectionDisconnectCancelsPendingExport() async throws {
        for owned in [false, true] {
            let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
            let id = try fixture.coordinator.armFromHuman()
            let operation = Task { try await self.export(fixture, id: id) }
            await awaitPending(fixture)
            fixture.coordinator.disconnected(owned ? fixture.connection : UUID())
            fixture.finishCapture()
            do {
                _ = try await operation.value
                XCTAssertFalse(owned)
            } catch {
                XCTAssertTrue(owned)
                XCTAssertEqual(error as? HostIdleReferenceError, .lifecycleChanged)
            }
            XCTAssertEqual(fixture.persisted.count, owned ? 0 : 1)
        }
    }

    func testConcurrentExportAndRearmCannotOverlapSuspendedCapture() async throws {
        let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
        let id = try fixture.coordinator.armFromHuman()
        let operation = Task { try await self.export(fixture, id: id) }
        await awaitPending(fixture)
        XCTAssertThrowsError(try fixture.coordinator.armFromHuman())
        do { _ = try await export(fixture, id: id); XCTFail("Concurrent export accepted") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .notIdle) }
        fixture.finishCapture(); _ = try await operation.value
        XCTAssertEqual(fixture.captures, 1)
    }

    func testArmDeadlineAppliesToCompletionAndRestartNeverRestoresArm() async throws {
        let fixture = IdleReferenceFixture(); fixture.suspendCapture = true
        let id = try fixture.coordinator.armFromHuman()
        let operation = Task { try await self.export(fixture, id: id) }
        await awaitPending(fixture)
        fixture.now += HostIdleReferenceCoordinator.armDurationMilliseconds
        fixture.finishCapture()
        do { _ = try await operation.value; XCTFail("Late completion persisted") }
        catch { XCTAssertEqual(error as? HostIdleReferenceError, .staleArm) }
        XCTAssertTrue(fixture.persisted.isEmpty)
        let restarted = IdleReferenceFixture()
        XCTAssertNil(restarted.coordinator.armedID)
        XCTAssertFalse(restarted.coordinator.isExporting)
    }
}

final class HostReferenceStoreTests: XCTestCase {
    private var roots: [URL] = []

    private func root() throws -> URL {
        let url = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath()
            .appendingPathComponent(".local/state/fruitctl-offline-tests/" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        roots.append(url)
        return url
    }

    override func tearDownWithError() throws {
        for url in roots { try FileManager.default.removeItem(at: url) }
        roots.removeAll()
    }

    private func image() throws -> HostReferenceCapture {
        let context = CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 0.5, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return HostReferenceCapture(png: data as Data, metadata: ["nativeWidth": .integer(2),
            "nativeHeight": .integer(2), "scaledWidth": .integer(2), "scaledHeight": .integer(2)])
    }

    /// Install an ACL only on this test's new UUID-owned fixture. The product
    /// never writes or repairs ACLs on existing directories or exports.
    private func installACL(_ url: URL, tag: acl_tag_t, inherit: Bool) throws {
        var acl: acl_t? = acl_init(1)
        guard acl != nil else { throw POSIXError(.ENOMEM) }
        defer { if let acl { acl_free(UnsafeMutableRawPointer(acl)) } }
        var entry: acl_entry_t?
        try check(acl_create_entry(&acl, &entry))
        guard let entry, let acl else { throw POSIXError(.EINVAL) }
        try check(acl_set_tag_type(entry, tag))
        // A synthetic UUID avoids changing access for any real fleet account.
        var principal = UUID().uuid
        try withUnsafePointer(to: &principal) { try check(acl_set_qualifier(entry, $0)) }
        var permissions: acl_permset_t?
        try check(acl_get_permset(entry, &permissions))
        guard let permissions else { throw POSIXError(.EINVAL) }
        try check(acl_add_perm(permissions, ACL_READ_DATA))
        try check(acl_add_perm(permissions, ACL_SEARCH))
        if inherit {
            var flags: acl_flagset_t?
            try check(acl_get_flagset_np(UnsafeMutableRawPointer(entry), &flags))
            guard let flags else { throw POSIXError(.EINVAL) }
            try check(acl_add_flag_np(flags, ACL_ENTRY_FILE_INHERIT))
            try check(acl_add_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT))
        }
        try check(acl_valid(acl))
        try check(acl_set_file(url.path, ACL_TYPE_EXTENDED, acl))
    }

    private func check(_ result: Int32) throws {
        guard result == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
    }

    private func aclBytes(_ url: URL, inherited: Bool = false) throws -> Data {
        guard let acl = acl_get_file(url.path, ACL_TYPE_EXTENDED) else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        if inherited {
            var entry: acl_entry_t?, flags: acl_flagset_t?
            try check(acl_get_entry(acl, 0, &entry))
            guard let entry else { throw POSIXError(.EINVAL) }
            try check(acl_get_flagset_np(UnsafeMutableRawPointer(entry), &flags))
            guard let flags else { throw POSIXError(.EINVAL) }
            XCTAssertEqual(acl_get_flag_np(flags, ACL_ENTRY_INHERITED), 1)
        }
        let size = acl_size(acl)
        guard size > 0 else { throw POSIXError(.EINVAL) }
        var data = Data(count: size)
        let copied = data.withUnsafeMutableBytes { acl_copy_ext($0.baseAddress, acl, size) }
        guard copied == size else { throw POSIXError(.EINVAL) }
        return data
    }

    func testNativePNGAndReceiptAreExclusivePrivateFilesWithBoundHashes() throws {
        let store = HostReferenceStore(root: try root()), capture = try image()
        let first = try store.save(capture, receipt: ["classification": .string("idle_reference")])
        let second = try store.save(capture, receipt: [:])
        XCTAssertNotEqual(first.directory, second.directory)
        let imageURL = URL(fileURLWithPath: first.directory).appendingPathComponent("reference.png")
        let receiptURL = URL(fileURLWithPath: first.directory).appendingPathComponent("receipt.json")
        let saved = try Data(contentsOf: imageURL), record = try Data(contentsOf: receiptURL)
        XCTAssertEqual(saved, capture.png)
        XCTAssertEqual(HostReferenceStore.sha256(saved), first.imageSHA256)
        XCTAssertEqual(HostReferenceStore.sha256(record), first.receiptSHA256)
        let object = try JSONSerialization.jsonObject(with: record) as! [String: Any]
        XCTAssertEqual(object["image_sha256"] as? String, first.imageSHA256)
        XCTAssertNil(object["image"])
        for path in [first.directory, imageURL.path, receiptURL.path] {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            let mode = (attributes[.posixPermissions] as! NSNumber).intValue
            XCTAssertEqual(mode, path == first.directory ? 0o700 : 0o600)
            XCTAssertEqual((attributes[.ownerAccountID] as! NSNumber).uint32Value, getuid())
        }
    }

    func testScaledMalformedOrGeometryMismatchedPNGCreatesNoOutput() throws {
        let store = HostReferenceStore(root: try root()), source = try image()
        var scaled = source.metadata; scaled["scaledWidth"] = .integer(1)
        var mismatch = source.metadata; mismatch["nativeWidth"] = .integer(3)
        mismatch["scaledWidth"] = .integer(3)
        for image in [HostReferenceCapture(png: source.png, metadata: scaled),
                      HostReferenceCapture(png: Data([1, 2, 3]), metadata: source.metadata),
                      HostReferenceCapture(png: Data(source.png.dropLast(12)), metadata: source.metadata),
                      HostReferenceCapture(png: source.png, metadata: mismatch)] {
            XCTAssertThrowsError(try store.save(image, receipt: [:])) {
                XCTAssertEqual($0 as? HostCaptureError, .incompleteImage)
            }
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: store.root.path), [])
    }

    func testUnsafeExistingRootAndSymlinkAreRejectedWithoutChangingTargets() throws {
        let parent = try root(), image = try image()
        let publicRoot = parent.appendingPathComponent("wrong-mode")
        try FileManager.default.createDirectory(at: publicRoot, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o755])
        XCTAssertThrowsError(try HostReferenceStore(root: publicRoot).save(image, receipt: [:]))
        let attributes = try FileManager.default.attributesOfItem(atPath: publicRoot.path)
        XCTAssertEqual((attributes[.posixPermissions] as! NSNumber).intValue, 0o755)
        let target = parent.appendingPathComponent("target")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        let link = parent.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try HostReferenceStore(root: link).save(image, receipt: [:]))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: target.path), [])
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link.path), target.path)
    }

    func testExtendedAllowACLIsRejectedWithoutOutputOrRepair() throws {
        let url = try root()
        try installACL(url, tag: ACL_EXTENDED_ALLOW, inherit: false)
        let before = try aclBytes(url)
        XCTAssertThrowsError(try HostReferenceStore(root: url).save(try image(), receipt: [:])) {
            XCTAssertEqual($0 as? HostIdleReferenceError, .unsafeOutput)
        }
        XCTAssertEqual(try aclBytes(url), before)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: url.path), [])
    }

    func testInheritedAllowACLRemainsUnsafeDespitePrivateModeBits() throws {
        let parent = try root()
        try installACL(parent, tag: ACL_EXTENDED_ALLOW, inherit: true)
        let child = parent.appendingPathComponent("inherited")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: false,
                                               attributes: [.posixPermissions: 0o700])
        let before = try aclBytes(child, inherited: true)
        let mode = try FileManager.default.attributesOfItem(atPath: child.path)
        XCTAssertEqual((mode[.posixPermissions] as! NSNumber).intValue, 0o700)
        XCTAssertThrowsError(try HostReferenceStore(root: child).save(try image(), receipt: [:])) {
            XCTAssertEqual($0 as? HostIdleReferenceError, .unsafeOutput)
        }
        XCTAssertEqual(try aclBytes(child, inherited: true), before)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: child.path), [])
    }

    func testDenyOnlyACLDoesNotBroadenRightsAndIsPreserved() throws {
        let url = try root()
        try installACL(url, tag: ACL_EXTENDED_DENY, inherit: true)
        let before = try aclBytes(url)
        let result = try HostReferenceStore(root: url).save(try image(), receipt: [:])
        XCTAssertEqual(try aclBytes(url), before)
        let output = URL(fileURLWithPath: result.directory)
        _ = try aclBytes(output, inherited: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath:
            output.appendingPathComponent("reference.png").path))
    }
}
