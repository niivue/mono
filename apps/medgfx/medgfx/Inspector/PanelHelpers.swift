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
        Toggle(setting.title, isOn: setting.binding(in: model))
            .help(setting.help)
    }
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
