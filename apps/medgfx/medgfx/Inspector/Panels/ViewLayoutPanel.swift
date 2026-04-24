//
//  ViewLayoutPanel.swift
//  medgfx
//
//  Slice type, multiplanar type, hero fraction, radiological flip, mosaic.
//

import SwiftUI

struct ViewLayoutPanel: InspectorPanel {
    let id = "view-layout"
    let title = "View"
    let systemImage = "square.grid.2x2"

    @MainActor
    func body(model: NiiVueModel) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            section("Backend") {
                Picker(
                    "Backend",
                    selection: Binding(
                        get: { model.currentBackend ?? .webgl2 },
                        set: { newValue in
                            Task { await model.setBackend(newValue) }
                        }
                    )
                ) {
                    ForEach(Backend.allCases) { backend in
                        Text(backend.label).tag(backend)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(model.currentBackend == nil || model.isSwitchingBackend)

                if model.isSwitchingBackend {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Reinitializing…").font(.caption2).foregroundStyle(.secondary)
                    }
                } else {
                    Text("Switching backends reinitializes the view and clears loaded volumes.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            section("Slice Type") {
                Picker("Slice type", selection: model.sliceTypeBinding) {
                    ForEach(SliceType.allCases) { type in
                        Text(type.label).tag(type)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }

            if model.sliceType == .multiplanar {
                section("Multiplanar Layout") {
                    Picker("Multiplanar layout", selection: model.multiplanarTypeBinding) {
                        ForEach(MultiplanarType.allCases) { type in
                            Text(type.label).tag(type)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()

                    sliderRow(
                        label: "Hero fraction",
                        binding: model.binding(\.heroFraction),
                        range: 0...1,
                        format: "%.2f"
                    )
                }

                section("3D Render") {
                    Picker("Show render", selection: model.showRenderBinding) {
                        ForEach(ShowRender.allCases) { v in
                            Text(v.label).tag(v)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
            }

            section("Orientation") {
                Toggle("Radiological (flip L/R)", isOn: model.binding(\.isRadiological))
            }

            section("Mosaic") {
                TextField(
                    "e.g. A -20 0 20 ; S R X 0",
                    text: model.binding(\.mosaicString),
                    axis: .vertical
                )
                .font(.system(.caption, design: .monospaced))
                .lineLimit(2...4)
                #if os(iOS)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                #else
                .textFieldStyle(.roundedBorder)
                #endif

                Text("DSL: A/C/S = slice, R = render, X = crosslines, L = labels, ; = row break")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
