//
//  InspectorContainer.swift
//  medgfx
//
//  A single scrollable inspector: the loaded layers and the selected layer's
//  display first, then viewer-wide sections. Implementation-level controls
//  live under Advanced.
//

import NiiVueKit
import SwiftUI

@MainActor
struct InspectorContainer: View {
    let model: NiiVueModel
    let fillsAvailableWidth: Bool

    @State private var selectedLayer = 0
    @State private var expandedSections: Set<InspectorSectionID> = Set(
        InspectorSectionID.allCases.filter(\.isExpandedByDefault)
    )

    init(model: NiiVueModel, fillsAvailableWidth: Bool = false) {
        self.model = model
        self.fillsAvailableWidth = fillsAvailableWidth
    }

    var body: some View {
        let layoutContext = ViewerLayoutContext(model: model)

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if !model.volumes.isEmpty {
                    LayersInspectorSection(model: model, selection: $selectedLayer)
                        .padding(.bottom, 14)
                    Divider()
                }

                inspectorSection(.layout) {
                    LayoutInspectorSection(model: model)
                }
                Divider()

                inspectorSection(.overlays) {
                    OverlaysInspectorSection(model: model)
                }
                Divider()

                inspectorSection(.camera) {
                    ThreeDInspectorSection(
                        model: model,
                        isEnabled: layoutContext.hasThreeDView
                    )
                }
                Divider()

                inspectorSection(.advanced) {
                    AdvancedInspectorSection(model: model)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(
            minWidth: 280,
            idealWidth: fillsAvailableWidth ? nil : 312,
            maxWidth: fillsAvailableWidth ? .infinity : 380
        )
        #if os(iOS)
        .background(Color(.secondarySystemBackground))
        #endif
        .onChange(of: model.volumes.count) { _, count in
            selectedLayer = min(selectedLayer, max(count - 1, 0))
        }
    }

    @ViewBuilder
    private func inspectorSection<Content: View>(
        _ section: InspectorSectionID,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        DisclosureGroup(isExpanded: expansionBinding(for: section)) {
            content()
                .padding(.top, 10)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text(section.title)
                .font(.headline)
        }
        .padding(.vertical, 10)
    }

    private func expansionBinding(for section: InspectorSectionID) -> Binding<Bool> {
        Binding(
            get: { expandedSections.contains(section) },
            set: { isExpanded in
                if isExpanded {
                    expandedSections.insert(section)
                } else {
                    expandedSections.remove(section)
                }
            }
        )
    }
}
