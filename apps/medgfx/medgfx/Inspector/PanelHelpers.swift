//
//  PanelHelpers.swift
//  medgfx
//
//  Shared SwiftUI controls for the display inspector.
//

import NiiVueKit
import SwiftUI

@MainActor @ViewBuilder
func sliderRow(
    setting: NiiVueSetting<Double>,
    model: NiiVueModel,
    range: ClosedRange<Double>,
    format: String
) -> some View {
    let binding = setting.binding(in: model)
    VStack(alignment: .leading, spacing: 4) {
        HStack {
            Text(setting.title).font(.caption)
            Spacer()
            Text(String(format: format, binding.wrappedValue))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        Slider(value: binding, in: range)
    }
    .help(setting.help)
}

@MainActor
struct SettingPicker<Value: Hashable>: View {
    let setting: NiiVueSetting<Value>
    let model: NiiVueModel

    var body: some View {
        Picker(setting.title, selection: setting.binding(in: model)) {
            ForEach(setting.choices) { choice in
                Text(choice.title).tag(choice.value)
            }
        }
        .help(setting.help)
    }
}

@MainActor
struct SettingToggle: View {
    let setting: NiiVueSetting<Bool>
    let model: NiiVueModel

    var body: some View {
        Toggle(isOn: setting.binding(in: model)) {
            Text(setting.title)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
        #if os(macOS)
        .controlSize(.mini)
        #endif
        .help(setting.help)
    }
}

/// Leading label of a two-column inspector row.
struct RowLabel: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(minWidth: 64, alignment: .leading)
    }
}

/// A volume's colormap as a horizontal gradient chip.
struct ColormapSwatch: View {
    let stops: [[Double]]

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 3)
        shape
            .fill(LinearGradient(stops: gradientStops, startPoint: .leading, endPoint: .trailing))
            .overlay(shape.strokeBorder(.separator, lineWidth: 0.5))
            .accessibilityHidden(true)
    }

    // Label colormaps carry no stops; show them as neutral gray.
    private var gradientStops: [Gradient.Stop] {
        let valid = stops.filter { $0.count == 4 }
        guard valid.count >= 2 else {
            return [.init(color: .gray, location: 0), .init(color: .gray, location: 1)]
        }
        return valid.map {
            Gradient.Stop(color: Color(red: $0[1], green: $0[2], blue: $0[3]), location: $0[0])
        }
    }
}

/// File name without its image extension, e.g. "mni152" for "mni152.nii.gz".
func imageTitle(_ fileName: String) -> String {
    var name = fileName
    if name.lowercased().hasSuffix(".gz") { name.removeLast(3) }
    return (name as NSString).deletingPathExtension
}

extension VolumeSummary {
    var title: String { imageTitle(name) }
}

@MainActor
struct SettingPresetGrid<Value: Equatable>: View {
    let setting: NiiVueSetting<Value>
    let model: NiiVueModel

    private let columns = [GridItem(.adaptive(minimum: 118), spacing: 8)]

    var body: some View {
        let selection = setting.binding(in: model)

        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(setting.choices) { choice in
                Button {
                    selection.wrappedValue = choice.value
                } label: {
                    HStack(spacing: 6) {
                        Text(choice.title)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if selection.wrappedValue == choice.value {
                            Image(systemName: "checkmark")
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .help(setting.help)
    }
}
