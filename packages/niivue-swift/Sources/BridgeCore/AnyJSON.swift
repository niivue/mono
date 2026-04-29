//
//  AnyJSON.swift
//  BridgeCore
//
//  Type-erased JSON value used to route inbound payloads to property cells
//  without knowing their concrete type at decode time.
//

import Foundation

public struct AnyJSON: Decodable {
    public let raw: Any

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Check nil first so genuine decode failures below surface instead
        // of being silently collapsed into NSNull.
        if container.decodeNil() { raw = NSNull(); return }
        if let v = try? container.decode(Bool.self)   { raw = v; return }
        if let v = try? container.decode(Double.self) { raw = v; return }
        if let v = try? container.decode(String.self) { raw = v; return }
        if let v = try? container.decode([AnyJSON].self) { raw = v.map { $0.raw }; return }
        if let v = try? container.decode([String: AnyJSON].self) {
            raw = v.mapValues { $0.raw }; return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "AnyJSON: unexpected JSON value"
        )
    }
}
