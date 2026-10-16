import AppKit
import ApplicationServices
import Foundation

enum HostAccessibilityError: String, Error {
    case permissionRequired = "accessibility_permission_required"
    case applicationUnavailable = "accessibility_application_unavailable"
}

/// The bounded request accepted from IPC. depth counts levels below each
/// application element; the application itself is depth 0.
struct HostAXRequest: Equatable {
    static let defaultDepth = 6
    static let maximumDepth = 12
    let depth: Int
    let focusedApplicationOnly: Bool

    static func parse(_ params: [String: HostValue]) throws -> HostAXRequest {
        var depth = defaultDepth
        if let value = params["depth"] {
            guard let requested = value.integer, (1...maximumDepth).contains(requested) else {
                throw HostLeaseError.invalidParameters
            }
            depth = requested
        }
        var focused = true
        if let value = params["focused_app"] {
            guard case .boolean(let requested) = value else { throw HostLeaseError.invalidParameters }
            focused = requested
        }
        return HostAXRequest(depth: depth, focusedApplicationOnly: focused)
    }
}

/// Attribute values read from one element. frame is in global display points
/// (top-left origin), exactly as the Accessibility API reports it.
struct HostAXAttributes: Equatable {
    var role: String?
    var subrole: String?
    var label: String?
    var value: String?
    var frame: CGRect?

    /// Secure text never leaves the host, even as a length.
    var isSecure: Bool { role == "AXSecureTextField" || subrole == "AXSecureTextField" }
}

/// One element handle. Children are fetched lazily so traversal can stop at
/// its depth, node and time budgets without reading the rest of the tree.
protocol HostAXNode {
    func attributes() -> HostAXAttributes
    func children(limit: Int) -> [HostAXNode]
}

struct HostAXApplication {
    let processID: pid_t
    let bundleID: String?
    let name: String?
    let root: HostAXNode
}

/// Real provider: AXUIElement. Tests supply a fake provider and nodes.
protocol HostAccessibilityProvider {
    /// AXIsProcessTrusted for the real provider. Never prompts.
    func isTrusted() -> Bool
    /// Called on the main actor; traversal of the returned roots may run elsewhere.
    func applications(focusedOnly: Bool, excluding processID: pid_t) -> [HostAXApplication]
}

/// Builds the bounded, framebuffer-mapped snapshot. Pure over the provider's
/// nodes; it never caches a tree and never returns a previous snapshot.
enum HostAccessibilitySnapshot {
    static let schema = "fruitctl.ax-snapshot.v1"
    static let maximumNodes = 1_500
    static let maximumChildren = 200
    static let maximumText = 256
    /// Traversal budget. The broker's helper round trip is 500 ms, so the
    /// snapshot stops early and reports truncated instead of overrunning it.
    static let budgetNanoseconds: UInt64 = 200_000_000

    static func build(applications: [HostAXApplication], request: HostAXRequest,
                      geometry: HostDisplayGeometry, maximumNodes: Int = HostAccessibilitySnapshot.maximumNodes,
                      expired: () -> Bool) throws -> [String: HostValue] {
        var nodes: [HostValue] = []
        var roots: [HostValue] = []
        var truncated = false
        // Breadth first: every window's top levels are reported before any
        // one subtree can consume the whole node budget.
        var queue: [(node: HostAXNode, ref: String, parent: String?, depth: Int)] = []
        for application in applications {
            let ref = "ax:\(application.processID):0"
            roots.append(.object([
                "pid": .integer(Int64(application.processID)), "ref": .string(ref),
                "bundle_id": application.bundleID.map { .string(bounded($0)) } ?? .null,
                "name": application.name.map { .string(bounded($0)) } ?? .null]))
            queue.append((application.root, ref, nil, 0))
        }
        var index = 0
        while index < queue.count {
            try Task.checkCancellation()
            guard nodes.count < maximumNodes, !expired() else { truncated = true; break }
            let entry = queue[index]
            index += 1
            nodes.append(.object(record(entry.node.attributes(), ref: entry.ref, parent: entry.parent,
                                        depth: entry.depth, geometry: geometry)))
            guard entry.depth < request.depth else { continue }
            let children = entry.node.children(limit: maximumChildren + 1)
            if children.count > maximumChildren { truncated = true }
            for (offset, child) in children.prefix(maximumChildren).enumerated() {
                queue.append((child, entry.ref + "." + String(offset), entry.ref, entry.depth + 1))
            }
        }
        return ["ax_snapshot": .object([
            "schema": .string(schema), "coordinate_space": .string("framebuffer_pixels"),
            "framebuffer": .object(geometry.metadata), "depth": .integer(Int64(request.depth)),
            "focused_app": .boolean(request.focusedApplicationOnly),
            "applications": .array(roots), "nodes": .array(nodes),
            "node_count": .integer(Int64(nodes.count)), "truncated": .boolean(truncated)])]
    }

    static func record(_ attributes: HostAXAttributes, ref: String, parent: String?, depth: Int,
                       geometry: HostDisplayGeometry) -> [String: HostValue] {
        var result: [String: HostValue] = ["ref": .string(ref), "parent": parent.map { .string($0) } ?? .null,
                                           "depth": .integer(Int64(depth)),
                                           "role": .string(bounded(attributes.role.flatMap {
                                               $0.isEmpty ? nil : $0 } ?? "AXUnknown"))]
        if let subrole = attributes.subrole { result["subrole"] = .string(bounded(subrole)) }
        if let label = attributes.label, !label.isEmpty { result["label"] = .string(bounded(label)) }
        if attributes.isSecure {
            result["value_redacted"] = .boolean(true)
        } else if let value = attributes.value, !value.isEmpty {
            result["value"] = .string(bounded(value))
        }
        if let frame = attributes.frame, let pixels = geometry.pixelRect(forGlobalPoints: frame) {
            result["frame"] = .object(["x": .integer(Int64(pixels.x)), "y": .integer(Int64(pixels.y)),
                                       "width": .integer(Int64(pixels.width)),
                                       "height": .integer(Int64(pixels.height))])
        } else {
            result["frame"] = .null
        }
        return result
    }

    /// Bounds UTF-16 length (the broker's string length) on a character
    /// boundary, so truncation never splits a surrogate pair or a grapheme.
    static func bounded(_ text: String) -> String {
        guard text.utf16.count > maximumText else { return text }
        var length = 0
        var end = text.startIndex
        for character in text {
            length += character.utf16.count
            guard length <= maximumText else { break }
            end = text.index(after: end)
        }
        return String(text[..<end])
    }
}

/// AXUIElement is an immutable CF reference to a remote element; reads are
/// synchronous IPC bounded by the process-wide messaging timeout.
struct HostSystemAXNode: HostAXNode, @unchecked Sendable {
    let element: AXUIElement

    static let identityAttributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute,
                                     kAXDescriptionAttribute, kAXPositionAttribute, kAXSizeAttribute]

    /// One IPC for identity and geometry; the value is read in a second call
    /// only after the role proves the element is not a secure text field.
    func attributes() -> HostAXAttributes {
        var result = HostAXAttributes()
        var copied: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, Self.identityAttributes as CFArray,
                                                     AXCopyMultipleAttributeOptions(rawValue: 0),
                                                     &copied) == .success,
              let values = copied as? [AnyObject], values.count == Self.identityAttributes.count else {
            return result
        }
        result.role = values[0] as? String
        result.subrole = values[1] as? String
        result.label = (values[2] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? values[3] as? String
        if let origin = Self.axValue(values[4], type: .cgPoint, as: CGPoint.zero),
           let size = Self.axValue(values[5], type: .cgSize, as: CGSize.zero) {
            result.frame = CGRect(origin: origin, size: size)
        }
        if !result.isSecure { result.value = valueText() }
        return result
    }

    func children(limit: Int) -> [HostAXNode] {
        var values: CFArray?
        guard limit > 0, AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0,
                                                        limit, &values) == .success,
              let items = values as? [AnyObject] else { return [] }
        return items.compactMap { item -> HostAXNode? in
            guard CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
            return HostSystemAXNode(element: item as! AXUIElement)
        }
    }

    private func valueText() -> String? {
        var copied: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &copied) == .success,
              let value = copied else { return nil }
        if let text = value as? String { return text }
        if CFGetTypeID(value) == CFNumberGetTypeID() || CFGetTypeID(value) == CFBooleanGetTypeID(),
           let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    /// Failed attributes arrive as AXValue of type axError and map to nil.
    private static func axValue<T>(_ value: AnyObject, type: AXValueType, as initial: T) -> T? {
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        var result = initial
        guard AXValueGetType(axValue) == type, AXValueGetValue(axValue, type, &result) else { return nil }
        return result
    }
}

final class HostSystemAccessibilityProvider: HostAccessibilityProvider {
    /// Per-request messaging timeout. An unresponsive application cannot hold
    /// the snapshot past its budget.
    static let messagingTimeoutSeconds: Float = 0.05

    init() {
        _ = AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeoutSeconds)
    }

    func isTrusted() -> Bool { AXIsProcessTrusted() }

    func applications(focusedOnly: Bool, excluding processID: pid_t) -> [HostAXApplication] {
        let candidates: [NSRunningApplication]
        if focusedOnly {
            candidates = NSWorkspace.shared.frontmostApplication.map { [$0] } ?? []
        } else {
            candidates = NSWorkspace.shared.runningApplications.filter {
                $0.activationPolicy == .regular && !$0.isHidden
            }
        }
        return candidates.filter { $0.processIdentifier != processID && !$0.isTerminated }.map {
            HostAXApplication(processID: $0.processIdentifier, bundleID: $0.bundleIdentifier,
                              name: $0.localizedName,
                              root: HostSystemAXNode(element: AXUIElementCreateApplication($0.processIdentifier)))
        }
    }
}
