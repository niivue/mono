## 1.0.0-rc.272 (2026-11-22)

### Features

- **nv-ohif:** hydrated RTSTRUCT as editable contours; contour segments overlap ([39aed1e3](https://github.com/niivue/mono/commit/39aed1e3))
- **nv-ohif:** contour interpolation, mirror panes, StackScroll over outputs, livewire scissors ([be361b4c](https://github.com/niivue/mono/commit/be361b4c))
- **nv-ohif:** contour segmentation on NiiVue panes (OHIF contour panel, tools, ops, Sculptor) ([4c20570c](https://github.com/niivue/mono/commit/4c20570c))

### Fixes

- **nv-ohif:** Combine replaces any result segment; a hidden contour has no core stroke ([24575010](https://github.com/niivue/mono/commit/24575010))
- **nv-ohif): each pane hides contour segments by its own representation; docs(nv-mcp:** edit_annotations replace ([bb513cd1](https://github.com/niivue/mono/commit/bb513cd1))
- **nv-ohif:** restyle after every contour edit; re-show only on held panes; cap before RTSTRUCT fallback ([#875](https://github.com/niivue/mono/issues/875), [#877](https://github.com/niivue/mono/issues/877), [#878](https://github.com/niivue/mono/issues/878))
- **nv-ohif:** flag RTSTRUCT truncation only for a drawable ROI past the cap ([f8fc05be](https://github.com/niivue/mono/commit/f8fc05be))
- **nv-ohif:** a StackScroll drag ends on pointer release ([efe0e0aa](https://github.com/niivue/mono/commit/efe0e0aa))
- **nv-ohif:** an RTSTRUCT ROI wholly off the image is not a contour segment ([59105aa4](https://github.com/niivue/mono/commit/59105aa4))
- **nv-ohif:** combining contours into segment B replaces B's shapes ([5b481327](https://github.com/niivue/mono/commit/5b481327))
- **nv-ohif:** style a new mirror by its own pane, and honour inactive render flags on generated contours ([7b6ba1fb](https://github.com/niivue/mono/commit/7b6ba1fb))
- **nv-ohif:** install the annotation grab policy before the font loads ([c784574c](https://github.com/niivue/mono/commit/c784574c))
- **nv-ohif:** install the contour cut policy before the annotation font loads ([c9bed2e9](https://github.com/niivue/mono/commit/c9bed2e9))
- **nv-ohif:** drop a segment deleted while its contours were parked ([68a209e4](https://github.com/niivue/mono/commit/68a209e4))
- review follow-ups for #875-#877 ([#875](https://github.com/niivue/mono/issues/875), [#877](https://github.com/niivue/mono/issues/877))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.236
- Updated nv-ext-drawing to 1.0.0-rc.238
- Updated nv-ext-tile to 1.0.0-rc.145
- Updated uikit to 1.0.0-rc.235

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.271 (2026-11-21)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.235
- Updated nv-ext-drawing to 1.0.0-rc.237
- Updated nv-ext-tile to 1.0.0-rc.144
- Updated uikit to 1.0.0-rc.234

## 1.0.0-rc.270 (2026-11-20)

### Fixes

- #868/#869 review follow-ups ([#868](https://github.com/niivue/mono/issues/868), [#869](https://github.com/niivue/mono/issues/869))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.234
- Updated nv-ext-drawing to 1.0.0-rc.236
- Updated nv-ext-tile to 1.0.0-rc.143
- Updated uikit to 1.0.0-rc.233

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.269 (2026-11-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.233
- Updated nv-ext-drawing to 1.0.0-rc.235
- Updated nv-ext-tile to 1.0.0-rc.142
- Updated uikit to 1.0.0-rc.232

## 1.0.0-rc.268 (2026-11-20)

### Features

- **nv-ohif:** Imaging Data Commons volumes and SEGs from S3; bulk pixel fetch ([acb213be](https://github.com/niivue/mono/commit/acb213be))

### Fixes

- **nv-ohif:** require @niivue/dcm2niix 1.4.20261122-rc.1 (DICOM SEG labels) ([40b1b0ac](https://github.com/niivue/mono/commit/40b1b0ac))
- **nv-ohif:** review fixes for IDC S3 and bulk pixels ([659e46f8](https://github.com/niivue/mono/commit/659e46f8))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.232
- Updated nv-ext-drawing to 1.0.0-rc.234
- Updated nv-ext-tile to 1.0.0-rc.141
- Updated uikit to 1.0.0-rc.231

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.267 (2026-11-19)

### Fixes

- **nv-ohif:** TMTV SEG reload, slide Bidirectional/Arrow, data overlay Foreground, readout and PT reload regressions ([be806a00](https://github.com/niivue/mono/commit/be806a00))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.231
- Updated nv-ext-drawing to 1.0.0-rc.233
- Updated nv-ext-tile to 1.0.0-rc.140
- Updated uikit to 1.0.0-rc.230

### Thank You

- neurolabusc

## 1.0.0-rc.266 (2026-11-19)

### Features

- **nv-ohif:** segment statistics card shows voxel count and volume ([7ea12378](https://github.com/niivue/mono/commit/7ea12378))
- ⚠️  **nv-ohif:** one NiiVue viewer with segmentation editing and slides; editable measurements ([b05979da](https://github.com/niivue/mono/commit/b05979da))
- **nv-ohif:** name the segment at the crosshair above its value ([c130b2a1](https://github.com/niivue/mono/commit/c130b2a1))

### Breaking Changes

- **nv-ohif:** one NiiVue viewer with segmentation editing and slides; editable measurements  ([b05979da](https://github.com/niivue/mono/commit/b05979da))
  the @niivue/nv-ohif/modes/segmentation and
  @niivue/nv-ohif/modes/microscopy exports and the /niivue-segmentation and
  /niivue-microscopy routes are removed; use /niivue-viewer.

### Updated Dependencies

- Updated niivue to 1.0.0-rc.230
- Updated nv-ext-drawing to 1.0.0-rc.232
- Updated nv-ext-tile to 1.0.0-rc.139
- Updated uikit to 1.0.0-rc.229

### Thank You

- neurolabusc

## 1.0.0-rc.265 (2026-11-19)

### Fixes

- **nv-ohif:** PT label waits out a cancelled or failed SEG; hold races ([a175d9b0](https://github.com/niivue/mono/commit/a175d9b0))
- **nv-ohif:** PT label yields to a loading SEG; label lifetime P3s ([11f52458](https://github.com/niivue/mono/commit/11f52458))
- **nv-ohif:** a PT label leaves a SEG or RTSTRUCT drawing alone ([1e8ec44c](https://github.com/niivue/mono/commit/1e8ec44c))
- **nv-ohif:** a dropped PT label closes only a drawing it created ([#866](https://github.com/niivue/mono/issues/866))
- **nv-ohif:** removing a PT overlay releases its label and plane hold ([44e8d3a6](https://github.com/niivue/mono/commit/44e8d3a6))
- **nv-ohif:** count plane holds, release a PT label's on a series switch, no plane past a 4D plane's frames ([67459100](https://github.com/niivue/mono/commit/67459100))
- **nv-ohif:** a TMTV label takes a pane's drawing from a 60xx plane ([dfb56120](https://github.com/niivue/mono/commit/dfb56120))
- **nv-ohif:** a 4D overlay plane follows the pane's frame ([a96a1578](https://github.com/niivue/mono/commit/a96a1578))
- **nv-ohif:** a mode exit drops petQuant masks and tool state ([9c442a98](https://github.com/niivue/mono/commit/9c442a98))
- **nv-ohif:** overlay planes give the drawing to a hung SEG or RTSTRUCT ([f956d4e3](https://github.com/niivue/mono/commit/f956d4e3))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.264 (2026-11-19)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.229
- Updated nv-ext-drawing to 1.0.0-rc.231
- Updated nv-ext-tile to 1.0.0-rc.138
- Updated uikit to 1.0.0-rc.228

## 1.0.0-rc.263 (2026-11-18)

### Features

- **nv-ohif:** a series opens in its acquired plane, from the DICOM frames ([e4254ef2](https://github.com/niivue/mono/commit/e4254ef2))

### Fixes

- **nv-ohif:** a direct NIfTI display set opens its acquired plane too ([1c4bd7c7](https://github.com/niivue/mono/commit/1c4bd7c7))
- **nv-ohif:** resolve 'acquisition' on a protocol change too ([60e8c370](https://github.com/niivue/mono/commit/60e8c370))
- **nv-ohif:** open the acquired plane under orientation 'acquisition' ([0f62e7b8](https://github.com/niivue/mono/commit/0f62e7b8))
- **nv-ohif:** volume viewports enter an output at its near end; bidirectional grid floor; malformed overlay data ([f440f379](https://github.com/niivue/mono/commit/f440f379))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.262 (2026-11-18)

### Fixes

- **nv-ohif:** bidirectional refines a zero minor too ([d995dcc2](https://github.com/niivue/mono/commit/d995dcc2))
- **nv-ohif:** bidirectional grid on a sheared affine ([2211f57f](https://github.com/niivue/mono/commit/2211f57f))
- **nv-ohif:** bidirectional grid covers each voxel's whole cell ([2d7b054c](https://github.com/niivue/mono/commit/2d7b054c))
- **nv-ohif:** bidirectional grid follows the voxel columns; superseded plane load keeps the pen ([1df7071b](https://github.com/niivue/mono/commit/1df7071b))
- **nv-ohif:** an oriented top output stays the pick; off-plane wheel steps outputs ([78d2ccf6](https://github.com/niivue/mono/commit/78d2ccf6))
- **nv-ohif:** an overlay plane leaves the pen off ([0c96b432](https://github.com/niivue/mono/commit/0c96b432))
- **nv-ohif:** Segment Bidirectional samples the segment on world planes ([#863](https://github.com/niivue/mono/issues/863))
- **nv-ohif:** the wheel on an unmapped slice moves a slice, not outputs ([4f222c25](https://github.com/niivue/mono/commit/4f222c25))
- **nv-ohif:** split-series outputs order by first instance; cine waits for a switch ([d2bb6a5e](https://github.com/niivue/mono/commit/d2bb6a5e))
- **nv-ohif:** bidirectional minor bins in-plane; wheel switches outputs in a volume viewport ([85bbce02](https://github.com/niivue/mono/commit/85bbce02))
- **nv-ohif:** Segment Bidirectional slabs follow the volume origin ([bf1651c3](https://github.com/niivue/mono/commit/bf1651c3))
- **nv-ohif:** Segment Bidirectional searches in-plane edges only ([3d6c41ec](https://github.com/niivue/mono/commit/3d6c41ec))
- **nv-ohif:** the wheel enters a multi-slice output on its adjacent image; an overlay load cannot overwrite a new segmentation ([b9e2ee22](https://github.com/niivue/mono/commit/b9e2ee22))
- **nv-ohif:** a mixed series opens on its oriented output, stacks multi-frame outputs and shows inline overlay planes ([a3afb374](https://github.com/niivue/mono/commit/a3afb374))
- **nv-ohif:** Segment Bidirectional measures in world-plane slabs (oblique grids keep endpoints on the segment) ([f9620af8](https://github.com/niivue/mono/commit/f9620af8))
- **nv-ohif:** Segment Bidirectional on a tilted grid projects onto the nearest world plane ([1663694d](https://github.com/niivue/mono/commit/1663694d))
- **nv-ohif:** Segment Label reads SegmentLabelTool; slide measurement tools enabled on slides; a non-reconstructable series opens in its acquired plane ([4d852f9b](https://github.com/niivue/mono/commit/4d852f9b))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.261 (2026-11-18)

### Fixes

- **nv-ohif:** a 53-bit digest keys 4D frame groups ([e9004685](https://github.com/niivue/mono/commit/e9004685))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.228
- Updated nv-ext-drawing to 1.0.0-rc.230
- Updated nv-ext-tile to 1.0.0-rc.137
- Updated uikit to 1.0.0-rc.227

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.260 (2026-11-18)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.227
- Updated nv-ext-drawing to 1.0.0-rc.229
- Updated nv-ext-tile to 1.0.0-rc.136
- Updated uikit to 1.0.0-rc.226

## 1.0.0-rc.259 (2026-11-18)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.226
- Updated nv-ext-drawing to 1.0.0-rc.228
- Updated nv-ext-tile to 1.0.0-rc.135
- Updated uikit to 1.0.0-rc.225

## 1.0.0-rc.258 (2026-11-18)

### Fixes

- **nv-ohif:** build the slide SR before storing OHIF's rows; digest the 4D group key ([74a94d28](https://github.com/niivue/mono/commit/74a94d28))
- **nv-ohif:** key a 4D frame group on the display set's instances ([23945f2b](https://github.com/niivue/mono/commit/23945f2b))
- **nv-ohif:** outline-only comes from the style, not a 1/255 fill ([9454f7d8](https://github.com/niivue/mono/commit/9454f7d8))
- **nv-ohif:** a slide SR save fails on a row without slide geometry ([1741119f](https://github.com/niivue/mono/commit/1741119f))
- **nv-ohif:** drop an overlay plane superseded while it loads ([4f1a26e6](https://github.com/niivue/mono/commit/4f1a26e6))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.225
- Updated nv-ext-drawing to 1.0.0-rc.227
- Updated nv-ext-tile to 1.0.0-rc.134
- Updated uikit to 1.0.0-rc.224

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.257 (2026-11-18)

### Fixes

- **nv-ohif:** hold 4D frame groups weakly instead of pruning them ([8d01d56f](https://github.com/niivue/mono/commit/8d01d56f))
- **nv-ohif:** key 4D frame groups on dimensions, not voxel count ([1044419e](https://github.com/niivue/mono/commit/1044419e))
- **nv-ohif:** key 4D frame groups on voxel count as well ([c0a347f1](https://github.com/niivue/mono/commit/c0a347f1))
- **nv-ohif:** key 4D frame groups on frame count; prune after a load swap ([822e4632](https://github.com/niivue/mono/commit/822e4632))
- **nv-ohif:** removing a 4D volume drops its unshown frame group ([05235f6d](https://github.com/niivue/mono/commit/05235f6d))
- **nv-ohif:** a 4D series no pane shows drops its frame group ([3131e3cc](https://github.com/niivue/mono/commit/3131e3cc))
- **nv-ohif:** a shorter 4D reload skips a remembered frame it lacks ([d54905ac](https://github.com/niivue/mono/commit/d54905ac))
- **nv-ohif:** dropping a protocol overlay VOI restores the volume's own window ([eb8cbde9](https://github.com/niivue/mono/commit/eb8cbde9))
- **nv-ohif:** trailing empty RT ROIs do not mark the drawing truncated ([abe9cc1a](https://github.com/niivue/mono/commit/abe9cc1a))
- **nv-ohif:** a superseded output switch fails without a note ([bd3deec7](https://github.com/niivue/mono/commit/bd3deec7))
- **nv-ohif:** a reopened SEG panel reuses its freed colour LUT index ([c8c40ef7](https://github.com/niivue/mono/commit/c8c40ef7))
- **nv-ohif:** a new SR mirror re-adds existing NiiVue rows ([c88e7b26](https://github.com/niivue/mono/commit/c88e7b26))
- **nv-ohif:** keep faint segments' outlines and hide a zero outline ([19fcadbb](https://github.com/niivue/mono/commit/19fcadbb))
- **nv-ohif:** note a failed localizer output switch instead of rejecting ([8bd9e036](https://github.com/niivue/mono/commit/8bd9e036))
- **nv-ohif:** drop the previous measurement mirror when the commands module rebuilds ([a1037274](https://github.com/niivue/mono/commit/a1037274))
- **nv-ohif:** remove a segmentation panel's colour LUT on close ([a47d716a](https://github.com/niivue/mono/commit/a47d716a))
- **nv-ohif:** note RT ROIs past 255 and a base without an orientation ([64c6763f](https://github.com/niivue/mono/commit/64c6763f))
- **nv-ohif:** key 4D frame groups on the display set ([4b10bed6](https://github.com/niivue/mono/commit/4b10bed6))
- **nv-ohif:** quote carriage returns in segmentation CSV cells ([67313b7a](https://github.com/niivue/mono/commit/67313b7a))
- **nv-ohif:** skip the dynamic mode's workflow steps on a missing study ([cda96a82](https://github.com/niivue/mono/commit/cda96a82))
- **nv-ohif:** clamp the 4D compute range to the shown series ([5c70fbb1](https://github.com/niivue/mono/commit/5c70fbb1))
- **nv-ohif:** reset pane background and overlay defaults the protocol drops ([20c8b927](https://github.com/niivue/mono/commit/20c8b927))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.224
- Updated nv-ext-drawing to 1.0.0-rc.226
- Updated nv-ext-tile to 1.0.0-rc.133
- Updated uikit to 1.0.0-rc.223

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.256 (2026-11-18)

### Features

- **nv-ohif:** OHIF parity closeout ([bb19b4a9](https://github.com/niivue/mono/commit/bb19b4a9))

### Thank You

- neurolabusc

## 1.0.0-rc.255 (2026-11-18)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.223
- Updated nv-ext-drawing to 1.0.0-rc.225
- Updated nv-ext-tile to 1.0.0-rc.132
- Updated uikit to 1.0.0-rc.222

## 1.0.0-rc.254 (2026-11-17)

### Features

- **nv-ohif:** pinch with a finger on the lens zooms the lens ([31fcc9e0](https://github.com/niivue/mono/commit/31fcc9e0))
- **nv-ohif:** ship the NiiVue OHIF modes (viewer, segmentation, microscopy, tmtv, dynamic) ([09ab1027](https://github.com/niivue/mono/commit/09ab1027))
- **nv-ohif:** SEG editing and export (M8); TMTV quantification and 4D kinetics (M9/M10) ([c980d364](https://github.com/niivue/mono/commit/c980d364))
- **nv-ohif:** reformat position lower right on coronal/sagittal panes ([2079cca0](https://github.com/niivue/mono/commit/2079cca0))
- **nv-ohif:** volume-rendering preset menu on CT 3D panes ([10dc6dfb](https://github.com/niivue/mono/commit/10dc6dfb))
- **nv-ohif:** NiiVue measurement rows in OHIF's CSV export ([5db85206](https://github.com/niivue/mono/commit/5db85206))
- **nv-ohif:** up/down/home/end and Capture on NiiVue panes ([5ba38419](https://github.com/niivue/mono/commit/5ba38419))
- **nv-ohif:** cameraPosition sync groups share 2D pan/zoom (4D per-orientation camera sync) ([9c317682](https://github.com/niivue/mono/commit/9c317682))
- **nv-ohif): 4D series on NiiVue panes (M7:** shared frame source, cine, 4D panel ([9274c9b4](https://github.com/niivue/mono/commit/9274c9b4))
- **nv-ohif:** SEG/RTSTRUCT hydrate prompt and LOAD badge on NiiVue panes ([fe6061b7](https://github.com/niivue/mono/commit/fe6061b7))

### Fixes

- **nv-ohif:** order each volume's computed uploads so an older one cannot land last ([e4bce2d6](https://github.com/niivue/mono/commit/e4bce2d6))
- **nv-ohif:** type the MIP volume header's scl_slope ([ad5901ea](https://github.com/niivue/mono/commit/ad5901ea))
- **nv-ohif:** a stale compute yields to a newer one; SEG export reads enhanced frames ([6ea2f1a7](https://github.com/niivue/mono/commit/6ea2f1a7))
- **nv-ohif:** unmounting the last 4D pane hides the panel's frame controls ([7fc1b0ec](https://github.com/niivue/mono/commit/7fc1b0ec))
- **nv-ohif:** settle a base colormap changed mid-load; MIP jump honours a negative slope ([9dbd8ffc](https://github.com/niivue/mono/commit/9dbd8ffc))
- **nv-ohif:** remove the magnifier lens before the viewer is destroyed ([6ca07231](https://github.com/niivue/mono/commit/6ca07231))
- **nv-ohif:** threshold strokes read the shown 4D frame; brush size uses in-plane spacing ([501afef7](https://github.com/niivue/mono/commit/501afef7))
- **nv-ohif:** the Dynamic panel follows the active pane's 4D series ([7d759bce](https://github.com/niivue/mono/commit/7d759bce))
- **nv-ohif:** restyling a hung overlay off a ramp resets its colormap type ([fabf0974](https://github.com/niivue/mono/commit/fabf0974))
- **nv-ohif:** an unchanged tool keeps the magnifier lens ([e7f13feb](https://github.com/niivue/mono/commit/e7f13feb))
- **nv-ohif:** a compute shown while 4D frames restore stays shown ([be103966](https://github.com/niivue/mono/commit/be103966))
- **nv-ohif:** a sync group links panes only by its own type ([35c1ab99](https://github.com/niivue/mono/commit/35c1ab99))
- **nv-ohif:** hung PT overlays load, also on a base without a series UID ([ecd80add](https://github.com/niivue/mono/commit/ecd80add))
- **nv-ohif:** a cancelled touch does not place the AdvancedMagnify glass ([bbcf8439](https://github.com/niivue/mono/commit/bbcf8439))
- **nv-ohif:** TMTV CSV total TLG in mL x SUV; SEG volume from the affine ([186480b7](https://github.com/niivue/mono/commit/186480b7))
- **nv-ohif:** land a split-series frame jump after its output switch ([9f7559d4](https://github.com/niivue/mono/commit/9f7559d4))
- **nv-ohif:** forget a removed SEG's order whichever series is shown ([44424e6c](https://github.com/niivue/mono/commit/44424e6c))
- **nv-ohif:** restyle the pane when its background or MIP inversion changes ([46431076](https://github.com/niivue/mono/commit/46431076))
- **nv-ohif:** raise keeps a press in progress; glass follows a held touch to its lift ([a96d786c](https://github.com/niivue/mono/commit/a96d786c))
- **nv-ohif:** keep the lens still through a pinch ([11c98a6a](https://github.com/niivue/mono/commit/11c98a6a))
- **nv-ohif:** keep AdvancedMagnify hidden during a pinch ([5ae34b32](https://github.com/niivue/mono/commit/5ae34b32))
- **nv-ohif:** stop an iOS long-press selecting the pane's canvas ([5c5eb295](https://github.com/niivue/mono/commit/5c5eb295))
- **nv-ohif:** keep the AdvancedMagnify glass after a touch lifts ([9e573f9c](https://github.com/niivue/mono/commit/9e573f9c))
- **nv-ohif:** Magnify hands a pinch to core, keeps double-clicks, stays above annotations ([39538111](https://github.com/niivue/mono/commit/39538111))
- **nv-ohif:** TMTV voxel volume from the affine determinant; quote CSV fields ([35fef95f](https://github.com/niivue/mono/commit/35fef95f))
- **nv-ohif:** Next/Previous in a split series counts frames, not instances ([db2b0533](https://github.com/niivue/mono/commit/db2b0533))
- **nv-ohif:** a SEG re-added to the active sets is the newest hydrated ([3f0b9dde](https://github.com/niivue/mono/commit/3f0b9dde))
- **nv-ohif:** a re-held finished conversion is not evicted while in use ([70329932](https://github.com/niivue/mono/commit/70329932))
- **nv-ohif:** a hung overlay leaves through niivueRemoveOverlay, refreshing the toolbar ([8507b136](https://github.com/niivue/mono/commit/8507b136))
- **nv-ohif:** an overlay dropped from the hanging protocol after it loaded is removed ([96485eec](https://github.com/niivue/mono/commit/96485eec))
- **nv-ohif:** hung MIP and overlays follow hanging-option changes ([4fea8ba4](https://github.com/niivue/mono/commit/4fea8ba4))
- **nv-ohif:** a new hang reads as not loaded before its load effect runs ([6b83701c](https://github.com/niivue/mono/commit/6b83701c))
- **nv-ohif:** keep PET labels outside a CT pane's FOV; per-pane threshold brush ([acbb348d](https://github.com/niivue/mono/commit/acbb348d))
- **nv-ohif:** removing the last 4D volume notifies the frame panel ([0480bf9a](https://github.com/niivue/mono/commit/0480bf9a))
- **nv-ohif:** a released row is adopted once, not again by its own broadcast ([aae5887e](https://github.com/niivue/mono/commit/aae5887e))
- **nv-ohif:** leaving the 4D mode drops its pending cine start ([89943e13](https://github.com/niivue/mono/commit/89943e13))
- **nv-ohif:** the magnifier binding drives its lens without attach() ([4fc1b486](https://github.com/niivue/mono/commit/4fc1b486))
- **nv-ohif:** an RT pane saved as SEG keeps nested and hidden ROIs ([6da2a170](https://github.com/niivue/mono/commit/6da2a170))
- **nv-ohif:** a newer SEG, reload or unmount retires the hydrate prompt ([ad7e241a](https://github.com/niivue/mono/commit/ad7e241a))
- **nv-ohif:** a frame NiiVue changes itself becomes the series frame ([1e478c4b](https://github.com/niivue/mono/commit/1e478c4b))
- **nv-ohif:** a superseded hung-overlay run adds no more overlays ([c33856dd](https://github.com/niivue/mono/commit/c33856dd))
- **nv-ohif:** a hydrateseg sync group links no crosshair ([5f565763](https://github.com/niivue/mono/commit/5f565763))
- **nv-ohif:** a released row is not deferred to the pane releasing it ([76965560](https://github.com/niivue/mono/commit/76965560))
- **nv-ohif:** M11 audit — editable segmentation panel, TMTV tool groups, mode d.ts ([75588b1b](https://github.com/niivue/mono/commit/75588b1b))
- **nv-ohif:** recount the stack position once a split series registers ([84505510](https://github.com/niivue/mono/commit/84505510))
- **nv-ohif:** a split series' overlay counts its whole display set ([5bcd6c08](https://github.com/niivue/mono/commit/5bcd6c08))
- **nv-ohif:** stack-scroll jump returns nothing (biome noVoidTypeReturn) ([ce0946bd](https://github.com/niivue/mono/commit/ce0946bd))
- **nv-ohif:** Capture saves a slide pane through its slide view; no row import into a pane mid-swap ([0eb55064](https://github.com/niivue/mono/commit/0eb55064))
- **nv-ohif:** release the pane's WebGL context on unmount ([958b1566](https://github.com/niivue/mono/commit/958b1566))
- **nv-ohif:** keep measurement rows across unmount and series swap; re-import them in the new pane ([a6674e34](https://github.com/niivue/mono/commit/a6674e34))
- **nv-ohif:** a removed SEG/RT forgets its hydration order, so reloading it makes it newest ([c9d00028](https://github.com/niivue/mono/commit/c9d00028))
- **nv-ohif:** pane shows the latest hydrated SEG/RT on its series, not the first ([e3fb7129](https://github.com/niivue/mono/commit/e3fb7129))
- **nv-ohif:** 4D cine clock runs only while a pane shows a 4D series ([7ffa7636](https://github.com/niivue/mono/commit/7ffa7636))
- **nv-ohif:** 4D panel plays/pauses every pane of the series; 2hot starts black ([385f1a1d](https://github.com/niivue/mono/commit/385f1a1d))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.222
- Updated nv-ext-drawing to 1.0.0-rc.224
- Updated nv-ext-tile to 1.0.0-rc.131
- Updated uikit to 1.0.0-rc.221

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.253 (2026-11-17)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.221
- Updated nv-ext-tile to 1.0.0-rc.130
- Updated uikit to 1.0.0-rc.220

## 1.0.0-rc.252 (2026-11-17)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.219

## 1.0.0-rc.251 (2026-11-17)

### Features

- **nv-ohif:** OHIF undo history, arrow text, measurement menu, contour closing, localizer stacking ([aad3547e](https://github.com/niivue/mono/commit/aad3547e))
- **nv-ohif:** undo/redo/delete, DICOM SR export and import, Angle/CobbAngle rows ([29ce6e5b](https://github.com/niivue/mono/commit/29ce6e5b))
- **nv-ohif:** right-drag on a slide zooms to the boxed region, as NiiVue's slide viewer ([a26e1fd4](https://github.com/niivue/mono/commit/a26e1fd4))
- **nv-ohif:** OHIF Probe on NiiVue panes; crosshair value; PET in SUVbw ([13be4d5b](https://github.com/niivue/mono/commit/13be4d5b))
- **nv-ohif:** orientation menu (3D, 3D Cinematic), measurement DOM, cornerstone ROI rows, slide W/L ([8d64915e](https://github.com/niivue/mono/commit/8d64915e))

### Fixes

- **nv-ohif:** slice a contour across the axis its plane faces ([1512ec63](https://github.com/niivue/mono/commit/1512ec63))
- **nv-ohif:** ring containment by split edges, not vertices ([dc701ca9](https://github.com/niivue/mono/commit/dc701ca9))
- **nv-ohif:** a ring crossing its encloser is not a hole ([4bae47c4](https://github.com/niivue/mono/commit/4bae47c4))
- **nv-ohif:** union overlapping CLOSED_PLANAR contours; holes by nesting ([1fe19b53](https://github.com/niivue/mono/commit/1fe19b53))
- **nv-ohif:** cap RT labels at 255 after dropping empty ROIs ([d1994178](https://github.com/niivue/mono/commit/d1994178))
- **nv-ohif:** restore claims only restyled fields; empty RT keeps the drawing ([35ab88e4](https://github.com/niivue/mono/commit/35ab88e4))
- **nv-ohif:** count the seg panel's restyle as the drawing's own style ([3e1aaa5d](https://github.com/niivue/mono/commit/3e1aaa5d))
- **nv-ohif:** restore the prior drawing style when an RT drawing is replaced ([05ff3380](https://github.com/niivue/mono/commit/05ff3380))
- **nv-ohif:** group a flat hole with its tilted outer ring; keep a drawing made during RT load ([0886c7b9](https://github.com/niivue/mono/commit/0886c7b9))
- **nv-ohif:** a one-slice hole on a tilted plane cuts its outer ring ([6b6155dd](https://github.com/niivue/mono/commit/6b6155dd))
- **nv-ohif:** group tilted RT contours by plane, keep off-volume midpoints ([45ec3a89](https://github.com/niivue/mono/commit/45ec3a89))
- **nv-ohif:** a tilted RT contour fills the slices its plane crosses ([#839](https://github.com/niivue/mono/issues/839))
- **nv-ohif:** a probe row's index uses the row's own frame where outputs overlap ([05d1bd1b](https://github.com/niivue/mono/commit/05d1bd1b))
- **nv-ohif:** R15 round 19 — the latest localizer jump wins; rename keeps the row's own image where outputs overlap ([8e92923b](https://github.com/niivue/mono/commit/8e92923b))
- **nv-ohif:** draw RTSTRUCT CLOSEDPLANAR_XOR contours ([#839](https://github.com/niivue/mono/issues/839))
- **nv-ohif:** RT cleanup closes only the drawing it installed ([#839](https://github.com/niivue/mono/issues/839))
- **nv-ohif:** SUV-scale every PET stack output; holes are not inside ([#835](https://github.com/niivue/mono/issues/835))
- **nv-ohif:** a series swap or unmount releases imported SR rows ([#828](https://github.com/niivue/mono/issues/828))
- **nv-ohif:** SUV decays to the earliest acquisition and needs ATTN+DECY ([#825](https://github.com/niivue/mono/issues/825))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.250 (2026-11-17)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.220
- Updated nv-ext-tile to 1.0.0-rc.129
- Updated uikit to 1.0.0-rc.218

## 1.0.0-rc.249 (2026-11-17)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.219
- Updated nv-ext-tile to 1.0.0-rc.128
- Updated uikit to 1.0.0-rc.217

## 1.0.0-rc.248 (2026-11-17)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.218
- Updated nv-ext-tile to 1.0.0-rc.127
- Updated uikit to 1.0.0-rc.216

## 1.0.0-rc.247 (2026-11-17)

### Features

- **niivue:** public drawingGeneration and cancelDrawingLoad() ([6cbe6fbc](https://github.com/niivue/mono/commit/6cbe6fbc))

### Fixes

- **nv-ohif:** clear a SEG conversion note after 6 s, as the base's ([d3eafc44](https://github.com/niivue/mono/commit/d3eafc44))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.217
- Updated nv-ext-tile to 1.0.0-rc.126
- Updated uikit to 1.0.0-rc.215

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.246 (2026-11-17)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.216
- Updated nv-ext-tile to 1.0.0-rc.125
- Updated uikit to 1.0.0-rc.214

## 1.0.0-rc.245 (2026-11-16)

### Features

- **nv-ohif:** SEG colormap labels carry the segment's laterality ([d458daf6](https://github.com/niivue/mono/commit/d458daf6))
- **nv-ohif:** a DICOM SEG shows as a NiiVue drawing over its referenced series ([f73974ae](https://github.com/niivue/mono/commit/f73974ae))

### Fixes

- **nv-ohif:** show a SEG conversion's dcm2niix note ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** give back the drawing style a SEG replaced ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** track SEG drawing ownership by core's drawing generation ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** a drawing loaded during SEG conversion supersedes the SEG ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** reload the SEG when a protocol change reloads the base ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** stopping a pending SEG keeps a drawing loaded since it began ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** stopping a SEG keeps a drawing that replaced it ([#820](https://github.com/niivue/mono/issues/820))
- **nv-ohif:** a SEG drawing waits for its installed base; a secondary SEG keeps the primary ([#820](https://github.com/niivue/mono/issues/820), [#819](https://github.com/niivue/mono/issues/819))
- **nv-ohif:** a SEG drawing superseded mid-load is closed, never installed late ([45f1d101](https://github.com/niivue/mono/commit/45f1d101))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.244 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.215
- Updated nv-ext-tile to 1.0.0-rc.124
- Updated uikit to 1.0.0-rc.213

## 1.0.0-rc.243 (2026-11-16)

### Features

- **nv-ohif:** OHIF viewport overlays, tracking, and tool parity ([d22faced](https://github.com/niivue/mono/commit/d22faced))

### Fixes

- **nv-ohif:** forward only measurements on the active NiiVue pane's series ([#814](https://github.com/niivue/mono/issues/814))
- **nv-ohif:** jumpToImage on a stack turned off its acquisition plane ([#814](https://github.com/niivue/mono/issues/814))
- **nv-ohif:** count a split multi-frame's shown frames; route firstImage and lastImage ([#814](https://github.com/niivue/mono/issues/814))
- **nv-ohif:** index and count only the instances the shown output holds ([#814](https://github.com/niivue/mono/issues/814))
- **nv-ohif:** jumpToImage along the view axis off the acquisition plane ([#814](https://github.com/niivue/mono/issues/814))
- **nv-ohif:** jumpToImage in volume order and on non-DICOM volumes ([#814](https://github.com/niivue/mono/issues/814))
- **nv-ohif:** data-loaded after install, multi-frame jumpToImage, stack readout on slice-type change ([#814](https://github.com/niivue/mono/issues/814))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.242 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.214
- Updated nv-ext-tile to 1.0.0-rc.123
- Updated uikit to 1.0.0-rc.212

## 1.0.0-rc.241 (2026-11-16)

### Features

- **nv-ohif:** OHIF multi-viewport layouts with cornerstone's display defaults ([1e675651](https://github.com/niivue/mono/commit/1e675651))

### Fixes

- **nv-ohif:** removing a render preset restores gray under the DICOM window ([#812](https://github.com/niivue/mono/issues/812))
- **nv-ohif:** apply a protocol window changed mid-load; restore the default on removal ([#812](https://github.com/niivue/mono/issues/812))
- **nv-ohif:** apply a hanging protocol's new window in place, without a reload ([#812](https://github.com/niivue/mono/issues/812))
- **nv-ohif:** re-apply a new hanging protocol's view, sync groups and window ([#812](https://github.com/niivue/mono/issues/812))
- **nv-ohif:** key shared conversions on headers, release unsignalled holds ([#812](https://github.com/niivue/mono/issues/812))
- **nv-ohif:** key shared conversions on every instance and frame count ([#812](https://github.com/niivue/mono/issues/812))
- **nv-ohif:** sagittal 3D camera, linked window baseline, release base conversion ([#812](https://github.com/niivue/mono/issues/812))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.240 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.213
- Updated nv-ext-tile to 1.0.0-rc.122
- Updated uikit to 1.0.0-rc.211

## 1.0.0-rc.239 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.212
- Updated nv-ext-tile to 1.0.0-rc.121
- Updated uikit to 1.0.0-rc.210

## 1.0.0-rc.238 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.211
- Updated nv-ext-tile to 1.0.0-rc.120
- Updated uikit to 1.0.0-rc.209

## 1.0.0-rc.237 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.210
- Updated nv-ext-tile to 1.0.0-rc.119
- Updated uikit to 1.0.0-rc.208

## 1.0.0-rc.236 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.209
- Updated nv-ext-tile to 1.0.0-rc.118
- Updated uikit to 1.0.0-rc.207

## 1.0.0-rc.235 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.208
- Updated nv-ext-tile to 1.0.0-rc.117
- Updated uikit to 1.0.0-rc.206

## 1.0.0-rc.234 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.207
- Updated nv-ext-tile to 1.0.0-rc.116
- Updated uikit to 1.0.0-rc.205

## 1.0.0-rc.233 (2026-11-16)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.206
- Updated nv-ext-tile to 1.0.0-rc.115
- Updated uikit to 1.0.0-rc.204

## 1.0.0-rc.232 (2026-11-15)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.205
- Updated nv-ext-tile to 1.0.0-rc.114
- Updated uikit to 1.0.0-rc.203

## 1.0.0-rc.231 (2026-11-14)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.204
- Updated nv-ext-tile to 1.0.0-rc.113
- Updated uikit to 1.0.0-rc.202

## 1.0.0-rc.230 (2026-11-14)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.203
- Updated nv-ext-tile to 1.0.0-rc.112
- Updated uikit to 1.0.0-rc.201

## 1.0.0-rc.229 (2026-11-14)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.202
- Updated nv-ext-tile to 1.0.0-rc.111
- Updated uikit to 1.0.0-rc.200

## 1.0.0-rc.228 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.201
- Updated nv-ext-tile to 1.0.0-rc.110
- Updated uikit to 1.0.0-rc.199

## 1.0.0-rc.227 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.200
- Updated nv-ext-tile to 1.0.0-rc.109
- Updated uikit to 1.0.0-rc.198

## 1.0.0-rc.226 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.199
- Updated nv-ext-tile to 1.0.0-rc.108
- Updated uikit to 1.0.0-rc.197

## 1.0.0-rc.225 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.198
- Updated nv-ext-tile to 1.0.0-rc.107
- Updated uikit to 1.0.0-rc.196

## 1.0.0-rc.224 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.197
- Updated nv-ext-tile to 1.0.0-rc.106
- Updated uikit to 1.0.0-rc.195

## 1.0.0-rc.223 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.196
- Updated nv-ext-tile to 1.0.0-rc.105
- Updated uikit to 1.0.0-rc.194

## 1.0.0-rc.222 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.195
- Updated nv-ext-tile to 1.0.0-rc.104
- Updated uikit to 1.0.0-rc.193

## 1.0.0-rc.221 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.194
- Updated nv-ext-tile to 1.0.0-rc.103
- Updated uikit to 1.0.0-rc.192

## 1.0.0-rc.220 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.193
- Updated nv-ext-tile to 1.0.0-rc.102
- Updated uikit to 1.0.0-rc.191

## 1.0.0-rc.219 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.192
- Updated nv-ext-tile to 1.0.0-rc.101
- Updated uikit to 1.0.0-rc.190

## 1.0.0-rc.218 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.191
- Updated nv-ext-tile to 1.0.0-rc.100
- Updated uikit to 1.0.0-rc.189

## 1.0.0-rc.217 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.190
- Updated nv-ext-tile to 1.0.0-rc.99
- Updated uikit to 1.0.0-rc.188

## 1.0.0-rc.216 (2026-11-13)

### Refactors

- ⚠️  **nv-ohif:** draw the WSI ruler with core's slide overlay ([0be54e98](https://github.com/niivue/mono/commit/0be54e98))

### Breaking Changes

- **nv-ohif:** draw the WSI ruler with core's slide overlay  ([0be54e98](https://github.com/niivue/mono/commit/0be54e98))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.189
- Updated nv-ext-tile to 1.0.0-rc.98
- Updated uikit to 1.0.0-rc.187

### Thank You

- neurolabusc

## 1.0.0-rc.215 (2026-11-13)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.97

## 1.0.0-rc.214 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.188
- Updated nv-ext-tile to 1.0.0-rc.96
- Updated uikit to 1.0.0-rc.186

## 1.0.0-rc.213 (2026-11-13)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.95

## 1.0.0-rc.212 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.187
- Updated nv-ext-tile to 1.0.0-rc.94
- Updated uikit to 1.0.0-rc.185

## 1.0.0-rc.211 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.186
- Updated nv-ext-tile to 1.0.0-rc.93
- Updated uikit to 1.0.0-rc.184

## 1.0.0-rc.210 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.185
- Updated nv-ext-tile to 1.0.0-rc.92
- Updated uikit to 1.0.0-rc.183

## 1.0.0-rc.209 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.184
- Updated nv-ext-tile to 1.0.0-rc.91
- Updated uikit to 1.0.0-rc.182

## 1.0.0-rc.208 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.183
- Updated nv-ext-tile to 1.0.0-rc.90
- Updated uikit to 1.0.0-rc.181

## 1.0.0-rc.207 (2026-11-12)

### Features

- slide viewer shell (createSlideView) for every NVSlide consumer ([7c86bb87](https://github.com/niivue/mono/commit/7c86bb87))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.182
- Updated nv-ext-tile to 1.0.0-rc.89
- Updated uikit to 1.0.0-rc.180

### Thank You

- neurolabusc

## 1.0.0-rc.206 (2026-11-12)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.88

## 1.0.0-rc.205 (2026-11-12)

### Features

- **niivue, nv-ext-tile:** tiled-image P0 foundation (split, shared helpers, contracts, baseline) ([7d843ee1](https://github.com/niivue/mono/commit/7d843ee1))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.181
- Updated nv-ext-tile to 1.0.0-rc.87
- Updated uikit to 1.0.0-rc.179

### Thank You

- neurolabusc

## 1.0.0-rc.204 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.180
- Updated nv-ext-tile to 1.0.0-rc.86
- Updated uikit to 1.0.0-rc.178

## 1.0.0-rc.203 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.179
- Updated nv-ext-tile to 1.0.0-rc.85
- Updated uikit to 1.0.0-rc.177

## 1.0.0-rc.202 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.178
- Updated nv-ext-tile to 1.0.0-rc.84
- Updated uikit to 1.0.0-rc.176

## 1.0.0-rc.201 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.177
- Updated nv-ext-tile to 1.0.0-rc.83
- Updated uikit to 1.0.0-rc.175

## 1.0.0-rc.200 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.176
- Updated nv-ext-tile to 1.0.0-rc.82
- Updated uikit to 1.0.0-rc.174

## 1.0.0-rc.199 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.175
- Updated nv-ext-tile to 1.0.0-rc.81
- Updated uikit to 1.0.0-rc.173

## 1.0.0-rc.198 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.174
- Updated nv-ext-tile to 1.0.0-rc.80
- Updated uikit to 1.0.0-rc.172

## 1.0.0-rc.197 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.173
- Updated nv-ext-tile to 1.0.0-rc.79
- Updated uikit to 1.0.0-rc.171

## 1.0.0-rc.196 (2026-11-12)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.78

## 1.0.0-rc.195 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.172
- Updated nv-ext-tile to 1.0.0-rc.77
- Updated uikit to 1.0.0-rc.170

## 1.0.0-rc.194 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.171
- Updated nv-ext-tile to 1.0.0-rc.76
- Updated uikit to 1.0.0-rc.169

## 1.0.0-rc.193 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.170
- Updated nv-ext-tile to 1.0.0-rc.75
- Updated uikit to 1.0.0-rc.168

## 1.0.0-rc.192 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.169
- Updated nv-ext-tile to 1.0.0-rc.74
- Updated uikit to 1.0.0-rc.167

## 1.0.0-rc.191 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.168
- Updated nv-ext-tile to 1.0.0-rc.73
- Updated uikit to 1.0.0-rc.166

## 1.0.0-rc.190 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.167
- Updated nv-ext-tile to 1.0.0-rc.72
- Updated uikit to 1.0.0-rc.165

## 1.0.0-rc.189 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.166
- Updated nv-ext-tile to 1.0.0-rc.71
- Updated uikit to 1.0.0-rc.164

## 1.0.0-rc.188 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.165
- Updated nv-ext-tile to 1.0.0-rc.70
- Updated uikit to 1.0.0-rc.163

## 1.0.0-rc.187 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.164
- Updated nv-ext-tile to 1.0.0-rc.69
- Updated uikit to 1.0.0-rc.162

## 1.0.0-rc.186 (2026-11-11)

### Fixes

- **nv-ohif:** warn on a throw after a no-uid add; PR 706 follow-ups ([75d78a6d](https://github.com/niivue/mono/commit/75d78a6d))

### Thank You

- neurolabusc

## 1.0.0-rc.185 (2026-11-11)

### Features

- **nv-ohif:** apply annotationChanged deltas instead of a full reconcile ([#125](https://github.com/niivue/mono/pull/125))

### Fixes

- **nv-ohif:** keep the throw count across a no-uid add ([194b177c](https://github.com/niivue/mono/commit/194b177c))
- **nv-ohif:** do not cap retries of an add that returned no uid ([0cac3c5d](https://github.com/niivue/mono/commit/0cac3c5d))
- **nv-ohif:** retry an add that returned no uid on the next delta ([5815e19e](https://github.com/niivue/mono/commit/5815e19e))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.184 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.163
- Updated nv-ext-tile to 1.0.0-rc.68
- Updated uikit to 1.0.0-rc.161

## 1.0.0-rc.183 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.162
- Updated nv-ext-tile to 1.0.0-rc.67
- Updated uikit to 1.0.0-rc.160

## 1.0.0-rc.182 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.161
- Updated nv-ext-tile to 1.0.0-rc.66
- Updated uikit to 1.0.0-rc.159

## 1.0.0-rc.181 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.160
- Updated nv-ext-tile to 1.0.0-rc.65
- Updated uikit to 1.0.0-rc.158

## 1.0.0-rc.180 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.159
- Updated nv-ext-tile to 1.0.0-rc.64
- Updated uikit to 1.0.0-rc.157

## 1.0.0-rc.179 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.158
- Updated nv-ext-tile to 1.0.0-rc.63
- Updated uikit to 1.0.0-rc.156

## 1.0.0-rc.178 (2026-11-11)

### Fixes

- **nv-ohif:** style the overlay menu trigger like OHIF toolbar buttons ([dbabcb7a](https://github.com/niivue/mono/commit/dbabcb7a))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.157
- Updated nv-ext-tile to 1.0.0-rc.62
- Updated uikit to 1.0.0-rc.155

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.177 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.156
- Updated nv-ext-tile to 1.0.0-rc.61
- Updated uikit to 1.0.0-rc.154

## 1.0.0-rc.176 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.155
- Updated nv-ext-tile to 1.0.0-rc.60
- Updated uikit to 1.0.0-rc.153

## 1.0.0-rc.175 (2026-11-11)

### Features

- **nv-ohif:** Overlays toolbar dropdown ([9f3bc680](https://github.com/niivue/mono/commit/9f3bc680))

### Fixes

- **nv-ohif:** overlay menu follows the OHIF toolbar open state ([433796b4](https://github.com/niivue/mono/commit/433796b4))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.174 (2026-11-11)

### Features

- **nv-ohif:** per-overlay commands (add chosen series, visibility, order, remove, colormap) ([29904da0](https://github.com/niivue/mono/commit/29904da0))

### Fixes

- **nv-ohif:** clear a cancelled overlay's status; skip colormaps during a base swap ([d9847351](https://github.com/niivue/mono/commit/d9847351))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.173 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.154
- Updated nv-ext-tile to 1.0.0-rc.59
- Updated uikit to 1.0.0-rc.152

## 1.0.0-rc.172 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.153
- Updated nv-ext-tile to 1.0.0-rc.58
- Updated uikit to 1.0.0-rc.151

## 1.0.0-rc.171 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.57

## 1.0.0-rc.170 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.152
- Updated nv-ext-tile to 1.0.0-rc.56
- Updated uikit to 1.0.0-rc.150

## 1.0.0-rc.169 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.151
- Updated nv-ext-tile to 1.0.0-rc.55
- Updated uikit to 1.0.0-rc.149

## 1.0.0-rc.168 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.150
- Updated nv-ext-tile to 1.0.0-rc.54
- Updated uikit to 1.0.0-rc.148

## 1.0.0-rc.167 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.53

## 1.0.0-rc.166 (2026-11-10)

### Features

- ⚠️  **niivue:** remove deprecated NVSlide.setWindow and window getter ([#659](https://github.com/niivue/mono/issues/659))

### Fixes

- **nv-ohif:** skip a slide window whose bounds overflow to Infinity ([293869a6](https://github.com/niivue/mono/commit/293869a6))

### Breaking Changes

- **niivue:** remove deprecated NVSlide.setWindow and window getter  ([#659](https://github.com/niivue/mono/issues/659))
  `slide.setWindow(lo, hi)` -> `slide.setChannel(0,
  { calMin: lo, calMax: hi })`; `slide.window` -> `slide.channels[0]`.
  setChannel treats a non-finite bound as the default window instead of
  rejecting it, so callers validate their own input.

### Updated Dependencies

- Updated niivue to 1.0.0-rc.149
- Updated nv-ext-tile to 1.0.0-rc.52
- Updated uikit to 1.0.0-rc.147

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.165 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.148
- Updated nv-ext-tile to 1.0.0-rc.51
- Updated uikit to 1.0.0-rc.146

## 1.0.0-rc.164 (2026-11-10)

### Fixes

- **nv-ohif:** restore the 32 MiB thumbnail fetch cap ([03365e41](https://github.com/niivue/mono/commit/03365e41))
- **nv-ohif:** ICC bulk data via OHIF data source; wsiThumbnail uses readFirstPart ([#650](https://github.com/niivue/mono/issues/650), [#657](https://github.com/niivue/mono/issues/657))

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.50

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.163 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.49

## 1.0.0-rc.162 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.147
- Updated nv-ext-tile to 1.0.0-rc.48
- Updated uikit to 1.0.0-rc.145

## 1.0.0-rc.161 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.47

## 1.0.0-rc.160 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.46

## 1.0.0-rc.159 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.146
- Updated nv-ext-tile to 1.0.0-rc.45
- Updated uikit to 1.0.0-rc.144

## 1.0.0-rc.158 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.145
- Updated nv-ext-tile to 1.0.0-rc.44
- Updated uikit to 1.0.0-rc.143

## 1.0.0-rc.157 (2026-11-10)

### Features

- **nv-ohif:** render whole-slide series with nv-ext-tile's DicomWebWsiSource ([a0386a22](https://github.com/niivue/mono/commit/a0386a22))

### Fixes

- **nv-ohif:** take the WSI series URL from an image ID that names a series ([a6fe33d6](https://github.com/niivue/mono/commit/a6fe33d6))

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.43

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.156 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.144
- Updated nv-ext-tile to 1.0.0-rc.42
- Updated uikit to 1.0.0-rc.142

## 1.0.0-rc.155 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.41

## 1.0.0-rc.154 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.40

## 1.0.0-rc.153 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.143
- Updated nv-ext-tile to 1.0.0-rc.39
- Updated uikit to 1.0.0-rc.141

## 1.0.0-rc.152 (2026-11-10)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.140

## 1.0.0-rc.151 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.142
- Updated nv-ext-tile to 1.0.0-rc.38
- Updated uikit to 1.0.0-rc.139

## 1.0.0-rc.150 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.141
- Updated nv-ext-tile to 1.0.0-rc.37
- Updated uikit to 1.0.0-rc.138

## 1.0.0-rc.149 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.140
- Updated nv-ext-tile to 1.0.0-rc.36
- Updated uikit to 1.0.0-rc.137

## 1.0.0-rc.148 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.139
- Updated nv-ext-tile to 1.0.0-rc.35
- Updated uikit to 1.0.0-rc.136

## 1.0.0-rc.147 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.34

## 1.0.0-rc.146 (2026-11-10)

### Updated Dependencies

- Updated nv-ext-tile to 1.0.0-rc.33

## 1.0.0-rc.145 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.138
- Updated nv-ext-tile to 1.0.0-rc.32
- Updated uikit to 1.0.0-rc.135

## 1.0.0-rc.144 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.137
- Updated nv-ext-tile to 1.0.0-rc.31
- Updated uikit to 1.0.0-rc.134

## 1.0.0-rc.143 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.136
- Updated nv-ext-tile to 1.0.0-rc.30
- Updated uikit to 1.0.0-rc.133

## 1.0.0-rc.142 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.135
- Updated nv-ext-tile to 1.0.0-rc.29
- Updated uikit to 1.0.0-rc.132

## 1.0.0-rc.141 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.134
- Updated nv-ext-tile to 1.0.0-rc.28
- Updated uikit to 1.0.0-rc.131

## 1.0.0-rc.140 (2026-11-09)

### Features

- **nv-ohif:** answer OHIF rotate/flip commands on NiiVue viewports ([6bebf88a](https://github.com/niivue/mono/commit/6bebf88a))

### Thank You

- neurolabusc

## 1.0.0-rc.139 (2026-11-09)

### Fixes

- **nv-ohif:** strip padding from a boundary recovered from the body ([f28313d6](https://github.com/niivue/mono/commit/f28313d6))
- **nv-ohif:** a multipart delimiter must end as RFC 2046 says ([2d67bbe3](https://github.com/niivue/mono/commit/2d67bbe3))
- **nv-ohif:** count a multipart delimiter only after CRLF ([ab6d0bfd](https://github.com/niivue/mono/commit/ab6d0bfd))
- **nv-ohif:** resolve a relative DICOMweb root against document.baseURI ([d3ee5b1d](https://github.com/niivue/mono/commit/d3ee5b1d))
- **nv-ohif:** load relative DICOMweb roots; start crosshair on a voxel ([934540af](https://github.com/niivue/mono/commit/934540af))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.138 (2026-11-09)

### Fixes

- **nv-ohif:** exclude dist from typecheck again ([e96277e2](https://github.com/niivue/mono/commit/e96277e2))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.137 (2026-11-09)

### Fixes

- **nv-ohif:** stop over-disabling host buttons; accept dcmjs 0.52 ([62b9c5a3](https://github.com/niivue/mono/commit/62b9c5a3))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.133
- Updated nv-ext-tile to 1.0.0-rc.27
- Updated uikit to 1.0.0-rc.130

### Thank You

- neurolabusc

## 1.0.0-rc.136 (2026-11-09)

### Features

- **nv-ohif:** DICOM frame identity on NiiVue measurements ([6733efe9](https://github.com/niivue/mono/commit/6733efe9))

### Fixes

- **nv-ohif:** frameAt bounds depth without spreading the contour ([c770c566](https://github.com/niivue/mono/commit/c770c566))
- **nv-ohif:** frameAt bounds the depth spread of all points ([c3771d9f](https://github.com/niivue/mono/commit/c3771d9f))
- **nv-ohif:** snap the crosshair once a volume loads ([6cc0d9c5](https://github.com/niivue/mono/commit/6cc0d9c5))
- **nv-ohif:** frameAt needs the points within ON_PLANE of each other ([c082a5b6](https://github.com/niivue/mono/commit/c082a5b6))
- **nv-ohif:** re-reflect a row when its slice frame appears ([66042339](https://github.com/niivue/mono/commit/66042339))
- **nv-ohif:** snap the crosshair to voxel centres, not frameAt ([8b6cc30e](https://github.com/niivue/mono/commit/8b6cc30e))
- **nv-ohif:** give measurements the displayed slice's identity ([0918b322](https://github.com/niivue/mono/commit/0918b322))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.135 (2026-11-09)

### Features

- **nv-ohif:** convert enhanced/multi-frame DICOMweb instances ([3c35df7a](https://github.com/niivue/mono/commit/3c35df7a))

### Fixes

- **nv-ohif:** take the frame count from series metadata; bound all requests ([bd990802](https://github.com/niivue/mono/commit/bd990802))
- **nv-ohif:** release the overlay entry on a cancel press ([731c0436](https://github.com/niivue/mono/commit/731c0436))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.134 (2026-11-09)

### Features

- **nv-ohif:** choose the dcm2niix output by policy; cancel overlay conversion; skip derived objects ([07dc11d7](https://github.com/niivue/mono/commit/07dc11d7))

### Fixes

- **nv-ohif:** rank magnitude over R and I parts in dcm2niix outputs ([d3607d5f](https://github.com/niivue/mono/commit/d3607d5f))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.133 (2026-11-09)

### Features

- **nv-ohif:** route OHIF's standard commands; independent windows; NiiVue toolbar evaluator ([39a1e8cc](https://github.com/niivue/mono/commit/39a1e8cc))

### Fixes

- **nv-ohif:** explicit context wins over tool commands too ([b5d1733e](https://github.com/niivue/mono/commit/b5d1733e))
- **nv-ohif:** check every toolbar command; explicit context wins ([c28d55a2](https://github.com/niivue/mono/commit/c28d55a2))
- **nv-ohif:** refresh the toolbar with the active viewport id ([706a50d4](https://github.com/niivue/mono/commit/706a50d4))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.132 (2026-11-09)

### Features

- **nv-ohif:** depend on nv-ext-tile/dicom for the WSI tile decoders ([49d65cb4](https://github.com/niivue/mono/commit/49d65cb4))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.132
- Updated nv-ext-tile to 1.0.0-rc.26
- Updated uikit to 1.0.0-rc.129

### Thank You

- neurolabusc

## 1.0.0-rc.131 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.131
- Updated uikit to 1.0.0-rc.128

## 1.0.0-rc.130 (2026-11-09)

### Fixes

- **nv-ohif:** take OHIF's managers from the module params; report viewport ready ([4a4a39ee](https://github.com/niivue/mono/commit/4a4a39ee))

### Thank You

- neurolabusc

## 1.0.0-rc.129 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.130
- Updated uikit to 1.0.0-rc.127

## 1.0.0-rc.128 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.129
- Updated uikit to 1.0.0-rc.126

## 1.0.0-rc.127 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.128
- Updated uikit to 1.0.0-rc.125

## 1.0.0-rc.126 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.127
- Updated uikit to 1.0.0-rc.124

## 1.0.0-rc.125 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.126
- Updated uikit to 1.0.0-rc.123

## 1.0.0-rc.124 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.125
- Updated uikit to 1.0.0-rc.122

## 1.0.0-rc.123 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.124
- Updated uikit to 1.0.0-rc.121

## 1.0.0-rc.122 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.123
- Updated uikit to 1.0.0-rc.120

## 1.0.0-rc.121 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.122
- Updated uikit to 1.0.0-rc.119

## 1.0.0-rc.120 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.121
- Updated uikit to 1.0.0-rc.118

## 1.0.0-rc.119 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.120
- Updated uikit to 1.0.0-rc.117

## 1.0.0-rc.118 (2026-11-08)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.119
- Updated uikit to 1.0.0-rc.116

## 1.0.0-rc.117 (2026-11-08)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.115

## 1.0.0-rc.116 (2026-11-08)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.114

## 1.0.0-rc.115 (2026-11-08)

### Fixes

- **nv-ohif:** build the library with the production JSX runtime ([49022f9d](https://github.com/niivue/mono/commit/49022f9d))

### Thank You

- neurolabusc

## 1.0.0-rc.114 (2026-11-08)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.118
- Updated uikit to 1.0.0-rc.113

## 1.0.0-rc.113 (2026-11-08)

### Fixes

- **nv-ohif:** retry a tile once on a fresh pool after a worker failure ([79c27c0c](https://github.com/niivue/mono/commit/79c27c0c))
- **nv-ohif:** tell an abort rejection from a worker death by its reason ([#595](https://github.com/niivue/mono/issues/595))
- **nv-ohif:** keep the decoder pool when an aborted tile rejects with a plain Error ([#595](https://github.com/niivue/mono/issues/595))
- **nv-ohif:** replace the dcm2niix tile decoder pool when its workers die ([25925f7d](https://github.com/niivue/mono/commit/25925f7d))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.117
- Updated uikit to 1.0.0-rc.112

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.112 (2026-11-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.116
- Updated uikit to 1.0.0-rc.111

## 1.0.0-rc.111 (2026-11-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.115
- Updated uikit to 1.0.0-rc.110

## 1.0.0-rc.110 (2026-11-07)

### Fixes

- **niivue:** coalesce slide rewindowing and tighten WSI codec checks ([434175a4](https://github.com/niivue/mono/commit/434175a4))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.114
- Updated uikit to 1.0.0-rc.109

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.109 (2026-11-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.113
- Updated uikit to 1.0.0-rc.108

## 1.0.0-rc.108 (2026-11-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.112
- Updated uikit to 1.0.0-rc.107

## 1.0.0-rc.107 (2026-11-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.111
- Updated uikit to 1.0.0-rc.106

## 1.0.0-rc.106 (2026-11-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.110
- Updated uikit to 1.0.0-rc.105

## 1.0.0-rc.105 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.109
- Updated uikit to 1.0.0-rc.104

## 1.0.0-rc.104 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.108
- Updated uikit to 1.0.0-rc.103

## 1.0.0-rc.103 (2026-11-06)

### Features

- **niivue:** sparse slide levels with holes ([1558f013](https://github.com/niivue/mono/commit/1558f013))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.107
- Updated uikit to 1.0.0-rc.102

### Thank You

- neurolabusc

## 1.0.0-rc.102 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.106
- Updated uikit to 1.0.0-rc.101

## 1.0.0-rc.101 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.105
- Updated uikit to 1.0.0-rc.100

## 1.0.0-rc.100 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.104
- Updated uikit to 1.0.0-rc.99

## 1.0.0-rc.99 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.103
- Updated uikit to 1.0.0-rc.98

## 1.0.0-rc.98 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.102
- Updated uikit to 1.0.0-rc.97

## 1.0.0-rc.97 (2026-11-06)

### Features

- **niivue,nv-ohif:** keep the slide ICC profile in DICOM-WSI manifests ([c60bc6d3](https://github.com/niivue/mono/commit/c60bc6d3))
- **nv-ohif:** note when a slide shows a coarser level than requested ([73f27c94](https://github.com/niivue/mono/commit/73f27c94))
- **nv-ohif,niivue:** JPEG-LS and monochrome DICOM-WSI levels ([93ce9bb0](https://github.com/niivue/mono/commit/93ce9bb0))

### Fixes

- **niivue,nv-ohif:** audit fixes for monochrome slide windowing ([992b53e6](https://github.com/niivue/mono/commit/992b53e6))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.101
- Updated uikit to 1.0.0-rc.96

### Thank You

- neurolabusc

## 1.0.0-rc.96 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.100
- Updated uikit to 1.0.0-rc.95

## 1.0.0-rc.95 (2026-11-06)

### Features

- **niivue,nv-ohif:** play JPEG 2000 DICOM-WSI through dcm2niix ([f64aca57](https://github.com/niivue/mono/commit/f64aca57))

### Fixes

- **niivue,nv-ohif:** show DICOM-WSI with row 0 at the top ([48d6cf2e](https://github.com/niivue/mono/commit/48d6cf2e))
- **niivue,nv-ohif:** audit fixes for JPEG 2000 WSI playback ([5480bf7c](https://github.com/niivue/mono/commit/5480bf7c))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.99
- Updated uikit to 1.0.0-rc.94

### Thank You

- neurolabusc

## 1.0.0-rc.94 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.98
- Updated uikit to 1.0.0-rc.93

## 1.0.0-rc.93 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.97
- Updated uikit to 1.0.0-rc.92

## 1.0.0-rc.92 (2026-11-06)

### Fixes

- **nv-ohif:** declare @niivue/niivue peer as a range ([#106](https://github.com/niivue/mono/issues/106))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.96
- Updated uikit to 1.0.0-rc.91

### Thank You

- neurolabusc

## 1.0.0-rc.91 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.95
- Updated uikit to 1.0.0-rc.90

## 1.0.0-rc.90 (2026-11-06)

### Fixes

- **niivue:** read the world unit from xyzt_units for ruler and labels ([#202](https://github.com/niivue/mono/issues/202))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.94
- Updated uikit to 1.0.0-rc.89

### Thank You

- neurolabusc

## 1.0.0-rc.89 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.93
- Updated uikit to 1.0.0-rc.88

## 1.0.0-rc.88 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.92
- Updated uikit to 1.0.0-rc.87

## 1.0.0-rc.87 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.91
- Updated uikit to 1.0.0-rc.86

## 1.0.0-rc.86 (2026-11-05)

### Fixes

- **nv-ohif:** drop the OHIF row for an erased line, arrow or bidirectional ([8bdf0225](https://github.com/niivue/mono/commit/8bdf0225))
- leave a shape untouched when the eraser misses it ([7f2b0a50](https://github.com/niivue/mono/commit/7f2b0a50))
- **nv-ohif:** drop the row for an erased rect, ellipse or circle ([8d8e684b](https://github.com/niivue/mono/commit/8d8e684b))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.90
- Updated uikit to 1.0.0-rc.85

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.85 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.89
- Updated uikit to 1.0.0-rc.84

## 1.0.0-rc.84 (2026-11-05)

### Fixes

- **nv-ohif:** do not run dcm2niix after an abort in the converting callback ([71605e31](https://github.com/niivue/mono/commit/71605e31))
- **nv-ohif:** hash ruler length to 0.01 mm, tag fields, cover style ([a9ccd062](https://github.com/niivue/mono/commit/a9ccd062))
- **nv-ohif:** stop the dcm2niix worker without waiting for its boot ([5e019d91](https://github.com/niivue/mono/commit/5e019d91))
- **nv-ohif:** redraw the ruler when its length label changes ([5a5d2f39](https://github.com/niivue/mono/commit/5a5d2f39))

### Performance

- **nv-ohif:** hash annotation overlay shapes instead of building a string ([#124](https://github.com/niivue/mono/issues/124))
- **nv-ohif:** boot the dcm2niix worker while DICOM instances download ([#121](https://github.com/niivue/mono/issues/121))

### Updated Dependencies

- Updated uikit to 1.0.0-rc.83

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.83 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.88
- Updated uikit to 1.0.0-rc.82

## 1.0.0-rc.82 (2026-11-04)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.87
- Updated uikit to 1.0.0-rc.81

## 1.0.0-rc.81 (2026-11-04)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.86
- Updated uikit to 1.0.0-rc.80

## 1.0.0-rc.80 (2026-11-04)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.85
- Updated uikit to 1.0.0-rc.79

## 1.0.0-rc.79 (2026-11-04)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.84
- Updated uikit to 1.0.0-rc.78

## 1.0.0-rc.78 (2026-11-04)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.83
- Updated uikit to 1.0.0-rc.77

## 1.0.0-rc.77 (2026-11-03)

### Fixes

- **nv-ohif:** do not export a split spline or livewire ROI as its first piece ([#484](https://github.com/niivue/mono/issues/484))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.82
- Updated uikit to 1.0.0-rc.76

### Thank You

- neurolabusc

## 1.0.0-rc.76 (2026-11-03)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.75

## 1.0.0-rc.75 (2026-11-03)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.81
- Updated uikit to 1.0.0-rc.74

## 1.0.0-rc.74 (2026-11-03)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.80
- Updated uikit to 1.0.0-rc.73

## 1.0.0-rc.73 (2026-11-03)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.79
- Updated uikit to 1.0.0-rc.72

## 1.0.0-rc.72 (2026-11-03)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.78
- Updated uikit to 1.0.0-rc.71

## 1.0.0-rc.71 (2026-11-03)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.70

## 1.0.0-rc.70 (2026-11-03)

### Fixes

- **nv-ohif:** clear failures on a row-less viewport; warn per failing change ([a81429a2](https://github.com/niivue/mono/commit/a81429a2))
- **nv-ohif:** drive the W/L reverse bridge from volumeUpdated ([#119](https://github.com/niivue/mono/issues/119))
- **nv-ohif:** log and cap thrown measurement add/remove retries ([#118](https://github.com/niivue/mono/issues/118))

### Updated Dependencies

- Updated uikit to 1.0.0-rc.69

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.69 (2026-11-03)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.77
- Updated uikit to 1.0.0-rc.68

## 1.0.0-rc.68 (2026-11-03)

### Performance

- **nv-ohif:** memoize NVSlide ruler updates ([#122](https://github.com/niivue/mono/issues/122))

### Thank You

- neurolabusc

## 1.0.0-rc.67 (2026-11-03)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.76
- Updated uikit to 1.0.0-rc.67

## 1.0.0-rc.66 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.75
- Updated uikit to 1.0.0-rc.66

## 1.0.0-rc.65 (2026-11-02)

### Fixes

- **nv-ohif:** pass the status kind instead of matching the message ([#130](https://github.com/niivue/mono/issues/130))
- **nv-ohif, nv-react:** handle a rejected setVolume ([#467](https://github.com/niivue/mono/issues/467))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.74
- Updated uikit to 1.0.0-rc.65

### Thank You

- neurolabusc

## 1.0.0-rc.64 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.73
- Updated uikit to 1.0.0-rc.64

## 1.0.0-rc.63 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.72
- Updated uikit to 1.0.0-rc.63

## 1.0.0-rc.62 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.71
- Updated uikit to 1.0.0-rc.62

## 1.0.0-rc.61 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.70
- Updated uikit to 1.0.0-rc.61

## 1.0.0-rc.60 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.69
- Updated uikit to 1.0.0-rc.60

## 1.0.0-rc.59 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.68
- Updated uikit to 1.0.0-rc.59

## 1.0.0-rc.58 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.67
- Updated uikit to 1.0.0-rc.58

## 1.0.0-rc.57 (2026-11-02)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.66
- Updated uikit to 1.0.0-rc.57

## 1.0.0-rc.56 (2026-11-02)

### Fixes

- **niivue:** annotation screen shapes and stats cover every polygon ([#115](https://github.com/niivue/mono/issues/115))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.65
- Updated uikit to 1.0.0-rc.56

### Thank You

- neurolabusc

## 1.0.0-rc.55 (2026-11-01)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.64
- Updated uikit to 1.0.0-rc.55

## 1.0.0-rc.54 (2026-11-01)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.63
- Updated uikit to 1.0.0-rc.54

## 1.0.0-rc.53 (2026-10-31)

### Fixes

- **niivue:** oblique-safe bidirectional slice test, ignore off-slice dblclick mid-contour, loadDocument clears annotation undo ([#111](https://github.com/niivue/mono/issues/111), [#114](https://github.com/niivue/mono/issues/114), [#113](https://github.com/niivue/mono/issues/113))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.62
- Updated uikit to 1.0.0-rc.53

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.52 (2026-10-30)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.61
- Updated uikit to 1.0.0-rc.52

## 1.0.0-rc.51 (2026-10-30)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.60
- Updated uikit to 1.0.0-rc.51

## 1.0.0-rc.50 (2026-10-30)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.59
- Updated uikit to 1.0.0-rc.50

## 1.0.0-rc.49 (2026-10-30)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.58
- Updated uikit to 1.0.0-rc.49

## 1.0.0-rc.48 (2026-10-30)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.57
- Updated uikit to 1.0.0-rc.48

## 1.0.0-rc.47 (2026-10-30)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.56
- Updated uikit to 1.0.0-rc.47

## 1.0.0-rc.46 (2026-10-29)

### Features

- **nv-ext-dcm2niix:** re-export @niivue/dcm2niix 1.4; nv-ohif uses convert() ([44da2e9a](https://github.com/niivue/mono/commit/44da2e9a))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.55
- Updated uikit to 1.0.0-rc.46

### Thank You

- neurolabusc

## 1.0.0-rc.45 (2026-10-29)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.54
- Updated uikit to 1.0.0-rc.45

## 1.0.0-rc.44 (2026-10-29)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.53
- Updated uikit to 1.0.0-rc.44

## 1.0.0-rc.43 (2026-10-29)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.43

## 1.0.0-rc.42 (2026-10-29)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.52
- Updated uikit to 1.0.0-rc.42

## 1.0.0-rc.41 (2026-10-29)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.51
- Updated uikit to 1.0.0-rc.41

## 1.0.0-rc.40 (2026-10-29)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.50
- Updated uikit to 1.0.0-rc.40

## 1.0.0-rc.39 (2026-10-29)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.39

## 1.0.0-rc.38 (2026-10-29)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.49
- Updated uikit to 1.0.0-rc.38

## 1.0.0-rc.37 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.48
- Updated uikit to 1.0.0-rc.37

## 1.0.0-rc.36 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.47
- Updated uikit to 1.0.0-rc.36

## 1.0.0-rc.35 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.46
- Updated uikit to 1.0.0-rc.35

## 1.0.0-rc.34 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.45
- Updated uikit to 1.0.0-rc.34

## 1.0.0-rc.33 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.44
- Updated uikit to 1.0.0-rc.33

## 1.0.0-rc.32 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.43
- Updated uikit to 1.0.0-rc.32

## 1.0.0-rc.31 (2026-10-28)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.42
- Updated uikit to 1.0.0-rc.31

## 1.0.0-rc.30 (2026-10-28)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.30

## 1.0.0-rc.29 (2026-10-27)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.41
- Updated uikit to 1.0.0-rc.29

## 1.0.0-rc.28 (2026-10-27)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.40
- Updated uikit to 1.0.0-rc.28

## 1.0.0-rc.27 (2026-10-26)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.39
- Updated uikit to 1.0.0-rc.27

## 1.0.0-rc.26 (2026-10-26)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.38
- Updated uikit to 1.0.0-rc.26

## 1.0.0-rc.25 (2026-10-23)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.37
- Updated uikit to 1.0.0-rc.25

## 1.0.0-rc.24 (2026-10-23)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.36
- Updated uikit to 1.0.0-rc.24

## 1.0.0-rc.23 (2026-10-23)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.35
- Updated uikit to 1.0.0-rc.23

## 1.0.0-rc.22 (2026-10-23)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.34
- Updated uikit to 1.0.0-rc.22

## 1.0.0-rc.21 (2026-10-21)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.33
- Updated uikit to 1.0.0-rc.21

## 1.0.0-rc.20 (2026-10-21)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.32
- Updated uikit to 1.0.0-rc.20

## 1.0.0-rc.19 (2026-10-21)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.31
- Updated uikit to 1.0.0-rc.19

## 1.0.0-rc.18 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.30
- Updated uikit to 1.0.0-rc.18

## 1.0.0-rc.17 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.29
- Updated uikit to 1.0.0-rc.17

## 1.0.0-rc.16 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.28
- Updated uikit to 1.0.0-rc.16

## 1.0.0-rc.15 (2026-10-20)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.27
- Updated uikit to 1.0.0-rc.15

## 1.0.0-rc.14 (2026-10-19)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.26
- Updated uikit to 1.0.0-rc.14

## 1.0.0-rc.13 (2026-10-19)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.25
- Updated uikit to 1.0.0-rc.13

## 1.0.0-rc.12 (2026-10-19)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.24
- Updated uikit to 1.0.0-rc.12

## 1.0.0-rc.11 (2026-10-18)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.23
- Updated uikit to 1.0.0-rc.11

## 1.0.0-rc.10 (2026-10-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.22
- Updated uikit to 1.0.0-rc.10

## 1.0.0-rc.9 (2026-10-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.21
- Updated uikit to 1.0.0-rc.9

## 1.0.0-rc.8 (2026-10-07)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.20
- Updated uikit to 1.0.0-rc.8

## 1.0.0-rc.7 (2026-10-07)

### Updated Dependencies

- Updated uikit to 1.0.0-rc.7

## 1.0.0-rc.6 (2026-10-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.19
- Updated uikit to 1.0.0-rc.6

## 1.0.0-rc.5 (2026-10-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.18
- Updated uikit to 1.0.0-rc.5

## 1.0.0-rc.4 (2026-10-05)

### Fixes

- **nv-ohif:** share transient note timer lifecycle ([82d9050](https://github.com/niivue/mono/commit/82d9050))

### Performance

- **nv-ohif:** cache WSI thumbnails per display set ([698da71](https://github.com/niivue/mono/commit/698da71))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.17
- Updated uikit to 1.0.0-rc.4

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.3 (2026-09-24)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.16
- Updated uikit to 1.0.0-rc.3

## 1.0.0-rc.2 (2026-09-24)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.15
- Updated uikit to 1.0.0-rc.2

## 1.0.0-rc.1 (2026-09-23)

### Features

- **niivue:** pass an AbortSignal to SlideTileSource.fetchTileBytes ([a5ff769](https://github.com/niivue/mono/commit/a5ff769))

### Fixes

- lint and format caches ignored most of what Biome checks ([8133ef3](https://github.com/niivue/mono/commit/8133ef3))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.14
- Updated uikit to 1.0.0-rc.1

### Thank You

- Claude Fable 5
- Claude Opus 5 (1M context)
- neurolabusc
- Steffen Bollmann

## 0.1.0-rc.0 (2026-09-02)

### Features

- **nv-ohif:** hide the NiiVue annotation when its OHIF measurement is hidden ([e7d3664](https://github.com/niivue/mono/commit/e7d3664))
- **nv-ohif:** delete the NiiVue annotation when its OHIF measurement is removed ([afbf170](https://github.com/niivue/mono/commit/afbf170))
- **nv-ohif:** unify Length onto the annotation system ([cd0509c](https://github.com/niivue/mono/commit/cd0509c))
- Bidirectional measurement (two perpendicular axes) end to end ([0064166](https://github.com/niivue/mono/commit/0064166))
- user-entered free-text labels for annotations ([3252bed](https://github.com/niivue/mono/commit/3252bed))
- LivewireContour (edge-snapping multi-click ROI) end to end ([7e965cf](https://github.com/niivue/mono/commit/7e965cf))
- multi-click SplineROI (niivue interaction + nv-ohif wiring) ([fb36c30](https://github.com/niivue/mono/commit/fb36c30))
- **nv-ohif:** render ROI annotations via UIKit through the niivue seam ([b0c0222](https://github.com/niivue/mono/commit/b0c0222))
- **nv-ohif:** wire OHIF ROI + arrow measurement tools to NiiVue annotations ([66f66be](https://github.com/niivue/mono/commit/66f66be))
- **uikit:** make @niivue/uikit publishable and depend on it from nv-ohif ([ebc8ca0](https://github.com/niivue/mono/commit/ebc8ca0))
- **nv-ohif:** bump @niivue/dcm2niix to the published fix (1.3.20260724) so DICOM works for consumers ([a34799f](https://github.com/niivue/mono/commit/a34799f))
- **nv-ohif:** unify the slide ruler control to click-drag (match the volume) ([739e082](https://github.com/niivue/mono/commit/739e082))
- **nv-ohif:** draw volume measurements as UIKit rulers (rotated tick numbers) ([fdbf5cc](https://github.com/niivue/mono/commit/fdbf5cc))
- **nv-ohif:** match the volume measurement ruler to the WSI ruler color ([d768632](https://github.com/niivue/mono/commit/d768632))
- **nv-ohif:** recover WSI pixel spacing so the ruler measures in mm/microns ([4f1a7ac](https://github.com/niivue/mono/commit/4f1a7ac))
- **nv-ohif:** UIKit ruler on the WSI viewport with physical-unit measurement ([3fec150](https://github.com/niivue/mono/commit/3fec150))
- **nv-ohif:** ruler tool bridged to OHIF's measurement panel ([90c4458](https://github.com/niivue/mono/commit/90c4458))
- **nv-ohif:** wire OHIF toolbar to NiiVue ([d2100e9](https://github.com/niivue/mono/commit/d2100e9))
- **nv-ohif:** study-panel preview thumbnails for whole-slide (SM) series ([89af65b](https://github.com/niivue/mono/commit/89af65b))
- **nv-ohif:** claim the SM SOP class so whole-slide series route to NiiVue ([2ff55a0](https://github.com/niivue/mono/commit/2ff55a0))
- **nv-ohif:** render DICOM-WSI (SM) display sets with NVSlide ([2291418](https://github.com/niivue/mono/commit/2291418))
- **nv-ohif:** interpolation (smoothing) toggle ([d96bd9d](https://github.com/niivue/mono/commit/d96bd9d))
- **nv-ohif:** colorbar (colormap legend) toggle ([1415a1b](https://github.com/niivue/mono/commit/1415a1b))
- **nv-ohif:** base-volume colormap dropdown ([3b0042e](https://github.com/niivue/mono/commit/3b0042e))
- **nv-ohif:** reverse W/L bridge (NiiVue drag -> OHIF) + NVSlide 2D TODO ([8660e5d](https://github.com/niivue/mono/commit/8660e5d))
- **nv-ohif:** bridge OHIF window/level presets to NiiVue calMin/calMax ([351932e](https://github.com/niivue/mono/commit/351932e))
- **nv-ohif:** add clip-plane and overlay toolbar controls ([e23a075](https://github.com/niivue/mono/commit/e23a075))
- **nv-ohif:** wire the OHIF toolbar to NiiVue (views dropdown + reset view) ([6cc012b](https://github.com/niivue/mono/commit/6cc012b))
- **nv-ohif:** mirror OHIF's active tool onto NiiVue's left-drag (Window/Level, Pan) ([66c01b6](https://github.com/niivue/mono/commit/66c01b6))
- **nv-ohif:** DICOM->NIfTI viewport path via in-browser P10 reconstruction + dcm2niix ([d18f51a](https://github.com/niivue/mono/commit/d18f51a))
- **nv-ohif:** prove Phase 1 — NiiVue renders a NIfTI in an OHIF-shaped harness ([9f8c1ae](https://github.com/niivue/mono/commit/9f8c1ae))
- **nv-ohif:** scaffold the NiiVue viewport extension for OHIF (Phase 1) ([7eb6386](https://github.com/niivue/mono/commit/7eb6386))

### Fixes

- **deps:** pin @types/bun instead of the "latest" dist-tag ([f466415](https://github.com/niivue/mono/commit/f466415))
- **nv-ohif:** guard the positional imageIds fallback against compaction ([3f08d12](https://github.com/niivue/mono/commit/3f08d12))
- **nv-ohif:** rank array-form ImageType in WSI thumbnail selection ([686b626](https://github.com/niivue/mono/commit/686b626))
- **nv-ohif:** classify array-form ImageType in WSI pyramid extraction ([6e9ddf0](https://github.com/niivue/mono/commit/6e9ddf0))
- **nv-ohif:** stale flashStatus timer no longer blanks newer status messages ([52f1538](https://github.com/niivue/mono/commit/52f1538))
- **nv-ohif:** ruler toolbar button reflects the Length annotation tool ([e240273](https://github.com/niivue/mono/commit/e240273))
- **nv-ohif:** harden annotation visibility/removal from the final review ([1f97794](https://github.com/niivue/mono/commit/1f97794))
- **nv-ohif:** no default label for a Length measurement ([a67a7c2](https://github.com/niivue/mono/commit/a67a7c2))
- **nv-ohif:** retry a thrown removal of an unsupported row (PR #76 F1) ([#76](https://github.com/niivue/mono/issues/76))
- **nv-ohif:** apply product rulings on labels + unsupported geometry (PR #76 round-5) ([#76](https://github.com/niivue/mono/issues/76))
- **nv-ohif:** restore failure-handling + labels, fix jump target (PR #76 round-4 review) ([#76](https://github.com/niivue/mono/issues/76))
- harden annotation synchronization ([c23d450](https://github.com/niivue/mono/commit/c23d450))
- harden OHIF annotation synchronization ([756cb9c](https://github.com/niivue/mono/commit/756cb9c))
- **nv-ohif:** fix reflect-failure churn, arrow direction, label clear (PR #76 round-3 review) ([#76](https://github.com/niivue/mono/issues/76))
- **nv-ohif:** preserve reflected annotation geometry ([83c30ab](https://github.com/niivue/mono/commit/83c30ab))
- **nv-ohif:** fix reflection recursion + label defects (PR #76 round-2 review) ([#76](https://github.com/niivue/mono/issues/76))
- **nv-ohif:** render default annotation labels ([6fc1ab8](https://github.com/niivue/mono/commit/6fc1ab8))
- **nv-ohif:** complete measurement reflection hardening ([28d0828](https://github.com/niivue/mono/commit/28d0828))
- **nv-ohif:** correct reflected measurement geometry + reconcile (PR #76 review) ([#76](https://github.com/niivue/mono/issues/76))
- **nv-ohif:** harden measurement reflection ([3bf0798](https://github.com/niivue/mono/commit/3bf0798))
- **nv-ohif:** harden the annotation/measurement subsystem (PR #76 review) ([#76](https://github.com/niivue/mono/issues/76))
- **nv-ohif:** rebuild the annotation overlay when a label changes ([8e5ac1a](https://github.com/niivue/mono/commit/8e5ac1a))
- **nv-ohif:** add working Crosshairs + Capture buttons (distinct ids, not id-overrides) ([452aaf1](https://github.com/niivue/mono/commit/452aaf1))
- **nv-ohif:** move bundled @niivue/uikit to devDependencies so the package is installable ([9c73103](https://github.com/niivue/mono/commit/9c73103))
- **nv-ohif:** close overlay/swap async races found in the review pass ([b7867f4](https://github.com/niivue/mono/commit/b7867f4))
- correct regressions found reviewing the review-fix commits ([1a6648d](https://github.com/niivue/mono/commit/1a6648d))
- address review findings 5-10 (WSI/DICOM loaders + chunked-volume leak) ([#5](https://github.com/niivue/mono/issues/5), [#6](https://github.com/niivue/mono/issues/6), [#7](https://github.com/niivue/mono/issues/7), [#8](https://github.com/niivue/mono/issues/8), [#9](https://github.com/niivue/mono/issues/9), [#10](https://github.com/niivue/mono/issues/10))
- **nv-ohif:** reset per-series state on display-set swap + guard async overlay (review blockers 1-4) ([#1](https://github.com/niivue/mono/issues/1), [#2](https://github.com/niivue/mono/issues/2), [#3](https://github.com/niivue/mono/issues/3), [#4](https://github.com/niivue/mono/issues/4))
- **nv-ohif:** re-enable volume toolbar buttons after the volume loads ([feee4fa](https://github.com/niivue/mono/commit/feee4fa))
- address second-review findings on the ruler/WSI fixes ([d1027c6](https://github.com/niivue/mono/commit/d1027c6))
- **nv-ohif:** strip query from WSI frame imageId so tile URLs stay valid (review finding 5) ([2e44538](https://github.com/niivue/mono/commit/2e44538))
- **nv-ohif:** read WSI PixelSpacing from per-frame functional groups too (review finding 3) ([731d323](https://github.com/niivue/mono/commit/731d323))
- **nv-ohif:** hide built-in volume measurement via isMeasurementDrawn (no gray boxes) ([9135ca9](https://github.com/niivue/mono/commit/9135ca9))
- **nv-ohif:** larger DPR-aware WSI ruler label; drop duplicate status readout ([ebfb7eb](https://github.com/niivue/mono/commit/ebfb7eb))
- **nv-ohif:** prevent runaway slide rendering ([3bd58da](https://github.com/niivue/mono/commit/3bd58da))
- **nv-ohif:** cap WSI thumbnail download and decode size ([be21cb6](https://github.com/niivue/mono/commit/be21cb6))
- **nv-ohif:** WSI tiles use column/row index (not pixel offset); preserve buffer ([36d2cb5](https://github.com/niivue/mono/commit/36d2cb5))
- **nv-ohif:** robust WSI fit + event-driven render; read per-instance imageId ([7906611](https://github.com/niivue/mono/commit/7906611))
- **nv-ohif:** reverse W/L syncs siblings by id, not the throwing active command ([a6b593e](https://github.com/niivue/mono/commit/a6b593e))
- **nv-ohif:** recover multipart boundary from body when Content-Type omits it ([3dce44f](https://github.com/niivue/mono/commit/3dce44f))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.13
- Updated uikit to 0.1.0-rc.0

### Thank You

- Chris Drake
- Claude Fable 5
- Claude Opus 4.8
- Claude Opus 5
- Taylor Hanayik @hanayik