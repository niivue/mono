# DICOM Whole-Slide Imaging (WSI) rendering

How a gigapixel pathology slide stored as DICOM is served and rendered by the
same machinery that handles OME-Zarr. The server side is implemented and
verified; the browser render-finish is the open work (see section 6).

---

## 1. Strategy in one line

A WSI is a 2D multi-resolution image, so model each pyramid level as a
**depth-1 RGB volume** `[W, H, 1]` (`dtype: 'rgb24'`). Then the OME-Zarr
pyramid + bbox-subvolume streaming path (`probeLevels` / `loadLevel` /
`loadSubvolume`, LRU chunk residency, coarse-first LOD) serves whole slides
**unchanged** — no new server route and no new render path.

---

## 2. What a DICOM WSI series actually is

A series is a set of multi-frame instances, one instance per pyramid level,
plus ancillary images. Ground truth from the tracked CPTAC-BRCA fixture
(`fetch-dicom-wsi` default series `37cb2625`, ~487 MB):

| Instance role | Total matrix (W×H) | Tiles | Codec |
| --- | --- | ---: | --- |
| VOLUME (L0 base) | 53783 × 49534 (2.66 GP) | 46575 | JPEG baseline |
| VOLUME (L1) | 13445 × 12383 | 2964 | JPEG baseline |
| VOLUME (L2) | 3361 × 3095 | 195 | JPEG baseline |
| VOLUME (L3) | 1680 × 1547 | 49 | JPEG baseline |
| LABEL / OVERVIEW / THUMBNAIL | small | 1 | uncompressed |

Key DICOM tags (all read before PixelData, so a header-only chunk read probes
even the 422 MB base instance):

- `TotalPixelMatrixColumns/Rows` (0048,0006 / 0048,0007) — level size in px.
- `Columns/Rows` (0028,0011 / 0028,0010) — tile size (240×240 here).
- `NumberOfFrames` (0028,0008) — tile count.
- `DimensionOrganizationType` (0020,9311) = **TILED_FULL** — implicit raster
  tile order, **column index fastest then row**, so a tile's frame index is
  pure arithmetic; no Per-Frame Functional Groups read needed.
- `PhotometricInterpretation` (0028,0004) — authoritative color space.
- `TransferSyntaxUID` (0002,0010) — drives codec / encapsulation detection.

The TILED_FULL invariant (verified against all 4 levels in
`dicomWsi.test.ts`): `tilesAcross = ceil(W / tileW)`,
`tilesDown = ceil(H / tileH)`, `tilesAcross * tilesDown == NumberOfFrames`,
and `frame(col, row) = row * tilesAcross + col`.

---

## 3. Server implementation (done)

`apps/iiif-volumetric-server/src/adapters/`

- **`dicomWsi.ts`** — pure, unit-tested: tag keys, `readInstanceMeta`,
  `buildPyramid` (keep VOLUME tiers, sort highest-resolution first, number
  0..N), tile geometry (`tilesAcross` / `frameIndexForTile` /
  `tileRangeForBbox`), `isEncapsulatedTransferSyntax`, `jpegColorTransform`.
- **`dicom.ts`** — the `VolumeAdapter`: `dicom-parser` for encapsulated
  per-frame extraction (`createJPEGBasicOffsetTable` +
  `readEncapsulatedImageFrame`), `jpeg-js` for baseline decode, per-level
  caching of the parsed dataset + basic offset table.
  - `probe` / `probeLevels` — `[W, H, 1]` shapes, header-only.
  - `loadLevel(i)` — decode every tile of a coarse tier into one rgb24
    volume; capped at `MAX_WHOLE_LEVEL_BYTES` (768 MB) so the base tier is
    never materialised whole.
  - `loadSubvolume(i, bbox)` — `tileRangeForBbox` → decode only the covering
    frames → `blitTile` crops/composites them into the requested slab. This
    is the deep-zoom path for L0/L1.

### Two non-obvious correctness points (both cost real debugging)

1. **Encapsulation must come from `TransferSyntaxUID`, not the PixelData
   element.** The header-only metadata read stops *before* PixelData, so
   inferring "compressed" from the pixel element's length is wrong and silently
   sends JPEG bytes down the uncompressed path → pure noise. Detect from the
   transfer syntax (JPEG family `1.2.840.10008.1.2.4.*`, RLE `...1.2.5`).
2. **The JPEG color transform must follow `PhotometricInterpretation`.** These
   CPTAC frames are `RGB` but carry an Adobe APP14 marker that tricks jpeg-js
   into a YCbCr→RGB transform → green cast. Force `colorTransform: false` for
   `RGB`; `true` for any `YBR_*`.

### Verified end to end (against the fixture)

- `/api` surfaces `cptac-brca_dicom` as `dicom-wsi`, `rgb24`, base
  `53783×49534×1`, 4 levels.
- `raw.nii.gz?level=3` → correct H&E thumbnail of the whole slide.
- `raw.nii.gz?level=0&bbox=...` → a 2048-cube of cellular detail (nuclei,
  adipocytes, stroma) pulled from the 2.66 GP base in tens of ms.

---

## 4. Download + registration

```sh
bun apps/iiif-volumetric-server/scripts/fetch-dicom-wsi.ts \
  --series=<SeriesInstanceUID> --name=<slug>
```

Defaults to the CPTAC-BRCA pyramid above. Pulls from the public NCI Imaging
Data Commons (`idc-open-data` S3); the series UUID is the bucket prefix. The
script drops a top-level symlink `fixtures/<slug>_dicom -> dicom-wsi/<slug>_dicom`
because the registry scan only reads the top level (mirrors how the OME-Zarr
fixtures are surfaced). Grab other series UUIDs from
<https://portal.imaging.datacommons.cancer.gov/>; thousands of SM (slide
microscopy) series exist across `cptac_*`, `tcga_*`, `htan_*`, `cmb_*`, `gtex`.

---

## 5. Why depth-1 RGB volume (vs a dedicated 2D deep-zoom viewer)

- `VolumeHandle` already has an `rgb24` dtype and the streaming endpoints
  already speak levels + bbox — zero new server surface.
- The client already has coarse-first LOD, chunk residency, and the exploded
  view. A slide is just a volume that happens to be one voxel deep.
- The natural WSI view is the **2D axial slice** (= the slide face) with
  pan/zoom driving LOD — exactly the pathology deep-zoom UX, reusing the slice
  path rather than the 3D ray-march.

---

## 6. Browser viewer (done) — `wsi.html`

`apps/iiif-volumetric-demo/wsi.html` + `src/wsi.ts` is a deep-zoom slide
viewer built on the single-texture RGB path (no niivue changes):

- niivue loads each level as a depth-1 `rgb24` volume (datatype 128 → uploaded
  straight to `rgba8unorm` via `rgba2Texture`) drawn as a 2D axial slice — the
  slide face. Verified that niivue accepts `[W,H,1]` RGB volumes for both a
  whole coarse level and a bbox subvolume.
- **Smooth OpenSeadragon-style zoom/pan**: the view is tracked as a viewport
  over the slide — a centre and a span, both in base-level pixels — which the
  wheel (centred zoom) and drag (pan) handlers own directly, re-aiming niivue's
  2D pan/zoom (`pan2Dxyzmm`) each frame via `setNiivueView`. We drive it
  ourselves rather than using niivue's built-in wheel zoom because that anchors
  on the crosshair and, for a window volume whose mm origin isn't at its centre,
  drifts the view — so `primaryDragMode` is `none` and the viewport state is
  authoritative (no mm round-trip, no drift).
- **Auto-LOD with a margin window**: a window `MARGIN`× larger than the viewport
  is loaded, so small zooms/pans stay within the texture. A debounced settle
  pass swaps the pyramid level (and reloads the window, scale-matched and
  recentred so the framing is preserved) only when a texel would grow past
  `TEXEL_BLUR` / shrink below `TEXEL_WASTE` screen pixels, or the view nears the
  window edge — picking the level whose pixels are ~1:1 with the screen. The
  dead-band stops levels thrashing during a continuous zoom.
- **Whole-slide overview**: the coarsest level fits one texture and loads whole.
- **Deep zoom**: finer levels exceed the 2048 texture limit, so the viewer
  loads only the visible window via the bbox subvolume read — the
  2.66-gigapixel base level is never materialised.
- Controls: scroll to zoom (centred), drag to pan, a log-scaled zoom slider, a
  level dropdown, double-click / "zoom in" to dive at centre, a "whole slide"
  reset, and a minimap with a viewport box and click-to-jump. Navigation math
  (level pick with the texture-fit guard, margin-window placement,
  viewport→niivue mapping) is in `wsi.ts`.
- **Axial Y orientation**: the window NIfTI carries no affine, so niivue orients
  it by pixdim — `frac2mm` Y is **positive** and the view is **not**
  radiological, i.e. axial is **+Y up** (data row 0 at the bottom). The IIIF
  thumbnail used by the minimap has row 0 at the top, so the minimap is flipped
  `scaleY(-1)` to match, the minimap click inverts Y, and the drag-pan adds
  `+dy` on Y (it subtracts `dx` on X, which is not flipped).

### Chunked RGB streaming — niivue support landed

niivue's **chunked** orient path now accepts RGB/RGBA color. Color sources skip
the orient/colormap shader and upload their chunk bytes straight into an RGBA8
texture via the per-chunk `chunkRGBA` + `rgba2TextureChunk` (WebGL2) /
`writeTexture` (WebGPU) bypass — the chunked analogue of the single-texture
`rgba2Texture`. The shared `chunkRGBA` helper (RGB24→RGBA8 expand, RGBA32
pass-through) lives in `volume/orientChunked.ts` and is unit-tested; per-chunk
residency already counts RGBA8 + gradient (8 bytes/voxel). Verified end to end:
loading the WSI L2 (3361×3095, dt 128) tiles into 4 chunks and uploads without
the old "RGB not supported" throw.

**Remaining (demo wiring):** `wsi.html` still uses the single-texture windowed
path. Switching it to load the whole base level as a chunked RGB volume (a
`chunkSource` that fetches tiles via bbox, like the OME-Zarr streaming volume)
would give smooth pan across full resolution with niivue's own
visibility-driven streaming, retiring the manual window-swap. The capability is
there; the viewer just needs to use it.

### Other nice-to-haves

- Surface the LABEL / OVERVIEW ancillary images (currently dropped from the
  pyramid) as a slide thumbnail.
- Lazy per-frame range reads of the base instance instead of buffering all
  422 MB into the per-level cache.
- WSI `PixelSpacing` is often absent (then `[1,1]`, square pixels). If a slide
  carries real spacing, confirm coarse-level spacing scales so levels register.

---

## 7. niivue integration contract (no niivue changes)

The OSD-style WSI navigation required **zero changes to niivue source** — it is
entirely demo code (`apps/iiif-volumetric-demo/src/wsi.ts`) driving niivue's
existing public API. This section pins down exactly which niivue behaviours the
viewer depends on, so a future niivue change that breaks one is recognised as
breaking WSI navigation.

### API surface the viewer relies on

| niivue API | How the WSI viewer uses it |
| --- | --- |
| `new NiiVue({ primaryDragMode: DRAG_MODE.none, backend })` | Disables niivue's own drag/zoom so the viewer fully owns pan/zoom (see the quirk below). |
| `nv.loadVolumes([{ url }])` | Loads each pyramid level / window — an `rgb24` NIfTI from the server — as an ordinary volume. |
| RGB volume support (`datatypeCode` 128 → `rgba8unorm` via `rgba2Texture`) | A WSI level is a depth-1 **RGB** volume; niivue uploads it straight to an RGBA8 texture (`wgpu/orient.ts` / `gl/orientOverlay.ts`), no colormap. |
| Depth-1 volume + `nv.sliceType = SLICE_TYPE.AXIAL` | A `[W, H, 1]` volume's axial slice **is** the slide face. |
| `nv.pan2Dxyzmm` (`vec4` `[panX_mm, panY_mm, panZ_mm, zoom]`) | The viewer writes this every frame to aim the 2D view; it is the entire camera. |
| `nv.drawScene()` | Repaint after the viewer changes `pan2Dxyzmm`. |

### The 2D ortho contract we invert

`setNiivueView()` depends on the exact 2D-ortho math in
`math/NVTransforms.ts:calculateMvpMatrix2D` (and the pan mapping in
`view/NVSliceLayout.ts:slicePanUV`):

- **visible width** on screen = `volumeWidthMM / zoom`
- **screen-centre** (mm) = `volumeCentreMM - panU`

Expressed relative to the volume centre (which maps to the window centre
regardless of the affine origin), that inverts to the `setNiivueView` /
viewport formulas in `wsi.ts`. WSI volumes carry spacing `[1,1,1]`, so
`base-px-per-mm = level downsample factor`. If niivue's 2D pan/zoom convention
changes, these formulas must change with it.

### The quirk we work around

niivue's built-in 2D **wheel zoom anchors on the crosshair**
(`control/interactions.ts`, the `isPanZoomMode` branch:
`pan2Dxyzmm[0] += zoomChange * scene2mm(crosshairPos)[0]`). For a volume whose
mm origin is **not** at its centre — which our server-built window volumes are —
that term is non-zero and the view **drifts toward a corner** as you zoom. So
the viewer sets `primaryDragMode: none` (which disables that branch) and drives
a **centred** wheel zoom and a drag pan itself, writing `pan2Dxyzmm` directly.
This is the single most important niivue-facing detail of the WSI work.

### What the demo orchestrates (and what niivue now supports)

niivue renders **one texture per volume** for the single-texture path the WSI
viewer currently uses, so the deep-zoom is orchestrated by the demo (swap which
window niivue shows). niivue **does** tile a single oversized volume into chunks
— and the chunked orient path now accepts **RGB/RGBA** color
(`gl/orientChunked.ts` / `wgpu/orientChunked.ts` upload color straight to RGBA8
via `chunkRGBA`). So the capability to stream the whole base level as tiles
exists; wiring `wsi.html` to use it (a chunked RGB volume with a tile-fetching
`chunkSource`) is the remaining demo step — see §6.

---

## 8. Files

| File | Role |
| --- | --- |
| `apps/iiif-volumetric-server/src/adapters/dicomWsi.ts` | pure WSI metadata + tile geometry |
| `apps/iiif-volumetric-server/src/adapters/dicomWsi.test.ts` | unit tests (ground-truth pyramid + tile math) |
| `apps/iiif-volumetric-server/src/adapters/dicom.ts` | the `VolumeAdapter` (decode + assemble) |
| `apps/iiif-volumetric-server/scripts/fetch-dicom-wsi.ts` | IDC fetch + registration symlink |
| `packages/niivue/docs/high-res-streaming.md` | the client/server streaming architecture this reuses |
