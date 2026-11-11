## 1.0.0-rc.168 (2026-11-11)

### Refactors

- ⚠️  **niivue:** rename NVSlide plane/setPlane to planeIndex/setPlaneIndex ([9cfc70a4](https://github.com/niivue/mono/commit/9cfc70a4))

### Breaking Changes

- **niivue:** rename NVSlide plane/setPlane to planeIndex/setPlaneIndex  ([9cfc70a4](https://github.com/niivue/mono/commit/9cfc70a4))
  NVSlide.plane is now NVSlide.planeIndex and
  NVSlide.setPlane() is now NVSlide.setPlaneIndex(); no aliases are kept.
  Claude-Session: https://claude.ai/code/session_01F6ttnTMSWvBfPipb4HPyjh

### Thank You

- neurolabusc

## 1.0.0-rc.167 (2026-11-11)

### Performance

- **niivue:** skip slide tile gutter copies under nearest filtering ([#684](https://github.com/niivue/mono/issues/684))

### Thank You

- neurolabusc

## 1.0.0-rc.166 (2026-11-11)

### Features

- slide demos use NVSlideController (zoom box, middle pan) ([c7e66f5b](https://github.com/niivue/mono/commit/c7e66f5b))

### Thank You

- neurolabusc

## 1.0.0-rc.165 (2026-11-11)

### Features

- **niivue:** NVSlide zoom box and middle-button pan ([2417b872](https://github.com/niivue/mono/commit/2417b872))

### Fixes

- **niivue:** end uncaptured slide gestures on leave; skip collapsed zoom box ([#713](https://github.com/niivue/mono/issues/713))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.164 (2026-11-11)

### Features

- **uikit:** slide minimap widget for NVSlide ([3960f0cc](https://github.com/niivue/mono/commit/3960f0cc))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.163 (2026-11-11)

### Fixes

- **niivue:** validate DZI descriptors and cancel superseded descriptor fetches ([d961ea51](https://github.com/niivue/mono/commit/d961ea51))
- **niivue:** keep a DZI descriptor's query on tile URLs ([78c589b4](https://github.com/niivue/mono/commit/78c589b4))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.162 (2026-11-11)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.161 (2026-11-11)

### Fixes

- guard missing OffscreenCanvas; keep tiny native Pixel Data not-tiled ([b308657c](https://github.com/niivue/mono/commit/b308657c))
- **niivue:** draw a placeholder for a slide tile that cannot be scaled ([134914d1](https://github.com/niivue/mono/commit/134914d1))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.160 (2026-11-11)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.159 (2026-11-11)

### Fixes

- **niivue:** attach-failure cleanup removes the failed viewer by identity ([ead26c44](https://github.com/niivue/mono/commit/ead26c44))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.158 (2026-11-11)

### Features

- **niivue:** side-effect-free @niivue/niivue/scene subpath (scene controller, layouts, types) ([f5a8d852](https://github.com/niivue/mono/commit/f5a8d852))

### Fixes

- **niivue:** volumeAdded reports the viewer's current index ([e34dc700](https://github.com/niivue/mono/commit/e34dc700))
- **niivue:** notify viewer creation after attachment starts ([4868616c](https://github.com/niivue/mono/commit/4868616c))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.157 (2026-11-11)

### Fixes

- **nv-ext-tile:** pin the DICOM slide tile cap to NiiVue's MAX_SLIDE_GRID ([efcba196](https://github.com/niivue/mono/commit/efcba196))
- **niivue:** fail when an oversize slide tile has no 2D context to scale it ([63d8df5f](https://github.com/niivue/mono/commit/63d8df5f))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.156 (2026-11-11)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.155 (2026-11-11)

### Fixes

- **niivue:** scale oversize slide tiles, refresh skipped gutters, inset plane UVs by texture ([2449692e](https://github.com/niivue/mono/commit/2449692e))
- **niivue:** keep slide tile gutter copies in bounds and under the texture limit ([5c00d35e](https://github.com/niivue/mono/commit/5c00d35e))
- **niivue:** 1-texel tile gutter to remove slide seams under linear filtering ([f9b9df21](https://github.com/niivue/mono/commit/f9b9df21))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.154 (2026-11-10)

### Fixes

- **niivue:** cap slide level grids and coalesce tile retry events ([76380039](https://github.com/niivue/mono/commit/76380039))

### Thank You

- neurolabusc

## 1.0.0-rc.153 (2026-11-10)

### Fixes

- **niivue:** look-ahead chunk prefetch for multi-LOD octree plans ([ec9b1396](https://github.com/niivue/mono/commit/ec9b1396))

### Thank You

- neurolabusc

## 1.0.0-rc.152 (2026-11-10)

### Features

- **niivue:** annotationChanged carries added/updated/removed ids ([#125](https://github.com/niivue/mono/pull/125))

### Thank You

- neurolabusc

## 1.0.0-rc.151 (2026-11-10)

### Features

- **demo-ext-tile:** anti-aliasing toggle works under WebGPU ([#643](https://github.com/niivue/mono/issues/643))

### Thank You

- neurolabusc

## 1.0.0-rc.150 (2026-11-10)

### Features

- **demo-ext-tile:** OME-Zarr slide menu with store credits ([2238ca69](https://github.com/niivue/mono/commit/2238ca69))

### Thank You

- neurolabusc

## 1.0.0-rc.149 (2026-11-10)

### Features

- ⚠️  **niivue:** remove deprecated NVSlide.setWindow and window getter ([#659](https://github.com/niivue/mono/issues/659))

### Breaking Changes

- **niivue:** remove deprecated NVSlide.setWindow and window getter  ([#659](https://github.com/niivue/mono/issues/659))
  `slide.setWindow(lo, hi)` -> `slide.setChannel(0,
  { calMin: lo, calMax: hi })`; `slide.window` -> `slide.channels[0]`.
  setChannel treats a non-finite bound as the default window instead of
  rejecting it, so callers validate their own input.

### Thank You

- neurolabusc

## 1.0.0-rc.148 (2026-11-10)

### Features

- **niivue,nv-mcp:** slide plane channel API; set_slide sets channels and blend ([#659](https://github.com/niivue/mono/issues/659))

### Thank You

- neurolabusc

## 1.0.0-rc.147 (2026-11-10)

### Fixes

- **niivue:** check inline demo scripts for missing element ids ([d542d90e](https://github.com/niivue/mono/commit/d542d90e))
- **niivue:** cap a one-row NVSlide view at the tile limit ([#666](https://github.com/niivue/mono/issues/666))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.146 (2026-11-10)

### Fixes

- **niivue:** NVSlide loads only the tiles that fit when no level does ([39b191bd](https://github.com/niivue/mono/commit/39b191bd))

### Thank You

- neurolabusc

## 1.0.0-rc.145 (2026-11-10)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.144 (2026-11-10)

### Fixes

- **examples:** static checks on the demos ([#586](https://github.com/niivue/mono/pull/586))

### Thank You

- neurolabusc

## 1.0.0-rc.143 (2026-11-10)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.142 (2026-11-10)

### Features

- **niivue:** multi-channel slides (NVSlide channels, setChannel, channelBlend) ([87e13ad4](https://github.com/niivue/mono/commit/87e13ad4))

### Fixes

- **niivue:** setChannel keeps a field passed as undefined ([c99b5435](https://github.com/niivue/mono/commit/c99b5435))
- **niivue:** slide channel readback copies, known fields, no fetch when all hidden ([73f48b4e](https://github.com/niivue/mono/commit/73f48b4e))
- **niivue:** slide channel audit follow-ups ([1f1fda20](https://github.com/niivue/mono/commit/1f1fda20))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.141 (2026-11-10)

### Features

- ⚠️  **niivue:** default isAntiAlias to true ([#381](https://github.com/niivue/mono/issues/381))

### Fixes

- **niivue:** turn off anti-aliasing on WebKit in the remaining WebGPU-first demos ([#381](https://github.com/niivue/mono/issues/381))

### Breaking Changes

- **niivue:** default isAntiAlias to true  ([#381](https://github.com/niivue/mono/issues/381))
  isAntiAlias defaults to true. Pages that choose the WebGPU
  backend should pass isAntiAlias: false on WebKit (Safari, iOS) to avoid the
  slowdown.

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.140 (2026-11-10)

### Features

- **niivue:** raw-gray slide tile codec ([db5b7f80](https://github.com/niivue/mono/commit/db5b7f80))

### Fixes

- **niivue:** reject raw-gray tiles with bitsStored above 16 ([259b92da](https://github.com/niivue/mono/commit/259b92da))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.139 (2026-11-10)

### Features

- **examples:** display controls on the slide examples; drop TIFF from slides.html ([9a50860c](https://github.com/niivue/mono/commit/9a50860c))

### Fixes

- **examples:** bind slide3d draw listeners to the live canvas after WebGPU fallback ([bf79b96a](https://github.com/niivue/mono/commit/bf79b96a))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.138 (2026-11-09)

### Fixes

- **examples:** use isDragDropEnabled in freesurfer.clip ([71434b59](https://github.com/niivue/mono/commit/71434b59))
- **examples:** pass the option names NiiVue reads ([#586](https://github.com/niivue/mono/issues/586))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.137 (2026-11-09)

### Fixes

- **niivue:** choose slide levels by device pixels, not CSS pixels ([#638](https://github.com/niivue/mono/issues/638))

### Thank You

- neurolabusc

## 1.0.0-rc.136 (2026-11-09)

### Fixes

- **examples, demos:** live-demo punch list batch ([c26c14a5](https://github.com/niivue/mono/commit/c26c14a5))

### Thank You

- neurolabusc

## 1.0.0-rc.135 (2026-11-09)

### Features

- **niivue:** optional 4x MSAA for SlideRendererGPU ([#638](https://github.com/niivue/mono/issues/638))

### Thank You

- neurolabusc

## 1.0.0-rc.134 (2026-11-09)

### Fixes

- **niivue:** explain chunked volumes accurately in the log ([2e48c660](https://github.com/niivue/mono/commit/2e48c660))

### Thank You

- neurolabusc

## 1.0.0-rc.133 (2026-11-09)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.132 (2026-11-09)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.131 (2026-11-09)

### Features

- **nv-ext-tile:** DicomWebWsiSource for DICOMweb whole-slide tiles ([fd930f5a](https://github.com/niivue/mono/commit/fd930f5a))

### Thank You

- neurolabusc

## 1.0.0-rc.130 (2026-11-09)

### Features

- **niivue:** rotate2D and flip2D turn and mirror slice views on screen ([6165dcb8](https://github.com/niivue/mono/commit/6165dcb8))

### Thank You

- neurolabusc

## 1.0.0-rc.129 (2026-11-09)

### Fixes

- **niivue:** record a coarse floor only once it reaches the view ([83e033fa](https://github.com/niivue/mono/commit/83e033fa))
- **niivue:** a failed chunked init undoes only its own floor set ([8c2b1638](https://github.com/niivue/mono/commit/8c2b1638))
- **niivue:** a failed chunked init leaves a newer load's floor alone ([9312a335](https://github.com/niivue/mono/commit/9312a335))
- **niivue:** a failed chunked init restores the prior coarse floor ([0e5daa4d](https://github.com/niivue/mono/commit/0e5daa4d))
- **niivue:** a failed chunked init clears the coarse floor it installed ([0bc2a824](https://github.com/niivue/mono/commit/0bc2a824))
- **niivue:** release a chunked volume whose init fails ([678be3f8](https://github.com/niivue/mono/commit/678be3f8))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.128 (2026-11-09)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.127 (2026-11-09)

### Fixes

- **niivue:** mark MGZ label volumes with the label intent ([0fecc98c](https://github.com/niivue/mono/commit/0fecc98c))

### Thank You

- neurolabusc

## 1.0.0-rc.126 (2026-11-09)

### Performance

- **niivue:** whole-voxel and tiled copies for reoriented chunk extraction ([f9feb6af](https://github.com/niivue/mono/commit/f9feb6af))

### Thank You

- neurolabusc

## 1.0.0-rc.125 (2026-11-09)

### Fixes

- **niivue:** keep the first streamline when reading TCK ([881536a0](https://github.com/niivue/mono/commit/881536a0))

### Thank You

- neurolabusc

## 1.0.0-rc.124 (2026-11-09)

### Features

- **niivue:** 2D rotate and flip for slice views ([4879f84c](https://github.com/niivue/mono/commit/4879f84c))

### Thank You

- neurolabusc

## 1.0.0-rc.123 (2026-11-09)

### Performance

- **niivue:** build the cinematic renderer on first use ([7a5e2b6f](https://github.com/niivue/mono/commit/7a5e2b6f))

### Thank You

- neurolabusc

## 1.0.0-rc.122 (2026-11-09)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.121 (2026-11-09)

### Features

- ⚠️  **niivue:** OME-Zarr exports move to @niivue/nv-ext-tile/zarr ([62b29fdb](https://github.com/niivue/mono/commit/62b29fdb))
- **niivue,nv-ext-tile:** move OME-Zarr from core to @niivue/nv-ext-tile/zarr ([9b428e29](https://github.com/niivue/mono/commit/9b428e29))

### Breaking Changes

- **niivue:** OME-Zarr exports move to @niivue/nv-ext-tile/zarr  ([62b29fdb](https://github.com/niivue/mono/commit/62b29fdb))
  the OME-Zarr names (loadOmeZarrVolumes, fetchOmeZarr,
  fetchOmeZarrChunkedSource, openOmeZarr, omeZarrChunkedSource, ByteLruCache,
  withChunkTiming, the persistent byte cache, ...) are no longer exported from
  '@niivue/niivue'. Import them from '@niivue/nv-ext-tile/zarr' instead; names
  and behaviour are unchanged.
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.120 (2026-11-09)

### Fixes

- **niivue:** declare @webgpu/types as a peer dependency ([496ebfda](https://github.com/niivue/mono/commit/496ebfda))
- **niivue:** ship @webgpu/types for the published declarations ([#570](https://github.com/niivue/mono/issues/570))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.119 (2026-11-08)

### Fixes

- **niivue:** a failed attach keeps the hold while another attach is pending or one succeeded ([3fa6964e](https://github.com/niivue/mono/commit/3fa6964e))
- **niivue:** a failed attach lets go of its page worker hold ([b415d9c3](https://github.com/niivue/mono/commit/b415d9c3))
- **niivue:** end page-wide workers when the last viewer is destroyed ([801973b5](https://github.com/niivue/mono/commit/801973b5))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.118 (2026-11-08)

### Fixes

- **niivue:** keep tract scalar metadata for prototype-named scalars ([8d55ef24](https://github.com/niivue/mono/commit/8d55ef24))
- **niivue:** accept visibleGroups null; keep TRK prototype-named scalars ([939a1669](https://github.com/niivue/mono/commit/939a1669))
- **niivue:** keep TRX names that collide with Object.prototype as own keys ([07c00f11](https://github.com/niivue/mono/commit/07c00f11))
- **niivue:** guard tract groups, label IDs, mesh colormaps and focus box ([#572](https://github.com/niivue/mono/issues/572), [#575](https://github.com/niivue/mono/issues/575), [#576](https://github.com/niivue/mono/issues/576))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.117 (2026-11-08)

### Fixes

- **examples:** slides keeps a failed pool's other tiles decoding ([a516870c](https://github.com/niivue/mono/commit/a516870c))
- **nv-ohif:** retry a tile once on a fresh pool after a worker failure ([79c27c0c](https://github.com/niivue/mono/commit/79c27c0c))
- **nv-ohif:** tell an abort rejection from a worker death by its reason ([#595](https://github.com/niivue/mono/issues/595))
- **nv-ohif:** keep the decoder pool when an aborted tile rejects with a plain Error ([#595](https://github.com/niivue/mono/issues/595))
- **nv-ohif:** replace the dcm2niix tile decoder pool when its workers die ([25925f7d](https://github.com/niivue/mono/commit/25925f7d))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.116 (2026-11-07)

### Fixes

- **niivue,uikit:** ruler majors every fifth drawn tick under decimation ([c6a0cb48](https://github.com/niivue/mono/commit/c6a0cb48))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.115 (2026-11-07)

### Fixes

- **examples:** reload with the running backend when attach falls back ([f4ab37ad](https://github.com/niivue/mono/commit/f4ab37ad))
- **examples:** choose the streaming budget from a WebGPU device, not an adapter ([6ad333f0](https://github.com/niivue/mono/commit/6ad333f0))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.114 (2026-11-07)

### Fixes

- **niivue:** abort a timed-out manifest error body, match JSON case-insensitively ([5e6d1c65](https://github.com/niivue/mono/commit/5e6d1c65))
- **niivue:** bound the slide manifest error-body read ([5b52e942](https://github.com/niivue/mono/commit/5b52e942))
- **niivue,iiif-volumetric-server:** refuse an unsupported WSI syntax with 415 and its reason ([7d195c9c](https://github.com/niivue/mono/commit/7d195c9c))
- **niivue:** coalesce slide rewindowing and tighten WSI codec checks ([434175a4](https://github.com/niivue/mono/commit/434175a4))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.113 (2026-11-07)

### Fixes

- **niivue:** getCanvasImage returns null when no frame was drawn ([4b61b9cf](https://github.com/niivue/mono/commit/4b61b9cf))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.112 (2026-11-07)

### Fixes

- **niivue:** bound ITK-Wasm CBOR reads before allocating ([9e313c31](https://github.com/niivue/mono/commit/9e313c31))

### Thank You

- neurolabusc

## 1.0.0-rc.111 (2026-11-07)

### Fixes

- **niivue:** loadMeshes emits meshLoaded only for meshes the model adds ([9c77b1c0](https://github.com/niivue/mono/commit/9c77b1c0))

### Thank You

- neurolabusc

## 1.0.0-rc.110 (2026-11-07)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.109 (2026-11-06)

### Features

- **niivue:** getCanvasImage reads the drawn canvas synchronously ([0f6a5679](https://github.com/niivue/mono/commit/0f6a5679))

### Thank You

- neurolabusc

## 1.0.0-rc.108 (2026-11-06)

### Features

- **niivue:** apply slide ICC profiles through a registered colour transform ([4be73dc9](https://github.com/niivue/mono/commit/4be73dc9))
- **examples:** DICOM-WSI showcase slides in the slides demo ([586c7fe1](https://github.com/niivue/mono/commit/586c7fe1))

### Fixes

- **niivue:** ICC review fixes: null table, size check, LRU caches, no mid-pass destroy ([de7f3a74](https://github.com/niivue/mono/commit/de7f3a74))
- **niivue:** leave grey slides unmanaged; cap colour-table caches; slides demo bakes profiles ([426fc073](https://github.com/niivue/mono/commit/426fc073))
- **nv-ext-wsi,demo-ext-wsi:** rank focal planes; linear nesting test ([6c30eca1](https://github.com/niivue/mono/commit/6c30eca1))

### Thank You

- neurolabusc

## 1.0.0-rc.107 (2026-11-06)

### Features

- **niivue:** per-tile slide files and listed sparse levels ([4dca555f](https://github.com/niivue/mono/commit/4dca555f))
- **niivue:** sparse slide levels with holes ([1558f013](https://github.com/niivue/mono/commit/1558f013))

### Fixes

- **niivue:** place listed sparse tiles by position, without changing the caller's manifest ([3951daf9](https://github.com/niivue/mono/commit/3951daf9))

### Thank You

- neurolabusc

## 1.0.0-rc.106 (2026-11-06)

### Fixes

- **niivue:** keep file label tables on mesh layer reload and re-send ([abdb67f6](https://github.com/niivue/mono/commit/abdb67f6))
- **niivue:** mesh layers look up label colormaps by ID ([5bb425c3](https://github.com/niivue/mono/commit/5bb425c3))

### Thank You

- Brent McPherson @bcmcpher
- Claude Opus 5.5

## 1.0.0-rc.105 (2026-11-06)

### Fixes

- **niivue:** price the planner's lower bound at the plan's bytes per voxel ([993a8ec9](https://github.com/niivue/mono/commit/993a8ec9))
- **niivue:** re-stream lit bricks when a plan swap turns unlit ([2692e129](https://github.com/niivue/mono/commit/2692e129))
- **niivue:** price unlit chunked plans and the decoded tier at 4 bytes per voxel ([#167](https://github.com/niivue/mono/issues/167), [#203](https://github.com/niivue/mono/issues/203))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.104 (2026-11-06)

### Fixes

- **niivue:** keep a combined mirror on the base grid when its own plan is swapped ([c328093b](https://github.com/niivue/mono/commit/c328093b))
- **niivue:** follow a superseding swap instead of evicting the chunked entry ([6fa2e3ac](https://github.com/niivue/mono/commit/6fa2e3ac))
- **niivue:** run chunk plan swaps on one entry one at a time ([847b5ee1](https://github.com/niivue/mono/commit/847b5ee1))
- leave combined mirrors on the newest plan when base swaps overlap ([dad5733b](https://github.com/niivue/mono/commit/dad5733b))
- catch a combined mirror up to a base plan swapped during its rebuild ([be4a47dc](https://github.com/niivue/mono/commit/be4a47dc))
- **niivue:** keep the central chunk over edge fits, move mirrors with base swaps ([f0da60d5](https://github.com/niivue/mono/commit/f0da60d5))
- **niivue:** keep a tile's central chunk and stream mirrors on the base plan ([8547ef90](https://github.com/niivue/mono/commit/8547ef90))
- **niivue:** keep a tile's first chunk, split mirror budgets evenly ([a6d5c304](https://github.com/niivue/mono/commit/a6d5c304))
- **niivue:** cap the frame's union of tile requests, not each tile ([6b355728](https://github.com/niivue/mono/commit/6b355728))
- **niivue:** cap chunked working sets against combined-overlay mirror budgets ([#188](https://github.com/niivue/mono/issues/188))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.103 (2026-11-06)

### Performance

- **niivue:** project world-space box outlines on the GPU per render tile ([#347](https://github.com/niivue/mono/issues/347))

### Thank You

- neurolabusc

## 1.0.0-rc.102 (2026-11-06)

### Features

- **niivue:** visibleGroups shows a subset of tract groups, keeping colorBy ([#340](https://github.com/niivue/mono/issues/340))

### Thank You

- neurolabusc

## 1.0.0-rc.101 (2026-11-06)

### Features

- **examples:** monochrome JPEG-LS test slides in the slides demo ([15df284d](https://github.com/niivue/mono/commit/15df284d))
- **niivue,nv-ohif:** keep the slide ICC profile in DICOM-WSI manifests ([c60bc6d3](https://github.com/niivue/mono/commit/c60bc6d3))
- **examples:** JPEG-LS and a monochrome window in the slides demo ([9c4ac1cf](https://github.com/niivue/mono/commit/9c4ac1cf))
- **nv-ohif,niivue:** JPEG-LS and monochrome DICOM-WSI levels ([93ce9bb0](https://github.com/niivue/mono/commit/93ce9bb0))
- **niivue:** window monochrome slide tiles from kept samples ([5c496bc2](https://github.com/niivue/mono/commit/5c496bc2))

### Fixes

- **niivue,nv-ohif:** audit fixes for monochrome slide windowing ([992b53e6](https://github.com/niivue/mono/commit/992b53e6))
- **niivue:** window and invert monochrome tiles from bitmap-only decoders ([9ebf5f80](https://github.com/niivue/mono/commit/9ebf5f80))
- **niivue:** crop padded monochrome sample frames to their tile ([d02e4b5c](https://github.com/niivue/mono/commit/d02e4b5c))

### Thank You

- neurolabusc

## 1.0.0-rc.100 (2026-11-06)

### Features

- **examples:** WebGPU, anti-aliasing and interpolation controls in the slide demos ([a2562242](https://github.com/niivue/mono/commit/a2562242))
- **examples:** toggle the slide demo HUD panels ([989d999d](https://github.com/niivue/mono/commit/989d999d))

### Fixes

- **examples:** audit fixes for the slide demo controls ([47ba79ef](https://github.com/niivue/mono/commit/47ba79ef))

### Thank You

- neurolabusc

## 1.0.0-rc.99 (2026-11-06)

### Features

- **niivue:** report when a slide level exceeds the tile-cache budget ([5c56ea7f](https://github.com/niivue/mono/commit/5c56ea7f))
- **niivue,nv-ohif:** play JPEG 2000 DICOM-WSI through dcm2niix ([f64aca57](https://github.com/niivue/mono/commit/f64aca57))

### Fixes

- **niivue,nv-ohif:** show DICOM-WSI with row 0 at the top ([48d6cf2e](https://github.com/niivue/mono/commit/48d6cf2e))
- **niivue:** back off before re-requesting a failed slide tile ([121b8393](https://github.com/niivue/mono/commit/121b8393))
- **niivue:** crop padded slide frames to their tile ([9ef1d363](https://github.com/niivue/mono/commit/9ef1d363))
- **niivue:** budget slide levels by full decoded tiles ([35e30ca0](https://github.com/niivue/mono/commit/35e30ca0))
- **niivue:** show a coarser slide level when the chosen one overflows the tile cache ([9fa4143e](https://github.com/niivue/mono/commit/9fa4143e))
- **niivue,nv-ohif:** audit fixes for JPEG 2000 WSI playback ([5480bf7c](https://github.com/niivue/mono/commit/5480bf7c))

### Thank You

- neurolabusc

## 1.0.0-rc.98 (2026-11-06)

### Fixes

- ⚠️  **niivue:** drop rotation and viewport from NVInstance ([#345](https://github.com/niivue/mono/issues/345))

### Breaking Changes

- **niivue:** drop rotation and viewport from NVInstance  ([#345](https://github.com/niivue/mono/issues/345))
  NVInstance no longer has rotation or viewport. Both were
  ignored; remove them from setInstances / opts.instances calls.
  Closes #345
  Claude-Session: https://claude.ai/code/session_01F6ttnRe1rzpJhKCkc8MraG

### Thank You

- neurolabusc

## 1.0.0-rc.97 (2026-11-06)

### Fixes

- **niivue:** refuse CBOR documents whose headers declare more items than the file holds ([#386](https://github.com/niivue/mono/issues/386))

### Thank You

- neurolabusc

## 1.0.0-rc.96 (2026-11-06)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.95 (2026-11-06)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.94 (2026-11-06)

### Fixes

- report micrometer voxels in mm for extensions and clickToSegment; warn on mixed units in loadVolumes ([20c8db12](https://github.com/niivue/mono/commit/20c8db12))
- report micrometer voxel volumes in mm3 and thin ruler ticks in 1/2/5 steps ([532fb356](https://github.com/niivue/mono/commit/532fb356))
- **niivue:** read the world unit from xyzt_units for ruler and labels ([#202](https://github.com/niivue/mono/issues/202))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.93 (2026-11-05)

### Fixes

- **niivue:** unregister a controller whose single-backend attach failed ([c748c527](https://github.com/niivue/mono/commit/c748c527))
- **niivue:** keep a failed thumbnail reload from aborting a single-backend rebuild ([1dcfe5ce](https://github.com/niivue/mono/commit/1dcfe5ce))
- single-backend views restore the drawing and emit viewDestroyed/viewAttached like viewBoth ([8471289a](https://github.com/niivue/mono/commit/8471289a))
- **niivue:** keep the canvas viewport and registry across view recreation ([b596fd2b](https://github.com/niivue/mono/commit/b596fd2b))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.92 (2026-11-05)

### Fixes

- **niivue:** still give a viewless sibling the new backend ([6cf8d971](https://github.com/niivue/mono/commit/6cf8d971))
- **niivue:** limit the antialias refusal to WebGL2, skip destroyed siblings ([d25fada2](https://github.com/niivue/mono/commit/d25fada2))
- **niivue:** publish the recreated single-backend view ([39c19a1e](https://github.com/niivue/mono/commit/39c19a1e))
- **niivue:** recreate the canvas when antialiasing changes ([ca8f605e](https://github.com/niivue/mono/commit/ca8f605e))
- **niivue:** never let a bad thumbnail abort attach or a view rebuild ([1d6bbbd1](https://github.com/niivue/mono/commit/1d6bbbd1))
- **niivue:** keep a failed thumbnail reload from aborting a view rebuild ([faf0f611](https://github.com/niivue/mono/commit/faf0f611))
- **niivue:** finish a shared-canvas backend switch for every controller ([0c9fbb2d](https://github.com/niivue/mono/commit/0c9fbb2d))
- **niivue:** keep rebuilding siblings after one fails on a backend switch ([4a066f0b](https://github.com/niivue/mono/commit/4a066f0b))
- restore siblings when a shared-canvas backend switch fails ([ee90a2b9](https://github.com/niivue/mono/commit/ee90a2b9))
- take sibling handlers off the old shared canvas on a backend switch ([4d8a5f54](https://github.com/niivue/mono/commit/4d8a5f54))
- keep same-backend recreates cloning, and clone a detached canvas WebGPU locked before failing ([fb4410ce](https://github.com/niivue/mono/commit/fb4410ce))
- **niivue:** keep a detached canvas on same-backend recreation, clone it on a backend switch ([5af39862](https://github.com/niivue/mono/commit/5af39862))
- **niivue:** keep shared-canvas siblings in step on backend and ratio restarts ([8cccb858](https://github.com/niivue/mono/commit/8cccb858))
- **niivue:** decide canvas sharing from the registry, not bounds ([067d9838](https://github.com/niivue/mono/commit/067d9838))
- **niivue:** keep a detached canvas on the universal fallback ([c8270aee](https://github.com/niivue/mono/commit/c8270aee))
- **niivue:** keep the canvas viewport and registry across view recreation ([ff250a97](https://github.com/niivue/mono/commit/ff250a97))
- **niivue:** keep the webgl2 and webgpu subpath builds backend-isolated ([#175](https://github.com/niivue/mono/issues/175))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.91 (2026-11-05)

### Fixes

- **niivue:** throw on a PLY header with no vertices or faces ([010005b6](https://github.com/niivue/mono/commit/010005b6))

### Thank You

- neurolabusc

## 1.0.0-rc.90 (2026-11-05)

### Features

- **niivue:** export isAnnotationErased and generateShape ([b331f27b](https://github.com/niivue/mono/commit/b331f27b))

### Fixes

- leave a shape untouched when the eraser misses it ([7f2b0a50](https://github.com/niivue/mono/commit/7f2b0a50))
- **niivue:** judge only rebuildable shapes in isAnnotationErased ([f3c9f363](https://github.com/niivue/mono/commit/f3c9f363))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.89 (2026-11-05)

### Features

- **nv-ext-tiff:** stream tiled/pyramidal TIFF and SVS slides via geotiff ([#179](https://github.com/niivue/mono/issues/179))

### Fixes

- **niivue:** centre a slide when the view is larger than it ([d323d37b](https://github.com/niivue/mono/commit/d323d37b))

### Thank You

- neurolabusc

## 1.0.0-rc.88 (2026-11-05)

### Fixes

- make destroy() idempotent ([dc41eef8](https://github.com/niivue/mono/commit/dc41eef8))

### Thank You

- neurolabusc

## 1.0.0-rc.87 (2026-11-04)

### Features

- **niivue:** corner orientation text option ([3370054c](https://github.com/niivue/mono/commit/3370054c))

### Thank You

- Claude Opus 5.5
- Taylor Hanayik @hanayik

## 1.0.0-rc.86 (2026-11-04)

### Fixes

- **niivue:** apply a document volume's id and links only to a volume it added ([71f07944](https://github.com/niivue/mono/commit/71f07944))
- **niivue:** give volumes loaded from the same URL distinct ids ([4928ef52](https://github.com/niivue/mono/commit/4928ef52))

### Thank You

- Claude Opus 5.5
- Taylor Hanayik @hanayik

## 1.0.0-rc.85 (2026-11-04)

### Features

- **niivue:** add isSagittalNoseLeft, independent of isRadiological ([93debd5d](https://github.com/niivue/mono/commit/93debd5d))

### Fixes

- **niivue:** pin classic NVD sagittal nose to classic's default ([b07d1dad](https://github.com/niivue/mono/commit/b07d1dad))

### Thank You

- Claude Opus 5.5
- Taylor Hanayik @hanayik

## 1.0.0-rc.84 (2026-11-04)

### Features

- **niivue:** ship a self-contained ESM build for bundler-free use ([e75292bf](https://github.com/niivue/mono/commit/e75292bf))
- **niivue:** find the .BRIK for a .HEAD URL automatically ([3717a339](https://github.com/niivue/mono/commit/3717a339))

### Thank You

- Claude Opus 5.5
- Taylor Hanayik @hanayik

## 1.0.0-rc.83 (2026-11-04)

### Fixes

- step over JPEG restart markers when reading the size ([897610ea](https://github.com/niivue/mono/commit/897610ea))
- give a window set during streaming to the coarse floor and handle too ([931b9fb7](https://github.com/niivue/mono/commit/931b9fb7))
- size a GIF by its first frame, refuse a JPEG with a DNL height ([2d7aa5f6](https://github.com/niivue/mono/commit/2d7aa5f6))
- **niivue:** skip 0xff fill bytes in the JPEG size scan ([#534](https://github.com/niivue/mono/issues/534))
- **niivue:** refuse an oversized image volume before decoding it ([#472](https://github.com/niivue/mono/issues/472), [#511](https://github.com/niivue/mono/issues/511))
- **niivue:** keep a window set while a chunked volume's sample streams in ([#489](https://github.com/niivue/mono/issues/489))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.82 (2026-11-03)

### Fixes

- **niivue:** FIB/SRC z spacing and MHA without TransformMatrix ([#536](https://github.com/niivue/mono/issues/536))

### Thank You

- neurolabusc

## 1.0.0-rc.81 (2026-11-03)

### Fixes

- **niivue:** map the drawing mask from its own grid ([8789a29d](https://github.com/niivue/mono/commit/8789a29d))
- **niivue:** getDescriptives masks and drawing on another voxel grid ([#337](https://github.com/niivue/mono/issues/337))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.80 (2026-11-03)

### Fixes

- **niivue:** multi-click contours on oblique volumes stay on their slice ([#469](https://github.com/niivue/mono/issues/469))

### Thank You

- neurolabusc

## 1.0.0-rc.79 (2026-11-03)

### Features

- ⚠️  **niivue:** rename alpha blend OVER to UNION ([#358](https://github.com/niivue/mono/issues/358))

### Fixes

- validate layoutInset in setter, options and documents ([#494](https://github.com/niivue/mono/issues/494))
- emit change from loadMatcap and report matcap by name in nv-mcp ([#460](https://github.com/niivue/mono/issues/460), [#462](https://github.com/niivue/mono/issues/462))

### Performance

- **niivue:** skip multi-LOD candidates that cannot fit the budget ([#201](https://github.com/niivue/mono/issues/201))

### Breaking Changes

- **niivue:** rename alpha blend OVER to UNION  ([#358](https://github.com/niivue/mono/issues/358))
  OVERLAY_ALPHA_BLEND.OVER is now OVERLAY_ALPHA_BLEND.UNION,
  and the nv-mcp volumeOverlayAlphaBlend choice 'over' is now 'union'.
  Numeric value 2 still works.
  Claude-Session: https://claude.ai/code/session_01F6ttnQfdKTLt8jfvVRr7i4

### Thank You

- Claude
- neurolabusc

## 1.0.0-rc.78 (2026-11-03)

### Fixes

- **niivue:** whenUpdatesSettle follows a takeover to the rebuild that replaced its pass ([218bafef](https://github.com/niivue/mono/commit/218bafef))
- **niivue:** stop a waiting rebuild at destroy; settle the lock holder with its own pass ([9b370f96](https://github.com/niivue/mono/commit/9b370f96))
- **niivue:** settle each coalesced caller with its own pass ([#466](https://github.com/niivue/mono/issues/466))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.77 (2026-11-03)

### Fixes

- settle post-destroy update callers and document unreported rebuild failures ([1225f424](https://github.com/niivue/mono/commit/1225f424))
- preserve update waiter ownership and report settings timeouts ([8ea97e22](https://github.com/niivue/mono/commit/8ea97e22))
- **niivue:** settle queued GPU-update callers on view takeover and destroy ([#466](https://github.com/niivue/mono/issues/466))
- **nv-mcp:** answer set_options once the GPU rebuild it started settles ([#447](https://github.com/niivue/mono/issues/447))
- **niivue:** settle a coalesced GPU update with the follow-up that carries it ([#447](https://github.com/niivue/mono/issues/447), [#273](https://github.com/niivue/mono/issues/273))

### Thank You

- Chris Drake
- Claude
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.76 (2026-11-03)

### Features

- **niivue:** zarrVersion option skips the OME-Zarr format probe ([e0bb3066](https://github.com/niivue/mono/commit/e0bb3066))
- **niivue:** slide renderers take isNearestInterpolation ([d2cea204](https://github.com/niivue/mono/commit/d2cea204))
- **niivue:** keepUntilCovered swap policy for streamed volumes ([03a309f3](https://github.com/niivue/mono/commit/03a309f3))
- **niivue:** slide rulers and contrast box, planeOutlines for a field of view ([180396f3](https://github.com/niivue/mono/commit/180396f3))
- **niivue:** NVSlideController, primary and secondary gestures for NVSlide ([d5c27040](https://github.com/niivue/mono/commit/d5c27040))
- **dandi-demo:** link the panes' crosshair depth and colour ([e29833b7](https://github.com/niivue/mono/commit/e29833b7))

### Fixes

- union retiree groups as a disjoint set; audit tidy-ups ([9ee5fead](https://github.com/niivue/mono/commit/9ee5fead))
- draw the full segment when a slice crosses outline corners ([948d595a](https://github.com/niivue/mono/commit/948d595a))
- address review findings on slide gestures and streaming ([af729fe9](https://github.com/niivue/mono/commit/af729fe9))
- **niivue:** dev server app files: 404 for folders and paths outside the app ([e1f12462](https://github.com/niivue/mono/commit/e1f12462))
- **niivue:** dev server runs NiiVue from source and generates fixtures ([1394c3da](https://github.com/niivue/mono/commit/1394c3da))
- **niivue:** dev server sends demo app data files as bytes, 404s missing ones ([da0febf6](https://github.com/niivue/mono/commit/da0febf6))
- final audit nits for plane outlines; demo README names the default ([9dfaf579](https://github.com/niivue/mono/commit/9dfaf579))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.75 (2026-11-02)

### Fixes

- **niivue:** refit the scene after tract/connectome retessellation ([95b54ed5](https://github.com/niivue/mono/commit/95b54ed5))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.74 (2026-11-02)

### Fixes

- **niivue:** a resize never collapses a shape to no area ([#504](https://github.com/niivue/mono/issues/504))
- **niivue:** a resize keeps an erased shape's erasure ([#504](https://github.com/niivue/mono/issues/504))
- **niivue:** an abandoned resize restores the polygons as drawn ([#504](https://github.com/niivue/mono/issues/504))
- **niivue:** revert an abandoned control-point resize ([10df76a9](https://github.com/niivue/mono/commit/10df76a9))
- **ipyniivue:** skip @internal members in codegen ([#476](https://github.com/niivue/mono/issues/476))
- **niivue:** a scene change also ends a control-point resize drag ([e988b98a](https://github.com/niivue/mono/commit/e988b98a))
- **niivue:** a scene change ends the annotation drag it abandons ([30764a8b](https://github.com/niivue/mono/commit/30764a8b))
- **niivue:** volume moves and held strokes drop the half-drawn annotation ([a9f423ce](https://github.com/niivue/mono/commit/a9f423ce))
- **niivue:** Escape also ends the drag it interrupts ([40feb84f](https://github.com/niivue/mono/commit/40feb84f))
- **niivue:** drop a half-drawn annotation when the scene is replaced ([#470](https://github.com/niivue/mono/issues/470))
- **niivue:** annotation screen shapes for every tile that shows them ([#116](https://github.com/niivue/mono/issues/116))
- **niivue:** Escape mid-drag cancels the annotation drag too ([#471](https://github.com/niivue/mono/issues/471))
- **niivue:** an erase keeps annotations its brush did not reach ([#486](https://github.com/niivue/mono/issues/486))

### Thank You

- neurolabusc

## 1.0.0-rc.73 (2026-11-02)

### Fixes

- **niivue:** refuse oversized thumbnail and matcap images before decoding ([#385](https://github.com/niivue/mono/issues/385))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.72 (2026-11-02)

### Fixes

- **niivue:** volumeMatcap setter reloads the rendered matcap texture ([#458](https://github.com/niivue/mono/issues/458))
- **niivue:** resolve matcap names in the volumeMatcap setter and loadMatcap ([#442](https://github.com/niivue/mono/issues/442), [#443](https://github.com/niivue/mono/issues/443))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.71 (2026-11-02)

### Fixes

- **niivue:** fontScale and fontMinSize resize the text at once ([#377](https://github.com/niivue/mono/issues/377))

### Thank You

- neurolabusc

## 1.0.0-rc.70 (2026-11-02)

### Features

- **niivue:** layoutInset; demo toolbars, uikit pages and local site fixes ([#488](https://github.com/niivue/mono/issues/488))

### Thank You

- neurolabusc

## 1.0.0-rc.69 (2026-11-02)

### Features

- **niivue:** cinematic demo extracted-T1 preset, clip colour menu ([e983405e](https://github.com/niivue/mono/commit/e983405e))
- **niivue:** cinematic cut face takes a negative clipPlaneColor tint ([#482](https://github.com/niivue/mono/issues/482))

### Thank You

- neurolabusc

## 1.0.0-rc.68 (2026-11-02)

### Fixes

- **niivue:** mesh slab follows the displayed voxel plane ([#451](https://github.com/niivue/mono/issues/451))

### Thank You

- neurolabusc

## 1.0.0-rc.67 (2026-11-02)

### Fixes

- **nv-mcp:** check set_volume's window before changing anything ([e14a4749](https://github.com/niivue/mono/commit/e14a4749))
- audit fixes for the colormap window paths ([#481](https://github.com/niivue/mono/pull/481))
- **niivue:** CT colormap window for streamed volumes, one bound and re-sent maps ([#395](https://github.com/niivue/mono/issues/395))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.66 (2026-11-02)

### Fixes

- **niivue:** draw a hidden legend swatch as one bordered panel ([#478](https://github.com/niivue/mono/issues/478))

### Thank You

- neurolabusc

## 1.0.0-rc.65 (2026-11-02)

### Fixes

- **niivue:** annotation screen shapes and stats cover every polygon ([#115](https://github.com/niivue/mono/issues/115))

### Thank You

- neurolabusc

## 1.0.0-rc.64 (2026-11-01)

### Features

- **niivue:** multi-column scrolling legend for large atlases ([36c75924](https://github.com/niivue/mono/commit/36c75924))
- **niivue:** cinematic isStochasticLighting, one shadow/AO sample per ray ([8ed98530](https://github.com/niivue/mono/commit/8ed98530))
- **niivue:** cinematic demo sample with streamlines; document mesh and legend limits ([7ebbbef7](https://github.com/niivue/mono/commit/7ebbbef7))
- **niivue:** cinematicFrameMs GPU timing; cinematic audit fixes ([f99f2a42](https://github.com/niivue/mono/commit/f99f2a42))
- **niivue:** standard overlays in cinematic mode ([8ad132f5](https://github.com/niivue/mono/commit/8ad132f5))
- **niivue:** WebGL2 cinematic renderer in the render tile loop ([f2b9131e](https://github.com/niivue/mono/commit/f2b9131e))
- **niivue:** MNI152 sample in the cinematic demo (default preset) ([091fc389](https://github.com/niivue/mono/commit/091fc389))
- **niivue:** cinematic demo 'default' preset for scans that are not CT ([3be54ac3](https://github.com/niivue/mono/commit/3be54ac3))
- **niivue:** cinematic demo on the public API ([6496f7ff](https://github.com/niivue/mono/commit/6496f7ff))
- **niivue:** WebGL2 draws CINEMATIC as COMPOSITE until its port lands ([f9baa411](https://github.com/niivue/mono/commit/f9baa411))
- **niivue:** WebGPU cinematic renderer in the render tile loop ([62b25e37](https://github.com/niivue/mono/commit/62b25e37))
- **niivue:** shared cinematic CPU module ([1c7ebf6f](https://github.com/niivue/mono/commit/1c7ebf6f))
- **niivue:** VOLUME_RENDER_MODE.CINEMATIC and volumeCinematic settings ([87e4902b](https://github.com/niivue/mono/commit/87e4902b))
- **niivue:** CT label-modulated preset, default for labelled CTs ([a9ae6205](https://github.com/niivue/mono/commit/a9ae6205))
- **niivue:** index links for Cinematic CT and Cinematic Labeled MR ([95687a41](https://github.com/niivue/mono/commit/95687a41))
- **niivue:** legend hides labels in cinematic mode; label-modulated T1 by default ([855c08be](https://github.com/niivue/mono/commit/855c08be))
- **niivue:** T1 label-modulated preset and CT_AbdoPelvis sample ([16f86c3e](https://github.com/niivue/mono/commit/16f86c3e))
- **niivue:** MRI (SIAM T1) label rendering with label-median calibration ([c40dcae5](https://github.com/niivue/mono/commit/c40dcae5))
- **niivue:** per-label visibility toggled from the legend colour box ([307bfa3f](https://github.com/niivue/mono/commit/307bfa3f))
- **niivue:** darker label albedo, surfaceness floor and stronger AO for labels ([db959e50](https://github.com/niivue/mono/commit/db959e50))
- **niivue:** label-driven materials in the cinematic demo ([560e4df2](https://github.com/niivue/mono/commit/560e4df2))
- **niivue:** background color picker in the cinematic demo ([6ec16b14](https://github.com/niivue/mono/commit/6ec16b14))
- **niivue:** AA checkbox in the cinematic demo (on by default) ([ac6058a8](https://github.com/niivue/mono/commit/ac6058a8))
- **niivue:** cinematic demo status shows mode (backend) at lower right ([845d4c75](https://github.com/niivue/mono/commit/845d4c75))
- **niivue:** cinematic demo keeps NiiVue's orientation cube; backend checkbox ([f8780813](https://github.com/niivue/mono/commit/f8780813))
- **niivue:** cinematic CT rendering prototype (WebGPU example) ([7fedb896](https://github.com/niivue/mono/commit/7fedb896))

### Fixes

- **niivue:** legend scrollbar sits inside its backing ([00ccd4d4](https://github.com/niivue/mono/commit/00ccd4d4))
- **niivue:** legend layout uses the font it draws with ([144c2b53](https://github.com/niivue/mono/commit/144c2b53))
- **niivue:** legend scroll resets when its source changes ([2cfab3a9](https://github.com/niivue/mono/commit/2cfab3a9))
- **niivue:** WebGL2 cinematic detaches its prep framebuffer ([c1dfe1d0](https://github.com/niivue/mono/commit/c1dfe1d0))
- **niivue:** warn that cinematic render tiles omit the drawing layer ([7838814d](https://github.com/niivue/mono/commit/7838814d))
- **niivue:** cinematic draws labels over a hidden background ([98770e20](https://github.com/niivue/mono/commit/98770e20))
- **niivue:** cinematic keeps out-of-range and NaN intensities correct ([f2a4f86c](https://github.com/niivue/mono/commit/f2a4f86c))
- **niivue:** RGB and RGBA backgrounds draw COMPOSITE in cinematic ([6afe5a80](https://github.com/niivue/mono/commit/6afe5a80))
- **niivue:** cinematic geometry follows the volume affine ([08737b2e](https://github.com/niivue/mono/commit/08737b2e))
- **niivue:** cinematic rand() stays below 1 ([9e7861d0](https://github.com/niivue/mono/commit/9e7861d0))
- **niivue:** cinematic cut faces unlit, like the classic renderer ([a409060e](https://github.com/niivue/mono/commit/a409060e))
- **niivue:** cinematic demo adopts a volume dropped on the canvas ([eb63dfc8](https://github.com/niivue/mono/commit/eb63dfc8))
- **niivue:** cinematic view fits NiiVue's render tile; classic fallback without WebGPU ([cc2bc9fb](https://github.com/niivue/mono/commit/cc2bc9fb))
- **niivue:** legend toggle decides from the live hiddenLabels list ([aea72474](https://github.com/niivue/mono/commit/aea72474))
- **niivue:** cinematic cutaway with no planes; cut-face lighting only past the face ([c7d8b9d8](https://github.com/niivue/mono/commit/c7d8b9d8))
- **niivue:** cinematic demo drops CT_Pancreas; AbdoPelvis URLs past a cached 404 ([45359cf9](https://github.com/niivue/mono/commit/45359cf9))
- **niivue:** draw a hidden legend label as an outline that survives transparent canvases ([a56cf886](https://github.com/niivue/mono/commit/a56cf886))
- **niivue:** version the WholeBody label URL past a CDN-cached 404 ([f515a569](https://github.com/niivue/mono/commit/f515a569))
- **niivue:** cinematic demo reports load failures in the status bar ([483bc8ae](https://github.com/niivue/mono/commit/483bc8ae))
- **niivue:** cinematic demo depth-tests the crosshair; backend-aware status text ([7e25b34f](https://github.com/niivue/mono/commit/7e25b34f))

### Thank You

- Claude Opus 5.5
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.63 (2026-11-01)

### Features

- **medgfx:** remove meshes and replace or add on drop ([#109](https://github.com/niivue/mono/issues/109))

### Thank You

- neurolabusc

## 1.0.0-rc.62 (2026-10-31)

### Fixes

- **niivue:** graph double-click keeps its action mid-contour; audit cleanups ([#114](https://github.com/niivue/mono/issues/114), [#111](https://github.com/niivue/mono/issues/111))
- **niivue:** oblique-safe bidirectional slice test, ignore off-slice dblclick mid-contour, loadDocument clears annotation undo ([#111](https://github.com/niivue/mono/issues/111), [#114](https://github.com/niivue/mono/issues/114), [#113](https://github.com/niivue/mono/issues/113))
- **niivue:** keep half-drawn annotations on their own slice and scene ([#111](https://github.com/niivue/mono/issues/111), [#112](https://github.com/niivue/mono/issues/112), [#113](https://github.com/niivue/mono/issues/113), [#114](https://github.com/niivue/mono/issues/114))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.61 (2026-10-30)

### Fixes

- **niivue:** validate document byte arrays before copying ([e95be24b](https://github.com/niivue/mono/commit/e95be24b))
- **niivue:** require a typed array before trusting an embedded image size ([a846faad](https://github.com/niivue/mono/commit/a846faad))
- **niivue:** bound embedded volume headers, slide drawing pixels, and Set/Map contents ([#463](https://github.com/niivue/mono/issues/463))
- **niivue:** walk documents without pushing plain values, and update the medgfx debt note ([#463](https://github.com/niivue/mono/issues/463), [#385](https://github.com/niivue/mono/issues/385), [#386](https://github.com/niivue/mono/issues/386))
- **niivue:** bound document size and drawing allocations in loadDocument ([#383](https://github.com/niivue/mono/issues/383), [#384](https://github.com/niivue/mono/issues/384))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.60 (2026-10-30)

### Features

- **niivue:** expose nv.version and report it in nv-mcp capabilities ([#257](https://github.com/niivue/mono/issues/257))

### Fixes

- **niivue:** keep declaration output rooted at src ([483090b8](https://github.com/niivue/mono/commit/483090b8))
- **niivue:** 'v' hotkey logs package version instead of hardcoded string ([d76ab7fd](https://github.com/niivue/mono/commit/d76ab7fd))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.59 (2026-10-30)

### Fixes

- **niivue:** apply a forced device pixel ratio to every controller on a canvas ([ad3866a0](https://github.com/niivue/mono/commit/ad3866a0))
- **niivue:** every resize path rebuilds instance tiles and redraws ([#465](https://github.com/niivue/mono/issues/465))
- **niivue:** one device pixel ratio rule, and rebuild instance tiles on change ([#200](https://github.com/niivue/mono/issues/200), [#461](https://github.com/niivue/mono/issues/461))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.58 (2026-10-30)

### Fixes

- **niivue:** loadDocument clears volumes and meshes deferred behind a thumbnail ([#388](https://github.com/niivue/mono/issues/388))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.57 (2026-10-30)

### Fixes

- **niivue:** type-check reader registries and fix MGH mesh layers ([#427](https://github.com/niivue/mono/issues/427))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.56 (2026-10-30)

### Fixes

- **niivue:** rebuild overlays when volumeIsBackgroundMasking changes ([#367](https://github.com/niivue/mono/issues/367))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.55 (2026-10-29)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.54 (2026-10-29)

### Features

- **niivue:** draw IMSC channels with baked fluorescence colormaps ([#431](https://github.com/niivue/mono/issues/431))
- **niivue:** lay out the IMSC example like Allen's 3D Cell Viewer ([45c0322f](https://github.com/niivue/mono/commit/45c0322f))
- **niivue:** 3D render mode controls in the IMSC example ([0b4614f7](https://github.com/niivue/mono/commit/0b4614f7))
- **niivue:** clip, clip-overlays and 3D zoom controls in the IMSC example ([e7b9b0a0](https://github.com/niivue/mono/commit/e7b9b0a0))
- add an Allen Integrated Mitotic Stem Cell gallery example ([d7ff8119](https://github.com/niivue/mono/commit/d7ff8119))

### Fixes

- serialize IMSC backend switches with volume updates ([bbbf0bff](https://github.com/niivue/mono/commit/bbbf0bff))
- **niivue:** serialize IMSC channel updates and clear an empty selection ([b6bb44bc](https://github.com/niivue/mono/commit/b6bb44bc))
- **niivue:** keep stale IMSC loads from replacing newer ones ([859ef8b5](https://github.com/niivue/mono/commit/859ef8b5))
- **examples:** use Allen's IMSC windows in the IMSC gallery ([ed21fdf8](https://github.com/niivue/mono/commit/ed21fdf8))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.53 (2026-10-29)

### Features

- **niivue:** crosscut2 mesh shader and meshCrosscutWidth ([#92](https://github.com/niivue/mono/issues/92), [#91](https://github.com/niivue/mono/issues/91))
- **niivue:** add oblique crosscut demo for issue #92 ([#92](https://github.com/niivue/mono/issues/92))

### Fixes

- **niivue:** refresh crosscut2 cluster bounds on a data version bump ([ca38b252](https://github.com/niivue/mono/commit/ca38b252))
- **niivue:** clamp crosscut width on every entry point; guard crosscut2 list buffer size ([70baf55c](https://github.com/niivue/mono/commit/70baf55c))

### Performance

- **niivue:** hash positions on a crosscut2 bounds refresh ([dc2f4a76](https://github.com/niivue/mono/commit/dc2f4a76))
- **niivue:** reuse the crosscut2 word texture when its size is unchanged ([ddb01515](https://github.com/niivue/mono/commit/ddb01515))
- **niivue:** refresh crosscut2 bounds on a data bump only when positions changed ([e6b96db5](https://github.com/niivue/mono/commit/e6b96db5))
- **niivue:** cull crosscut2 triangles by spatial cluster ([15f2a29d](https://github.com/niivue/mono/commit/15f2a29d))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.52 (2026-10-29)

### Features

- **niivue:** export COLORMAP_TYPE from all entry points ([#375](https://github.com/niivue/mono/issues/375))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.51 (2026-10-29)

### Fixes

- **niivue:** honour isInteractionEnabled in the single-backend builds ([#317](https://github.com/niivue/mono/issues/317))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.50 (2026-10-29)

### Fixes

- **niivue:** clamp the other range-checked settings from a document ([#387](https://github.com/niivue/mono/issues/387))
- **niivue:** clamp volume sampleRate and renderMode from a document ([#387](https://github.com/niivue/mono/issues/387))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.49 (2026-10-29)

### Features

- ⚠️  **niivue:** make per-item isLegendVisible work; one legend flag name ([#350](https://github.com/niivue/mono/issues/350), [#376](https://github.com/niivue/mono/issues/376))

### Fixes

- **niivue:** default a restored mesh's isLegendVisible to true ([ffa19c7a](https://github.com/niivue/mono/commit/ffa19c7a))

### Breaking Changes

- **niivue:** make per-item isLegendVisible work; one legend flag name  ([#350](https://github.com/niivue/mono/issues/350), [#376](https://github.com/niivue/mono/issues/376))
  signal display option `showLegend` is renamed
  `isLegendVisible` (loadSignals, addSignal, setSignal).
  Closes #350.
  Closes #376.
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.48 (2026-10-28)

### Fixes

- **niivue:** warn on an unknown matcap name and document volumeMatcap ([ff6da670](https://github.com/niivue/mono/commit/ff6da670))
- **niivue:** keep another host's matcap under an assets/matcaps path ([d812b796](https://github.com/niivue/mono/commit/d812b796))
- **niivue:** keep an explicit volumeMatcap option at construction ([#225](https://github.com/niivue/mono/issues/225))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.47 (2026-10-28)

### Features

- load the Allen IMSC atlases from niivue-demo-images-lfs ([a9f75d69](https://github.com/niivue/mono/commit/a9f75d69))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.46 (2026-10-28)

### Fixes

- **niivue:** step-size opacity correction for the 3D overlay pass ([#366](https://github.com/niivue/mono/issues/366))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.45 (2026-10-28)

### Fixes

- **niivue:** cache the WebGPU blend accumulate pipeline by colour mode ([#358](https://github.com/niivue/mono/issues/358))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.44 (2026-10-28)

### Fixes

- **niivue:** free cached textures when the last volume is removed ([c2199e14](https://github.com/niivue/mono/commit/c2199e14))
- **niivue:** give each volume its own texture cache entry ([#346](https://github.com/niivue/mono/issues/346))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.43 (2026-10-28)

### Fixes

- **niivue:** keep document copy demo controls in step with the scene ([1953c209](https://github.com/niivue/mono/commit/1953c209))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.42 (2026-10-28)

### Features

- **niivue:** route linked meshes and the thumbnail through resolveUrl ([d57597ce](https://github.com/niivue/mono/commit/d57597ce))
- **niivue:** let loadDocument resolve or skip linked volume URLs ([cba38d92](https://github.com/niivue/mono/commit/cba38d92))
- **medgfx:** preview NiiVue documents (.nvd) in Quick Look ([#107](https://github.com/niivue/mono/issues/107))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.41 (2026-10-27)

### Fixes

- **niivue:** CT colormaps apply their Hounsfield window ([60132867](https://github.com/niivue/mono/commit/60132867))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.40 (2026-10-27)

### Features

- ⚠️  **niivue:** one colormap per volume, label or continuous ([#69](https://github.com/niivue/mono/issues/69))

### Fixes

- **niivue:** keep streamed label ranges across colormap changes ([546e6bdb](https://github.com/niivue/mono/commit/546e6bdb))
- **nv-mcp:** register an overlay's label table only once its file loads ([#257](https://github.com/niivue/mono/issues/257))
- **niivue:** grow the generated label palette as streamed bricks arrive ([8135f668](https://github.com/niivue/mono/commit/8135f668))
- **niivue:** keep the generated label palette finite and its 0..255 IDs ([e3f295b6](https://github.com/niivue/mono/commit/e3f295b6))
- **niivue:** grow the generated label palette across 4D frames and streamed volumes ([2977df7c](https://github.com/niivue/mono/commit/2977df7c))
- **niivue:** save the label table a volume shows, not the registry's ([df945332](https://github.com/niivue/mono/commit/df945332))
- **niivue:** grow the generated label palette with the data ([5b39e5e5](https://github.com/niivue/mono/commit/5b39e5e5))

### Breaking Changes

- **niivue:** one colormap per volume, label or continuous  ([#69](https://github.com/niivue/mono/issues/69))
  setColormapLabel/setColormapLabelFromUrl are removed;
  `_draw`, `_itksnap` and `_slicer3d` are now `draw`, `itksnap` and
  `slicer3d`; colormapNames() lists both kinds; documents are version 10.
  Closes #69
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01D77vyvTqs1NMFXhaGsw2ZZ

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.39 (2026-10-26)

### Fixes

- **niivue:** judge a gray channel colour relative to its brightness ([1cc77a9b](https://github.com/niivue/mono/commit/1cc77a9b))
- **niivue:** emit meshLoaded for the mesh addMesh added ([bf7f42c1](https://github.com/niivue/mono/commit/bf7f42c1))
- **niivue:** follow-ups from the #362, #368, #369 and #370 reviews ([#362](https://github.com/niivue/mono/issues/362), [#368](https://github.com/niivue/mono/issues/368), [#369](https://github.com/niivue/mono/issues/369), [#370](https://github.com/niivue/mono/issues/370))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.38 (2026-10-26)

### Fixes

- **niivue:** keep a document's custom matcap URL ([dad77c2f](https://github.com/niivue/mono/commit/dad77c2f))
- **niivue:** draw the default matcap when a matcap fails to load ([8819d3fb](https://github.com/niivue/mono/commit/8819d3fb))
- **niivue:** leave the matcap alone when a document does not set one ([608b6534](https://github.com/niivue/mono/commit/608b6534))
- **niivue:** load an unresolvable matcap path as the instance default ([9b32a999](https://github.com/niivue/mono/commit/9b32a999))
- **niivue:** save a document's matcap by name, not by URL ([601bddc3](https://github.com/niivue/mono/commit/601bddc3))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.37 (2026-10-23)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.36 (2026-10-23)

### Fixes

- ⚠️  **niivue:** default isAntiAlias to false ([#318](https://github.com/niivue/mono/issues/318))

### Breaking Changes

- **niivue:** default isAntiAlias to false  ([#318](https://github.com/niivue/mono/issues/318))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.35 (2026-10-23)

### Features

- **niivue:** fuse volumes[0] with the overlays as a channel stack ([#365](https://github.com/niivue/mono/issues/365))
- **niivue:** add OVERLAY_COLOR_BLEND.MAX channel fusion ([#363](https://github.com/niivue/mono/issues/363))

### Fixes

- **niivue:** ignore placeholder omero windows, add gray channel ramp ([#364](https://github.com/niivue/mono/issues/364))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.34 (2026-10-23)

### Features

- **niivue:** add ordered source-over colour blend for overlays ([#90](https://github.com/niivue/mono/issues/90))

### Fixes

- **niivue:** address PR #354 audit findings ([#354](https://github.com/niivue/mono/issues/354), [#257](https://github.com/niivue/mono/issues/257))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.33 (2026-10-21)

### Features

- ⚠️  **niivue:** remove vestigial isPositionInMM ([36546908](https://github.com/niivue/mono/commit/36546908))

### Breaking Changes

- **niivue:** remove vestigial isPositionInMM  ([36546908](https://github.com/niivue/mono/commit/36546908))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.32 (2026-10-21)

### Fixes

- **niivue:** reveal only arms the slice hides, and only on oblique volumes ([a60b249e](https://github.com/niivue/mono/commit/a60b249e))
- **niivue:** draw the crosshair arms a 2D slice hides faintly ([d207e503](https://github.com/niivue/mono/commit/d207e503))
- **niivue:** fit crosshair arms to each tile's drawn slice plane ([8ddde619](https://github.com/niivue/mono/commit/8ddde619))
- **niivue:** keep 2D crosshair arms on oblique slices ([e3e9abc8](https://github.com/niivue/mono/commit/e3e9abc8))

### Thank You

- Claude Opus 5.5
- Steffen Bollmann

## 1.0.0-rc.31 (2026-10-21)

### Fixes

- **niivue:** resolve the chunk settle wait at once in a hidden tab ([70025e29](https://github.com/niivue/mono/commit/70025e29))
- **niivue:** wait for the cross-fade before the chunk stream counts as settled ([2f006fd6](https://github.com/niivue/mono/commit/2f006fd6))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.30 (2026-10-20)

### Fixes

- **niivue:** stop animated benchmark scenarios rendering an extra frame ([#331](https://github.com/niivue/mono/issues/331))
- **niivue:** report a failed backend switch in the live data example ([#332](https://github.com/niivue/mono/issues/332))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.29 (2026-10-20)

### Fixes

- **niivue:** rebuild cached volume textures when the voxel source changes ([#330](https://github.com/niivue/mono/issues/330))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.28 (2026-10-20)

### Fixes

- **niivue:** hide colorbars and legends of hidden meshes; richer mesh examples ([08a8c045](https://github.com/niivue/mono/commit/08a8c045))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.27 (2026-10-20)

### Features

- **niivue:** restrict a getDescriptives mask volume to chosen labels ([#326](https://github.com/niivue/mono/issues/326))
- **niivue:** animate between scene states with animateTo ([6cc176ae](https://github.com/niivue/mono/commit/6cc176ae))
- **niivue:** anchor labels to an exploded chunked volume ([919d7f0d](https://github.com/niivue/mono/commit/919d7f0d))
- **niivue:** restrict a getDescriptives mask volume to chosen labels ([#326](https://github.com/niivue/mono/issues/326))
- **niivue:** animate between scene states with animateTo ([66e0aa79](https://github.com/niivue/mono/commit/66e0aa79))

### Fixes

- **niivue:** keep an empty instance list in instance mode, and convert V1 afresh ([ce9baf6c](https://github.com/niivue/mono/commit/ce9baf6c))
- **niivue:** rebuild volume textures when setInstances changes mode ([7d6fd735](https://github.com/niivue/mono/commit/7d6fd735))
- **niivue:** report a failed animateTo landing, and stop mid-frame ([8157c6ec](https://github.com/niivue/mono/commit/8157c6ec))
- **niivue:** drop stale bricks when a WebGL2 plan swap follows a display change ([1ab72555](https://github.com/niivue/mono/commit/1ab72555))
- **niivue:** settle the chunk stream when the view needs no more bricks ([2cff5dd7](https://github.com/niivue/mono/commit/2cff5dd7))
- **niivue:** keep the chunked entry when a refresh races a plan swap on WebGPU ([5195521f](https://github.com/niivue/mono/commit/5195521f))
- **niivue:** report a failed animateTo landing, and stop mid-frame ([863fa72a](https://github.com/niivue/mono/commit/863fa72a))

### Thank You

- Chris Drake
- Claude Opus 5.5
- Taylor Hanayik @hanayik

## 1.0.0-rc.26 (2026-10-19)

### Fixes

- **niivue:** report annotation.style whole in load change events ([1e7a8d53](https://github.com/niivue/mono/commit/1e7a8d53))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.25 (2026-10-19)

### Fixes

- **niivue:** reorient loaded drawings using the native dims ([56734439](https://github.com/niivue/mono/commit/56734439))

### Thank You

- Claude Fable 5.1
- Steffen Bollmann

## 1.0.0-rc.24 (2026-10-19)

### Fixes

- **niivue:** skip the CPU chunk pick for a hidden background ([#224](https://github.com/niivue/mono/issues/224))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.23 (2026-10-18)

### Fixes

- **niivue:** only decode a $num tag that has no other keys ([#216](https://github.com/niivue/mono/issues/216))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.22 (2026-10-13)

### Features

- **niivue:** make WebGL2 the default rendering backend ([65d16bc](https://github.com/niivue/mono/commit/65d16bc))
- **medgfx:** redesign inspector, add layers and overlay loading ([eb6d813](https://github.com/niivue/mono/commit/eb6d813))

### Fixes

- **niivue:** show the real backend in example WebGPU checkboxes ([f3bb3c9](https://github.com/niivue/mono/commit/f3bb3c9))

### Thank You

- Claude Opus 5.5
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.21 (2026-10-12)

### Features

- **niivue:** add updateMeshPositions and updateVolumeData live-update fast paths ([9aae6cc](https://github.com/niivue/mono/commit/9aae6cc))

### Fixes

- **niivue:** ignore isDirty on chunkSource volumes ([91db4ec](https://github.com/niivue/mono/commit/91db4ec))
- **niivue:** update a loaded volume passed as the coarse floor ([d2e91b0](https://github.com/niivue/mono/commit/d2e91b0))
- **niivue:** key the coarse floor on everything its orient pass bakes ([5fdf117](https://github.com/niivue/mono/commit/5fdf117))
- **niivue:** show the selected frame of 4D RGB/RGBA volumes ([f12f257](https://github.com/niivue/mono/commit/f12f257))
- **niivue:** recompute modulation when a view is recreated ([f2d2d42](https://github.com/niivue/mono/commit/f2d2d42))
- **niivue:** report chunked volumes first in updateVolumeData and document them ([16a9fca](https://github.com/niivue/mono/commit/16a9fca))
- **niivue:** re-stream chunked volumes after an in-place edit ([0298137](https://github.com/niivue/mono/commit/0298137))
- **niivue:** rebuild multi-instance volume textures on any display change ([ad3d104](https://github.com/niivue/mono/commit/ad3d104))
- **niivue:** rebuild cached volume colormap textures when addColormap re-registers a name ([5225106](https://github.com/niivue/mono/commit/5225106))
- **niivue:** re-upload in-place voxel edits flagged isDirty on any update ([950d1c3](https://github.com/niivue/mono/commit/950d1c3))
- **niivue:** rebuild multi-instance volume textures when their modulator changes ([85b5fd4](https://github.com/niivue/mono/commit/85b5fd4))
- **niivue:** make updateMeshPositions a no-op on a lost GPU context ([796bf89](https://github.com/niivue/mono/commit/796bf89))
- **niivue:** resample the volume+physio time-course after updateVolumeData ([75be85f](https://github.com/niivue/mono/commit/75be85f))
- **niivue:** rebuild a recreated view's GPU resources under the update lock ([322edc7](https://github.com/niivue/mono/commit/322edc7))
- **niivue:** size updateVolumeData's one-frame write by channels per voxel ([770dd2f](https://github.com/niivue/mono/commit/770dd2f))
- **niivue:** record a volume's data version at upload time, not after awaits ([a809e03](https://github.com/niivue/mono/commit/a809e03))

### Performance

- **niivue:** rebuild only the GPU resources a change touches ([#303](https://github.com/niivue/mono/pull/303))
- **niivue:** cheap mesh normals, cached per geometry and reused by live updates ([#302](https://github.com/niivue/mono/pull/302))
- **niivue:** add live-data animation scenarios to the benchmark ([f5596a4](https://github.com/niivue/mono/commit/f5596a4))
- **niivue:** keep caches across modulator edits and unchanged RGBA uploads ([d445e70](https://github.com/niivue/mono/commit/d445e70))
- **niivue:** write RGB/RGBA volume updates into their existing texture ([1007bc7](https://github.com/niivue/mono/commit/1007bc7))
- **niivue:** reuse a staging buffer for updateMeshPositions uploads ([283f143](https://github.com/niivue/mono/commit/283f143))
- **niivue:** limit updateVolumeData's rebuild to the edited volume ([0ca1a57](https://github.com/niivue/mono/commit/0ca1a57))

### Thank You

- Claude Opus 5.5
- Taylor Hanayik @hanayik

## 1.0.0-rc.20 (2026-10-07)

### Fixes

- **niivue:** recompute legend centroids when the volume affine changes ([a878eeb](https://github.com/niivue/mono/commit/a878eeb))

### Performance

- ⚠️  **niivue:** compute legend label centroids lazily ([fe79675](https://github.com/niivue/mono/commit/fe79675))

### Breaking Changes

- **niivue:** compute legend label centroids lazily  ([fe79675](https://github.com/niivue/mono/commit/fe79675))
  LUT.centroids is removed, and LegendEntry.centroid is now
  `() => [number, number, number] | undefined` instead of a precomputed vec3.
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.19 (2026-10-06)

### Features

- **niivue:** overlay alpha and colour blend modes ([307a45b](https://github.com/niivue/mono/commit/307a45b))

### Thank You

- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.18 (2026-10-06)

### Fixes

- **niivue:** fall back when modulation exceeds texture limits ([7de0545](https://github.com/niivue/mono/commit/7de0545))
- **niivue:** modulate streamed and independent chunked overlays too ([#256](https://github.com/niivue/mono/issues/256))
- **niivue:** keep overlay modulation on the chunked path ([#256](https://github.com/niivue/mono/issues/256))

### Thank You

- Chris Drake
- Claude Fable 5.1

## 1.0.0-rc.17 (2026-10-05)

### Features

- **niivue:** an undo snapshot API for external drawing edits ([813ecf1](https://github.com/niivue/mono/commit/813ecf1))

### Thank You

- Paul Wighton

## 1.0.0-rc.16 (2026-09-24)

### Features

- **niivue:** two-finger pinch zoom on touch screens ([19af1de](https://github.com/niivue/mono/commit/19af1de))

### Thank You

- Claude Opus 5.5 (1M context)
- neurolabusc

## 1.0.0-rc.15 (2026-09-24)

### Fixes

- **niivue:** wheel scrolls 2D slices in slicer3D mode, as in 0.6 ([41aeea6](https://github.com/niivue/mono/commit/41aeea6))
- **niivue:** pick 2D interpolation per volume; keep the 3D render linear ([7c40ccc](https://github.com/niivue/mono/commit/7c40ccc))

### Thank You

- Claude Opus 5.5 (1M context)
- neurolabusc

## 1.0.0-rc.14 (2026-09-23)

### Features

- **niivue:** programmatic measurement add, remove, list and pick ([#155](https://github.com/niivue/mono/issues/155))
- **niivue:** add clientToCanvas so pointer events reach the projection API ([68706c3](https://github.com/niivue/mono/commit/68706c3))
- **niivue:** screen-space projection API for external overlays ([#150](https://github.com/niivue/mono/issues/150))
- **examples:** vox.matcap opens on a sphere at full illumination ([ea902bb](https://github.com/niivue/mono/commit/ea902bb))
- **examples:** vox.matcap, showing the matcap image that does the lighting ([e3d7ad3](https://github.com/niivue/mono/commit/e3d7ad3))
- **examples:** vox.stats-multi, three statistical maps on one threshold ([52e9da3](https://github.com/niivue/mono/commit/52e9da3))
- **examples:** raise the Matcap preset to 0.6 illumination ([f440fb2](https://github.com/niivue/mono/commit/f440fb2))
- **examples:** rename Composite to Volume, add a Matcap preset ([122a092](https://github.com/niivue/mono/commit/122a092))
- **examples:** default the cerebellum to the matte shader ([8371bf9](https://github.com/niivue/mono/commit/8371bf9))
- **examples:** put the rendermode scene in standard space ([759b543](https://github.com/niivue/mono/commit/759b543))
- **niivue:** implement mesh `visible`, and add the cerebellum to the demo ([1f3a316](https://github.com/niivue/mono/commit/1f3a316))
- **niivue:** SLICES honours volumeIsAlphaClipDark, like the 2D tiles ([9003af5](https://github.com/niivue/mono/commit/9003af5))
- **niivue:** orthogonal slices as a third volume render mode ([c47e859](https://github.com/niivue/mono/commit/c47e859))
- **niivue:** let a custom layout tile fill its pane ([#148](https://github.com/niivue/mono/issues/148))
- **control:** optional V hotkey to cycle the view ([dd2de03](https://github.com/niivue/mono/commit/dd2de03))
- **niivue:** opt-in pan follows crosshair when zoomed ([#156](https://github.com/niivue/mono/issues/156))
- **niivue:** per-axis multi-LOD focus radius ([bae3897](https://github.com/niivue/mono/commit/bae3897))
- **niivue:** reserve uniform LOD inside focus bounds ([e497c50](https://github.com/niivue/mono/commit/e497c50))
- **niivue:** resolve NVChunkedVolume refocus when the plan swap applies ([#153](https://github.com/niivue/mono/issues/153))
- **niivue:** pass an AbortSignal to SlideTileSource.fetchTileBytes ([a5ff769](https://github.com/niivue/mono/commit/a5ff769))
- **niivue:** optional pointer-anchored 2D wheel zoom ([#68](https://github.com/niivue/mono/issues/68), [#157](https://github.com/niivue/mono/issues/157))
- **niivue:** add crosshairPan drag mode ([#149](https://github.com/niivue/mono/issues/149))
- **niivue:** emit chunkStreamIdle when streaming settles ([#151](https://github.com/niivue/mono/issues/151))
- **niivue:** add per-axis crosshair colors ([02f431d](https://github.com/niivue/mono/commit/02f431d))
- **niivue:** export the visible-mm-window helper from all three entries ([f9ca3bb](https://github.com/niivue/mono/commit/f9ca3bb))
- **niivue:** report the visible mm window per world axis ([5e046b4](https://github.com/niivue/mono/commit/5e046b4))
- **niivue:** export the screen-space projection surface ([#150](https://github.com/niivue/mono/issues/150))
- **niivue:** add a um ruler step below mm ([#147](https://github.com/niivue/mono/issues/147))
- add circular pen shape option to drawing tools and update drawing app ([dedd17a](https://github.com/niivue/mono/commit/dedd17a))

### Fixes

- **niivue:** wheel steps the clip plane by a fixed notch, as 0.6 did ([9ff9090](https://github.com/niivue/mono/commit/9ff9090))
- **niivue:** harden the circular pen shape option ([fa326fa](https://github.com/niivue/mono/commit/fa326fa))
- **niivue:** make measurement removal re-entrant safe and getMeasurements a snapshot ([814b51c](https://github.com/niivue/mono/commit/814b51c))
- **niivue:** validate measurement indices and pin addMeasurement's return ([8453058](https://github.com/niivue/mono/commit/8453058))
- **niivue:** pick SLICES planes where PAQD or the drawing is drawn over transparent base ([#198](https://github.com/niivue/mono/issues/198), [#197](https://github.com/niivue/mono/issues/197))
- **niivue:** store only a VOLUME_RENDER_MODE member in volumeRenderMode ([8d8dce2](https://github.com/niivue/mono/commit/8d8dce2))
- **niivue:** drop the mat4 import getScreenTiles no longer uses ([87b14c2](https://github.com/niivue/mono/commit/87b14c2))
- **niivue:** make getScreenTiles a deep copy of the layout ([4b45534](https://github.com/niivue/mono/commit/4b45534))
- **niivue:** fold the projection exports into the existing entry lines ([8fec9fa](https://github.com/niivue/mono/commit/8fec9fa))
- **niivue:** two-pass gradient estimator restores smooth normals on both backends ([c5370b5](https://github.com/niivue/mono/commit/c5370b5))
- **niivue:** matcap lookup flips x, not y ([c65c7e3](https://github.com/niivue/mono/commit/c65c7e3))
- **examples:** tint white matter white, so partial volumes ramp smoothly ([ffc1c17](https://github.com/niivue/mono/commit/ffc1c17))
- lint and format caches ignored most of what Biome checks ([8133ef3](https://github.com/niivue/mono/commit/8133ef3))
- **examples:** blend the tissue overlays by fraction, and expose their opacity ([bd7b56f](https://github.com/niivue/mono/commit/bd7b56f))
- **niivue:** audit fixes for the SLICES render mode ([6b4b5a8](https://github.com/niivue/mono/commit/6b4b5a8))
- **niivue:** derive chunkStreamIdle from a settled frame, wire hooks on attach ([#171](https://github.com/niivue/mono/issues/171))
- **examples:** harden the CT and worker demos after review ([94b4b9d](https://github.com/niivue/mono/commit/94b4b9d))
- **cmap:** keep the display window of bundled colormaps ([7730078](https://github.com/niivue/mono/commit/7730078))
- **niivue:** keep a finite tile rect when the in-plane span is zero ([84cf859](https://github.com/niivue/mono/commit/84cf859))
- **control:** send hotkeys only to the viewer under the pointer ([b28ab34](https://github.com/niivue/mono/commit/b28ab34))
- **control:** see focused fields inside shadow roots before hotkeys ([2e062d8](https://github.com/niivue/mono/commit/2e062d8))
- **render:** compile WebGL2 shader variants without stalling a frame ([894704d](https://github.com/niivue/mono/commit/894704d))
- **niivue:** honour the devicePixelRatio option ([3a75147](https://github.com/niivue/mono/commit/3a75147))
- **niivue:** pan-follows-crosshair reads the window off the rendered tiles ([63dfb6f](https://github.com/niivue/mono/commit/63dfb6f))
- **niivue:** copy a per-axis radius on resolve; balance the octree that passed the bound ([17f1b52](https://github.com/niivue/mono/commit/17f1b52))
- **niivue:** re-plan an 'auto' radius when the 2D zoom changes ([a761dac](https://github.com/niivue/mono/commit/a761dac))
- **niivue:** circumscribe the 2D 'auto' focus ellipsoid ([4a6bed4](https://github.com/niivue/mono/commit/4a6bed4))
- **niivue:** skip render centering when a swap settles after dispose ([9757272](https://github.com/niivue/mono/commit/9757272))
- **niivue:** export WheelZoomAnchor from the backend entries too ([ade2f16](https://github.com/niivue/mono/commit/ade2f16))
- **niivue:** use a 1x1x1 placeholder gradient for unlit chunked volumes ([#154](https://github.com/niivue/mono/issues/154))
- **render:** fade the background by its accumulated alpha, not per sample ([678481a](https://github.com/niivue/mono/commit/678481a))
- **niivue:** export DecodedChunkStats from the backend entries too ([a1c023d](https://github.com/niivue/mono/commit/a1c023d))
- **niivue:** export the types named in public signatures ([#171](https://github.com/niivue/mono/issues/171))
- **niivue:** close the entry-point export drift and pin it with a test ([b19e92e](https://github.com/niivue/mono/commit/b19e92e))
- **niivue:** evict a stale chunked entry on the ordinary volume path ([d520f38](https://github.com/niivue/mono/commit/d520f38))
- **niivue:** correct the bind group binding numbers in the evict comment ([efe8713](https://github.com/niivue/mono/commit/efe8713))
- **niivue:** delete the texture cache key when destroying its entry ([#145](https://github.com/niivue/mono/issues/145))

### Performance

- **render:** specialize the volume ray-march shader per draw ([e4b2369](https://github.com/niivue/mono/commit/e4b2369))
- **niivue:** bound budget candidates before balancing them ([254dae3](https://github.com/niivue/mono/commit/254dae3))

### Thank You

- Chris Drake
- Claude Fable 5
- Claude Fable 5.1
- Claude Opus 5
- Claude Opus 5 (1M context)
- Mohannad
- neurolabusc
- Steffen Bollmann
- Taylor Hanayik @hanayik
- yosukey

## 1.0.0-rc.13 (2026-09-02)

### Features

- **niivue:** let a single 2D slice fill the canvas ([#68](https://github.com/niivue/mono/issues/68))
- **niivue:** add the lighting controls to the range streaming demo ([ab556c1](https://github.com/niivue/mono/commit/ab556c1))
- **niivue:** add the gradient examples ([c7b9063](https://github.com/niivue/mono/commit/c7b9063))
- **niivue:** gradient opacity, silhouette, and a shared gradient estimator ([b246878](https://github.com/niivue/mono/commit/b246878))
- **range-demo:** default the budget plan to uniform, and stop counting aborts as failures ([74364c6](https://github.com/niivue/mono/commit/74364c6))
- **niivue:** cache OME-Zarr chunk bytes across sessions ([d6037b6](https://github.com/niivue/mono/commit/d6037b6))
- **niivue:** demote an evicted chunk to a decoded tier instead of dropping it ([e166f92](https://github.com/niivue/mono/commit/e166f92))
- **niivue:** fetch ahead of where the view is travelling ([1281a74](https://github.com/niivue/mono/commit/1281a74))
- **niivue:** cancel chunk reads the view stopped wanting ([70c3dfc](https://github.com/niivue/mono/commit/70c3dfc))
- **niivue:** read OME-Zarr chunks on a worker pool ([46151b9](https://github.com/niivue/mono/commit/46151b9))
- **niivue:** count byte-cache hits, misses and evictions ([fa4e0f0](https://github.com/niivue/mono/commit/fa4e0f0))
- **niivue:** time the streaming phases, and measure what actually stalls ([1a76c7c](https://github.com/niivue/mono/commit/1a76c7c))
- **niivue:** keep coarse slide tiles on screen until finer ones land ([b245524](https://github.com/niivue/mono/commit/b245524))
- **niivue:** pin a chunk plan's brick count with gridDims ([c2749fd](https://github.com/niivue/mono/commit/c2749fd))
- **niivue:** add a streamed OME-Zarr block inspector demo ([69975d8](https://github.com/niivue/mono/commit/69975d8))
- **niivue:** pick an exploded block and open it in its own pane ([d2b61c4](https://github.com/niivue/mono/commit/d2b61c4))
- **dandi-demo:** move the DANDI demo to an app and measure with UIKit ([b621c22](https://github.com/niivue/mono/commit/b621c22))
- **niivue:** read NVSlide tiles straight from a chunked volume ([29a9aae](https://github.com/niivue/mono/commit/29a9aae))
- **examples:** stream DANDI OME-Zarr into the volume and NVSlide at once ([379692d](https://github.com/niivue/mono/commit/379692d))
- **niivue:** give streamed volumes a named budget plan ([aee6572](https://github.com/niivue/mono/commit/aee6572))
- **range-demo:** show a streaming progress badge while blocks load ([1d61aa7](https://github.com/niivue/mono/commit/1d61aa7))
- **niivue:** make the LOD compensation settings introspectable ([bb2bc23](https://github.com/niivue/mono/commit/bb2bc23))
- **niivue:** add opt-in per-level opacity compensation for coarse LOD bricks ([770556b](https://github.com/niivue/mono/commit/770556b))
- **niivue:** compensate coarse-LOD dimness and gamma the 2D slices ([9d0c937](https://github.com/niivue/mono/commit/9d0c937))
- **niivue:** implement scene.gamma in the volume ray-march ([b0b4274](https://github.com/niivue/mono/commit/b0b4274))
- **niivue:** rebuild the view after a GPU context loss ([a1dcf4c](https://github.com/niivue/mono/commit/a1dcf4c))
- **niivue:** add a linear vs cubic B-spline interpolation example ([8808b8d](https://github.com/niivue/mono/commit/8808b8d))
- **range-demo:** add an interp selector and an A/B filter comparison ([9a9863c](https://github.com/niivue/mono/commit/9a9863c))
- **niivue:** opt-in tricubic B-spline volume reconstruction ([5669e52](https://github.com/niivue/mono/commit/5669e52))
- **niivue:** add a samples-per-voxel control to the range example ([005891c](https://github.com/niivue/mono/commit/005891c))
- **niivue:** back streamed chunks with an automatic coarse floor ([403d7ce](https://github.com/niivue/mono/commit/403d7ce))
- **niivue:** add intensity window demo ([ac82361](https://github.com/niivue/mono/commit/ac82361))
- **niivue:** pinnable slide-plane LOD, with a control in slide3d ([fe6be28](https://github.com/niivue/mono/commit/fe6be28))
- **niivue:** view selector in the OME-Zarr demo ([ee5c4cc](https://github.com/niivue/mono/commit/ee5c4cc))
- **niivue:** clip, clip-overlays and 3D zoom controls in the Allen demo ([d0e40b6](https://github.com/niivue/mono/commit/d0e40b6))
- **niivue:** start the Allen atlas demo on the local fixture mirror ([4f26906](https://github.com/niivue/mono/commit/4f26906))
- **niivue:** clip, clip-overlays and 3D zoom controls in the OME-TIFF demo ([4814ba9](https://github.com/niivue/mono/commit/4814ba9))
- **niivue:** promote the OME-Zarr ChunkedVolumeSource into the library ([531859b](https://github.com/niivue/mono/commit/531859b))
- **niivue:** add an OME-Zarr multi-channel demo ([f6769b1](https://github.com/niivue/mono/commit/f6769b1))
- **niivue:** load OME-Zarr channels as per-channel volumes ([1e9aa02](https://github.com/niivue/mono/commit/1e9aa02))
- **niivue:** parse OME-Zarr multiscale and omero metadata ([ad78c71](https://github.com/niivue/mono/commit/ad78c71))
- **niivue:** toggle the 3D crosshair in the range demo ([67f3fad](https://github.com/niivue/mono/commit/67f3fad))
- **niivue:** read OME-Zarr 0.4 and stream the HOA human heart ([b60d9c6](https://github.com/niivue/mono/commit/b60d9c6))
- **range-demo:** drop woodbranch from the store list ([b642ce5](https://github.com/niivue/mono/commit/b642ce5))
- **range-demo:** swap pig heart for chameleon, add a pyramid screening rule ([0d778ee](https://github.com/niivue/mono/commit/0d778ee))
- **niivue:** stream OME-Zarr demo stores from the public bucket ([fdd7107](https://github.com/niivue/mono/commit/fdd7107))
- **niivue:** add a real multi-channel OME-TIFF sample ([3021701](https://github.com/niivue/mono/commit/3021701))
- **niivue:** add an OME-TIFF demo and read real-world unit strings ([60d4cd6](https://github.com/niivue/mono/commit/60d4cd6))
- **niivue:** read TIFF, OME-TIFF and ImageJ stacks ([ee3faad](https://github.com/niivue/mono/commit/ee3faad))
- **niivue:** exercise the new APIs from the demos ([f017ebb](https://github.com/niivue/mono/commit/f017ebb))
- **niivue:** persist isColormapInverted and atlasOutline in documents ([8434a1d](https://github.com/niivue/mono/commit/8434a1d))
- **niivue:** add clearAngles, clearDistanceMeasurements and clearBounds ([5f9e8c8](https://github.com/niivue/mono/commit/5f9e8c8))
- **niivue:** emit clickToSegment after a magic-wand fill ([a1e6628](https://github.com/niivue/mono/commit/a1e6628))
- **niivue:** report region statistics with getDescriptives ([4bec296](https://github.com/niivue/mono/commit/4bec296))
- **niivue:** reverse a volume colormap with isColormapInverted ([1e82064](https://github.com/niivue/mono/commit/1e82064))
- **niivue:** outline atlas regions with setAtlasOutline ([0d38156](https://github.com/niivue/mono/commit/0d38156))
- **niivue:** opt-in colormap alpha on 2D slices ([458b4d2](https://github.com/niivue/mono/commit/458b4d2))
- **niivue:** light the overlay pass and add maximum-intensity projection ([190eec8](https://github.com/niivue/mono/commit/190eec8))
- **niivue:** demo for Allen JSON + PNG atlas datasets ([481f64e](https://github.com/niivue/mono/commit/481f64e))
- **niivue:** load Allen JSON + PNG atlas datasets as multi-channel volumes ([4b5cd92](https://github.com/niivue/mono/commit/4b5cd92))
- **niivue:** parse the Allen JSON + PNG atlas volume format ([10e11fb](https://github.com/niivue/mono/commit/10e11fb))
- **nv-ohif:** unify Length onto the annotation system ([cd0509c](https://github.com/niivue/mono/commit/cd0509c))
- Bidirectional measurement (two perpendicular axes) end to end ([0064166](https://github.com/niivue/mono/commit/0064166))
- user-entered free-text labels for annotations ([3252bed](https://github.com/niivue/mono/commit/3252bed))
- LivewireContour (edge-snapping multi-click ROI) end to end ([7e965cf](https://github.com/niivue/mono/commit/7e965cf))
- **niivue:** live-wire (intelligent scissors) path algorithm ([d0c60a6](https://github.com/niivue/mono/commit/d0c60a6))
- multi-click SplineROI (niivue interaction + nv-ohif wiring) ([fb36c30](https://github.com/niivue/mono/commit/fb36c30))
- **niivue:** spline contour geometry for multi-click ROIs ([ff90664](https://github.com/niivue/mono/commit/ff90664))
- **niivue:** expose annotation screen-geometry seam for external overlays ([6adc823](https://github.com/niivue/mono/commit/6adc823))
- **nv-ohif:** wire OHIF ROI + arrow measurement tools to NiiVue annotations ([66f66be](https://github.com/niivue/mono/commit/66f66be))
- **niivue:** isMeasurementDrawn flag to suppress the built-in measurement ([df129c7](https://github.com/niivue/mono/commit/df129c7))
- **niivue:** expose measurement screen projection for external overlays ([2644d94](https://github.com/niivue/mono/commit/2644d94))
- **niivue:** numbered graduations on the measurement ruler ([452c433](https://github.com/niivue/mono/commit/452c433))
- **niivue:** graduated arrowed measurement ruler (both backends) ([19d1c0f](https://github.com/niivue/mono/commit/19d1c0f))
- **nv-ohif:** UIKit ruler on the WSI viewport with physical-unit measurement ([3fec150](https://github.com/niivue/mono/commit/3fec150))
- measure WSI slides in real physical units (um/mm) ([d030a76](https://github.com/niivue/mono/commit/d030a76))
- **niivue:** overlay hook on the standalone WSI slide viewer ([e9fd75e](https://github.com/niivue/mono/commit/e9fd75e))
- **uikit:** ruler widget with readability guard + demo ([555edc5](https://github.com/niivue/mono/commit/555edc5))
- **uikit:** transformed MSDF text renderer on both backends ([56317c8](https://github.com/niivue/mono/commit/56317c8))
- **uikit:** line renderer on both backends + overlay-hook proof ([2ca8aab](https://github.com/niivue/mono/commit/2ca8aab))
- **niivue:** UIKit overlay lifecycle hook on both backends ([d61b795](https://github.com/niivue/mono/commit/d61b795))
- **niivue:** terminated-line builder (arrow terminator) for UIKit ruler ([2a02a2e](https://github.com/niivue/mono/commit/2a02a2e))

### Fixes

- **niivue:** window streamed volumes from the coarse floor ([7f0da14](https://github.com/niivue/mono/commit/7f0da14))
- **niivue:** clamp dragRelease voxel indices to the volume ([98c3741](https://github.com/niivue/mono/commit/98c3741))
- **niivue:** size the scale ruler from the visible image ([a3f02f0](https://github.com/niivue/mono/commit/a3f02f0))
- **niivue:** decode MGH from a Node Buffer without aliasing its allocation ([7d45649](https://github.com/niivue/mono/commit/7d45649))
- **niivue:** keep the 2D wheel zoom moving after a float32 round-trip ([b2b4e7d](https://github.com/niivue/mono/commit/b2b4e7d))
- **niivue:** build examples with ES-format workers ([#138](https://github.com/niivue/mono/issues/138))
- **niivue:** keep the slide tile cap when given Infinity or NaN ([e21df06](https://github.com/niivue/mono/commit/e21df06))
- **niivue:** reject non-finite chunk loader limits ([a9188a6](https://github.com/niivue/mono/commit/a9188a6))
- **niivue:** escape the NUL separator in the chunk worker cache key ([7704b19](https://github.com/niivue/mono/commit/7704b19))
- **niivue:** revoke the object URL when assigning img.src throws ([839737e](https://github.com/niivue/mono/commit/839737e))
- **niivue:** validate OME-TIFF channel and timepoint selectors ([c7259ca](https://github.com/niivue/mono/commit/c7259ca))
- **niivue:** resolve pinned slide levels by manifest id, not array offset ([727aaf6](https://github.com/niivue/mono/commit/727aaf6))
- **niivue:** default crosshairWidth to 2 canvas pixels ([4f8857d](https://github.com/niivue/mono/commit/4f8857d))
- **niivue:** make crosshairWidth canvas pixels everywhere ([#137](https://github.com/niivue/mono/issues/137))
- **niivue:** honour the background volume's opacity in the 3D render ([#67](https://github.com/niivue/mono/issues/67))
- **niivue:** let the 2D wheel zoom reach the bottom of its range ([0064eec](https://github.com/niivue/mono/commit/0064eec))
- **niivue:** anchor the 2D wheel zoom on the crosshair ([#68](https://github.com/niivue/mono/issues/68))
- **niivue:** forward the persistent cache scope to each worker ([eb66167](https://github.com/niivue/mono/commit/eb66167))
- **niivue:** pick visible tissue on a streamed exploded volume ([95df8d0](https://github.com/niivue/mono/commit/95df8d0))
- **niivue:** map a brick's owned box, not its fetched box, into its texture ([3f2b612](https://github.com/niivue/mono/commit/3f2b612))
- **niivue:** grow the LOD brightness lift per level, not per downsample ([63e7df5](https://github.com/niivue/mono/commit/63e7df5))
- **niivue:** compensate the coarse floor's brightness too ([6931055](https://github.com/niivue/mono/commit/6931055))
- **range-demo:** size the WebGL2 chunk budget so the LRU evicts ([0a4d040](https://github.com/niivue/mono/commit/0a4d040))
- **niivue:** keep drawing a chunked volume when chunk 0 is evicted ([4f7021c](https://github.com/niivue/mono/commit/4f7021c))
- **niivue:** probe one stride past a cube's exit face in the empty-space skip ([a00e6b0](https://github.com/niivue/mono/commit/a00e6b0))
- **niivue:** never reconstruct cubic from clamp-to-edge brick data ([601480c](https://github.com/niivue/mono/commit/601480c))
- **range-demo:** make the A/B divider a slider and free the canvas ([2d7e079](https://github.com/niivue/mono/commit/2d7e079))
- **niivue:** render the coarse floor as volume, not a dark shell ([afa8dfb](https://github.com/niivue/mono/commit/afa8dfb))
- **niivue:** tile ray slabs exactly across LOD brick boundaries ([93a57ae](https://github.com/niivue/mono/commit/93a57ae))
- **niivue:** oversample the 3D ray march to kill render ringing ([6843b5b](https://github.com/niivue/mono/commit/6843b5b))
- **niivue:** pick tissue exposed by a clip plane in chunked volumes ([b1ea40d](https://github.com/niivue/mono/commit/b1ea40d))
- **niivue:** merge chunked MIP cube draws with MAX blending ([b7683fb](https://github.com/niivue/mono/commit/b7683fb))
- **niivue:** re-stream chunked volumes when display state changes ([8ad3c8a](https://github.com/niivue/mono/commit/8ad3c8a))
- **niivue:** harden loaders and close review gaps from the PR sweep ([d94a6a3](https://github.com/niivue/mono/commit/d94a6a3))
- **niivue:** harden the microscopy loaders against real-world metadata ([efca0a8](https://github.com/niivue/mono/commit/efca0a8))
- validate Allen colors, integer metadata, and fetch concurrency ([62220fe](https://github.com/niivue/mono/commit/62220fe))
- **niivue:** rename the slide3d lod variable so codespell stays clean ([d6be590](https://github.com/niivue/mono/commit/d6be590))
- **niivue:** spline double-click no longer appends coincident control points ([5b67844](https://github.com/niivue/mono/commit/5b67844))
- **niivue:** thread clipPlaneOverlay into the WebGPU depth-pick uniforms ([a976186](https://github.com/niivue/mono/commit/a976186))
- **niivue:** depth pick honours clipPlaneOverlay on both backends ([0cb8da3](https://github.com/niivue/mono/commit/0cb8da3))
- **niivue:** enforce the OME-Zarr cache budget, harden image decoding ([6e3e6d3](https://github.com/niivue/mono/commit/6e3e6d3))
- **niivue:** replace the pig-heart demo store with woodbranch ([bf41ffc](https://github.com/niivue/mono/commit/bf41ffc))
- **examples:** report setup failures on the page instead of rejecting ([c795f6b](https://github.com/niivue/mono/commit/c795f6b))
- **niivue:** keep a colormap's alpha in place when inverting it ([bd2ed18](https://github.com/niivue/mono/commit/bd2ed18))
- harden annotation synchronization ([c23d450](https://github.com/niivue/mono/commit/c23d450))
- harden OHIF annotation synchronization ([756cb9c](https://github.com/niivue/mono/commit/756cb9c))
- **nv-ohif:** harden measurement reflection ([3bf0798](https://github.com/niivue/mono/commit/3bf0798))
- **nv-ohif:** harden the annotation/measurement subsystem (PR #76 review) ([#76](https://github.com/niivue/mono/issues/76))
- **niivue:** offset the arrow label off the tail so it does not obscure it ([1c5f14b](https://github.com/niivue/mono/commit/1c5f14b))
- **niivue:** anchor an arrow's text label at its start (the tail) ([ac4d183](https://github.com/niivue/mono/commit/ac4d183))
- **niivue:** rename livewire `nd` to `newDist` (codespell) ([d9977be](https://github.com/niivue/mono/commit/d9977be))
- **niivue:** render annotation free-text in the built-in draw too ([547f77f](https://github.com/niivue/mono/commit/547f77f))
- **niivue:** abandon a half-drawn multi-click contour on tool/mode change ([40e7902](https://github.com/niivue/mono/commit/40e7902))
- correct regressions found reviewing the review-fix commits ([1a6648d](https://github.com/niivue/mono/commit/1a6648d))
- address review findings 5-10 (WSI/DICOM loaders + chunked-volume leak) ([#5](https://github.com/niivue/mono/issues/5), [#6](https://github.com/niivue/mono/issues/6), [#7](https://github.com/niivue/mono/issues/7), [#8](https://github.com/niivue/mono/issues/8), [#9](https://github.com/niivue/mono/issues/9), [#10](https://github.com/niivue/mono/issues/10))
- address second-review findings on the ruler/WSI fixes ([d1027c6](https://github.com/niivue/mono/commit/d1027c6))
- **niivue,uikit:** shrink arrowheads on short lines so buildTerminatedLine can't invert (review finding 2) ([9b3de35](https://github.com/niivue/mono/commit/9b3de35))
- **niivue:** harden the built-in measurement ruler (review findings 4/6/7) ([#7](https://github.com/niivue/mono/issues/7), [#2](https://github.com/niivue/mono/issues/2), [#6](https://github.com/niivue/mono/issues/6), [#4](https://github.com/niivue/mono/issues/4))
- **nv-ohif:** prevent runaway slide rendering ([3bd58da](https://github.com/niivue/mono/commit/3bd58da))
- **niivue:** bound GPU memory in the NVSlide tile pipeline ([0292adf](https://github.com/niivue/mono/commit/0292adf))

### Performance

- **niivue:** drop stale chunk upload requests and reprioritize per frame ([1a9d525](https://github.com/niivue/mono/commit/1a9d525))
- **niivue:** stop re-fetching OME-Zarr chunks already known absent ([9e05015](https://github.com/niivue/mono/commit/9e05015))

### Thank You

- Chris Drake
- Claude Fable 5
- Claude Opus 5
- Claude Opus 5 (1M context)
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.12 (2026-08-10)

### Features

- **medgfx:** redesign display inspector ([97d0d69](https://github.com/niivue/mono/commit/97d0d69))
- **medgfx:** add native image file loading ([4b2665c](https://github.com/niivue/mono/commit/4b2665c))
- **medgfx:** add macOS Quick Look preview extension ([734ff8d](https://github.com/niivue/mono/commit/734ff8d))

### Fixes

- **niivue:** forward the frame limit, the reader name, and loader errors ([f65908f](https://github.com/niivue/mono/commit/f65908f))
- **niivue:** make limitFrames4D bound decoding, not just retention ([d2d3ded](https://github.com/niivue/mono/commit/d2d3ded))
- **niivue:** publish ctrl.view only after init() resolves ([#61](https://github.com/niivue/mono/issues/61))
- **niivue:** preserve computed window for linked NVD volumes ([d5b0ae3](https://github.com/niivue/mono/commit/d5b0ae3))
- preserve typed MGH voxel interpretation ([3b30eba](https://github.com/niivue/mono/commit/3b30eba))
- **niivue:** emit precise keyboard camera changes ([a75f783](https://github.com/niivue/mono/commit/a75f783))

### Thank You

- Claude Opus 5
- Claude Opus 5 (1M context)
- Korbinian Eckstein @korbinian90
- neurolabusc
- Paul Wighton
- Taylor Hanayik @hanayik

## 1.0.0-rc.11 (2026-07-29)

### Features

- **niivue:** sync range-demo zoom slider with external zoom changes ([2e5ac13](https://github.com/niivue/mono/commit/2e5ac13))
- **niivue:** crosshair-focused multi-LOD volume streaming in core ([d364f20](https://github.com/niivue/mono/commit/d364f20))
- **niivue:** crosshair-focused multi-LOD render in the range demo ([1a1d86d](https://github.com/niivue/mono/commit/1a1d86d))
- **niivue:** draw 3D vector SVGs on the clip-plane cut ([c34770d](https://github.com/niivue/mono/commit/c34770d))
- **niivue:** draw 3D vector SVGs on the face of the picked block ([29fa1c3](https://github.com/niivue/mono/commit/29fa1c3))
- **niivue:** converter for classic-NiiVue (legacy) JSON documents ([c3704c1](https://github.com/niivue/mono/commit/c3704c1))
- **niivue:** JSON encoding for NVD documents (export + import) ([ea50068](https://github.com/niivue/mono/commit/ea50068))
- **niivue:** load-time fill policy for sparse NVD settings (defaults by default) ([#2](https://github.com/niivue/mono/issues/2))
- **niivue:** linked NVD documents (reference volumes by URL, don't embed) ([56f2a21](https://github.com/niivue/mono/commit/56f2a21))
- **niivue:** sparse NVD settings that inherit current options on load ([29f943e](https://github.com/niivue/mono/commit/29f943e))
- **niivue:** render-forward hero layout + tool cursor in vox.draw.explode ([8171883](https://github.com/niivue/mono/commit/8171883))
- **niivue:** usability Lows for vox.draw.explode (Tol readout + color swatch) ([995a0fe](https://github.com/niivue/mono/commit/995a0fe))
- **niivue:** contextual hint line in vox.draw.explode ([b42531b](https://github.com/niivue/mono/commit/b42531b))
- **niivue:** consolidate vox.draw.explode into a single Tool selector ([#2](https://github.com/niivue/mono/issues/2))
- **niivue:** magic wand defaults to 2D (in-slice); demo tooltips ([570c662](https://github.com/niivue/mono/commit/570c662))
- **niivue:** Alt+right-drag rotates the clip plane while in a draw mode ([4386ca3](https://github.com/niivue/mono/commit/4386ca3))
- **niivue:** honor ?backend= in the vox.draw.explode demo ([109c3c6](https://github.com/niivue/mono/commit/109c3c6))
- **niivue:** draw vector (SVG) annotations directly on the 3D blocks ([d764e84](https://github.com/niivue/mono/commit/d764e84))
- **niivue:** add a Clip toggle to vox.draw.explode so RMB stays free to draw ([f3e755b](https://github.com/niivue/mono/commit/f3e755b))
- **niivue:** render vector annotations on exploded blocks (explode-aware 3D) ([954580d](https://github.com/niivue/mono/commit/954580d))
- **niivue:** add the "Vector (SVG)" mode to vox.draw.explode too ([cd2bd54](https://github.com/niivue/mono/commit/cd2bd54))
- **niivue:** "Vector (SVG)" drawing mode in vox.draw ([c1c9f75](https://github.com/niivue/mono/commit/c1c9f75))
- **niivue:** add 2D-slice mode to the voxel magic wand ([cb6aaa6](https://github.com/niivue/mono/commit/cb6aaa6))
- **niivue:** magic wand + SVG export for voxel volume drawing ([eb8b214](https://github.com/niivue/mono/commit/eb8b214))
- **niivue:** add drawing-on-exploded-blocks demo (2D + 3D, both backends) ([1104ddb](https://github.com/niivue/mono/commit/1104ddb))
- **niivue:** support all drawing methods on exploded blocks ([3527964](https://github.com/niivue/mono/commit/3527964))
- **niivue:** default the range demo "blocks" toggle to off ([a3216aa](https://github.com/niivue/mono/commit/a3216aa))
- **niivue:** render the range demo exploded while loading (drop the load gate) ([b6f7b6a](https://github.com/niivue/mono/commit/b6f7b6a))
- **niivue:** explode slider (uniform x/y/z brick spacing) in the range demo ([f4edf84](https://github.com/niivue/mono/commit/f4edf84))
- **niivue:** zoom slider + restrictable 3D block outlines in the range demo ([a2898a8](https://github.com/niivue/mono/commit/a2898a8))
- **niivue:** tool-aware slide drawing API + full tool set in slide3d ([d363058](https://github.com/niivue/mono/commit/d363058))
- **niivue:** serialize slide vector annotations in NVDocument + render in 3D ([a8770c4](https://github.com/niivue/mono/commit/a8770c4))
- **niivue:** SVG vector annotation layer for slides + export ([4f844f1](https://github.com/niivue/mono/commit/4f844f1))
- **niivue:** magic-wand drawing mode for slides (color region-grow) ([c4fea0b](https://github.com/niivue/mono/commit/c4fea0b))
- **niivue:** slide drawing modes — bucket fill + filled pen (+ tool selector) ([1e5718c](https://github.com/niivue/mono/commit/1e5718c))
- **niivue:** label-colored slide drawing in slides.html (parity with 3D demo) ([30b1a48](https://github.com/niivue/mono/commit/30b1a48))
- **niivue:** slide-space drawing affordance in the 2D slides viewer + nav links ([010508b](https://github.com/niivue/mono/commit/010508b))
- **niivue:** serialize the slide plane + slide-space drawing in NVDocument (v8) ([136d49f](https://github.com/niivue/mono/commit/136d49f))
- **niivue:** draw on the slide in slide space, reusing the pen tools (both backends) ([ce389d1](https://github.com/niivue/mono/commit/ce389d1))
- **niivue:** camera-distance LOD for the slide plane (both backends) ([1ba9a5e](https://github.com/niivue/mono/commit/1ba9a5e))
- **niivue:** composite NVSlide plane with the volume render (both backends) ([bf259b1](https://github.com/niivue/mono/commit/bf259b1))
- **niivue:** render an NVSlide as a 3D plane in MNI152 space (slide3d demo) ([312264e](https://github.com/niivue/mono/commit/312264e))
- **niivue:** slide-plane 3D geometry foundation (leverages NVSlide) ([7cd79c7](https://github.com/niivue/mono/commit/7cd79c7))
- **niivue:** TIFF/SVS slide source for NVSlide (geotiff) ([28acb33](https://github.com/niivue/mono/commit/28acb33))
- **niivue:** DZI (DeepZoom) slide source on the adapter seam ([f626533](https://github.com/niivue/mono/commit/f626533))
- **niivue:** JPEG 2000 tile decoding for NVSlide (OpenJPEG WASM) ([22dd71a](https://github.com/niivue/mono/commit/22dd71a))
- **niivue:** pluggable tile-codec registry + JP2K manifest tagging ([27f43ca](https://github.com/niivue/mono/commit/27f43ca))
- **niivue:** fetch OpenSlide DICOM-WSI test data for NVSlide ([fc4169e](https://github.com/niivue/mono/commit/fc4169e))
- **niivue:** ensure-samples script to fetch demo data on demand ([2e32469](https://github.com/niivue/mono/commit/2e32469))
- **niivue:** bound + stabilize chunked OME-Zarr streaming in the range demo ([41658aa](https://github.com/niivue/mono/commit/41658aa))
- **niivue:** draggable HUD info panels in the range and slides examples ([4e97202](https://github.com/niivue/mono/commit/4e97202))
- **niivue:** self-contained DICOM-WSI range fetch script + slides source ([993a955](https://github.com/niivue/mono/commit/993a955))
- **niivue:** add pawpawsaurus OME-Zarr source with selectable levels to range demo ([ec7b61b](https://github.com/niivue/mono/commit/ec7b61b))
- **niivue:** port the chunk-streaming demo into the core examples (range.html) ([504bf4c](https://github.com/niivue/mono/commit/504bf4c))
- **niivue:** port the whole-slide tile viewer into the core examples (slides.html) ([a39059c](https://github.com/niivue/mono/commit/a39059c))
- **niivue:** NVSlide whole-slide-image tile viewer (WebGL2 + WebGPU); use it in the tiles demo ([c84440c](https://github.com/niivue/mono/commit/c84440c))

### Fixes

- **niivue:** drive range-demo HUD counts from chunkStreamStats ([9197dce](https://github.com/niivue/mono/commit/9197dce))
- **niivue:** cap range-demo HUD counts to the live plan ([1e06a34](https://github.com/niivue/mono/commit/1e06a34))
- **niivue:** don't serialize transient streamed volumes into NVDocuments ([39d23dc](https://github.com/niivue/mono/commit/39d23dc))
- **niivue:** correct range-demo zoom, HUD telemetry, and reload identity ([e294c5e](https://github.com/niivue/mono/commit/e294c5e))
- **niivue:** close chunked-volume identity and option-validation gaps ([e5fff30](https://github.com/niivue/mono/commit/e5fff30))
- **niivue:** clamp biased focus centre and default deviceLimit from host ([1d59f48](https://github.com/niivue/mono/commit/1d59f48))
- **niivue:** harden range demo streaming paths (review findings 5-10) ([b9338b4](https://github.com/niivue/mono/commit/b9338b4))
- **niivue:** harden core chunked-volume streaming (review findings 1-4) ([af24255](https://github.com/niivue/mono/commit/af24255))
- **niivue:** default the range-demo coarse floor to on ([f54a9f5](https://github.com/niivue/mono/commit/f54a9f5))
- treat zero-valued mesh layer vertices as transparent ([8ed3403](https://github.com/niivue/mono/commit/8ed3403))
- serve streaming demo assets remotely ([4379f6c](https://github.com/niivue/mono/commit/4379f6c))
- **niivue:** harden 3D SVG block drawing (clip index, oblique, normal) ([0c194f0](https://github.com/niivue/mono/commit/0c194f0))
- **niivue:** guard the 3D stroke on polygon area, not its bounding box ([68b0953](https://github.com/niivue/mono/commit/68b0953))
- **niivue:** settingEquals must not duck-type `length` ([0608eb6](https://github.com/niivue/mono/commit/0608eb6))
- **niivue:** commit a 3D vector stroke on pointercancel, reject 1-D strokes ([485a4b5](https://github.com/niivue/mono/commit/485a4b5))
- **niivue:** make the volume-load worker actually work (it never did) ([f2a0e3f](https://github.com/niivue/mono/commit/f2a0e3f))
- harden streaming budget and generated bindings ([577d052](https://github.com/niivue/mono/commit/577d052))
- **niivue:** drop slide3d's dangling stylesheet link (pre-existing 404) ([9a78660](https://github.com/niivue/mono/commit/9a78660))
- **niivue:** review fixes — exception-safe cleanup, SVG geometry + depth-filter ([6c90a2e](https://github.com/niivue/mono/commit/6c90a2e))
- **niivue:** 3D crosshair explode offset uses texture fraction, not scene fraction ([529a2b8](https://github.com/niivue/mono/commit/529a2b8))
- **niivue:** define raster-vs-vector edit-mode priority, stop failing silently ([b3ebd68](https://github.com/niivue/mono/commit/b3ebd68))
- **niivue:** SVG export covers every plane, and hardens untrusted fields ([0c71711](https://github.com/niivue/mono/commit/0c71711))
- **niivue:** never strand drag state when a stroke finalize throws ([e707b72](https://github.com/niivue/mono/commit/e707b72))
- **niivue:** review fixes — stroke sample cache, no-op undo, linkData invariant ([#4](https://github.com/niivue/mono/issues/4), [#5](https://github.com/niivue/mono/issues/5), [#3](https://github.com/niivue/mono/issues/3))
- **niivue:** review-pass fixes for the drawing/exploded-block work ([d59675a](https://github.com/niivue/mono/commit/d59675a))
- **niivue:** demo-hardening for the walkthrough (range H2, slides M3/M4) ([dceeec6](https://github.com/niivue/mono/commit/dceeec6))
- **niivue:** don't streak lines across block gaps in 3D exploded drawing ([6203304](https://github.com/niivue/mono/commit/6203304))
- render physio graph traces continuously ([133cf90](https://github.com/niivue/mono/commit/133cf90))
- **niivue:** clear isDragging on pointercancel so streaming can't stall ([9dfe282](https://github.com/niivue/mono/commit/9dfe282))
- refresh chunk gradients before frame requests ([88ef2c8](https://github.com/niivue/mono/commit/88ef2c8))
- **niivue:** load all blocks when switching the range demo to the render view ([cc93e9c](https://github.com/niivue/mono/commit/cc93e9c))
- **niivue:** gate the range demo's explode on load-settle to avoid a load-time stall ([ae729e3](https://github.com/niivue/mono/commit/ae729e3))
- **niivue:** map slide tiles to base by per-axis level scale (annotation drift) ([2a9ac60](https://github.com/niivue/mono/commit/2a9ac60))
- **niivue:** guard range demo reloads against races ([12421b1](https://github.com/niivue/mono/commit/12421b1))
- **niivue:** stop the "c" key from cycling the clip plane in the slide3d demo ([baf55aa](https://github.com/niivue/mono/commit/baf55aa))
- **niivue:** reset slide renderer texture cache on source switch (ghost tiles) ([58eadbc](https://github.com/niivue/mono/commit/58eadbc))
- **niivue:** hide the zoom focus box too when "blocks" is unchecked ([5bb144f](https://github.com/niivue/mono/commit/5bb144f))
- **niivue:** move the loaded-chunks strip off the 3D render in the range demo ([eafdb16](https://github.com/niivue/mono/commit/eafdb16))
- **niivue:** correctly diagnose Hamamatsu-2 (dicom-parser buffer overrun, not tiling) ([f5a3647](https://github.com/niivue/mono/commit/f5a3647))
- **niivue:** slides links need several clicks — stop capturing the pointer on press ([06e6475](https://github.com/niivue/mono/commit/06e6475))
- **niivue:** wire slide annotation draw + pickFrame into both view loops ([2eb537d](https://github.com/niivue/mono/commit/2eb537d))
- **niivue:** slide-plane lifecycle + decouple slide drawing + tests ([e7b3ea0](https://github.com/niivue/mono/commit/e7b3ea0))
- **niivue:** use uppercase LOD in slides demo label for codespell ([ef49231](https://github.com/niivue/mono/commit/ef49231))

### Performance

- **niivue:** throttle the range demo HUD off the render frame (smoother rotation) ([11ef84d](https://github.com/niivue/mono/commit/11ef84d))
- **niivue:** skip per-chunk gradient pass when unlit (faster chunked loading) ([7783f69](https://github.com/niivue/mono/commit/7783f69))
- **niivue:** pause chunked-volume streaming during drag (smoother rotate/pan) ([1f8bdc4](https://github.com/niivue/mono/commit/1f8bdc4))

### Thank You

- Chris Drake
- Claude Fable 5
- Claude Opus 4.8
- neurolabusc

## 1.0.0-rc.10 (2026-07-01)

### Features

- **niivue:** independent slice/render mesh shader + MRSI packaging, exports, and demo polish ([05778c5](https://github.com/niivue/mono/commit/05778c5))
- **niivue:** promote MRSI scene controller to core; retire nv-ext-mrs ([6d40058](https://github.com/niivue/mono/commit/6d40058))
- **niivue:** graphics-backend fallback + harden >2 GiB partial 4D loading ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** auto-cap 4D loads to the ArrayBuffer limit; clamp nFrame4D to data ([76cdbb6](https://github.com/niivue/mono/commit/76cdbb6))
- **niivue:** partial 4D load (limitFrames4D) via streaming gzip — avoids the 2 GiB cap ([8755b97](https://github.com/niivue/mono/commit/8755b97))
- **niivue:** renderPivotMM — orbit/zoom the 3D render about a world point ([47e50e0](https://github.com/niivue/mono/commit/47e50e0))
- **niivue:** centerRenderOnMM — rebase the 3D render origin on a world point ([89900d8](https://github.com/niivue/mono/commit/89900d8))
- **niivue:** true-ortho render zoom + tile-clipped focus boxes; multiplanar WYSIWYG clip ([407cbe6](https://github.com/niivue/mono/commit/407cbe6))
- **niivue:** WebGL2 multi-LOD render parity + correct mixed-size chunk ordering ([a827644](https://github.com/niivue/mono/commit/a827644))
- **niivue:** 2:1 balanced multi-LOD octree for smoother LOD transitions ([ec8eb69](https://github.com/niivue/mono/commit/ec8eb69))
- **niivue:** per-brick multi-LOD focus fixes, LOD debug boxes, in-place plan swap ([58e327d](https://github.com/niivue/mono/commit/58e327d))
- **niivue:** 3D crosshair tracks the exploded block ([6d6d764](https://github.com/niivue/mono/commit/6d6d764))
- **niivue:** focus-box overlay + explode-aware chunked depth-pick ([ae54f99](https://github.com/niivue/mono/commit/ae54f99))
- **niivue:** per-brick multi-LOD volumes + chunked depth-pick ([562f45a](https://github.com/niivue/mono/commit/562f45a))
- **niivue:** SLICE_TYPE.NONE - hide slices so the signal graph fills the canvas ([b6a7c3b](https://github.com/niivue/mono/commit/b6a7c3b))
- **niivue:** export nii2volume, writeVolume, makeLabelLut for extensions ([0b6fd4b](https://github.com/niivue/mono/commit/0b6fd4b))
- **niivue:** cross-fade streaming chunks in over the coarse floor (2D + 3D) ([58652d1](https://github.com/niivue/mono/commit/58652d1))
- **niivue:** coarse floor in the 3D render (no pop-in while streaming) ([6f20990](https://github.com/niivue/mono/commit/6f20990))
- **niivue:** smooth WSI deep-zoom level transitions via a coarse floor ([9cb5f32](https://github.com/niivue/mono/commit/9cb5f32))
- **niivue:** coarse LOD floor for smooth 2D deep-zoom streaming ([3c86c36](https://github.com/niivue/mono/commit/3c86c36))
- **niivue:** LOD-aware texture-to-texture resampler (resampleInto) ([d23aff7](https://github.com/niivue/mono/commit/d23aff7))
- **niivue:** clipPlaneOverlay to clip overlays with the base volume ([02f4281](https://github.com/niivue/mono/commit/02f4281))
- **niivue:** rebakeChunkedOverlays() for in-place overlay re-bake ([e3d4b88](https://github.com/niivue/mono/commit/e3d4b88))
- **niivue:** render streamed combined overlays on 2D slices ([2bf7d84](https://github.com/niivue/mono/commit/2bf7d84))
- **niivue:** streamed combined overlays on the base grid (strategy A) ([fdac690](https://github.com/niivue/mono/commit/fdac690))
- **niivue:** independent hi-res chunked overlay layer ([ef1b77d](https://github.com/niivue/mono/commit/ef1b77d))
- **niivue:** draw on exploded blocks with right-click, free left-drag for rotate ([793a061](https://github.com/niivue/mono/commit/793a061))
- **niivue:** draw directly on 3D exploded blocks ([2919265](https://github.com/niivue/mono/commit/2919265))
- **niivue:** incremental per-chunk drawing upload for large volumes ([3708476](https://github.com/niivue/mono/commit/3708476))
- **niivue:** cull clip-plane-hidden chunks from the streaming working set ([2794b17](https://github.com/niivue/mono/commit/2794b17))
- **niivue:** stream chunks center-first, spiralling outward ([2949c96](https://github.com/niivue/mono/commit/2949c96))
- **iiif-volumetric-demo:** stream chunked RGB in the wsi.html OSD viewer ([87a9cfc](https://github.com/niivue/mono/commit/87a9cfc))
- **niivue:** viewport-cull the 2D chunked-slice working set ([f7c0b95](https://github.com/niivue/mono/commit/f7c0b95))
- **iiif-volumetric-demo:** stream DICOM-WSI as chunked RGB in the streaming viewer ([eb1c0d9](https://github.com/niivue/mono/commit/eb1c0d9))
- **niivue:** support RGB/RGBA color in the chunked volume path ([894dfed](https://github.com/niivue/mono/commit/894dfed))
- **iiif-volumetric-demo:** smooth OpenSeadragon-style zoom for WSI viewer ([220f77f](https://github.com/niivue/mono/commit/220f77f))
- **iiif-volumetric-demo:** DICOM-WSI deep-zoom viewer (wsi.html) ([8431cfe](https://github.com/niivue/mono/commit/8431cfe))
- add scivis OME-Zarr fetcher and high-res streaming docs ([575d9a8](https://github.com/niivue/mono/commit/575d9a8))
- add aspect-aware OME-Zarr exploded blocks ([7a34939](https://github.com/niivue/mono/commit/7a34939))
- add exploded OME-Zarr chunk rendering ([59ba931](https://github.com/niivue/mono/commit/59ba931))
- **niivue:** Phase 3d demo chunk-budget control ([f5641b2](https://github.com/niivue/mono/commit/f5641b2))
- **niivue:** Phase 3d configurable chunk residency budget ([5a9fbec](https://github.com/niivue/mono/commit/5a9fbec))
- **niivue:** Phase 3d renderer wiring for chunk eviction ([57fddbf](https://github.com/niivue/mono/commit/57fddbf))
- **niivue:** Phase 3d LRU eviction in ChunkResidencyManager ([b6d2139](https://github.com/niivue/mono/commit/b6d2139))
- **niivue:** Phase 3c visibility-driven chunk working set ([2258910](https://github.com/niivue/mono/commit/2258910))
- **niivue:** Phase 3c on-demand chunk uploader and streaming pump ([c5b2828](https://github.com/niivue/mono/commit/c5b2828))
- **niivue:** Phase 3a-3c chunk residency manager and visibility math ([2a327df](https://github.com/niivue/mono/commit/2a327df))
- **niivue:** tiled rendering for volumes exceeding maxTextureDimension3D ([20f0cd0](https://github.com/niivue/mono/commit/20f0cd0))
- **niivue:** renderPan API, atomic loadVolumes swap, worker-based load ([b87f09b](https://github.com/niivue/mono/commit/b87f09b))
- **niivue:** port opts.instances and global3d tile space to WebGPU ([6f8e1d6](https://github.com/niivue/mono/commit/6f8e1d6))
- **niivue:** per-volume GPU texture cache for multi-instance scenes ([db2b2b8](https://github.com/niivue/mono/commit/db2b2b8))
- **niivue:** mirror niivuegpu pan/zoom + instancing ([ff25cb2](https://github.com/niivue/mono/commit/ff25cb2))
- **niivue:** expose volumeTransmittanceCutoff as renderer uniform ([af5117a](https://github.com/niivue/mono/commit/af5117a))

### Fixes

- **niivue:** persist urlImageData for detached-format deferred 4D reload ([#3](https://github.com/niivue/mono/issues/3), [#59](https://github.com/niivue/mono/issues/59), [#1](https://github.com/niivue/mono/issues/1), [#2](https://github.com/niivue/mono/issues/2))
- **niivue:** MRSI crosshair spectrum averages transients to match maps ([8cd8f08](https://github.com/niivue/mono/commit/8cd8f08))
- **niivue:** guard DOMException for non-browser runtimes ([#59](https://github.com/niivue/mono/issues/59))
- **niivue:** address Copilot review (overlay placement, File names, malformed headers) ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** audit round 8 — isBusy try/finally, deferred ownership guard, RGB partial gate ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** audit round 7 — deferred-reload conversion, graph/backend hardening ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** 4D-volume time-course graph fills the canvas on SLICE_TYPE.NONE ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** cap vox_offset for header read to MAX_HEADER_BYTES (64 KiB) ([798b5b1](https://github.com/niivue/mono/commit/798b5b1))
- **niivue:** address Copilot review (URL fragment ext, vox_offset, swiftshader caution) ([#60](https://github.com/niivue/mono/issues/60))
- **niivue:** robustness LOWs from the PR review ([1f8b79e](https://github.com/niivue/mono/commit/1f8b79e))
- **niivue:** don't composite a whole-volume overlay in the chunked 2D path (render M2) ([512fab1](https://github.com/niivue/mono/commit/512fab1))
- **niivue:** cull multi-LOD bricks per slice by voxel extent (chunking M3) ([fe8622f](https://github.com/niivue/mono/commit/fe8622f))
- **niivue:** average MRSI crosshair FID over transients ([82e672b](https://github.com/niivue/mono/commit/82e672b))
- **niivue:** wrap GL per-volume updateVolume in try/catch (WebGPU parity) ([a24519e](https://github.com/niivue/mono/commit/a24519e))
- **niivue:** backend-parity and graph-cache correctness fixes ([79b2b5a](https://github.com/niivue/mono/commit/79b2b5a))
- **niivue:** enforce maxBricks by coarsening the multi-LOD root grid ([2dc448e](https://github.com/niivue/mono/commit/2dc448e))
- **niivue:** guard chunk upload against a stale plan swap ([7f87f2b](https://github.com/niivue/mono/commit/7f87f2b))
- **niivue:** exact BSP back-to-front order for mixed-size chunks ([4695056](https://github.com/niivue/mono/commit/4695056))
- **niivue:** wire modulation placeholder into the chunked orient path ([01fd6df](https://github.com/niivue/mono/commit/01fd6df))
- **niivue:** drop unused import and sort exports after merge (lint) ([13addf6](https://github.com/niivue/mono/commit/13addf6))
- bypass linter for makeLabelLut re-export ([e4575ba](https://github.com/niivue/mono/commit/e4575ba))
- stop "missing image data" crash on rapid overlay-option changes ([9e83564](https://github.com/niivue/mono/commit/9e83564))
- **niivue:** land exploded-block drawing on the visible tissue, not air or clipped voxels ([b7064a1](https://github.com/niivue/mono/commit/b7064a1))
- **niivue:** don't draw on exploded blocks the clip plane has hidden ([089f1dd](https://github.com/niivue/mono/commit/089f1dd))
- **iiif-volumetric-demo:** correct WSI minimap + drag Y orientation ([eb93b6d](https://github.com/niivue/mono/commit/eb93b6d))
- **iiif-volumetric-demo:** smooth, drift-free WSI zoom/pan ([ce73b70](https://github.com/niivue/mono/commit/ce73b70))
- **niivue:** keep exploded chunks resident during rotation ([b223deb](https://github.com/niivue/mono/commit/b223deb))
- address codespell gate ([a0a4657](https://github.com/niivue/mono/commit/a0a4657))
- eliminate streamed volume seam artifacts ([8be40df](https://github.com/niivue/mono/commit/8be40df))
- stabilize streamed OME-Zarr chunk rendering ([90ed416](https://github.com/niivue/mono/commit/90ed416))
- smooth tiled volume rendering ([004f567](https://github.com/niivue/mono/commit/004f567))
- **niivue:** request adapter's max 3D texture limit on WebGPU ([042fdad](https://github.com/niivue/mono/commit/042fdad))
- **iiif-volumetric:** address PR #42 review ([#42](https://github.com/niivue/mono/issues/42))
- **niivue:** correct fan-out and hit-test for shared-canvas multi-instance ([052f4a5](https://github.com/niivue/mono/commit/052f4a5))

### Performance

- **niivue:** stream partial 4D image into one pre-sized buffer ([#60](https://github.com/niivue/mono/issues/60))
- route background volume through the orient-texture cache, cache matcap ([a4982d2](https://github.com/niivue/mono/commit/a4982d2))
- **niivue:** split residency budget between base and chunked overlay ([184f068](https://github.com/niivue/mono/commit/184f068))
- **niivue:** parallel-prefetch chunk source fetches ahead of upload ([b6480bd](https://github.com/niivue/mono/commit/b6480bd))
- **niivue:** time-budgeted round-robin chunk upload pump + stream stats ([edde445](https://github.com/niivue/mono/commit/edde445))

### Thank You

- Chris Drake
- Claude Opus 4.7
- Claude Opus 4.8
- Claude Opus 4.8 (1M context)
- Massny
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.9 (2026-06-12)

### Features

- **niivue:** trigger rug uses the measure-specific <name>_trigger column ([4558b8c](https://github.com/niivue/mono/commit/4558b8c))
- **niivue:** trigger rug at top of signal graph; address PR review + codespell ([f3d33f1](https://github.com/niivue/mono/commit/f3d33f1))
- **niivue:** signal-graph range/zoom interaction (auto-reset + reactive sync) ([#1](https://github.com/niivue/mono/issues/1), [#2](https://github.com/niivue/mono/issues/2))
- **niivue:** signal-graph pan/zoom, missing-data rug, long-physio demo ([fc8db6a](https://github.com/niivue/mono/commit/fc8db6a))
- **niivue:** modulate scalar and background volumes via setModulationImage ([fe0eaca](https://github.com/niivue/mono/commit/fe0eaca))
- **niivue:** add MRSI (MR spectroscopic imaging) support ([bf07b72](https://github.com/niivue/mono/commit/bf07b72))
- **niivue:** annotate signal graphs and add spectroscopy MRI/MRS/voxel demo ([0a68aee](https://github.com/niivue/mono/commit/0a68aee))
- **niivue:** volume+physio association, signal graph UX, audit fixes ([1361053](https://github.com/niivue/mono/commit/1361053))
- **niivue:** add Signal data class (physio + spectroscopy) ([a26b4b3](https://github.com/niivue/mono/commit/a26b4b3))
- **niivue:** bench:report — add fps head-to-head table ([8de6492](https://github.com/niivue/mono/commit/8de6492))
- **niivue:** bench:report — backend-specific tables, real-GPU only ([301794d](https://github.com/niivue/mono/commit/301794d))
- **niivue:** bench:report — self-contained HTML perf report (WebGPU + WebGL2) ([b5a17c7](https://github.com/niivue/mono/commit/b5a17c7))
- **niivue:** dual-backend bench (WebGPU + WebGL2) with GPU timer queries ([fde4c8f](https://github.com/niivue/mono/commit/fde4c8f))
- **niivue:** nv.perf API for per-frame interaction metrics ([876cb52](https://github.com/niivue/mono/commit/876cb52))
- **niivue:** replace CI perf gate with local bench:compare script ([7c6c322](https://github.com/niivue/mono/commit/7c6c322))
- **niivue:** perf gate — handle bootstrap (main predates infra) ([2fb4fae](https://github.com/niivue/mono/commit/2fb4fae))
- **niivue:** perf-regression CI gate (compare PR vs main) ([d92d018](https://github.com/niivue/mono/commit/d92d018))
- **niivue:** add Playwright bench runner ([e492b21](https://github.com/niivue/mono/commit/e492b21))
- **niivue:** add autorun mode to benchmark suite ([ea42a63](https://github.com/niivue/mono/commit/ea42a63))
- **niivue:** minimal perf example + benchmark guardrails ([cc38632](https://github.com/niivue/mono/commit/cc38632))
- **niivue:** gate perf instrumentation on __NIIVUE_PERF__ build flag ([df61452](https://github.com/niivue/mono/commit/df61452))
- **niivue:** port perf harness from niivuegpu ([b648895](https://github.com/niivue/mono/commit/b648895))

### Fixes

- **niivue:** audit round - per-series triggers, default trigger exclusion, doc restore ([d6725ad](https://github.com/niivue/mono/commit/d6725ad))
- **niivue:** audit round - MRS dwell sidecar-first, trigger guards, label, frame index ([5383dca](https://github.com/niivue/mono/commit/5383dca))
- **niivue:** restrict graph double-click reset to the zoom-out button; format sidecars ([8fa900f](https://github.com/niivue/mono/commit/8fa900f))
- **npy:** set trailing pixDims to 0 for NIfTI consistency ([ea071aa](https://github.com/niivue/mono/commit/ea071aa))
- **niivue:** 4D wheel scroll, frame-aware contrast, DPR-change resize ([a4ef65f](https://github.com/niivue/mono/commit/a4ef65f))
- **niivue:** address perf-harness review feedback ([5354456](https://github.com/niivue/mono/commit/5354456))

### Performance

- **niivue:** reduce bench variance + fix asymmetric fps comparison ([b1e0592](https://github.com/niivue/mono/commit/b1e0592))

### Thank You

- Chris Drake
- Claude Opus 4.7
- Claude Opus 4.7 (1M context)
- Claude Opus 4.8
- Claude Opus 4.8 (1M context)
- Matt McCormick @thewtex
- neurolabusc

## 1.0.0-rc.8 (2026-05-13)

### Features

- **niivue:** port legacy colormaps ([06902e0](https://github.com/niivue/mono/commit/06902e0))

### Fixes

- **niivue:** validate colormap channel bounds ([27b3882](https://github.com/niivue/mono/commit/27b3882))

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.7 (2026-05-12)

### Fixes

- **niivue:** update README package reference ([9f1ffe0](https://github.com/niivue/mono/commit/9f1ffe0))

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.6 (2026-05-12)

### Fixes

- **niivue:** correct package import examples ([7e4567c](https://github.com/niivue/mono/commit/7e4567c))

### Thank You

- Taylor Hanayik @hanayik

## 1.0.0-rc.5 (2026-05-12)

### Fixes

- **niivue:** sort imports after merge conflict resolution ([aa6a73d](https://github.com/niivue/mono/commit/aa6a73d))
- **niivue:** clean up overlay texture transitions ([a3b861f](https://github.com/niivue/mono/commit/a3b861f))
- address Copilot second-round PR review ([53651fb](https://github.com/niivue/mono/commit/53651fb))
- **niivue:** repair loadDeferred4DVolumes after limitFrames4D ([#28](https://github.com/niivue/mono/issues/28))
- **niivue:** address affine review feedback ([185c5f5](https://github.com/niivue/mono/commit/185c5f5))
- **niivue:** invalidate label colormap texture cache ([3808d90](https://github.com/niivue/mono/commit/3808d90))

### Performance

- **niivue:** cache affine overlay rebakes ([2717694](https://github.com/niivue/mono/commit/2717694))

### Thank You

- Claude Opus 4.7 (1M context)
- hanayik @hanayik
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.4 (2026-05-01)

### Features

- extract NiiVue <-> WKWebView bridge into reusable packages ([4a929a1](https://github.com/niivue/mono/commit/4a929a1))
- **nv-ext-dcm2niix:** add DICOM-to-NIfTI extension and demo ([04a3898](https://github.com/niivue/mono/commit/04a3898))

### Fixes

- **niivue:** extend default drawing colormap to 8 colors ([#8](https://github.com/niivue/mono/issues/8))
- **niivue:** tolerate VTK files missing the title line ([c4d9b49](https://github.com/niivue/mono/commit/c4d9b49))
- **ipyniivue:** suppress JupyterLab cell context menu on canvas right-click ([a58bd8c](https://github.com/niivue/mono/commit/a58bd8c))

### Thank You

- Claude Opus 4.7 (1M context)
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.3 (2026-04-27)

This was a version bump only for niivue to align it with other projects, there were no code changes.

## 1.0.0-rc.2 (2026-04-27)

### Features

- add vox.torso.html link to examples index page ([280c831](https://github.com/niivue/mono/commit/280c831))
- **niivue:** drawing matcap lighting and bench modularization ([d0e6e7f](https://github.com/niivue/mono/commit/d0e6e7f))
- **niivue:** drawing labels, loadDrawing fix, and render bench harness ([3334824](https://github.com/niivue/mono/commit/3334824))
- **medgfx:** add native macOS/iOS app with embedded NiiVue web view ([38d7a70](https://github.com/niivue/mono/commit/38d7a70))

### Fixes

- **niivue:** inline asset images as base64 data URIs in lib build ([#10](https://github.com/niivue/mono/issues/10))

### Thank You

- Claude Opus 4.7 (1M context)
- hanayik @hanayik
- neurolabusc
- Taylor Hanayik @hanayik

## 1.0.0-rc.1 (2026-04-22)

### 🚀 Features

- **niivue:** add custom layout support ([26f23c5](https://github.com/niivue/mono/commit/26f23c5))

### 🩹 Fixes

- **ci:** use bunx --bun to force Bun runtime for vite commands ([19e1df2](https://github.com/niivue/mono/commit/19e1df2))
- **ci:** use bunx for vite commands and resolve typecheck errors ([6e637db](https://github.com/niivue/mono/commit/6e637db))
- **niivue:** preserve aspect ratio in custom layout tiles ([aa418c8](https://github.com/niivue/mono/commit/aa418c8))
- **nv-react:** update to new niivue API and switch dev server to Vite ([5c90bc4](https://github.com/niivue/mono/commit/5c90bc4))
- **niivue:** resolve TypeScript strict null check errors across codebase ([f3936c3](https://github.com/niivue/mono/commit/f3936c3))

### ❤️ Thank You

- Taylor Hanayik @hanayik