//
//  InspectorPanel.swift
//  medgfx
//
//  Protocol + container for modular inspector panels. Each panel is a
//  self-contained SwiftUI View plus a title/icon. To add a panel, implement
//  this protocol and register it in InspectorContainer.allPanels.
//

import NiiVueKit
import SwiftUI

protocol InspectorPanel: Identifiable, Hashable {
    var id: String { get }
    var title: String { get }
    var systemImage: String { get }

    associatedtype Body: View
    @ViewBuilder @MainActor
    func body(model: NiiVueModel) -> Body
}

/// Type-erased box so the container can hold mixed panels in one array.
@MainActor
struct AnyInspectorPanel: Identifiable, Hashable {
    let id: String
    let title: String
    let systemImage: String
    let bodyBuilder: (NiiVueModel) -> AnyView

    init<P: InspectorPanel>(_ panel: P) {
        self.id = panel.id
        self.title = panel.title
        self.systemImage = panel.systemImage
        self.bodyBuilder = { AnyView(panel.body(model: $0)) }
    }

    nonisolated static func == (lhs: AnyInspectorPanel, rhs: AnyInspectorPanel) -> Bool {
        lhs.id == rhs.id
    }

    nonisolated func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}
