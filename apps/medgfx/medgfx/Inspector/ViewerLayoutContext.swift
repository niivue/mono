//
//  ViewerLayoutContext.swift
//  medgfx
//
//  Single source of truth for layout precedence, applicability, and transitions.
//

import NiiVueKit

struct ViewerLayoutContext: Equatable {
    enum Mode: Equatable {
        case builtIn
        case mosaic
        case custom
    }

    let mode: Mode
    let usesBuiltInMultiplanarLayout: Bool
    let hasThreeDView: Bool

    var isMosaicActive: Bool { mode == .mosaic }
    var isCustomLayoutActive: Bool { mode == .custom }

    init(
        sliceType: SliceType,
        showRender: ShowRender,
        mosaicString: String,
        customLayout: [CustomLayoutTile]?
    ) {
        let activeCustomLayout = customLayout.flatMap { $0.isEmpty ? nil : $0 }
        let mosaicTokens = mosaicString
            .split(whereSeparator: { $0.isWhitespace || $0 == ";" })

        if let activeCustomLayout {
            mode = .custom
            hasThreeDView = activeCustomLayout.contains {
                $0.sliceType == SliceType.render.rawValue
            }
        } else if !mosaicTokens.isEmpty {
            mode = .mosaic
            hasThreeDView = mosaicTokens.contains { $0.uppercased() == "R" }
        } else {
            mode = .builtIn
            hasThreeDView = sliceType == .render
                || (sliceType == .multiplanar && showRender != .never)
        }

        usesBuiltInMultiplanarLayout = mode == .builtIn && sliceType == .multiplanar
    }
}

@MainActor
extension ViewerLayoutContext {
    init(model: NiiVueModel) {
        self.init(
            sliceType: model.sliceType,
            showRender: model.showRender,
            mosaicString: model.mosaicString.value,
            customLayout: model.customLayout.value
        )
    }
}

@MainActor
extension NiiVueModel {
    func selectBuiltInView(_ view: SliceType) {
        mosaicString.value = ""
        customLayout.value = nil
        sliceType = view
    }

    func applyMosaicLayout(_ mosaic: String) {
        customLayout.value = nil
        sliceType = .multiplanar
        mosaicString.value = mosaic
    }

    func applyCustomMultiplanarLayout(_ layout: [CustomLayoutTile]?) {
        let normalizedLayout = layout.flatMap { $0.isEmpty ? nil : $0 }
        mosaicString.value = ""
        sliceType = .multiplanar
        customLayout.value = normalizedLayout
    }
}
