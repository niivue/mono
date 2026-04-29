//
//  WireTypes.swift
//  BridgeCore
//
//  Envelope structs used on the wire. Kept internal to the module --
//  callers interact with the bridge through `call` / `emit` / `handle` /
//  `on` and never construct these directly.
//

import Foundation

struct CallEnvelope: Encodable {
    let kind: String
    let id: String
    let method: String
    let payload: AnyEncodable
}

struct EventEnvelope: Encodable {
    let kind: String
    let name: String
    let payload: AnyEncodable
}

struct ResultOK: Encodable {
    let kind: String
    let id: String
    let ok: Bool
    let value: AnyEncodable
}

struct ResultErr: Encodable {
    let kind: String
    let id: String
    let ok: Bool
    let error: String
}
