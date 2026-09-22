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