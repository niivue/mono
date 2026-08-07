//
//  InspectorSectionViews.swift
//  medgfx
//
//  Focused content views hosted by InspectorContainer's disclosure groups.
//

import NiiVueKit
import SwiftUI

@MainActor
struct LayoutInspectorSection: View {
    let model: NiiVueModel

    var body: some View {
        let layoutContext = ViewerLayoutContext(model: model)

        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text(InspectorSettings.panelArrangement.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                SettingPicker(setting: InspectorSettings.panelArrangement, model: model)
                    .pickerStyle(.segmented)
                    .labelsHidden()
            }
            .disabled(!layoutContext.usesBuiltInMultiplanarLayout)

            VStack(alignment: .leading, spacing: 6) {
                Text(InspectorSettings.threeDPanel.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                SettingPicker(setting: InspectorSettings.threeDPanel, model: model)
                    .pickerStyle(.segmented)
                    .labelsHidden()
            }
            .disabled(!layoutContext.usesBuiltInMultiplanarLayout)

            VStack(alignment: .leading, spacing: 6) {
                Text(InspectorSettings.leftRightConvention.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                SettingPicker(setting: InspectorSettings.leftRightConvention, model: model)
                    .pickerStyle(.segmented)
                    .labelsHidden()
            }

            DisclosureGroup(InspectorSettings.multiplanarPresets.title) {
                VStack(alignment: .leading, spacing: 10) {
                    SettingPresetGrid(setting: InspectorSettings.multiplanarPresets, model: model)

                    Button("Use Built-in Layout") {
                        InspectorSettings.multiplanarPresets.binding(in: model).wrappedValue = nil
                    }
                    .controlSize(.small)
                    .disabled(!layoutContext.isCustomLayoutActive)
                }
                .padding(.top, 8)
            }
            .font(.caption)
            .help(InspectorSettings.multiplanarPresets.help)

            DisclosureGroup(InspectorSettings.mosaicLayout.title) {
                VStack(alignment: .leading, spacing: 6) {
                    SettingPresetGrid(setting: InspectorSettings.mosaicLayout, model: model)

                    HStack {
                        Text("Mosaic String")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Button("Clear Mosaic") {
                            InspectorSettings.mosaicLayout.binding(in: model).wrappedValue = ""
                        }
                        .controlSize(.small)
                        .disabled(!layoutContext.isMosaicActive)
                    }

                    TextField(
                        "For example: A -20 0 20 ; S R X 0",
                        text: InspectorSettings.mosaicLayout.binding(in: model),
                        axis: .vertical
                    )
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(2...4)
                    .textFieldStyle(.roundedBorder)
                    #if os(iOS)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    #endif

                    Text("Advanced syntax: A/C/S = slice, R = 3D render, X = intersection lines, L = labels, ; = row break")
                        .font(.caption2)
                        .foregroundStyle(.secondary)

                    SettingToggle(setting: InspectorSettings.sliceIntersectionLines, model: model)
                        .padding(.top, 4)
                        .disabled(!layoutContext.isMosaicActive)
                }
                .padding(.top, 8)
            }
            .font(.caption)
            .help(InspectorSettings.mosaicLayout.help)
        }
    }

}

@MainActor
struct GuidesLabelsInspectorSection: View {
    let model: NiiVueModel

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            SettingToggle(setting: InspectorSettings.directionLabels, model: model)
            SettingToggle(setting: InspectorSettings.colorBar, model: model)
            SettingToggle(setting: InspectorSettings.ruler, model: model)
            SettingToggle(setting: InspectorSettings.legend, model: model)
            SettingToggle(setting: InspectorSettings.orientationCube, model: model)
            SettingToggle(setting: InspectorSettings.threeDCursor, model: model)
        }
    }
}

@MainActor
struct ImageAppearanceInspectorSection: View {
    let model: NiiVueModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ColorPicker(
                InspectorSettings.backgroundColor.title,
                selection: backgroundColorBinding,
                supportsOpacity: false
            )
            .help(InspectorSettings.backgroundColor.help)
        }
    }

    private var backgroundColorBinding: Binding<Color> {
        let rgbaBinding = InspectorSettings.backgroundColor.binding(in: model)
        return Binding(
            get: { Color.fromRGBA(rgbaBinding.wrappedValue) },
            set: { rgbaBinding.wrappedValue = $0.toRGBAComponents() }
        )
    }
}

@MainActor
struct ThreeDInspectorSection: View {
    let model: NiiVueModel
    let isEnabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            sliderRow(
                setting: InspectorSettings.rotation,
                model: model,
                range: 0...360,
                format: "%.0f°"
            )
            sliderRow(
                setting: InspectorSettings.tilt,
                model: model,
                range: -90...90,
                format: "%.0f°"
            )
            // Keep this mapped setting available for a future 3D surface workflow.
            // SettingToggle(setting: InspectorSettings.seeThroughSurfaces, model: model)
        }
        .disabled(!isEnabled)
    }
}

@MainActor
struct AdvancedInspectorSection: View {
    let model: NiiVueModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker(
                InspectorSettings.renderingEngine.title,
                selection: InspectorSettings.renderingEngine.binding(in: model)
            ) {
                ForEach(InspectorSettings.renderingEngine.choices) { choice in
                    Text(choice.title).tag(choice.value)
                }
            }
            .pickerStyle(.segmented)
            .disabled(model.currentBackend == nil || model.isSwitchingBackend)
            .help(InspectorSettings.renderingEngine.help)

            Text(InspectorSettings.renderingEngine.help)
                .font(.caption)
                .foregroundStyle(.secondary)

            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Reinitializing viewer…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .opacity(model.isSwitchingBackend ? 1 : 0)
            .accessibilityHidden(!model.isSwitchingBackend)
        }
    }
}

private extension Color {
    static func fromRGBA(_ rgba: [Double]) -> Color {
        guard rgba.count >= 3 else { return .black }
        return Color(.sRGB, red: rgba[0], green: rgba[1], blue: rgba[2], opacity: 1.0)
    }

    func toRGBAComponents() -> [Double] {
        #if os(macOS)
        let color = NSColor(self).usingColorSpace(.sRGB) ?? .black
        return [
            Double(color.redComponent),
            Double(color.greenComponent),
            Double(color.blueComponent),
            1.0,
        ]
        #else
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [Double(red), Double(green), Double(blue), 1.0]
        #endif
    }
}
