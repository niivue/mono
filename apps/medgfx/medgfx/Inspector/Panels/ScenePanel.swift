//
//  ScenePanel.swift
//  medgfx
//
//  Background color, gamma, camera (azimuth/elevation).
//

import SwiftUI

struct ScenePanel: InspectorPanel {
    let id = "scene"
    let title = "Scene"
    let systemImage = "camera.viewfinder"

    @MainActor
    func body(model: NiiVueModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            section("Background") {
                ColorPicker(
                    "Background color",
                    selection: Binding(
                        get: { Color.fromRGBA(model.backgroundColor.value) },
                        set: { model.backgroundColor.value = $0.toRGBAComponents() }
                    ),
                    supportsOpacity: false
                )
            }

            section("Display") {
                sliderRow(
                    label: "Gamma",
                    binding: model.binding(\.gamma),
                    range: 0.1...3.0,
                    format: "%.2f"
                )
            }

            section("Camera (3D)") {
                sliderRow(
                    label: "Azimuth",
                    binding: model.binding(\.azimuth),
                    range: 0...360,
                    format: "%.0f°"
                )
                sliderRow(
                    label: "Elevation",
                    binding: model.binding(\.elevation),
                    range: -90...90,
                    format: "%.0f°"
                )
            }
        }
    }
}

// MARK: Color helpers

private extension Color {
    static func fromRGBA(_ rgba: [Double]) -> Color {
        guard rgba.count >= 3 else { return .black }
        return Color(.sRGB, red: rgba[0], green: rgba[1], blue: rgba[2], opacity: 1.0)
    }

    func toRGBAComponents() -> [Double] {
        #if os(macOS)
        let ns = NSColor(self).usingColorSpace(.sRGB) ?? .black
        return [Double(ns.redComponent), Double(ns.greenComponent), Double(ns.blueComponent), 1.0]
        #else
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        return [Double(r), Double(g), Double(b), 1.0]
        #endif
    }
}
