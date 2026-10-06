import XCTest
import Foundation
import AppKit

final class NativeBehaviorTests: XCTestCase {
    private func request(_ method: String, _ params: String = "{}") throws -> PCRequest {
        try JSONDecoder().decode(PCRequest.self,
            from: Data("{\"method\":\"\(method)\",\"params\":\(params),\"id\":1}".utf8))
    }

    func testEncodedGeometryMatchesMappingForOddAspectRatio() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1081)
        let pixels = Data(repeating: 127, count: 1920 * 1081 * 4)
        let encoded = try XCTUnwrap(pixels.withUnsafeBytes {
            FrameImageEncoder.encode(buffer: $0, width: 1920, height: 1081, scaling: scaling)
        })
        let image = try XCTUnwrap(NSBitmapImageRep(data: encoded))
        XCTAssertEqual(image.pixelsWide, scaling.scaledWidth)
        XCTAssertEqual(image.pixelsHigh, scaling.scaledHeight)
        XCTAssertEqual(image.pixelsHigh, 721) // old encoder truncated to 720
    }

    func testResizeRefreshesNativeMappingAndResetRestoresStartupMaximum() {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080, maxDimension: 1024)
        scaling.reconfigure(maxDimension: 320)
        scaling.updateGeometry(width: 1080, height: 1920)
        XCTAssertEqual(scaling.nativeWidth, 1080)
        XCTAssertEqual(scaling.scaledHeight, 320)
        scaling.reset()
        XCTAssertEqual(scaling.maxDimension, 1024)
        XCTAssertEqual(scaling.scaledWidth, 576)
        XCTAssertEqual(scaling.scaledHeight, 1024)
        let edge = scaling.toNative(x: scaling.scaledWidth - 1, y: scaling.scaledHeight - 1)
        XCTAssertLessThan(edge.x, 1080)
        XCTAssertLessThan(edge.y, 1920)
    }

    func testTinyAspectRatioNeverCreatesZeroSizedImage() {
        let scaling = DisplayScaling(nativeWidth: 1, nativeHeight: 32_000, maxDimension: 320)
        XCTAssertEqual(scaling.scaledWidth, 1)
        XCTAssertEqual(scaling.scaledHeight, 320)
    }

    func testEncoderRejectsWrongBufferSizeAndStaleGeometry() {
        let scaling = DisplayScaling(nativeWidth: 2, nativeHeight: 2)
        XCTAssertNil(Data(repeating: 0, count: 15).withUnsafeBytes {
            FrameImageEncoder.encode(buffer: $0, width: 2, height: 2, scaling: scaling)
        })
        XCTAssertNil(Data(repeating: 0, count: 16).withUnsafeBytes {
            FrameImageEncoder.encode(buffer: $0, width: 1, height: 4, scaling: scaling)
        })
    }

    func testNativeValidationRejectsMissingNegativeAndExtremeCoordinates() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        for params in ["{}", "{\"x\":-1,\"y\":0}", "{\"x\":9223372036854775807,\"y\":0}", "{\"x\":0,\"y\":720}"] {
            XCTAssertThrowsError(try request("mouse_click", params).validate(scaling: scaling))
        }
        XCTAssertNoThrow(try request("mouse_click", "{\"x\":1279,\"y\":719}").validate(scaling: scaling))
        XCTAssertThrowsError(try request("scroll", "{\"x\":0,\"y\":0,\"direction\":\"up\",\"amount\":-1}").validate(scaling: scaling))
        XCTAssertThrowsError(try request("key_combo", "{\"key\":\"cmd++v\"}").validate(scaling: scaling))
    }

    func testConfigurationValidatedBeforeUnsignedConversion() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        for params in ["{\"key_hold_ms\":-1}", "{\"max_dimension\":0}",
                       "{\"drag_pixels_per_step\":0}", "{\"drag_min_steps\":-1}",
                       "{\"scroll_tick_ms\":9223372036854775807}"] {
            XCTAssertThrowsError(try request("configure", params).validate(scaling: scaling))
        }
        XCTAssertThrowsError(try request("wait", "{\"ms\":-1}").validate(scaling: scaling))
        XCTAssertNoThrow(try request("configure", "{\"key_hold_ms\":500,\"drag_pixels_per_step\":1}").validate(scaling: scaling))
    }

    func testBaselineDetectsGeometryGenerationAndByteCountChanges() {
        var baseline = FramebufferBaseline()
        let pixels = Data(repeating: 0, count: 16)
        let first = VNCInputContext(width: 2, height: 2, connectionGeneration: 1, allocation: 1)
        XCTAssertFalse(baseline.compareAndReplace(pixels, context: first))
        XCTAssertFalse(baseline.compareAndReplace(pixels, context: first))
        let rotated = VNCInputContext(width: 1, height: 4, connectionGeneration: 1, allocation: 2)
        XCTAssertTrue(baseline.compareAndReplace(pixels, context: rotated))
        let reconnected = VNCInputContext(width: 1, height: 4, connectionGeneration: 2, allocation: 2)
        XCTAssertTrue(baseline.compareAndReplace(pixels, context: reconnected))
        XCTAssertTrue(baseline.compareAndReplace(Data(repeating: 0, count: 12), context: reconnected))
    }

    func testKeyFailureReleasesUncertainPressWithoutReplaying() async {
        let vnc = VNCBridge(config: .init()) // never connects to a target
        var events: [String] = []
        let input = InputController(vnc: vnc, keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
            if down { throw VNCError.sendFailed("synthetic uncertain write") }
        }, sleeper: { _ in })
        do { try await input.keyTap(KeySym.shiftLeft); XCTFail("expected failure") } catch {}
        XCTAssertEqual(events, ["65505:true:false", "65505:false:true"])
        XCTAssertTrue(input.heldKeys.isEmpty)
    }

    func testCancelledClickAttemptsButtonRelease() async {
        let vnc = VNCBridge(config: .init())
        var events: [Int] = []
        let input = InputController(vnc: vnc, pointerSender: { _, _, mask, _, _ in
            events.append(mask)
        }, sleeper: { _ in throw CancellationError() })
        do { try await input.mouseClick(x: 1, y: 1); XCTFail("expected cancellation") } catch {}
        XCTAssertEqual(events, [1, 0])
        XCTAssertFalse(input.heldButtons)
    }

    func testPartialComboFailureReleasesKeysInReverseOrder() async {
        let vnc = VNCBridge(config: .init())
        var events: [String] = []
        let input = InputController(vnc: vnc, keySender: { key, down, _, release in
            events.append("\(key):\(down):\(release)")
            if key == 99 && down { throw VNCError.sendFailed("synthetic") }
        }, sleeper: { _ in })
        do { try await input.keyCombo([KeySym.ctrlLeft, KeySym.shiftLeft, 99]); XCTFail("expected failure") } catch {}
        XCTAssertEqual(Array(events.suffix(3)), ["99:false:true", "65505:false:true", "65507:false:true"])
    }

    func testFailedReleaseRetainsUncertainHeldState() async {
        let vnc = VNCBridge(config: .init())
        let input = InputController(vnc: vnc, keySender: { _, _, _, _ in
            throw VNCError.sendFailed("synthetic disconnected channel")
        }, sleeper: { _ in })
        do { try await input.keyTap(KeySym.shiftLeft); XCTFail("expected failure") } catch {}
        XCTAssertEqual(input.heldKeys, [KeySym.shiftLeft])
        let released = await input.releaseHeldInput()
        XCTAssertFalse(released)
    }

    func testExternalObservationRequiresCompleteBindingAndExactRoundedScale() throws {
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        let valid = "{\"nativeWidth\":1920,\"nativeHeight\":1081,\"scaledWidth\":1280,\"scaledHeight\":721,\"connectionGeneration\":2,\"allocation\":3}"
        let adopted = try request("adopt_observation", valid).externalObservation(scaling: scaling)
        XCTAssertEqual(adopted, VNCInputContext(width: 1920, height: 1081, connectionGeneration: 2, allocation: 3))
        for invalid in ["{}", valid.replacingOccurrences(of: "\"allocation\":3", with: "\"allocation\":0"),
                        valid.replacingOccurrences(of: "\"connectionGeneration\":2", with: "\"connectionGeneration\":0"),
                        valid.replacingOccurrences(of: "\"scaledHeight\":721", with: "\"scaledHeight\":720"),
                        valid.replacingOccurrences(of: "\"nativeWidth\":1920", with: "\"nativeWidth\":9223372036854775807")] {
            XCTAssertThrowsError(try request("adopt_observation", invalid).validate(scaling: scaling))
        }
    }

    func testExternalObservationAcknowledgmentCarriesAllSixExactBindingFields() throws {
        let context = VNCInputContext(width: 1920, height: 1081, connectionGeneration: 2, allocation: 3)
        let response = PCResponse.success(id: .number(1), scaledWidth: 1280, scaledHeight: 721, frameContext: context)
        let encoded = try JSONEncoder().encode(response)
        let payload = try XCTUnwrap((JSONSerialization.jsonObject(with: encoded) as? [String: Any])?["result"] as? [String: Any])
        for (field, expected) in ["nativeWidth":1920, "nativeHeight":1081, "scaledWidth":1280,
                                  "scaledHeight":721, "connectionGeneration":2, "allocation":3] {
            XCTAssertEqual(payload[field] as? Int, expected)
        }
    }

    func testRefusedExternalObservationClearsPreviousInputAuthorization() async {
        let vnc = VNCBridge(config: .init()) // no native connection or target
        let input = InputController(vnc: vnc)
        let context = VNCInputContext(width: 1920, height: 1080, connectionGeneration: 1, allocation: 1)
        input.context = context
        let scaling = DisplayScaling(nativeWidth: 1920, nativeHeight: 1080)
        do { try await input.adoptObservation(context, scaling: scaling); XCTFail("disconnected adoption admitted") }
        catch VNCError.notConnected {} catch { XCTFail("unexpected error: \(error)") }
        XCTAssertNil(input.context)
    }
}
