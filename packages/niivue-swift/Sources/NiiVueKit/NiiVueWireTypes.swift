//
//  NiiVueWireTypes.swift
//  NiiVueKit
//
//  Encodable / Decodable types used for the niivue-specific bridge methods
//  (loadVolume, setProp, setBackend) and the events the JS side emits
//  (propChange, locationChange, backendChange, ready).
//

import BridgeCore
import Foundation

// MARK: - Outbound (Swift -> JS)

public struct LoadVolumePayload: Encodable {
    public let name: String
    public let bytesBase64: String

    public init(name: String, bytesBase64: String) {
        self.name = name
        self.bytesBase64 = bytesBase64
    }
}

public struct SetPropPayload: Encodable {
    public let path: String
    public let value: AnyEncodable

    public init(path: String, value: AnyEncodable) {
        self.path = path
        self.value = value
    }
}

public struct SetBackendPayload: Encodable {
    public let backend: String

    public init(backend: String) {
        self.backend = backend
    }
}

// MARK: - Inbound (JS -> Swift)

public struct OKReply: Decodable {
    public let ok: Bool
}

public struct SetBackendReply: Decodable {
    public let backend: String
}

public struct ReadyPayload: Decodable {
    public let backend: String?
}

public struct BackendChangePayload: Decodable {
    public let backend: String
}

public struct PropChangeEnvelope: Decodable {
    public let path: String
    public let value: AnyJSON
}

public struct LocationChangeEnvelope: Decodable {
    public let mm: [Double]?
    public let voxel: [Double]?
    public let string: String
}
