//
//  ChromePanel.swift
//  medgfx
//
//  Visibility toggles for NiiVue UI chrome: colorbar, orient cube,
//  orientation labels, crosshair in 3D, cross lines, ruler, legend.
//

import SwiftUI

struct ChromePanel: InspectorPanel {
    let id = "chrome"
    let title = "Chrome"
    let systemImage = "eye"

    @MainActor
    func body(model: NiiVueModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            section("Overlays") {
                Toggle("Colorbar",          isOn: model.binding(\.isColorbarVisible))
                Toggle("Orientation cube",  isOn: model.binding(\.isOrientCubeVisible))
                Toggle("Orientation text",  isOn: model.binding(\.isOrientationTextVisible))
                Toggle("3D crosshair",      isOn: model.binding(\.is3DCrosshairVisible))
                Toggle("Cross lines",       isOn: model.binding(\.isCrossLinesVisible))
                Toggle("Ruler",             isOn: model.binding(\.isRulerVisible))
                Toggle("Legend",            isOn: model.binding(\.isLegendVisible))
            }
        }
    }
}
