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

## 6. Open work — the browser render-finish

The server hands the client a `dicom-wsi` multiscale `rgb24` volume; making it
appear in the demo is the remaining piece, roughly in order:

1. **Confirm niivue renders a depth-1 `rgb24` volume.** RGB volumes upload
   straight to `rgba8unorm` (`rgba2Texture`); verify a `[W,H,1]` volume
   slices cleanly in 2D (axial = the slide face) and doesn't trip the 3D
   ray-march placeholder guards (`textureSize > 2`).
2. **Stream `rgb24` chunks.** Check the chunk uploader path carries the
   `rgb24` dtype end to end (orient pass already supports RGB bypass) so
   `loadSubvolume` bricks upload correctly when the slide exceeds the GPU
   texture limit (it does: 53783 > maxTextureDimension3D).
3. **Demo wiring.** Either widen the `omezarr.html` volume filter to include
   `dicom-wsi`, or add a `wsi.html` page. Default the view to 2D axial,
   coarse-first, with shift-click / scroll driving bbox + level the way the
   OME-Zarr page does. The slide is depth-1, so the 3D pane is a thin slab —
   lead with the slice.
4. **Aspect / spacing.** WSI `PixelSpacing` is often absent or per-level;
   confirm the `[W,H,1]` aspect renders square-pixel correct, and that
   coarse-level spacing scales so levels register.
5. **Nice-to-haves.** Surface the LABEL/OVERVIEW ancillary images (currently
   dropped from the pyramid) as a slide thumbnail; lazy per-frame range reads
   of the base instance instead of buffering all 422 MB.

---

## 7. Files

| File | Role |
| --- | --- |
| `apps/iiif-volumetric-server/src/adapters/dicomWsi.ts` | pure WSI metadata + tile geometry |
| `apps/iiif-volumetric-server/src/adapters/dicomWsi.test.ts` | unit tests (ground-truth pyramid + tile math) |
| `apps/iiif-volumetric-server/src/adapters/dicom.ts` | the `VolumeAdapter` (decode + assemble) |
| `apps/iiif-volumetric-server/scripts/fetch-dicom-wsi.ts` | IDC fetch + registration symlink |
| `packages/niivue/docs/high-res-streaming.md` | the client/server streaming architecture this reuses |
