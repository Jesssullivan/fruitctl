import Foundation
import CLibVNCClient

/// All operations execute on VNCBridge's one native-client queue. The failed
/// initialize operation consumes its client, matching rfbInitClient's contract.
/// Tests replace these operations; production never selects another transport.
struct VNCClientOperations {
    typealias Client = UnsafeMutablePointer<rfbClient>
    var make: (VNCConfiguration) -> Client?
    var initialize: (Client) -> Bool
    var cleanup: (Client) -> Void
    var poll: (Client, UInt32, (VNCDecoderPhase) -> Void) -> Bool
    var incrementalUpdate: (Client) -> Bool
    var fullUpdate: (Client) -> Bool
    var allocateFramebuffer: (Int) -> UnsafeMutablePointer<UInt8>? = { malloc($0)?.assumingMemoryBound(to: UInt8.self) }
    var freeFramebuffer: (UnsafeMutablePointer<UInt8>) -> Void = { free($0) }
    /// Writes one already-mapped RFB KeyEvent. Tests record the wire sequence.
    var sendKey: (Client, UInt32, Bool) -> Bool = { SendKeyEvent($0, $1, $2 ? -1 : 0) != 0 }
    /// Writes one RFB PointerEvent (x, y, button mask). Every input write
    /// crosses a seam, so tests can prove a capture path writes no input.
    var sendPointer: (Client, Int32, Int32, Int32) -> Bool = { SendPointerEvent($0, $1, $2, $3) != 0 }
    /// Writes one RFB ClientCutText from a NUL-terminated buffer. The wire
    /// length excludes the terminator.
    var sendClientCutText: (Client, [CChar]) -> Bool = { client, text in
        var bytes = text
        return SendClientCutText(client, &bytes, Int32(bytes.count - 1)) != 0
    }
    /// Writes UTF-8 text as an ExtendedClipboard Notify + Provide from a
    /// NUL-terminated buffer. LibVNC refuses it unless the server advertised
    /// text capability, so callers check `extendedClipboardText` first.
    var sendClientCutTextUTF8: (Client, [CChar]) -> Bool = { client, text in
        var bytes = text
        return SendClientCutTextUTF8(client, &bytes, Int32(bytes.count - 1)) != 0
    }
    /// Whether the server's ExtendedClipboard Caps message included text.
    var extendedClipboardText: (Client) -> Bool = {
        ($0.pointee.extendedClipboardServerCapabilities & 1) != 0 // rfbExtendedClipboard_Text
    }
    /// Asks for the server's clipboard text: an ExtendedClipboard Request
    /// (ClientCutText, length -4, flags Request|Text). The answer arrives as
    /// a Provide through GotXCutTextUTF8. LibVNC has no API for this message.
    var requestClipboardText: (Client) -> Bool = { client in
        let message: [UInt8] = [6, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFC, 0x02, 0x00, 0x00, 0x01]
        return message.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return false }
            return WriteToRFBServer(client, base.assumingMemoryBound(to: CChar.self), UInt32(raw.count)) != 0
        }
    }

    static let native = VNCClientOperations(
        make: { rfbGetClient($0.bitsPerSample, $0.samplesPerPixel, $0.bytesPerPixel) },
        initialize: { client in
            var argc: Int32 = 0
            return rfbInitClient(client, &argc, nil) != 0
        },
        cleanup: release,
        poll: { client, interval, phase in
            phase(.waitingForMessage)
            defer { phase(.idle) }
            let result = WaitForMessage(client, interval)
            guard result > 0 else { return result == 0 }
            phase(.handlingServerMessage)
            return HandleRFBServerMessage(client) != 0
        },
        incrementalUpdate: { SendIncrementalFramebufferUpdateRequest($0) != 0 },
        fullUpdate: { client in
            SendFramebufferUpdateRequest(client, 0, 0,
                                         client.pointee.width, client.pointee.height, 0) != 0
        }
    )

    static func release(_ client: Client) {
        // The bridge owns frameBuffer separately, including when initialization
        // fails after allocating it. rfbClientCleanup never frees that buffer.
        free(client.pointee.serverHost)
        client.pointee.serverHost = nil
        rfbClientCleanup(client)
    }
}

/// One outstanding poll OR retry item, owned and cancelled by the bridge.
/// The test scheduler retains work until explicitly advanced; it never sleeps.
typealias VNCWorkScheduler = (DispatchQueue, TimeInterval, DispatchWorkItem) -> Void

func scheduleVNCWork(on queue: DispatchQueue, after delay: TimeInterval, item: DispatchWorkItem) {
    if delay == 0 {
        queue.async(execute: item)
    } else {
        queue.asyncAfter(deadline: .now() + delay, execute: item)
    }
}
