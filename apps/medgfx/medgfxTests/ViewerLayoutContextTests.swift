import NiiVueKit
import Testing
@testable import medgfx

@MainActor
struct ViewerLayoutContextTests {
    @Test
    func identifiesBuiltInMultiplanarLayout() {
        let context = makeContext(
            sliceType: .multiplanar,
            showRender: .never
        )

        #expect(context.mode == .builtIn)
        #expect(context.usesBuiltInMultiplanarLayout)
        #expect(!context.hasThreeDView)
    }

    @Test
    func treatsEmptyCustomLayoutAsInactive() {
        let context = makeContext(
            sliceType: .multiplanar,
            showRender: .never,
            customLayout: []
        )

        #expect(context.mode == .builtIn)
        #expect(context.usesBuiltInMultiplanarLayout)
    }

    @Test
    func identifiesMosaicRenderTile() {
        let context = makeContext(
            mosaicString: "A 0 C 0 ; S 0 R 0"
        )

        #expect(context.mode == .mosaic)
        #expect(context.hasThreeDView)
    }

    @Test
    func customLayoutTakesPrecedenceOverMosaic() {
        let context = makeContext(
            mosaicString: "R 0",
            customLayout: [
                CustomLayoutTile(
                    sliceType: .axial,
                    position: [0, 0, 1, 1]
                ),
            ]
        )

        #expect(context.mode == .custom)
        #expect(!context.hasThreeDView)
    }

    @Test
    func identifiesBuiltInThreeDViews() {
        let renderContext = makeContext(sliceType: .render)
        let multiplanarContext = makeContext(
            sliceType: .multiplanar,
            showRender: .always
        )

        #expect(renderContext.hasThreeDView)
        #expect(multiplanarContext.hasThreeDView)
    }

    @Test
    func layoutTransitionsKeepModesMutuallyExclusive() {
        let model = NiiVueModel(bridge: Bridge(config: .default))

        model.applyMosaicLayout("A 0 C 0")
        #expect(model.sliceType == .multiplanar)
        #expect(model.mosaicString.value == "A 0 C 0")
        #expect(model.customLayout.value == nil)

        let customLayout = [
            CustomLayoutTile(
                sliceType: .render,
                position: [0, 0, 1, 1]
            ),
        ]
        model.applyCustomMultiplanarLayout(customLayout)
        #expect(model.sliceType == .multiplanar)
        #expect(model.mosaicString.value.isEmpty)
        #expect(model.customLayout.value == customLayout)

        model.applyCustomMultiplanarLayout([])
        #expect(model.customLayout.value == nil)
        #expect(ViewerLayoutContext(model: model).mode == .builtIn)

        model.applyMosaicLayout("A 0")
        model.selectBuiltInView(.axial)
        #expect(model.sliceType == .axial)
        #expect(model.mosaicString.value.isEmpty)
        #expect(model.customLayout.value == nil)
    }

    private func makeContext(
        sliceType: SliceType = .multiplanar,
        showRender: ShowRender = .never,
        mosaicString: String = "",
        customLayout: [CustomLayoutTile]? = nil
    ) -> ViewerLayoutContext {
        ViewerLayoutContext(
            sliceType: sliceType,
            showRender: showRender,
            mosaicString: mosaicString,
            customLayout: customLayout
        )
    }
}
