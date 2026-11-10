# @niivue/nv-ext-tile

Tiled and chunked image formats for NiiVue (slides and streamed volumes), one subpath per format, so a page loads only the format it uses:
- `@niivue/nv-ext-tile/tiff`: tiled TIFF (below).
- `@niivue/nv-ext-tile/dicom`: DICOM-WSI folders, hosted manifests and DICOMweb ([Local DICOM-WSI folders](#local-dicom-wsi-folders), [DICOMweb](#dicomweb)). It is a whole-slide adapter, not a DICOM loader: convert other DICOM to NIfTI with `@niivue/dcm2niix`.
- `@niivue/nv-ext-tile/zarr`: OME-Zarr volumes, whole levels or streamed brick by brick, and 2D OME-Zarr slides streamed tile by tile into `NVSlide` ([OME-Zarr](#ome-zarr)).

Replaces `@niivue/nv-ext-wsi` and `@niivue/nv-ext-tiff`, and core's OME-Zarr exports; the APIs are unchanged, only the import paths differ.

## Installation

```bash
bun add @niivue/nv-ext-tile
```

Requires `@niivue/niivue` as a peer dependency, at least the core version current when this package was published (`workspace:^`, which `bun publish` writes as `^<that version>`).

## TIFF

Stream large tiled/pyramidal TIFF, BigTIFF, OME-TIFF and Aperio SVS whole-slide images into NiiVue's `NVSlide`, one tile at a time, using [@niivue/geotiff-rs](https://github.com/rordenlab/geotiff-rs) (a read-only port of geotiff.js 3.1 with Rust/WASM decoders).

Core NiiVue already reads TIFF volumes (strips, tiles, LZW, Deflate, PackBits) with no dependencies, but decodes the whole file. This package is for slides too large to fetch: it reads only the IFDs and the tiles in view, over HTTP Range, and adds the compressions core lacks (JPEG with `JPEGTables`, JPEG 2000, ZSTD, WebP, LERC). Apps that need it pay for `@niivue/geotiff-rs`; core users do not.

### Usage

```ts
import { NVSlide, SlideRenderer } from '@niivue/niivue'
import { registerDcm2niixTiffDecoders, TiffSlideSource } from '@niivue/nv-ext-tile/tiff'
import { fromBlob, Pool } from '@niivue/geotiff-rs'

const pool = new Pool() // optional: decode in web workers
registerDcm2niixTiffDecoders() // optional: JPEG 2000 tiles (Aperio SVS); needs @niivue/dcm2niix

// Remote file, streamed by HTTP Range
const source = await TiffSlideSource.fromUrl('https://example.org/slide.svs', { pool })
// or a local file
// const source = await TiffSlideSource.fromGeoTIFF(await fromBlob(file), { id: file.name, pool })

const slide = NVSlide.fromSource(source)
// draw with SlideRenderer (WebGL2) / SlideRendererGPU, or nv.setSlidePlane(slide, ...)

// When done (NVSlide.dispose() does not reach the source):
slide.dispose()
source.dispose()
pool.destroy()
```

`fromUrl` accepts `fetch` to supply your own fetch (e.g. to add auth headers) and `signal` to abort a superseded open. The manifest id defaults to the decoded file name.

### What it reads

- **Levels:** OME-TIFF pyramids in `SubIFDs` (first plane only), else every tiled image in the IFD chain, one per downsample, finest first. Stripped images (SVS thumbnail, label, macro) and tiled images off the base aspect ratio (an SVS macro) are skipped, except a whole-tile image that a power-of-two downsample of the base, padded to tiles, explains (Philips TIFF); its level covers the unpadded area.
- **Pixels:** geotiff-rs's `readRGB` converts RGB, YCbCr, gray (incl. WhiteIsZero), palette and CMYK to 8-bit RGB. Tiles reach `NVSlide` as `raw-rgba`, cropped at the right/bottom edge.
- **Compression:** none, LZW, JPEG, Deflate, PackBits (Rust/WASM), LERC, ZSTD, WebP (JS). JPEG 2000 (Aperio 33003 and 33005, TIFF 34712) after `registerDcm2niixTiffDecoders()`, which decodes in @niivue/dcm2niix's OpenJPEG workers (loaded on the first such tile, one pool shared with `/dicom`'s `registerDcm2niixDecoders`) rather than the geotiff `Pool`; colour matches OpenSlide within 1. Without it those tiles fail with geotiff-rs's "has no built-in decoder" error. Not supported: old-style JPEG (6), 12-bit and lossless JPEG.
- **Limits:** tiles 16-4096 px per side in multiples of 16 (as TIFF 6.0 requires), at most 2^21 tiles across all levels, unsigned integer samples, RGB 8 bits per sample; other files are rejected. dcm2niix decodes JPEG 2000 tiles up to 2048 px per side. Only the first 64 IFDs (main chain or SubIFDs) are examined.
- **JS decoders trust the compressed stream.** The Rust codecs and dcm2niix bound a tile's decoded size, but LERC, ZSTD and WebP do not: a hostile tile can exhaust memory. Only open files you trust, or decode in workers with a `Pool`, so the damage stays in a worker rather than the tab.

Not supported yet: 16-bit and multichannel fluorescence planes (only 8-bit RGB/gray displays correctly), choosing an OME plane other than the first, TIFF z-stacks as streamed volumes (`VolumeChunkSource`), pixel spacing.

## Local DICOM-WSI folders

```ts
import { DicomWsiSource, indexDicomWsi, registerDcm2niixDecoders } from '@niivue/nv-ext-tile/dicom'

registerDcm2niixDecoders() // JPEG 2000 and JPEG-LS tiles, and ICC colour management; needs @niivue/dcm2niix
const files = [...folderInput.files] // <input type="file" webkitdirectory>
const index = await indexDicomWsi(files)
const slide = NVSlide.fromSource(new DicomWsiSource(index.slides[0], files))
```

- `indexDicomWsi` reads only headers and item tags (`File.slice`), never pixel data.
  It uses the Basic or Extended Offset Table when present, and otherwise walks the items.
- It handles multi-fragment frames, TILED_SPARSE (holes stay empty), and
  concatenations. TILED_FULL frames keep their implicit order; per-frame
  positions, when given, win (items holding only other metadata, such as Frame
  Content, do not change the order). A file with no DimensionOrganizationType is
  placed by its per-frame positions (path and plane from per-frame values) when
  it gives them, else in the implicit order.
- Each optical path and focal plane becomes its own slide. A shared
  OpticalPathIdentifier assigns every frame to that path; an identifier missing
  from OpticalPathSequence is its own path. `focalPlane` is a plane index, not µm:
  stated ZOffsets (shared or per frame, to the nm) are ranked across the slide's
  levels (lowest first), so a lower level holding only some planes joins the right
  ones. A multi-plane TILED_FULL level stating no ZOffset keeps its implicit plane
  index (scanners give TotalPixelMatrixOriginSequence no Z), so it is matched by
  index and may join the wrong plane if other levels hold a different set of planes.
  A single shared ZOffset in a multi-plane TILED_FULL file is ignored. ZOffset on
  only some of a file's frames is `malformed`.
- `pixelSpacingMM` is the level-0 PixelSpacing: shared PixelMeasures, else the first
  frame's, else top-level, else ImagedVolumeWidth/Height over the total pixel matrix.
- Files it cannot index are listed in `index.skipped` with a reason: `not-dicom`,
  `transfer-syntax` (explicit VR little endian only), `uncompressed`, `malformed` or
  `not-tiled`.
- Hostile input is bounded: the header read stops at 64 MiB, sequences at 8 levels,
  a level at 2^22 tiles, a file at 4096 (optical path, focal plane) pairs, TILED_FULL
  frames at tiles x planes x NumberOfOpticalPaths, and counts and offsets are checked
  against the file size (`malformed` otherwise). A slide's levels total at most
  2 x 2^22 tiles; levels past that are dropped and listed in `skipped`.
- The index holds only per-frame data, bounded by the files' sizes, so a folder of
  many slides indexes in memory proportional to its headers. Each level reports
  `duplicates` and `holes`; its grid-sized tile map is built only when
  a slide is opened (`DicomWsiSource`) or a manifest is written.
- **ICC colour management.** `DicomWsiSource`, `DicomWebWsiSource` and `TiffSlideSource` serve the slide's ICC profile (the optical path's (0028,2000), or TIFF tag 34675). `registerDcm2niixDecoders` also registers @niivue/dcm2niix's LittleCMS as NVSlide's ICC transform (unless the host registered one), so a slide with a profile is shown in sRGB unless `colorManagement` is off. Call it before opening slides: a slide bakes its profile when it is created. This needs @niivue/dcm2niix 1.4.20261105-rc.3 or later (`iccLut`), the peer floor. `fetchIccProfile(signal)` stops waiting on abort; `source.dispose()` cancels the read.
- `DicomWsiSource` reads one tile at a time and checks each frame's item tag, so a file
  that changed since indexing fails rather than decoding garbage.
- Supported transfer syntaxes: JPEG baseline/extended (browser), JPEG 2000 and JPEG-LS
  (`registerDcm2niixDecoders`, with `@niivue/dcm2niix` as an optional peer dependency;
  a decoder the host already registered wins). A dcm2niix pool whose workers die is
  replaced, and the tile or profile retried once.
- Slides are shown with row 0 of the total pixel matrix at the top (`displayYAxis: 'down'`),
  as OpenSlide shows them.
- Index speed for the 8 OpenSlide DICOM-WSI test sets (local SSD; Chrome reads through
  the `webkitdirectory` input in the demo):

  | Set | Frames | Holes | Bun | Chrome |
  |---|---|---|---|---|
  | Hamamatsu-2 (EOT) | 6,199 | 0 | 2 ms | 12 ms |
  | 3DHISTECH-2 (BOT, sparse, split L0) | 56,233 | 449,040 | 65 ms | 102 ms |
  | Leica-4 (sparse) | 8,546 | 0 | 73 ms | 323 ms |
  | 3DHISTECH-1 | 4,434 | 0 | 100 ms | 643 ms |
  | JP2K-33003-1 (item walk) | 4,569 | 0 | 93 ms | 600 ms |
  | CMU-1-JP2K-ICT (item walk) | 24,813 | 0 | 159 ms | 952 ms |
  | CMU-1-JP2K-33005 (item walk) | 28,284 | 0 | 280 ms | 1.74 s |
  | CMU-1-JP2K-RCT (item walk) | 24,813 | 0 | 429 ms | 2.78 s |

  Indexing awaits `File.slice` reads, so the page stays responsive; a folder without
  offset tables just takes longer in the browser.

- Test fixtures: `fixtures/dicom-wsi` (synthetic, about 60 KB, with the generator
  `make_fixtures.py`; `colors.dcm` has real JPEG tiles, made by `cjpeg`, for the demo's
  browser check). A `.json` is its `.dcm` as DICOM JSON, for the parity test.

## DICOM JSON metadata

`indexDicomWsiMetadata(instances)` indexes DICOM-WSI from metadata alone, as a DICOMweb server returns it: PS3.18 DICOM JSON (`{"00480006": {"vr": "UL", "Value": [40]}}`) or dcmjs-naturalized objects (keyword keys, as OHIF's `displaySet.instances`). It places frames with the same code as `indexDicomWsi`, so slides, levels, sparse holes, focal planes, concatenations, spacing and bounds match; frames have no byte spans (`instance` and `frame` name each one, for WADO-RS `/frames/{n}`).

- Transfer syntax: TransferSyntaxUID, else the first AvailableTransferSyntaxUID a tile codec reads, else `''` for the source to resolve. Native syntaxes are skipped, as for local files.
- ICC profile: `iccProfile.bulkDataURI` to fetch, or `data` when inline.
- No DimensionOrganizationType and no per-frame positions (or per-frame groups left as bulk data) means implicit TILED_FULL order, as for local files.
- One call indexes at most 2 x 2^22 frames; instances past that are skipped.
- `skipped[].file` holds the instance's name: its SOPInstanceUID, else `instances[k]`.

## DICOMweb

```ts
const index = indexDicomWsiMetadata(seriesMetadata) // WADO-RS .../series/{uid}/metadata
const source = await DicomWebWsiSource.open(index.slides[0], {
  seriesUrl: 'https://host/dicomweb/studies/1.2/series/3.4',
  headers: () => ({ Authorization: getToken() }), // read per request
})
const slide = NVSlide.fromSource(source)
```

- Tiles are fetched by WADO-RS `{seriesUrl}/instances/{sop}/frames/{n}`, with the slide's abort signal. A query on `seriesUrl` (an access token) is kept on each frame URL.
- A level whose metadata states no transfer syntax costs one frame request in `open` (all levels at once), which reads the syntax from the bytes. A server that refuses it (HTTP 400, 406 or 415) is assumed to serve JPEG Baseline; other errors fail the open.
- JPEG 2000 and JPEG-LS tiles are requested untranscoded (`transfer-syntax=*`); a tile the server transcoded anyway is refused.
- Responses are capped at 64 MB, also when streamed without Content-Length. `readFirstPart(response, what)` applies the same cap and returns the first multipart/related part, for a host's own WADO-RS requests.
- ICC profile: the inline value, else the BulkDataURI resolved against `seriesUrl`, through `retrieveBulkData(url, signal)` when given (e.g. OHIF's data source) and the URL is on `seriesUrl`'s origin, else (or when it resolves undefined or empty) fetched. `headers`, and the `seriesUrl` query when the URI has none, go only to `seriesUrl`'s origin, so an ICC BulkDataURI on another origin that needs auth is unsupported (it is fetched without credentials). A relative `seriesUrl` resolves against the page.
- One slide per optical path and focal plane, as for local files; a viewer that shows one picks `slides[0]`, the first path and lowest plane, and should say others exist.

## OME-Zarr

```ts
import { loadOmeZarrVolumes, streamOmeZarr } from '@niivue/nv-ext-tile/zarr'

await nv.loadVolumes(await loadOmeZarrVolumes(storeUrl, { level: 2 })) // one whole level
await streamOmeZarr(nv, storeUrl) // or stream bricks; its workers stop once the volume is removed
```

To share one source (a volume and a slide), open it with `fetchOmeZarrChunkedSource`, pass it to `nv.loadChunkedVolume`, and call `source.dispose()` when done: dropping the reference leaves its workers running.

For a 2D image (one y/x plane per level), `ZarrSlideSource` streams chunks into `NVSlide` as tiles instead:

```ts
import { NVSlide } from '@niivue/niivue'
import { ZarrSlideSource } from '@niivue/nv-ext-tile/zarr'

const source = await ZarrSlideSource.fromUrl(storeUrl) // or fromStore(store); { channel, z, t } pick a plane
const slide = NVSlide.fromSource(source)
if (source.window) slide.setChannel(0, source.window) // grey only: NVSlide does not read this window from the source
```

Three uint8 channels show as RGB. Other multi-channel stores open as `slide.channels`: omero label, colour (snapped to a colormap), window and `active` (inactive channels start hidden and are not fetched; only the first 4 active ones start visible, so many-channel stores keep a usable tile budget), composited by `slide.channelBlend` (MAX by default). A single-channel store, or `channel`, shows one channel in grey. Windows come from omero (else the data range of up to 1024 x 1024 samples at the centre of the coarsest level, or the whole level when that sample is flat), with non-uint8/16 dtypes quantized to uint16. A store with z or t > 1 needs `z` / `t`. Tile reads run on the main thread.

Volume reads run in a worker pool (inlined, no asset to deploy) with a main-thread fallback; `zarrita` is a dependency. The worker carries its own copy of the few core helpers it calls (chunk timing, voxel utilities), built from the core this package was built against, so it can lag the core a page installs within the peer range; the main thread always uses the page's core. Details: [docs/ome-zarr-format.md](docs/ome-zarr-format.md). Demos: `ome.zarr.html`, `range.html` and `vox.block.pick.zarr.html` in `apps/demo-ext-tile`.

## Without a bundler

`dist/standalone/` holds `tiff.js`, `dicom.js` and `zarr.js` with geotiff-rs (its WASM inlined) and zarrita bundled in and the Zarr worker inlined. Only `@niivue/niivue` stays a bare import, plus `@niivue/dcm2niix` in `/dicom` and `/tiff`, imported only when a registered decoder first runs. Map them with an import map onto core's standalone build, so the page and the extension share one core (one NVSlide decoder registry, one chunk-timing recorder):

```html
<script type="importmap">
{ "imports": {
  "@niivue/niivue": "./niivue/niivue.js",
  "@niivue/nv-ext-tile/tiff": "./nv-ext-tile/tiff.js",
  "@niivue/nv-ext-tile/zarr": "./nv-ext-tile/zarr.js",
  "@niivue/nv-ext-tile/dicom": "./nv-ext-tile/dicom.js",
  "@niivue/dcm2niix": "./dcm2niix/index.jpeg.js"
} }
</script>
```

Copy `@niivue/niivue`'s `dist/standalone/` to `niivue/`, this package's to `nv-ext-tile/`, and, for JPEG 2000 / JPEG-LS tiles (DICOM and TIFF) and ICC profiles, `@niivue/dcm2niix`'s `dist/` to `dcm2niix/` (its workers and WASM load relative to `index.jpeg.js`). A page using `@niivue/niivue/webgpu` or `/webgl2` maps those entries too; they share core's chunks with `niivue.js`. Without the dcm2niix mapping, tiles that need it fail (the slide counts them in `stats.failures`) and JPEG tiles still decode. `scripts/check-standalone.ts` runs with the build: it rejects any other bare import and any format reaching another's code. `bunx nx e2e nv-ext-tile` checks NIfTI, Zarr, TIFF and DICOM pages built this way under a nested base.

## Hosting an indexed slide

`manifestFromIndex(slide, files, fileUrlFor)` turns an indexed slide into a `dicom-wsi-range-v1` manifest that NVSlide reads by HTTP Range, as the hosted demo slides are served:
- Each tile has its offset and length, or `fragments` for a frame split across fragments.
- Sparse levels list only their present tiles; NVSlide places them by `x`, `y`.
- A level split across files (a concatenation) names each tile's `fileUrl`.

`bun scripts/build-manifest.ts <slide-dir> <id>` indexes `<slide-dir>/files` and writes `<slide-dir>/manifest.json` for the first slide found, with tiles read from `files/<name>` (URL-encoded). Serve the directory with Range and CORS (see below).

## Range, CORS and full downloads

Reads go through geotiff-rs's 64 KiB block cache: the header and each level's tile offset table cost a few blocks, and a tile costs its compressed size rounded out to block boundaries.

A remote server **must** support HTTP Range (`206 Partial Content`). If it answers `200`, `fromUrl` cancels that response and rejects with "server ignored the HTTP Range request"; there is no fallback to downloading the full slide. Cross-origin servers must send `Access-Control-Allow-Origin` and allow the `Range` request header. Exposing `Content-Range` (`Access-Control-Expose-Headers`) is optional: when visible, each response's start offset is checked against the request. For a server you cannot change, download the file and open it with `fromGeoTIFF(await fromBlob(file))`.

## Demo

[`apps/demo-ext-tile`](../../apps/demo-ext-tile): `bunx nx dev demo-ext-tile`.

## Development

```bash
bunx nx test nv-ext-tile
bunx nx build nv-ext-tile
bunx nx typecheck nv-ext-tile
```

Tests write small tiled TIFFs in memory (pyramid, SubIFDs, JPEG/YCbCr, JPEG 2000) and serve them through a fake Range server that records every request. With the OpenSlide Aperio samples in `$OPENSLIDE_APERIO` (`JP2K-33003-1.svs`, `CMU-1-JP2K-33005.svs`), they also check JPEG 2000 colour against OpenSlide; otherwise those tests are skipped.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
