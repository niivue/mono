//
//  InspectorContainer.swift
//  medgfx
//
//  Renders the active inspector panel, with a segmented picker along the top
//  to switch between registered panels. Host views control the container's
//  visibility — InspectorContainer itself is always "visible" when instantiated.
//

import NiiVueKit
import SwiftUI

@MainActor
struct InspectorContainer: View {
    let model: NiiVueModel
    let panels: [AnyInspectorPanel]

    @State private var selection: String

    init(model: NiiVueModel, panels: [AnyInspectorPanel]) {
        self.model = model
        self.panels = panels
        _selection = State(initialValue: panels.first?.id ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Panel", selection: $selection) {
                ForEach(panels) { panel in
                    Label(panel.title, systemImage: panel.systemImage)
                        .tag(panel.id)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 12)

            Divider()

            ScrollView {
                if let active = panels.first(where: { $0.id == selection }) {
                    active.bodyBuilder(model)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 20)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("No panel selected")
                        .foregroundStyle(.secondary)
                        .padding(20)
                }
            }
        }
        .frame(minWidth: 280, idealWidth: 320, maxWidth: 380)
        #if os(macOS)
        .background(.regularMaterial)
        #else
        .background(Color(.secondarySystemBackground))
        #endif
    }
}

/// Central registry of available panels. Add one line here to expose a new
/// panel in the inspector.
@MainActor
enum InspectorPanels {
    static let all: [AnyInspectorPanel] = [
        AnyInspectorPanel(ViewLayoutPanel()),
        AnyInspectorPanel(ChromePanel()),
        AnyInspectorPanel(ScenePanel()),
    ]
}
