//
//  AnyEncodable.swift
//  BridgeCore
//
//  Type-erased `Encodable` wrapper so the bridge can embed arbitrary
//  payloads in a single envelope type. Paired with `AnyJSON` for decoding.
//

import Foundation

/// Type-erased `Encodable` wrapper. `Bridge` uses this to box payloads
/// inside a generic `CallEnvelope` / `EventEnvelope` / `ResultOK` without
/// being generic over the payload type itself.
public struct AnyEncodable: Encodable {
    private let _encode: (Encoder) throws -> Void
    public init<T: Encodable>(_ wrapped: T) { _encode = wrapped.encode }
    public func encode(to encoder: Encoder) throws { try _encode(encoder) }
}

/// Empty payload for fire-and-forget events that carry no data.
public struct EmptyPayload: Encodable {
    public init() {}
}
