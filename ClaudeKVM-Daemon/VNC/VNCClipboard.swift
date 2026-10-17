import Foundation

/// Typed input refusals (JSON-RPC code -32011, `data.reason`). Each is raised
/// before any wire event of the refused request.
enum NativeInputRefusal: String, Error, LocalizedError, CaseIterable {
    /// mouse_down/mouse_up outside one action_queue batch (D27).
    case holdOutsideBatch = "hold_outside_batch"
    case buttonAlreadyHeld = "button_already_held"
    case buttonNotHeld = "button_not_held"
    /// D8: the server has no UTF-8 clipboard (ExtendedClipboard) and the text
    /// is not Latin-1, the only legacy ClientCutText encoding.
    case clipboardUnicodeUnsupported = "clipboard_unicode_unsupported"
    /// The declared input source is not US-compatible and paste routing is off.
    case inputSourceNotUS = "input_source_not_us"
    /// D29: paste routing could not learn the target clipboard to restore it.
    case clipboardRestoreUnavailable = "clipboard_restore_unavailable"

    static let code = -32011

    var errorDescription: String? {
        switch self {
        case .holdOutsideBatch: "mouse_down and mouse_up are only valid inside one action_queue batch"
        case .buttonAlreadyHeld: "Mouse button is already held in this batch"
        case .buttonNotHeld: "Mouse button is not held in this batch"
        case .clipboardUnicodeUnsupported:
            "The server offers no UTF-8 clipboard and this text is not Latin-1; nothing was written"
        case .inputSourceNotUS:
            "The target's declared input source is not US-compatible and paste routing is off; nothing was typed"
        case .clipboardRestoreUnavailable:
            "Paste routing needs the target's current clipboard to restore it, and none is known; nothing was typed"
        }
    }
}

/// The target clipboard text as this connection last knew it: received from
/// the server, or written by this client. Held in memory only when the
/// profile enables clipboard_read or paste routing; never logged.
struct VNCClipboardSnapshot: Equatable, Sendable {
    enum Encoding: String, Sendable {
        /// ExtendedClipboard text (UTF-8).
        case utf8
        /// Legacy ServerCutText/ClientCutText (ISO 8859-1).
        case latin1
    }
    let text: String
    let encoding: Encoding
    let connectionGeneration: Int
    let observedNs: UInt64

    /// Legacy cut text is Latin-1 by protocol: every byte is one scalar.
    static func decodeLatin1(_ bytes: UnsafeRawBufferPointer) -> String {
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: bytes.lazy.map { Unicode.Scalar($0) })
        return String(scalars)
    }

    /// ExtendedClipboard text is NUL-terminated UTF-8. Invalid UTF-8 is
    /// dropped rather than repaired, so a lossy value is never returned.
    static func decodeUTF8(_ bytes: UnsafeRawBufferPointer) -> String? {
        var end = bytes.count
        while end > 0 && bytes[end - 1] == 0 { end -= 1 }
        return String(bytes: bytes[0..<end], encoding: .utf8)
    }

    static func isLatin1(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { $0.value <= 0xFF }
    }
}

/// clipboard_read failures (JSON-RPC code -32014, `data.reason`).
enum ClipboardReadError: String, Error, LocalizedError, CaseIterable {
    /// The target profile does not enable clipboard_read (D8, off by default).
    case disabled = "clipboard_read_disabled"
    /// No clipboard text is known for this connection within its TTL.
    case unavailable = "clipboard_unavailable"

    static let code = -32014

    var errorDescription: String? {
        switch self {
        case .disabled: "clipboard_read is not enabled for this target"
        case .unavailable: "The target clipboard is unknown on this connection"
        }
    }
}
