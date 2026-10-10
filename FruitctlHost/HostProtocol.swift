import Foundation

enum HostValue: Codable, Equatable {
    case string(String), integer(Int64), number(Double), boolean(Bool)
    case object([String: HostValue]), array([HostValue]), null

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let item = try? value.decode(Bool.self) { self = .boolean(item) }
        else if let item = try? value.decode(Int64.self) { self = .integer(item) }
        else if let item = try? value.decode(Double.self) { self = .number(item) }
        else if let item = try? value.decode(String.self) { self = .string(item) }
        else if let item = try? value.decode([String: HostValue].self) { self = .object(item) }
        else { self = .array(try value.decode([HostValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let item): try value.encode(item)
        case .integer(let item): try value.encode(item)
        case .number(let item): try value.encode(item)
        case .boolean(let item): try value.encode(item)
        case .object(let item): try value.encode(item)
        case .array(let item): try value.encode(item)
        case .null: try value.encodeNil()
        }
    }

    var string: String? { if case .string(let value) = self { return value }; return nil }
    var unsigned: UInt64? {
        if case .integer(let value) = self, value >= 0 { return UInt64(value) }
        return nil
    }
    var integer: Int? {
        if case .integer(let value) = self { return Int(exactly: value) }
        return nil
    }
}

struct HostRequest: Decodable {
    let action: String
    let params: [String: HostValue]
    let id: HostValue?

    enum CodingKeys: String, CodingKey { case action, method, params, id }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        action = try values.decodeIfPresent(String.self, forKey: .action)
            ?? values.decode(String.self, forKey: .method)
        params = try values.decodeIfPresent([String: HostValue].self, forKey: .params) ?? [:]
        id = try values.decodeIfPresent(HostValue.self, forKey: .id)
        if let id {
            switch id {
            case .string, .integer: break
            default:
                throw DecodingError.dataCorruptedError(forKey: .id, in: values,
                                                       debugDescription: "ID must be a string or integer")
            }
        }
    }

    func requiredString(_ name: String) throws -> String {
        guard let value = params[name]?.string, HostLeaseState.validToken(value) else {
            throw HostLeaseError.invalidParameters
        }
        return value
    }

    func requiredSequence() throws -> UInt64 {
        guard let value = params["sequence"]?.unsigned, value > 0 else {
            throw HostLeaseError.invalidParameters
        }
        return value
    }
}

struct HostResponse: Encodable {
    let id: HostValue?
    let success: Bool
    let result: [String: HostValue]?
    let error: RPCError?

    struct RPCError: Encodable {
        let code: Int
        let message: String
        let data: HostCaptureDiagnostic?
    }

    static func ok(_ request: HostRequest, _ result: [String: HostValue]) -> HostResponse {
        HostResponse(id: request.id, success: true, result: result, error: nil)
    }

    static func failure(id: HostValue?, code: Int = -32000, message: String,
                        data: HostCaptureDiagnostic? = nil) -> HostResponse {
        HostResponse(id: id, success: false, result: nil,
                     error: RPCError(code: code, message: message, data: data))
    }

    func line() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        data.append(10)
        return data
    }
}

/// Bounds untrusted stdin/socket input independently of the transport's read
/// sizes. Capture replies can be larger, but requests cannot contain images.
struct HostLineFramer {
    static let maximumRequestBytes = 65_536
    private var pending = Data()

    mutating func append(_ bytes: Data) throws -> [Data] {
        var lines: [Data] = []
        for byte in bytes {
            if byte == 10 {
                guard !pending.isEmpty else { continue }
                lines.append(pending)
                pending.removeAll(keepingCapacity: true)
            } else {
                guard pending.count < Self.maximumRequestBytes else {
                    throw HostLeaseError.invalidParameters
                }
                pending.append(byte)
            }
        }
        return lines
    }

    var hasIncompleteLine: Bool { !pending.isEmpty }
}
