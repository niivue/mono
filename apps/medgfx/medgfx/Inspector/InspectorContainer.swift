//
//  InspectorContainer.swift
//  medgfx
//
//  A single scrollable display inspector. Common adjustments are expanded;
//  implementation-level controls live under Advanced.
//

import NiiVueKit
import SwiftUI

@MainActor
struct InspectorContainer: View {
    let model: NiiVueModel
    let fillsAvailableWidth: Bool

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
            LazyVStack(alignment: .leading, spacing: 0) {
                Text("Display")
                    .font(.title3.weight(.semibold))
                    .padding(.bottom, 8)

                inspectorSection(.layout) {
                    LayoutInspectorSection(model: model)
                }
                Divider()

                inspectorSection(.guidesAndLabels) {
                    GuidesLabelsInspectorSection(model: model)
                }
                Divider()

                inspectorSection(.imageAppearance) {
                    ImageAppearanceInspectorSection(model: model)
                }

                Divider()
                inspectorSection(.threeDView) {
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
            minWidth: 290,
            idealWidth: fillsAvailableWidth ? nil : 340,
            maxWidth: fillsAvailableWidth ? .infinity : 400
        )
        #if os(macOS)
        .background(.regularMaterial)
        #else
        .background(Color(.secondarySystemBackground))
        #endif
    }

    @ViewBuilder
    private func inspectorSection<Content: View>(
        _ section: InspectorSectionID,
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        DisclosureGroup(isExpanded: expansionBinding(for: section)) {
            content()
                .padding(.top, 12)
                .padding(.bottom, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label(section.title, systemImage: section.systemImage)
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
