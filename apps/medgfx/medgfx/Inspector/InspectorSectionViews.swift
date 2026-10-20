//
//  InspectorSectionViews.swift
//  medgfx
//
//  Focused content views hosted by InspectorContainer's disclosure groups.
//

import NiiVueKit
import SwiftUI

@MainActor
struct LayersInspectorSection: View {
    let model: NiiVueModel
    @Binding var selection: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Layers")
                .font(.headline)

            // Topmost layer first, as it draws over the ones below.
            VStack(spacing: 2) {
                ForEach(model.volumes.indices.reversed(), id: \.self) { index in
                    layerRow(index)
                }
            }

            if model.volumes.indices.contains(selection) {
                Divider()
                    .padding(.vertical, 6)
                LayerDisplayControls(
                    model: model,
                    index: selection,
                    volume: model.volumes[selection]
                )
                .id(selection)
            }
        }
        .padding(.top, 4)
    }

    private func layerRow(_ index: Int) -> some View {
        let volume = model.volumes[index]
        let isSelected = index == selection
        return Button {
            selection = index
        } label: {
            HStack(spacing: 8) {
                ColormapSwatch(stops: volume.colormapStops)
                    .frame(width: 22, height: 14)
                Text(volume.title)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .opacity(volume.opacity > 0 ? 1 : 0.45)
                Spacer(minLength: 4)
                Text(index == 0 ? "Base" : "Overlay")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)
            .frame(height: 28)
            .background(
                isSelected ? Color.accentColor.opacity(0.2) : .clear,
                in: RoundedRectangle(cornerRadius: 6)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .contextMenu {
            Button("Remove \(volume.title)", role: .destructive) {
                Task { await model.removeVolume(at: index) }
            }
        }
    }
}

@MainActor
private struct LayerDisplayControls: View {
    let model: NiiVueModel
    let index: Int
    let volume: VolumeSummary

    // Local so the slider tracks the pointer without waiting for NiiVue's echo.
    @State private var opacity: Double = 1
    @State private var isDraggingOpacity = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Display")
                    .font(.headline)
                Spacer()
                Text(volume.title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    RowLabel("Colormap")
                    Picker("Colormap", selection: colormapBinding) {
                        ForEach(model.colormaps, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                    .disabled(model.colormaps.isEmpty)
                }
                GridRow {
                    RowLabel("Range")
                    HStack(spacing: 6) {
                        rangeField("Minimum", value: volume.calMin) { SetVolumePayload(index: index, calMin: $0) }
                        Text("–").foregroundStyle(.secondary)
                        rangeField("Maximum", value: volume.calMax) { SetVolumePayload(index: index, calMax: $0) }
                    }
                }
                GridRow {
                    RowLabel("Opacity")
                    HStack(spacing: 8) {
                        Slider(value: $opacity, in: 0...1) { isDraggingOpacity = $0 }
                            .controlSize(.small)
                        Text(opacity, format: .percent.precision(.fractionLength(0)))
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(width: 36, alignment: .trailing)
                    }
                }
            }
        }
        .onAppear { opacity = volume.opacity }
        // Ignore echoes mid-drag, or late ones snap the knob back.
        .onChange(of: volume.opacity) { _, new in
            if !isDraggingOpacity { opacity = new }
        }
        .onChange(of: opacity) { _, new in
            guard abs(new - volume.opacity) > 0.001 else { return }
            Task { await model.setVolume(SetVolumePayload(index: index, opacity: new)) }
        }
    }

    /// NiiVue may canonicalize case, so match the menu entry case-insensitively.
    private var colormapBinding: Binding<String> {
        Binding(
            get: {
                model.colormaps.first {
                    $0.caseInsensitiveCompare(volume.colormap) == .orderedSame
                } ?? volume.colormap
            },
            set: { name in
                Task { await model.setVolume(SetVolumePayload(index: index, colormap: name)) }
            }
        )
    }

    private func rangeField(
        _ label: String,
        value: Double,
        update: @escaping (Double) -> SetVolumePayload
    ) -> some View {
        TextField(
            label,
            value: Binding(
                get: { value },
                set: { new in Task { await model.setVolume(update(new)) } }
            ),
            format: .number.precision(.significantDigits(1...4))
        )
        .labelsHidden()
        .multilineTextAlignment(.trailing)
        .font(.callout.monospacedDigit())
        .textFieldStyle(.roundedBorder)
    }
}

@MainActor
struct LayoutInspectorSection: View {
    let model: NiiVueModel

    var body: some View {
        let layoutContext = ViewerLayoutContext(model: model)

        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 10) {
                GridRow {
                    RowLabel(InspectorSettings.panelArrangement.title)
                    SettingPicker(setting: InspectorSettings.panelArrangement, model: model)
                        .pickerStyle(.segmented)
                        .labelsHidden()
                }
                GridRow {
                    RowLabel(InspectorSettings.threeDPanel.title)
                    SettingPicker(setting: InspectorSettings.threeDPanel, model: model)
                        .pickerStyle(.segmented)
                        .labelsHidden()
                }
            }
            .disabled(!layoutContext.usesBuiltInMultiplanarLayout)

            SettingToggle(setting: InspectorSettings.radiological, model: model)

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
struct OverlaysInspectorSection: View {
    let model: NiiVueModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
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
