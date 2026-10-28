## 1.0.0-rc.25 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.45
- Updated uikit to 1.0.0-rc.34

## 1.0.0-rc.24 (2026-10-28)

### Fixes

- **niivue:** give each volume its own texture cache entry ([#346](https://github.com/niivue/mono/issues/346))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.44
- Updated uikit to 1.0.0-rc.33

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.23 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.43
- Updated uikit to 1.0.0-rc.32

## 1.0.0-rc.22 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.42
- Updated uikit to 1.0.0-rc.31

## 1.0.0-rc.21 (2026-10-28)

### Fixes

- **uikit:** let the browser file picker offer .nii.gz files on macOS ([#341](https://github.com/niivue/mono/issues/341))

### Updated Dependencies

- Updated uikit to 1.0.0-rc.30

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.20 (2026-10-28)

### Fixes

- **nv-mcp:** refuse set_mesh before changing anything ([34a7fd21](https://github.com/niivue/mono/commit/34a7fd21))
- **nv-mcp:** translate set_mesh colorBy direction and refuse unknown modes ([#339](https://github.com/niivue/mono/issues/339))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.19 (2026-10-28)

### Fixes

- **nv-mcp:** say why describe_volume has no statistics ([#338](https://github.com/niivue/mono/issues/338))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.18 (2026-10-27)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.41
- Updated uikit to 1.0.0-rc.29

## 1.0.0-rc.17 (2026-10-27)

### Features

- **nv-mcp:** draw label tables through the unified colormap API ([48ebfe88](https://github.com/niivue/mono/commit/48ebfe88))

### Fixes

- **nv-mcp:** register an overlay's label table only once its file loads ([#257](https://github.com/niivue/mono/issues/257))
- **nv-mcp:** register a fetched label table only once add_overlay is accepted ([8958fe00](https://github.com/niivue/mono/commit/8958fe00))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.40
- Updated uikit to 1.0.0-rc.28

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.16 (2026-10-26)

### Fixes

- **nv-mcp:** refuse options a read-back cannot tell apart ([9b890cdc](https://github.com/niivue/mono/commit/9b890cdc))
- **nv-mcp:** follow-ups from the #357, #359 and #361 reviews ([#357](https://github.com/niivue/mono/issues/357), [#359](https://github.com/niivue/mono/issues/359), [#361](https://github.com/niivue/mono/issues/361))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.39
- Updated uikit to 1.0.0-rc.27

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.15 (2026-10-26)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.38
- Updated uikit to 1.0.0-rc.26

## 1.0.0-rc.14 (2026-10-23)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.37
- Updated uikit to 1.0.0-rc.25

## 1.0.0-rc.13 (2026-10-23)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.36
- Updated uikit to 1.0.0-rc.24

## 1.0.0-rc.12 (2026-10-23)

### Features

- **nv-mcp:** bind controls to mesh layers and mesh colour ([63c6b07e](https://github.com/niivue/mono/commit/63c6b07e))

### Fixes

- **nv-mcp:** say a mesh could not be read instead of a kind error ([c2d308fd](https://github.com/niivue/mono/commit/c2d308fd))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.11 (2026-10-23)

### Features

- **niivue:** fuse volumes[0] with the overlays as a channel stack ([#365](https://github.com/niivue/mono/issues/365))
- **niivue:** add OVERLAY_COLOR_BLEND.MAX channel fusion ([#363](https://github.com/niivue/mono/issues/363))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.35
- Updated uikit to 1.0.0-rc.23

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.10 (2026-10-23)

### Features

- **nv-mcp:** let a select control write numeric values to its binding ([8233f630](https://github.com/niivue/mono/commit/8233f630))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.9 (2026-10-23)

### Fixes

- **nv-mcp:** announce where an animate move of the crosshair or cut ends ([fcd51c7f](https://github.com/niivue/mono/commit/fcd51c7f))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.8 (2026-10-23)

### Features

- **niivue:** add ordered source-over colour blend for overlays ([#90](https://github.com/niivue/mono/issues/90))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.34
- Updated uikit to 1.0.0-rc.22

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.7 (2026-10-21)

### Features

- ⚠️  **niivue:** remove vestigial isPositionInMM ([36546908](https://github.com/niivue/mono/commit/36546908))

### Breaking Changes

- **niivue:** remove vestigial isPositionInMM  ([36546908](https://github.com/niivue/mono/commit/36546908))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.33
- Updated uikit to 1.0.0-rc.21

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.6 (2026-10-21)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.32
- Updated uikit to 1.0.0-rc.20

## 1.0.0-rc.5 (2026-10-21)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.31
- Updated uikit to 1.0.0-rc.19

## 1.0.0-rc.4 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.30
- Updated uikit to 1.0.0-rc.18

## 1.0.0-rc.3 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.29
- Updated uikit to 1.0.0-rc.17

## 1.0.0-rc.2 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.28
- Updated uikit to 1.0.0-rc.16

## 1.0.0-rc.1 (2026-10-20)

### Features

- **nv-mcp:** draw a vector field as direction colours with set_volume v1 ([8f8f643b](https://github.com/niivue/mono/commit/8f8f643b))
- **nv-mcp:** outline boxes on the render with set_boxes ([70fbe7a9](https://github.com/niivue/mono/commit/70fbe7a9))
- **nv-mcp:** set the style annotations drawn by hand take ([46cb02a9](https://github.com/niivue/mono/commit/46cb02a9))
- **nv-mcp:** add set_instances so an agent can build a global3d scene ([#342](https://github.com/niivue/mono/issues/342))
- **nv-mcp:** count labels of a mask volume in describe_volume ([#326](https://github.com/niivue/mono/issues/326))
- **nv-mcp:** animate the scene to a target state through the tools ([93cf3775](https://github.com/niivue/mono/commit/93cf3775))
- **nv-mcp:** write voxel values and vertex positions through the tools ([cb04cd12](https://github.com/niivue/mono/commit/cb04cd12))
- **nv-mcp:** let an agent add, list, change and remove page controls ([2e386df3](https://github.com/niivue/mono/commit/2e386df3))
- **nv-mcp:** label bricks of an exploded volume from an agent ([80f3ada9](https://github.com/niivue/mono/commit/80f3ada9))
- **nv-mcp:** add a data palette an agent loads from by id ([a544f6bf](https://github.com/niivue/mono/commit/a544f6bf))
- **nv-mcp:** bind controls to mesh, tract and connectome options ([60806d48](https://github.com/niivue/mono/commit/60806d48))
- **nv-mcp:** draw agent controls on the canvas with UIKit ([a922912b](https://github.com/niivue/mono/commit/a922912b))
- **nv-mcp:** bind controls to settings, the view, volumes, dialogs and actions ([039ac48e](https://github.com/niivue/mono/commit/039ac48e))
- **demo-mcp:** add a demo app for nv-mcp and a guide to connecting agents ([e05ce384](https://github.com/niivue/mono/commit/e05ce384))
- **nv-mcp:** add viewport, slide, chunk and document tools ([666873ab](https://github.com/niivue/mono/commit/666873ab))
- **nv-mcp:** add signal and graph tools ([35006afa](https://github.com/niivue/mono/commit/35006afa))
- **nv-mcp:** add drawing, annotation and measurement tools ([ce119946](https://github.com/niivue/mono/commit/ce119946))
- **nv-mcp:** add mesh tools ([6e72d718](https://github.com/niivue/mono/commit/6e72d718))
- **nv-mcp:** add add_colormap, set_font and set_custom_layout ([4e7b2aa0](https://github.com/niivue/mono/commit/4e7b2aa0))
- **nv-mcp:** add get_options, set_options and capabilities ([1002a0cc](https://github.com/niivue/mono/commit/1002a0cc))
- **nv-mcp:** add the settings table ([d42368d6](https://github.com/niivue/mono/commit/d42368d6))
- **nv-mcp:** add tools to step, transform, remove, reorder and describe volumes ([ed4ece46](https://github.com/niivue/mono/commit/ed4ece46))
- **nv-mcp:** add overlays and change how a volume is drawn ([ddbb9450](https://github.com/niivue/mono/commit/ddbb9450))
- **nv-mcp:** find and go to atlas regions ([fffae82b](https://github.com/niivue/mono/commit/fffae82b))
- **nv-mcp:** move the crosshair to a point and cut the clip plane ([28382068](https://github.com/niivue/mono/commit/28382068))
- **nv-mcp:** drive the camera and the view, and take a screenshot ([d11caa41](https://github.com/niivue/mono/commit/d11caa41))
- **nv-mcp:** load a volume and read the scene ([d760f77d](https://github.com/niivue/mono/commit/d760f77d))
- **nv-mcp:** name planes and view layouts ([fd76049c](https://github.com/niivue/mono/commit/fd76049c))
- **nv-mcp:** add the browser client and view adapter ([e781be7f](https://github.com/niivue/mono/commit/e781be7f))
- **nv-mcp:** add the MCP server, HTTP end and tab tools ([0e1fd59d](https://github.com/niivue/mono/commit/0e1fd59d))
- **nv-mcp:** add the package, wire protocol and tab bridge ([7d9ca08b](https://github.com/niivue/mono/commit/7d9ca08b))

### Fixes

- **nv-mcp:** keep a volume control bound to its volume, not its index ([92a4494c](https://github.com/niivue/mono/commit/92a4494c))
- **nv-mcp:** refuse instances NiiVue would draw from another volume ([e63f0ab8](https://github.com/niivue/mono/commit/e63f0ab8))
- **nv-mcp:** keep only the annotation style fields NiiVue reads ([45db52bc](https://github.com/niivue/mono/commit/45db52bc))
- **nv-mcp:** drop canvas tile angles NiiVue never draws, clear with no volume ([1bfcad8f](https://github.com/niivue/mono/commit/1bfcad8f))
- **nv-mcp:** check before writing in set_camera and set_volume v1 ([6c451749](https://github.com/niivue/mono/commit/6c451749))
- **nv-mcp:** keep a later spread when set_volume also untiles ([7cc780af](https://github.com/niivue/mono/commit/7cc780af))
- **nv-mcp:** keep the latest spread across controls and set_volume ([471e1b5c](https://github.com/niivue/mono/commit/471e1b5c))
- **nv-mcp:** keep the latest spread across controls bound to one volume ([da16daeb](https://github.com/niivue/mono/commit/da16daeb))
- **nv-mcp:** keep the latest spread when a slider moves during tiling ([c1400103](https://github.com/niivue/mono/commit/c1400103))
- **nv-mcp:** let a control bind how far a volume's bricks are spread ([67e59677](https://github.com/niivue/mono/commit/67e59677))
- **nv-mcp:** show what the target holds after an agent write, and time it out ([#273](https://github.com/niivue/mono/issues/273))
- **nv-mcp:** report a late NiiVue write failure in the control tool result ([#271](https://github.com/niivue/mono/issues/271))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.27
- Updated uikit to 1.0.0-rc.15

### Thank You

- Chris Drake
- Claude Opus 5.5
- Taylor Hanayik @hanayik