# NiiVueGPU Property Migration Reference

Complete mapping from old property names/locations to new API.

## Global Config: Model Root Properties

| Old (`model.*`) | New (`model.*`) | Controller Access |
|-----------------|----------------|-------------------|
| `backColor` | `scene.backgroundColor` | `nv1.backgroundColor` |
| `gradientAmount` | `volume.illumination` | `nv1.volumeIllumination` |
| `overlayOutlineWidth` | `volume.outlineWidth` | `nv1.volumeOutlineWidth` |
| `overlayAlphaShader` | `volume.alphaShader` | `nv1.volumeAlphaShader` |
| `isBackgroundMasksOverlays` | `volume.isBackgroundMasking` | `nv1.volumeIsBackgroundMasking` |
| `isAlphaClipDark` | `volume.isAlphaClipDark` | `nv1.volumeIsAlphaClipDark` |
| `drawingEnabled` | `draw.isEnabled` | `nv1.drawIsEnabled` |
| `drawPenValue` | `draw.penValue` | `nv1.drawPenValue` |
| `drawPenSize` | `draw.penSize` | `nv1.drawPenSize` |
| `drawFillOverwrites` | `draw.isFillOverwriting` | `nv1.drawIsFillOverwriting` |
| `drawOpacity` | `draw.opacity` | `nv1.drawOpacity` |
| `drawRimOpacity` | `draw.rimOpacity` | `nv1.drawRimOpacity` |
| `drawColormap` | `draw.colormap` | `nv1.drawColormap` |
| `drawBitmap` | `model.drawingVolume` (`NVImage \| null`) | (internal) |
| `volumeMatcap` | `volume.matcap` | `nv1.volumeMatcap` |
| `show3Dcrosshair` | `ui.is3DCrosshairVisible` | `nv1.is3DCrosshairVisible` |
| `thumbnailVisible` | `ui.isThumbnailVisible` | `nv1.isThumbnailVisible` |
| `thumbnailUrl` | `ui.thumbnailUrl` | `nv1.thumbnailUrl` |

## Global Config: Scene Properties

| Old (`model.scene.*`) | New (`model.scene.*`) | Controller Access |
|----------------------|----------------------|-------------------|
| `azimuth` | `azimuth` | `nv1.azimuth` |
| `elevation` | `elevation` | `nv1.elevation` |
| `crosshairPos` | `crosshairPos` | `nv1.crosshairPos` |
| `pan2Dxyzmm` | `pan2Dxyzmm` | `nv1.pan2Dxyzmm` |
| `volScaleMultiplier` | `scaleMultiplier` | `nv1.scaleMultiplier` |
| `gamma` | `gamma` | `nv1.gamma` |

## Global Config: Options (`model.opts.*`)

| Old (`model.opts.*`) | New (`model.*`) | Controller Access |
|---------------------|----------------|-------------------|
| `sliceType` | `layout.sliceType` | `nv1.sliceType` |
| `sliceMosaicString` | `layout.mosaicString` | `nv1.mosaicString` |
| `multiplanarShowRender` | `layout.showRender` | `nv1.showRender` |
| `multiplanarLayout` | `layout.multiplanarType` | `nv1.multiplanarType` |
| `heroImageFraction` | `layout.heroFraction` | `nv1.heroFraction` |
| `heroSliceType` | `layout.heroSliceType` | `nv1.heroSliceType` |
| `isMultiplanarEqualSize` | `layout.isEqualSize` | `nv1.isEqualSize` |
| `isCenterMosaic` | `layout.isMosaicCentered` | `nv1.isMosaicCentered` |
| `tileMargin` | `layout.margin` | `nv1.tileMargin` |
| `isRadiologicalConvention` | `layout.isRadiological` | `nv1.isRadiological` |
| `isColorbar` | `ui.isColorbarVisible` | `nv1.isColorbarVisible` |
| `isOrientCube` | `ui.isOrientCubeVisible` | `nv1.isOrientCubeVisible` |
| `isOrientationTextVisible` | `ui.isOrientationTextVisible` | `nv1.isOrientationTextVisible` |
| `isGraph` | `ui.isGraphVisible` | `nv1.isGraphVisible` |
| `isRuler` | `ui.isRulerVisible` | `nv1.isRulerVisible` |
| `isCrossLines` | `ui.isCrossLinesVisible` | `nv1.isCrossLinesVisible` |
| `isLegend` | `ui.isLegendVisible` | `nv1.isLegendVisible` |
| `isSliceMM` | `ui.isPositionInMM` | `nv1.isPositionInMM` |
| `showMeasureUnits` | `ui.isMeasureUnitsVisible` | `nv1.isMeasureUnitsVisible` |
| `crosshairColor` | `ui.crosshairColor` | `nv1.crosshairColor` |
| `crosshairGap` | `ui.crosshairGap` | `nv1.crosshairGap` |
| `crosshairWidth` | `ui.crosshairWidth` | `nv1.crosshairWidth` |
| `fontColor` | `ui.fontColor` | `nv1.fontColor` |
| `fontSizeScaling` | `ui.fontScale` | `nv1.fontScale` |
| `fontMinPx` | `ui.fontMinSize` | `nv1.fontMinSize` |
| `selectionBoxColor` | `ui.selectionBoxColor` | `nv1.selectionBoxColor` |
| `measureLineColor` | `ui.measureLineColor` | `nv1.measureLineColor` |
| `measureTextColor` | `ui.measureTextColor` | `nv1.measureTextColor` |
| `rulerWidth` | `ui.rulerWidth` | `nv1.rulerWidth` |
| `graph` | `ui.graph` | `nv1.graphNormalizeValues` / `nv1.graphIsRangeCalMinMax` |
| `isClipPlanesCutaway` | `scene.isClipPlaneCutaway` | `nv1.isClipPlaneCutaway` |
| `clipPlaneColor` | `scene.clipPlaneColor` | `nv1.clipPlaneColor` |
| `meshXRay` | `mesh.xRay` | `nv1.meshXRay` |
| `meshThicknessOn2D` | `mesh.thicknessOn2D` | `nv1.meshThicknessOn2D` |
| `isNearestInterpolation` | `volume.isNearestInterpolation` | `nv1.volumeIsNearestInterpolation` |
| `isV1SliceShader` | `volume.isV1SliceShader` | `nv1.volumeIsV1SliceShader` |
| `paqdUniforms` | `volume.paqdUniforms` | `nv1.volumePaqdUniforms` |
| `dragMode` | `interaction.secondaryDragMode` | `nv1.secondaryDragMode` |
| `dragModePrimary` | `interaction.primaryDragMode` | `nv1.primaryDragMode` |
| `isForceMouseClickToVoxelCenters` | `interaction.isSnapToVoxelCenters` | `nv1.isSnapToVoxelCenters` |
| `yoke3Dto2DZoom` | `interaction.isYoked3DTo2DZoom` | `nv1.isYoked3DTo2DZoom` |

## Per-Volume Properties (NVImage)

| Old | New | Notes |
|-----|-----|-------|
| `cal_min` | `calMin` | camelCase |
| `cal_max` | `calMax` | camelCase |
| `cal_minNeg` | `calMinNeg` | camelCase |
| `cal_maxNeg` | `calMaxNeg` | camelCase |
| `robust_min` | `robustMin` | camelCase |
| `robust_max` | `robustMax` | camelCase |
| `global_min` | `globalMin` | camelCase |
| `global_max` | `globalMax` | camelCase |
| `colorbarVisible` | `isColorbarVisible` | boolean prefix |
| `showLegend` | `isLegendVisible` | boolean prefix |
| `imaginary` | `isImaginary` | boolean prefix |
| `url` | `url` | unchanged |
| `name` | `name` | unchanged |
| `colormap` | `colormap` | unchanged |
| `colormapNegative` | `colormapNegative` | unchanged |
| `colormapType` | `colormapType` | unchanged |
| `isTransparentBelowCalMin` | `isTransparentBelowCalMin` | unchanged |
| `opacity` | `opacity` | unchanged |
| `modulateAlpha` | `modulateAlpha` | unchanged |
| `frame4D` | `frame4D` | unchanged |
| `limitFrames4D` | `limitFrames4D` | unchanged |

## Per-Mesh Properties (NVMesh)

| Old | New | Notes |
|-----|-----|-------|
| `colorbarVisible` | `isColorbarVisible` | boolean prefix |
| `showLegend` | `isLegendVisible` | boolean prefix |
| `url` | `url` | unchanged |
| `name` | `name` | unchanged |
| `opacity` | `opacity` | unchanged |
| `color` | `color` | unchanged |
| `shaderType` | `shaderType` | unchanged |

## Per-Layer Properties (NVMeshLayer)

| Old | New | Notes |
|-----|-----|-------|
| `cal_min` | `calMin` | camelCase |
| `cal_max` | `calMax` | camelCase |
| `cal_minNeg` | `calMinNeg` | camelCase |
| `cal_maxNeg` | `calMaxNeg` | camelCase |
| `global_min` | `globalMin` | camelCase |
| `global_max` | `globalMax` | camelCase |
| `colorbarVisible` | `isColorbarVisible` | boolean prefix |
| `colormapInvert` | `isColormapInverted` | boolean prefix |
| `outlineBorder` | `outlineWidth` | clearer name |
| `url` | `url` | unchanged |
| `name` | `name` | unchanged |
| `colormap` | `colormap` | unchanged |
| `colormapNegative` | `colormapNegative` | unchanged |
| `colormapType` | `colormapType` | unchanged |
| `isTransparentBelowCalMin` | `isTransparentBelowCalMin` | unchanged |
| `isAdditiveBlend` | `isAdditiveBlend` | unchanged |
| `opacity` | `opacity` | unchanged |
| `frame4D` | `frame4D` | unchanged |
| `nFrame4D` | `nFrame4D` | unchanged |

## Tract Options (NVTractOptions)

| Old | New | Notes |
|-----|-----|-------|
| `cal_min` | `calMin` | camelCase |
| `cal_max` | `calMax` | camelCase |
| `cal_minNeg` | `calMinNeg` | camelCase |
| `cal_maxNeg` | `calMaxNeg` | camelCase |
| All others | unchanged | |

## Removed Controller Methods -> Property Setters

| Old Method | New Property |
|------------|-------------|
| `setVolumeRenderIllumination(v)` | `nv1.volumeIllumination = v` |
| `setRadiologicalConvention(v)` | `nv1.isRadiological = v` |
| `setSliceType(v)` | `nv1.sliceType = v` |
| `setCrosshairColor(v)` | `nv1.crosshairColor = v` |
| `setRenderAzimuthElevation(a, e)` | `nv1.azimuth = a; nv1.elevation = e` |
| `setScale(v)` | `nv1.scaleMultiplier = v` |
| `setDragMode(v)` | still exists as method (for string-to-number mapping) |

## Annotation Options

| Old | New (`model.annotation.*`) | Controller Access |
|-----|---------------------------|-------------------|
| (new) | `annotation.isEnabled` | `nv1.annotationIsEnabled` |
| (new) | `annotation.activeLabel` | `nv1.annotationActiveLabel` |
| (new) | `annotation.activeGroup` | `nv1.annotationActiveGroup` |
| (new) | `annotation.brushRadius` | `nv1.annotationBrushRadius` |
| (new) | `annotation.isErasing` | `nv1.annotationIsErasing` |
| (new) | `annotation.isVisibleIn3D` | `nv1.annotationIsVisibleIn3D` |
| (new) | `annotation.style` | `nv1.annotationStyle` |
| (new) | `annotation.tool` | `nv1.annotationTool` |

## Constructor Options Migration

| Old (grouped) | New (flat) |
|--------------|-----------|
| `scene: { backgroundColor: [0,0,0,1] }` | `backgroundColor: [0,0,0,1]` |
| `ui: { isColorbarVisible: true }` | `isColorbarVisible: true` |
| `mesh: { xRay: 0.1 }` | `meshXRay: 0.1` |
| `layout: { sliceType: 3 }` | `sliceType: SLICE_TYPE.MULTIPLANAR` |
| `ui: { isOrientCubeVisible: false }` | `isOrientCubeVisible: false` |
| `interaction: { secondaryDragMode: ... }` | `secondaryDragMode: DRAG_MODE.contrast` |
| `forceDevicePixelRatio: 2` | `devicePixelRatio: 2` |
