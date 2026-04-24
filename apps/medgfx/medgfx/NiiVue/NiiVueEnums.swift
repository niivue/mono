//
//  NiiVueEnums.swift
//  medgfx
//
//  Swift mirrors of NiiVue constants. Raw values match the JS side so they
//  round-trip through the bridge without any translation.
//

import Foundation

enum SliceType: Int, CaseIterable, Identifiable, Hashable {
    case axial = 0
    case coronal = 1
    case sagittal = 2
    case multiplanar = 3
    case render = 4

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .axial:       return "Axial"
        case .coronal:     return "Coronal"
        case .sagittal:    return "Sagittal"
        case .multiplanar: return "Multiplanar"
        case .render:      return "3D Render"
        }
    }
}

enum MultiplanarType: Int, CaseIterable, Identifiable, Hashable {
    case auto = 0
    case column = 1
    case grid = 2
    case row = 3

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .auto:   return "Auto"
        case .column: return "Column"
        case .grid:   return "Grid"
        case .row:    return "Row"
        }
    }
}

enum Backend: String, CaseIterable, Identifiable, Hashable, Codable {
    case webgl2 = "webgl2"
    case webgpu = "webgpu"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .webgl2: return "WebGL2"
        case .webgpu: return "WebGPU"
        }
    }
}

enum ShowRender: Int, CaseIterable, Identifiable, Hashable {
    case never = 0
    case always = 1
    case auto = 2

    var id: Int { rawValue }

    var label: String {
        switch self {
        case .never:  return "Never"
        case .always: return "Always"
        case .auto:   return "Auto"
        }
    }
}
