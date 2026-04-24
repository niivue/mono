//
//  PanelHelpers.swift
//  medgfx
//
//  Shared SwiftUI helpers used across InspectorPanel implementations.
//  Kept at file scope (not in a protocol extension) so panels stay small
//  and the helpers are independently previewable.
//

import SwiftUI

@MainActor @ViewBuilder
func section<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Text(title)
            .font(.caption)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
        content()
    }
}

@MainActor @ViewBuilder
func sliderRow(
    label: String,
    binding: Binding<Double>,
    range: ClosedRange<Double>,
    format: String
) -> some View {
    VStack(alignment: .leading, spacing: 4) {
        HStack {
            Text(label).font(.caption)
            Spacer()
            Text(String(format: format, binding.wrappedValue))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
        }
        Slider(value: binding, in: range)
    }
}
