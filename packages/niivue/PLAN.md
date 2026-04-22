# Unit Test Plan for `packages/niivue` — Non-Rendering Code

## Overview

15+ modules containing pure logic that can be tested server-side with no WebGL/WebGPU or DOM dependencies. These cover ~2,500 lines of code spanning math transforms, drawing tools, annotation utilities, volume utilities, colormap generation, and mesh I/O.

## Test Runner Setup

The `project.json` currently targets vitest (which isn't installed). Since we want **bun's test runner**:

1. Switch the test target in `project.json` to `bun test`
2. Add a `bunfig.toml` in `packages/niivue/` to resolve the `@/*` path alias:
   ```toml
   [test]
   preload = []

   [resolve]
   paths = { "@/*" = ["./src/*"] }
   ```
3. Tests co-located as `*.test.ts` next to source files (per project convention in AGENTS.md)

## Proposed Test Files & Cases

### 1. `src/drawing/rle.test.ts` — PackBits RLE codec

| Test | Rationale |
|------|-----------|
| `encodeRLE_emptyInput_returnsEmptyArray` | Edge: zero-length |
| `encodeRLE_singleByte_encodesCorrectly` | Boundary: minimum input |
| `encodeRLE_allSameBytes_compressesAsRun` | Happy path: max compression |
| `encodeRLE_allDifferentBytes_encodesAsLiterals` | Happy path: worst-case |
| `decodeRLE_roundtrip_matchesOriginal` | Integration: encode→decode identity |
| `decodeRLE_roundtrip_randomData_matchesOriginal` | Broad: random payloads |
| `decodeRLE_roundtrip_drawingBitmap_matchesOriginal` | Realistic: sparse label data (mostly zeros) |
| `encodeRLE_longRun_splitsAt129` | Boundary: max run length capping |

### 2. `src/drawing/penTool.test.ts` — Voxel drawing primitives

| Test | Rationale |
|------|-----------|
| `voxelIndex_computes_flatIndex` | Happy path |
| `clampToDimension_clampsNegativeToZero` | Edge |
| `clampToDimension_clampsOverflowToMax` | Edge |
| `drawPoint_setsVoxelInBitmap` | Happy path: pen size 1 |
| `drawPoint_penSize3_axial_setsNeighborhood` | Happy path: larger pen |
| `drawPoint_penOverwritesFalse_doesNotOverwriteExisting` | Behavioral toggle |
| `drawLine_horizontalLine_setsAllVoxels` | Happy path |
| `drawLine_diagonalLine_connectsEndpoints` | Happy path: Bresenham 3D |
| `drawLine_samePoint_noOp` | Edge: zero-length line |
| `floodFillSection_fillsInterior` | Happy path |
| `floodFillSection_edgeBoundaryAlreadyFilled` | Edge |
| `isPenLocationValid_NaN_returnsFalse` | Edge |
| `isPenLocationValid_validCoord_returnsTrue` | Happy path |
| `isSamePoint_identical_returnsTrue` | Happy path |
| `isSamePoint_different_returnsFalse` | Happy path |
| `getSliceIndices_axial_returns_0_1` | Happy path |
| `getSliceIndices_coronal_returns_0_2` | Happy path |
| `getSliceIndices_sagittal_returns_1_2` | Happy path |

### 3. `src/drawing/undo.test.ts` — Drawing undo

| Test | Rationale |
|------|-----------|
| `drawUndo_emptyBitmaps_returnsUndefined` | Edge: no history |
| `drawUndo_restoresPreviousState` | Happy path |
| `drawUndo_wrapsAroundWhenIndexNegative` | Boundary: circular buffer |
| `drawUndo_shortBitmap_returnsUndefined` | Edge: corrupt entry |

### 4. `src/annotation/undoRedo.test.ts` — Annotation undo/redo stack

| Test | Rationale |
|------|-----------|
| `canUndo_initiallyFalse` | Initial state |
| `canRedo_initiallyFalse` | Initial state |
| `push_then_canUndo_isTrue` | Happy path |
| `undo_restoresPreviousSnapshot` | Happy path |
| `redo_afterUndo_restoresUndoneState` | Happy path |
| `push_clearsRedoStack` | Behavioral: redo invalidated by new push |
| `push_exceedsMaxSnapshots_dropsOldest` | Boundary: capacity |
| `clear_resetsStacks` | Happy path |
| `undo_emptyStack_returnsNull` | Edge |
| `redo_emptyStack_returnsNull` | Edge |

### 5. `src/annotation/pointInRing.test.ts` — Point-in-polygon

| Test | Rationale |
|------|-----------|
| `pointInRing_insideSquare_returnsTrue` | Happy path |
| `pointInRing_outsideSquare_returnsFalse` | Happy path |
| `pointInRing_onEdge_returnsFalse` (or true) | Edge: boundary behavior |
| `pointInRing_triangle_insideReturnsTrue` | Happy path: different polygon |
| `pointInRing_concavePolygon_correctResult` | Edge: concavity |
| `pointInRing_emptyRing_returnsFalse` | Edge |

### 6. `src/annotation/sliceProjection.test.ts` — mm↔2D projection

| Test | Rationale |
|------|-----------|
| `mmToSlice2D_axial_usesXY` | Happy path |
| `mmToSlice2D_coronal_usesXZ` | Happy path |
| `mmToSlice2D_sagittal_usesYZ` | Happy path |
| `slice2DToMM_axial_reconstructsMMWithDepth` | Roundtrip |
| `slice2DToMM_coronal_reconstructsMMWithDepth` | Roundtrip |
| `slice2DToMM_sagittal_reconstructsMMWithDepth` | Roundtrip |
| `isOnSlice_pointOnPlane_returnsTrue` | Happy path |
| `isOnSlice_pointOffPlane_returnsFalse` | Happy path |
| `isOnSlice_pointWithinTolerance_returnsTrue` | Boundary |

### 7. `src/annotation/selection.test.ts` — Shape control points & hit testing

| Test | Rationale |
|------|-----------|
| `getControlPoints_rectangle_returns8Points` | Happy path |
| `getControlPoints_ellipse_returns4CardinalPoints` | Happy path |
| `getControlPoints_line_returns3Points` | Happy path |
| `getControlPoints_unknownType_returnsEmpty` | Edge: freehand |
| `hitTestControlPoint_onPoint_returnsIndex` | Happy path |
| `hitTestControlPoint_noHit_returnsNegativeOne` | Happy path |
| `updateShapeBounds_rectangleCornerDrag_fixesOppositeCorner` | Happy path |
| `updateShapeBounds_circleCardinalDrag_maintainsSquareAspect` | Happy path |
| `updateShapeBounds_lineWidthHandle_adjustsWidth` | Happy path |

### 8. `src/math/NVTransforms.test.ts` — Spatial math

| Test | Rationale |
|------|-----------|
| `deg2rad_0_returns0` | Boundary |
| `deg2rad_180_returnsPi` | Happy path |
| `deg2rad_360_returns2Pi` | Happy path |
| `cart2sphDeg_unitX_returnsCorrectAzimuthElevation` | Happy path |
| `cart2sphDeg_origin_returns0_0` | Edge: zero vector |
| `depthAziElevToClipPlane_returnsCorrectPlane` | Happy path |
| `vox2mm_identityMatrix_returnsInputCoords` | Sanity check |
| `vox2mm_scaledMatrix_scalesCorrectly` | Happy path |
| `mm2vox_identityRAS_roundtripsWithVox2mm` | Integration |
| `mm2frac_validImage_returnsNormalizedCoords` | Happy path |
| `slicePlaneEquation_axial_returnsZNormal` | Happy path for identity affine |
| `slicePlaneEquation_coronal_returnsYNormal` | Happy path |
| `slicePlaneEquation_sagittal_returnsXNormal` | Happy path |
| `unprojectScreen_center_returnsOrigin` | Sanity check |

### 9. `src/volume/utils.test.ts` — Volume data utilities

| Test | Rationale |
|------|-----------|
| `ensureValidNonZero_0_returns1` | Edge |
| `ensureValidNonZero_Infinity_returns1` | Edge |
| `ensureValidNonZero_42_returns42` | Happy path |
| `getTypedArrayConstructor_DT_FLOAT32_returnsFloat32Array` | Happy path |
| `getTypedArrayConstructor_unknownCode_returnsNull` | Edge |
| `getBitsPerVoxel_DT_UINT8_returns8` | Happy path |
| `getBitsPerVoxel_DT_FLOAT64_returns64` | Happy path |
| `getBitsPerVoxel_unknownCode_returns0` | Edge |
| `calMinMax_uniformData_returnsEqualMinMax` | Edge: constant image |
| `calMinMax_rampData_returnsCorrectRange` | Happy path |
| `calMinMax_calMinCalMaxSet_usesHeaderValues` | Happy path: header override |
| `createNiftiHeader_setsCorrectDims` | Happy path |
| `hdrToArrayBuffer_returns348bytes` | Structural |
| `createNiftiArray_headerOnly_returnsHeaderBytes` | Edge: empty image |
| `createNiftiArray_withData_roundtripsHeader` | Happy path |
| `buildPaqdLut256_mapsColorsCorrectly` | Happy path |
| `buildPaqdLut256_outOfRangeIndex_staysTransparent` | Boundary |
| `getVoxelValue_validCoord_returnsScaledValue` | Happy path |
| `getVoxelValue_outOfBounds_returnsZero` | Edge |
| `reorientDrawingToNative_identityPerm_returnsUnchanged` | Edge: no-op |

### 10. `src/cmap/NVCmaps.test.ts` — Colormap generation

| Test | Rationale |
|------|-----------|
| `makeLut_grayscale_producesLinearRamp` | Happy path |
| `makeLut_twoStops_interpolatesCorrectly` | Happy path |
| `makeLut_returns1024bytes` | Structural (256×4) |
| `makeLabelLut_setsBackgroundTransparent` | Happy path |
| `makeLabelLut_mismatchedArrayLengths_throws` | Error path |

### 11. `src/NVConstants.test.ts` — Constants & predicates

| Test | Rationale |
|------|-----------|
| `isPaqd_labelAndRGBA32_returnsTrue` | Happy path |
| `isPaqd_wrongIntent_returnsFalse` | Happy path |
| `sliceTypeDim_axial_returns2` | Happy path |
| `sliceTypeDim_coronal_returns1` | Happy path |
| `sliceTypeDim_sagittal_returns0` | Happy path |

### 12. `src/mesh/writers/stl.test.ts` — STL binary writer

| Test | Rationale |
|------|-----------|
| `write_singleTriangle_producesCorrectBinarySize` | Happy path: 84 + 50 |
| `write_vertexPositions_areReadableFromOutput` | Roundtrip |

### 13. `src/mesh/writers/obj.test.ts` — OBJ text writer

| Test | Rationale |
|------|-----------|
| `write_singleTriangle_producesValidOBJText` | Happy path |
| `write_indicesAre1Based` | OBJ format requirement |

### 14. `src/mesh/readers/off.test.ts` — OFF mesh reader

| Test | Rationale |
|------|-----------|
| `read_validOFF_parsesPositionsAndIndices` | Happy path |
| `read_missingHeader_stillParses` | Edge: tolerant parsing |

### 15. `src/mesh/readers/stl.test.ts` — STL mesh reader

| Test | Rationale |
|------|-----------|
| `read_binarySTL_parsesTriangles` | Happy path |
| `read_asciiSTL_parsesVertices` | Happy path |
| `read_tooSmallBuffer_throws` | Error path |

### 16. `src/view/sliceUtils.test.ts` — Canvas projection

| Test | Rationale |
|------|-----------|
| `projectMMToCanvas_identityMVP_projectsToCenter` | Happy path |

### 17. `src/volume/modulation.test.ts` — Volume modulation

| Test | Rationale |
|------|-----------|
| `computeModulationData_noModulationImage_setsNull` | Edge |
| `computeModulationData_validModulation_producesNormalizedValues` | Happy path |

## Summary

| Category | Modules | Test Cases |
|----------|---------|------------|
| Drawing tools | 3 | ~25 |
| Annotations | 4 | ~30 |
| Math/transforms | 1 | ~14 |
| Volume utilities | 2 | ~22 |
| Colormaps | 1 | ~5 |
| Constants | 1 | ~5 |
| Mesh I/O | 4 | ~9 |
| View utils | 1 | ~1 |
| **Total** | **17 files** | **~111 tests** |

## Priority Order

Implement in this order for maximum bang-per-buck:

1. **`rle.test.ts`** — Foundational codec used by drawing undo; pure, easy to test
2. **`volume/utils.test.ts`** — Most utility functions, widest coverage
3. **`penTool.test.ts`** — Core drawing logic, complex Bresenham & flood fill
4. **`NVTransforms.test.ts`** — Critical spatial math, subtle bugs possible
5. **`annotation/undoRedo.test.ts`** + **`pointInRing.test.ts`** + **`sliceProjection.test.ts`** — Small, self-contained
6. **`selection.test.ts`** — Shape editing logic
7. **`NVCmaps.test.ts`** + **`NVConstants.test.ts`** — Quick wins
8. **Mesh readers/writers** — Roundtrip tests (write→read→compare)
9. **`modulation.test.ts`** + **`sliceUtils.test.ts`** — Remaining coverage

## What's Explicitly Excluded

- **`gl/`**, **`wgpu/`** — All GPU shader/rendering code
- **`NVControl*.ts`**, **`NVLoader.ts`** — Browser DOM / canvas / fetch dependencies
- **`control/`** — Mouse/keyboard interaction handlers tied to DOM events
- **`view/NVRenderer.ts`**, **`view/NVFont.ts`** etc. — Rendering pipeline
- **`workers/`** — Web Worker code (needs browser Worker API)
- **`codecs/NVGz.ts`**, **`codecs/NVZip.ts`** — Rely on DecompressionStream (browser API), though these could be tested with polyfills later
