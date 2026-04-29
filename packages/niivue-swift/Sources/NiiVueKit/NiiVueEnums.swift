//
//  NiiVueEnums.swift
//  NiiVueKit
//
//  Swift mirrors of NiiVue constants. Raw values match the JS side so they
//  round-trip through the bridge without translation.
//

import Foundation

public enum SliceType: Int, CaseIterable, Identifiable, Hashable, Sendable {
    case axial = 0
    case coronal = 1
    case sagittal = 2
    case multiplanar = 3
    case render = 4

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .axial:       return "Axial"
        case .coronal:     return "Coronal"
        case .sagittal:    return "Sagittal"
        case .multiplanar: return "Multiplanar"
        case .render:      return "3D Render"
        }
    }
}

public enum MultiplanarType: Int, CaseIterable, Identifiable, Hashable, Sendable {
    case auto = 0
    case column = 1
    case grid = 2
    case row = 3

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .auto:   return "Auto"
        case .column: return "Column"
        case .grid:   return "Grid"
        case .row:    return "Row"
        }
    }
}

public enum Backend: String, CaseIterable, Identifiable, Hashable, Codable, Sendable {
    case webgl2 = "webgl2"
    case webgpu = "webgpu"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .webgl2: return "WebGL2"
        case .webgpu: return "WebGPU"
        }
    }
}

public enum ShowRender: Int, CaseIterable, Identifiable, Hashable, Sendable {
    case never = 0
    case always = 1
    case auto = 2

    public var id: Int { rawValue }

    public var label: String {
        switch self {
        case .never:  return "Never"
        case .always: return "Always"
        case .auto:   return "Auto"
        }
    }
}
