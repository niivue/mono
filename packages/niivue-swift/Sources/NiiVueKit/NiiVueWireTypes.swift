//
//  NiiVueWireTypes.swift
//  NiiVueKit
//
//  Encodable / Decodable types used for the niivue-specific bridge methods
//  (loadVolume, setProp, setBackend) and the events the JS side emits
//  (propChange, locationChange, imageLoaded, backendChange, ready).
//

import BridgeCore
import Foundation

// MARK: - Outbound (Swift -> JS)

public struct LoadVolumePayload: Encodable {
    public let name: String
    public let bytesBase64: String
    public let add: Bool

    public init(name: String, bytesBase64: String, add: Bool = false) {
        self.name = name
        self.bytesBase64 = bytesBase64
        self.add = add
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

/// Display changes for one volume. Nil fields are left as they are.
public struct SetVolumePayload: Encodable {
    public let index: Int
    public var colormap: String?
    public var calMin: Double?
    public var calMax: Double?
    public var opacity: Double?

    public init(index: Int, colormap: String? = nil, calMin: Double? = nil, calMax: Double? = nil, opacity: Double? = nil) {
        self.index = index
        self.colormap = colormap
        self.calMin = calMin
        self.calMax = calMax
        self.opacity = opacity
    }
}

public struct VolumeIndexPayload: Encodable {
    public let index: Int
}

// MARK: - Inbound (JS -> Swift)

/// Display state of one loaded volume (`volumesChange` / `getVolumes`).
public struct VolumeSummary: Codable, Equatable {
    public var name: String
    public var colormap: String
    /// Colormap control points as [position 0...1, r, g, b].
    public var colormapStops: [[Double]]
    public var calMin: Double
    public var calMax: Double
    public var globalMin: Double
    public var globalMax: Double
    public var opacity: Double
    /// RAS dimensions and voxel size in mm.
    public var dims: [Int]
    public var pixDims: [Double]
}

public struct LocationValue: Decodable, Equatable {
    public let name: String
    public let value: Double
}

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
    public let values: [LocationValue]?
    public let string: String
}

public struct ImageLoadedEnvelope: Decodable {
    public let name: String
    public let kind: String
}
