//
//  InspectorSettings.swift
//  medgfx
//
//  Central vocabulary and typed mapping for every native display control.
//  Views consume this registry instead of repeating labels or NiiVue paths.
//

import NiiVueKit
import SwiftUI

struct SettingChoice<Value> {
    let id: String
    let title: String
    let value: Value

    init(_ id: String, _ title: String, _ value: Value) {
        self.id = id
        self.title = title
        self.value = value
    }
}

extension SettingChoice: Identifiable {}

@MainActor
struct NiiVueSetting<Value> {
    let title: String
    let help: String
    let choices: [SettingChoice<Value>]

    private let bindingBuilder: (NiiVueModel) -> Binding<Value>

    init(
        title: String,
        help: String,
        choices: [SettingChoice<Value>] = [],
        binding: @escaping (NiiVueModel) -> Binding<Value>
    ) {
        self.title = title
        self.help = help
        self.choices = choices
        self.bindingBuilder = binding
    }

    func binding(in model: NiiVueModel) -> Binding<Value> {
        bindingBuilder(model)
    }
}

extension NiiVueSetting where Value: Codable & Equatable {
    init(
        title: String,
        help: String,
        niiVueProperty: KeyPath<NiiVueModel, NiiVueProp<Value>>,
        choices: [SettingChoice<Value>] = []
    ) {
        self.init(
            title: title,
            help: help,
            choices: choices,
            binding: { $0.binding(niiVueProperty) }
        )
    }
}

@MainActor
enum InspectorSettings {
    static let viewMode = NiiVueSetting(
        title: "View Mode",
        help: "Choose an anatomical plane, a multiplanar view, or a 3D rendering.",
        choices: [
            SettingChoice("axial", "Axial", SliceType.axial),
            SettingChoice("coronal", "Coronal", SliceType.coronal),
            SettingChoice("sagittal", "Sagittal", SliceType.sagittal),
            SettingChoice("multiplanar", "Multiplanar", SliceType.multiplanar),
            SettingChoice("render", "3D", SliceType.render),
        ],
        binding: { model in
            Binding(
                get: { model.sliceType },
                set: { model.selectBuiltInView($0) }
            )
        }
    )

    static let panelArrangement = NiiVueSetting(
        title: "Panel Arrangement",
        help: "Arrange the anatomical planes in the multiplanar view.",
        choices: [
            SettingChoice("automatic", "Automatic", MultiplanarType.auto),
            SettingChoice("column", "Column", MultiplanarType.column),
            SettingChoice("grid", "Grid", MultiplanarType.grid),
            SettingChoice("row", "Row", MultiplanarType.row),
        ],
        binding: { $0.multiplanarTypeBinding }
    )

    static let threeDPanel = NiiVueSetting(
        title: "3D Panel",
        help: "Control whether a 3D rendering is included with the anatomical planes.",
        choices: [
            SettingChoice("hidden", "Hidden", ShowRender.never),
            SettingChoice("shown", "Shown", ShowRender.always),
            SettingChoice("automatic", "Automatic", ShowRender.auto),
        ],
        binding: { $0.showRenderBinding }
    )

    static let leftRightConvention = NiiVueSetting(
        title: "Left–Right Convention",
        help: "Radiological places the patient's left on the right side of the display.",
        niiVueProperty: \NiiVueModel.isRadiological,
        choices: [
            SettingChoice("neurological", "Neurological", false),
            SettingChoice("radiological", "Radiological", true),
        ]
    )

    static let multiplanarPresets = NiiVueSetting(
        title: "Multiplanar Presets",
        help: "Choose a clinically useful arrangement of orthogonal slices and 3D rendering.",
        choices: [
            SettingChoice(
                "sagittal-focus",
                "Sagittal Focus",
                [
                    CustomLayoutTile(sliceType: .sagittal, position: [0, 0, 0.5, 1]),
                    CustomLayoutTile(sliceType: .coronal, position: [0.5, 0, 0.5, 0.5]),
                    CustomLayoutTile(sliceType: .axial, position: [0.5, 0.5, 0.5, 0.5]),
                ]
            ),
            SettingChoice(
                "axial-focus",
                "Axial Focus",
                [
                    CustomLayoutTile(sliceType: .axial, position: [0, 0, 1, 0.5]),
                    CustomLayoutTile(sliceType: .coronal, position: [0, 0.5, 0.5, 0.5]),
                    CustomLayoutTile(sliceType: .sagittal, position: [0.5, 0.5, 0.5, 0.5]),
                ]
            ),
            SettingChoice(
                "three-columns",
                "Three Columns",
                [
                    CustomLayoutTile(sliceType: .sagittal, position: [0, 0, 1.0 / 3.0, 1]),
                    CustomLayoutTile(sliceType: .coronal, position: [1.0 / 3.0, 0, 1.0 / 3.0, 1]),
                    CustomLayoutTile(sliceType: .axial, position: [2.0 / 3.0, 0, 1.0 / 3.0, 1]),
                ]
            ),
            SettingChoice(
                "four-quadrants",
                "Four Quadrants",
                [
                    CustomLayoutTile(sliceType: .axial, position: [0, 0, 0.5, 0.5]),
                    CustomLayoutTile(sliceType: .coronal, position: [0.5, 0, 0.5, 0.5]),
                    CustomLayoutTile(sliceType: .sagittal, position: [0, 0.5, 0.5, 0.5]),
                    CustomLayoutTile(sliceType: .render, position: [0.5, 0.5, 0.5, 0.5]),
                ]
            ),
            SettingChoice(
                "three-d-focus",
                "3D Focus",
                [
                    CustomLayoutTile(sliceType: .render, position: [0, 0, 0.7, 1]),
                    CustomLayoutTile(sliceType: .axial, position: [0.7, 0, 0.3, 1.0 / 3.0]),
                    CustomLayoutTile(sliceType: .coronal, position: [0.7, 1.0 / 3.0, 0.3, 1.0 / 3.0]),
                    CustomLayoutTile(sliceType: .sagittal, position: [0.7, 2.0 / 3.0, 0.3, 1.0 / 3.0]),
                ]
            ),
        ],
        binding: { model in
            Binding(
                get: { model.customLayout.value },
                set: { model.applyCustomMultiplanarLayout($0) }
            )
        }
    )

    static let mosaicLayout = NiiVueSetting(
        title: "Mosaic Layout",
        help: "Arrange slices at fixed millimetre positions using NiiVue's mosaic layout.",
        choices: [
            SettingChoice(
                "axial-three-by-three",
                "Axial 3 × 3",
                "A -40 -30 -20 ; A -10 0 10 ; A 20 30 40"
            ),
            SettingChoice(
                "axial-series",
                "Axial Series",
                "A -30 -20 -10 0 ; A 10 20 30 40"
            ),
            SettingChoice("orthogonal", "Orthogonal", "A 0 C 0 S 0"),
            SettingChoice(
                "orthogonal-three-d",
                "Orthogonal + 3D",
                "A 0 C 0 ; S 0 R 0"
            ),
        ],
        binding: { model in
            Binding(
                get: { model.mosaicString.value },
                set: { model.applyMosaicLayout($0) }
            )
        }
    )

    static let colorBar = NiiVueSetting(
        title: "Color Bar",
        help: "Show the image intensity color scale.",
        niiVueProperty: \NiiVueModel.isColorbarVisible
    )

    static let orientationCube = NiiVueSetting(
        title: "Orientation Cube",
        help: "Show the 3D anatomical orientation cube.",
        niiVueProperty: \NiiVueModel.isOrientCubeVisible
    )

    static let directionLabels = NiiVueSetting(
        title: "Direction Labels",
        help: "Show anatomical direction labels such as L, R, A, and P.",
        niiVueProperty: \NiiVueModel.isOrientationTextVisible
    )

    static let threeDCursor = NiiVueSetting(
        title: "3D Crosshairs",
        help: "Show the crosshair position in the 3D rendering.",
        niiVueProperty: \NiiVueModel.is3DCrosshairVisible
    )

    static let sliceIntersectionLines = NiiVueSetting(
        title: "Slice Intersection Lines",
        help: "Show slice intersection lines on 3D tiles in a mosaic layout.",
        niiVueProperty: \NiiVueModel.isCrossLinesVisible
    )

    static let ruler = NiiVueSetting(
        title: "Ruler",
        help: "Show the spatial measurement ruler.",
        niiVueProperty: \NiiVueModel.isRulerVisible
    )

    static let legend = NiiVueSetting(
        title: "Legend",
        help: "Show the overlay and mesh legend.",
        niiVueProperty: \NiiVueModel.isLegendVisible
    )

    static let seeThroughSurfaces = NiiVueSetting(
        title: "See-through 3D Surfaces",
        help: "Reveal the cursor through rendered surfaces.",
        binding: { $0.meshXRayEnabledBinding }
    )

    static let backgroundColor = NiiVueSetting(
        title: "Background Color",
        help: "Set the viewer background color.",
        niiVueProperty: \NiiVueModel.backgroundColor
    )

    static let rotation = NiiVueSetting(
        title: "Horizontal Rotation",
        help: "Rotate the 3D camera around the superior–inferior axis.",
        niiVueProperty: \NiiVueModel.azimuth
    )

    static let tilt = NiiVueSetting(
        title: "Vertical Tilt",
        help: "Tilt the 3D camera above or below the axial plane.",
        niiVueProperty: \NiiVueModel.elevation
    )

    static let renderingEngine = NiiVueSetting(
        title: "Rendering Engine",
        help: "Choose the graphics technology used to render images. Loaded data remains available and is re-rendered.",
        choices: [
            SettingChoice("webgl2", "WebGL 2", Backend.webgl2),
            SettingChoice("webgpu", "WebGPU", Backend.webgpu),
        ],
        binding: { model in
            Binding(
                get: { model.currentBackend ?? .webgl2 },
                set: { backend in Task { await model.setBackend(backend) } }
            )
        }
    )
}

enum InspectorSectionID: String, CaseIterable, Identifiable {
    case layout
    case guidesAndLabels
    case imageAppearance
    case threeDView
    case advanced

    var id: String { rawValue }

    var title: String {
        switch self {
        case .layout: return "Layout"
        case .guidesAndLabels: return "Guides & Labels"
        case .imageAppearance: return "Appearance"
        case .threeDView: return "3D View"
        case .advanced: return "Advanced"
        }
    }

    var systemImage: String {
        switch self {
        case .layout: return "rectangle.3.group"
        case .guidesAndLabels: return "scope"
        case .imageAppearance: return "circle.lefthalf.filled"
        case .threeDView: return "rotate.3d"
        case .advanced: return "gearshape.2"
        }
    }

    var isExpandedByDefault: Bool {
        switch self {
        case .layout, .guidesAndLabels: return true
        case .imageAppearance, .threeDView, .advanced: return false
        }
    }
}
