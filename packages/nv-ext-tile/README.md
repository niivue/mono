# @niivue/nv-ext-tile

Tiled and chunked image formats for NiiVue (slides and streamed volumes), one subpath per format, so a page loads only the format it uses:
- `@niivue/nv-ext-tile/tiff`: tiled TIFF (below).
- `@niivue/nv-ext-tile/dicom`: DICOM-WSI folders, hosted manifests and DICOMweb ([Local DICOM-WSI folders](#local-dicom-wsi-folders), [DICOMweb](#dicomweb)). It is a whole-slide adapter, not a DICOM loader: convert other DICOM to NIfTI with `@niivue/dcm2niix`.
- `@niivue/nv-ext-tile/zarr`: OME-Zarr volumes, whole levels or streamed brick by brick, and 2D OME-Zarr slides streamed tile by tile into `NVSlide` ([OME-Zarr](#ome-zarr)).
- `@niivue/nv-ext-tile/open`: one opener for all of the above ([Opening any slide](#opening-any-slide)); each format loads only when a slide of it opens.

Replaces `@niivue/nv-ext-wsi` and `@niivue/nv-ext-tiff`, and core's OME-Zarr exports; the APIs are unchanged, only the import paths differ.

## Installation

```bash
bun add @niivue/nv-ext-tile
```

Requires `@niivue/niivue` as a peer dependency, at least the core version current when this package was published (`workspace:^`, which `bun publish` writes as `^<that version>`).

## Opening any slide

```ts
import { NVSlide } from '@niivue/niivue'
import { openSlide } from '@niivue/nv-ext-tile/open'

// A URL (TIFF, OME-Zarr, DZI, hosted manifest), or local TIFFs and DICOM-WSI files.
const { candidates, index } = await openSlide(input, { fetch, signal, pool })
// Every slide found is listed; none is chosen for you.
const slide = NVSlide.fromSource(await candidates[0].open())
```

- `sniffSlide(input, { fetch, signal })` names the kind: a URL by its path (`.zarr` or a trailing `/`, `.dzi`, `.json`, TIFF suffixes), else by one `bytes=0-131` Range probe through `fetch` (TIFF or DICM magic, then JSON or XML by Content-Type or first byte); a file by its magic bytes; several files are a DICOM folder (`openSlide` still lists the TIFFs among them). A TIFF with `DICM` at byte 128 is indexed as DICOM and listed as a TIFF too.
- `openSlide` returns `{ kind, candidates, index? }`. Each local TIFF is a candidate; a DICOM folder gives one per optical path and focal plane; its label, overview and thumbnail images and skipped files stay in `index`, never in `candidates`. `candidate.open(signal)` makes the source; the slide that adopts it owns it (`NVSlide.dispose` disposes it).
- Options: `fetch` (a `SlideFetch`, `(url, init?) => Promise<Response>`) serves every read of TIFF, DICOMweb, OME-Zarr and the sniff probe, and a hosted manifest's reads on its own origin (tile files elsewhere are read without credentials); a DZI rejects one (its tiles use the global fetch). `signal`; `pool` (TIFF, borrowed); `tiff` (TIFF options such as `placement`, `z`, `t`); `attribution` (TIFF, DICOM and manifests: set on the manifest, text only, `url` only when http(s)); `baseUrl` (a hosted manifest's relative URLs; default the manifest URL); `onProgress(done, total)` (DICOM indexing).
- Not opened by URL: a bare DICOM file (host a manifest), a local OME-Zarr folder or DZI.

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

// When done: the slide disposes the source it owns. Pass { ownsSource: false }
// to fromSource to keep a shared source, and call source.dispose() yourself.
slide.dispose()
pool.destroy()
```

`fromUrl` accepts `fetch` (a `SlideFetch`, `(url, init?) => Promise<Response>`, e.g. to add auth headers) and `signal` to abort a superseded open. The manifest id defaults to the decoded file name. Both open methods take `z` / `t` to pick an OME-TIFF (or Argos) plane (default 0; Argos, the middle), `placement` (vendor layouts, below) and `attribution` (kept as `manifest.attribution`: text fields, `url` only when http(s)).

### What it reads

- **Levels:** OME-TIFF pyramids in each plane's `SubIFDs`, else every tiled image in the IFD chain, one per downsample, finest first. Stripped images (SVS thumbnail, label, macro) and tiled images off the base aspect ratio (an SVS macro) are skipped, except a whole-tile image that a downsample of the base, padded to tiles, explains (Philips TIFF), or a power-of-two downsample padded to 8 px blocks (Ventana iScan); its level covers the unpadded area. The downsample is the one Philips's XML states for that padded size (its pixel spacing ratio, any factor), else the first free power of two.
- **Vendor layouts:**
  - *Argos AVS z-stack* (one pyramid per focal plane, `MinZ`/`MaxZ` in tag 65000): `SlidePlaneCapable` with `planes.z` focal planes; it opens on the middle plane (the unstacked scan's focus, usually the sharpest) unless `z` is given. Plane `i` is taken as focal step `MinZ + i` (which end is `MinZ` is not stated; units unstated); each level states its `plane`.
  - *Hamamatsu NDPI* (one JPEG strip per level): read as virtual `image/jpeg` tiles of whole restart intervals (tag 65426), each wrapped as a small JPEG, so no strip is decoded whole; a strip without restart markers is one tile if it fits 4096 px. Locally a tile reads only its intervals; by URL the first tile of a 512 px band reads that band through geotiff's 64 KiB blocks (CMU-1 level 0: 2.4 MB, then 0 for the band's other 24 tiles). Files over 4 GiB are not supported: their 32-bit offsets wrap, and geotiff-rs cannot parse their IFDs.
  - *Placement* (default; `placement: false` opens these files as their storage grid) adds `level.placement`, per-piece crops and origins, and makes the manifest's width/height the placed extent: Ventana BIF tile joints (XMP `TileJointInfo`; overlaps split at their midpoint; frames past `NumCols` dropped; iScan Coreo files, whose background frames are not joined, placed best effort with one warning and `placementReport.seams`; joints that do not resolve keep the grid with one warning), Trestle `OverlapsXY` per level, and Leica SCN regions (several brightfield images side by side in one storage grid, placed by their `<view>` in the collection; one region opens as its own pyramid).
- **Pixels:** geotiff-rs's `readRGB` converts RGB, YCbCr, palette and CMYK to 8-bit RGB; those tiles reach `NVSlide` as `raw-rgba`, cropped at the right/bottom edge, an absent tile (`TileByteCounts` 0) transparent. A one-sample grey image (BlackIsZero, WhiteIsZero as `MONOCHROME1`; plain TIFF or an OME-TIFF with one channel) is `raw-gray` with one `manifest.channelInfo` entry, windowed by `NVSlide`: uint8/uint16/int16/float32 samples native (int8 widens to int16, float16 to float32), uint32/int32/float64 quantized to uint16 (`storedToValue`). A uint8 image opens at 0-255, as it showed before, with no extra reads; wider types default to the 2-98% range of a coarsest-level sample, read at open (up to 16 tiles). An absent grey tile reads as zeros (no alpha), as a multi-channel plane or a Zarr fill value.
- **OME-TIFF channels:** the OME-XML (first IFD's ImageDescription) maps channel, `z` and `t` to a main-chain IFD by `DimensionOrder` and `TiffData` (`IFD`, `First*`, `PlaneCount`). With more than one 1-sample channel, as for the ZarrSlideSource: `manifest.channelInfo` gets each `Channel`'s `Name` and `Color` (snapped to a colormap); OME-XML has no `active`, so the first 4 start visible and the rest hidden (not fetched); `fetchTileSamples` serves the visible channels' samples for `NVSlide` to composite. Default windows are the 2-98% range (the volume rule) of a sample of the coarsest level, as for the ZarrSlideSource, read at open for the visible channels only; a hidden channel's is read the first time it is shown and stated through `SlideSourceHost.channelInfoChanged` before its first tile (a 27-channel uint8 file: 114 open reads, 7.3 MB, against 313 and 21 MB when every channel was sampled). Sample types follow the grey rule above (int16/float32 native); uint32/int32/float64 are quantized to uint16 over the sample's min..max, with `channelInfo[c].storedToValue` mapping samples back (`NVSlide.sampleAt` reports approximate data values). XML entities and character references in channel names are decoded. An OME-TIFF with more than one `z` or `t` is `SlidePlaneCapable`: `planes` states the counts (and `zPositionsUm` from `PhysicalSizeZ` in µm), `preparePlane(p, signal)` reads that plane's IFDs (no pixels) and returns its manifest, whose levels state `plane`, so one source serves every plane; a plane whose pyramid differs from the open one's rejects `RangeError`. RGB OME-TIFF stays `raw-rgba`; with several RGB channels, the first shows. Limits: a plane that another file of a multi-file set holds (`TiffData` `UUID` not this file's) is refused, the first `Image` only, plane IFDs below 4096, every channel's pyramid must match the first's. geotiff walks the IFD chain to a plane, so a deep `z` costs a read per IFD before it (z 977 of the 3910-plane Avivator brain: ~6 s).
- **Compression:** none, LZW, JPEG, Deflate, PackBits (Rust/WASM), LERC, ZSTD, WebP (JS). JPEG 2000 (Aperio 33003 and 33005, TIFF 34712) after `registerDcm2niixTiffDecoders()`, which decodes in @niivue/dcm2niix's OpenJPEG workers (loaded on the first such tile, one pool shared with `/dicom`'s `registerDcm2niixDecoders`) rather than the geotiff `Pool`; colour matches OpenSlide within 1. Without it those tiles fail with geotiff-rs's "has no built-in decoder" error. Not supported: old-style JPEG (6), 12-bit and lossless JPEG.
- **Limits:** tiles 16-4096 px per side in multiples of 16 (as TIFF 6.0 requires; a one-tile level may be its exact size, as bioformats writes), at most 2^21 tiles across all levels, unsigned integer samples for RGB and palette (any type for grey), RGB 8 bits per sample; other files are rejected. dcm2niix decodes JPEG 2000 tiles up to 2048 px per side. Only the first 64 IFDs (main chain or SubIFDs) are examined.
- **JS decoders trust the compressed stream.** The Rust codecs and dcm2niix bound a tile's decoded size, but LERC, ZSTD and WebP do not: a hostile tile can exhaust memory. Only open files you trust, or decode in workers with a `Pool`, so the damage stays in a worker rather than the tab.

**Migration (rc), vendor TIFF.** `placement` defaults to true: Ventana BIF, Trestle and multi-region Leica SCN files now open placed, the manifest width/height being the placed extent; pass `placement: false` for the storage grid. Ventana iScan lower levels padded to 8 px now open (OS-2: 10 levels, was 3).

**Migration (rc), other sources.** `openSlide` (and any `DziSource`) rejects a custom `fetch` for a DZI: its tiles use the global fetch. DICOM-WSI indexing needs resizable `ArrayBuffer`s (Chrome 111, Firefox 128, Safari 16.4) and rejects with that message without them. Label, overview and thumbnail instances moved from `index.skipped` to `index.associated`. DICOMweb `headers` is deprecated for `fetch`.

**Migration (rc).** Single-channel grey TIFF is now `raw-gray` with a channel, not an 8-bit RGB bitmap: it is windowed, and 16-bit data keeps its 16 bits. int16 and float32 samples (single and multi-channel) are native, no longer quantized to uint16, so their windows and `NVSlide.sampleAt` `stored` values are data values and `storedToValue` is gone. A saved document's stored-unit window for such a slide changes meaning: convert it with the old map, `value = stored * scale + offset` (from the saved `storedToValue`), or reset it.

Not supported yet: TIFF z-stacks as streamed volumes (`VolumeChunkSource`), pixel spacing.

## Local DICOM-WSI folders

```ts
import { DicomWsiSource, indexDicomWsi, registerDcm2niixDecoders } from '@niivue/nv-ext-tile/dicom'

registerDcm2niixDecoders() // JPEG 2000 and JPEG-LS tiles, and ICC colour management; needs @niivue/dcm2niix
const files = [...folderInput.files] // <input type="file" webkitdirectory>
const index = await indexDicomWsi(files, { signal, onProgress: (done, total) => {} })
const slide = NVSlide.fromSource(new DicomWsiSource(index.slides[0], files, { attribution }))
```

- `signal` stops indexing (the worker is terminated) and rejects with its reason;
  `onProgress(done, total)` runs after each file, from the worker or this thread.

- `indexDicomWsi` parses only headers and item tags, never pixel data.
  It uses the Basic or Extended Offset Table when present, and otherwise walks the items.
  In a page it runs in an inlined worker that reads 1 MiB blocks (`FileReaderSync`), so
  an item walk reads each file through; without a worker (Bun, or a CSP that blocks
  `blob:` workers) it reads with `File.slice` on the calling thread.
- It handles multi-fragment frames, TILED_SPARSE (holes show the slide's
  `backgroundColor`, from RecommendedAbsentPixelCIELabValue (0048,0015) when
  stated, local or DICOMweb; the 3D slide plane leaves them empty), and
  concatenations. TILED_FULL frames keep their implicit order; per-frame
  positions, when given, win (items holding only other metadata, such as Frame
  Content, do not change the order). A file with no DimensionOrganizationType is
  placed by its per-frame positions (path and plane from per-frame values) when
  it gives them, else in the implicit order.
- Label, overview and thumbnail instances (ImageType value 3 `LABEL`, `OVERVIEW`,
  `THUMBNAIL`, single frame) are never slides: they are listed in `index.associated`.
  `associatedImages(index, slide)` picks a slide's (same study and container, else
  series); `readAssociatedImage(image, files, signal)` returns its encoded frame
  (`codec`, `bytes`) or, for native 8-bit grey/RGB pixel data (labels often are),
  `raw-rgba`; `associatedImageBitmap` decodes it through NVSlide's tile decoders
  (JPEG and native built in, JPEG 2000/JPEG-LS once registered). Associated
  images are not in `index.skipped`, except a native one that is not 8-bit grey or
  RGB (`uncompressed`); a tiled (multi-frame) one is in neither list.
- Each optical path and focal plane becomes its own slide. A shared
  OpticalPathIdentifier assigns every frame to that path; an identifier missing
  from OpticalPathSequence is its own path. `focalPlane` is a plane index, not µm:
  stated ZOffsets (shared or per frame, to the nm) are ranked across the slide's
  levels (lowest first), so a lower level holding only some planes joins the right
  ones. A multi-plane TILED_FULL level stating no ZOffset keeps its implicit plane
  index (scanners give TotalPixelMatrixOriginSequence no Z), so it is matched by
  index and may join the wrong plane if other levels hold a different set of planes.
  A single shared ZOffset in a multi-plane TILED_FULL file is ignored. ZOffset on
  only some of a file's frames is `malformed`. A plane's stated ZOffset is kept as
  `zOffsetUm`.
- **Focal planes as one source.** `focalStacks(index.slides)` groups the slides of
  one study, series, container and optical path, planes in rank order;
  `new DicomPlaneStack(stack.map((s) => new DicomWsiSource(s, files)), { zPositionsUm })`
  (or `DicomWebWsiSource`s) is `SlidePlaneCapable`: `planes` `{ z, t: 1 }`,
  `preparePlane(p, signal)` returns plane `p`'s manifest, whose levels state `plane`,
  so one bound source serves every plane. A plane out of bounds, or whose level-0
  size, spacing or sample semantics differ from the open one's, rejects `RangeError`.
  The stack owns its plane sources.
- **Monochrome.** A MONOCHROME1/2 slide states one grey `channelInfo` entry (as NVSlide
  shows one without it), with `storedToValue` `{ scale: RescaleSlope, offset:
  RescaleIntercept, quantized: false }` when the top-level rescale is stated. A signed
  one (PixelRepresentation 1) states `sampleType: 'i16'` on its levels, so NVSlide reads
  the decoded samples as two's complement.
- `pixelSpacingMM` is the level-0 PixelSpacing: shared PixelMeasures, else the first
  frame's, else top-level, else ImagedVolumeWidth/Height over the total pixel matrix.
- Files it cannot index are listed in `index.skipped` with a reason: `not-dicom`,
  `transfer-syntax` (explicit VR little endian only), `uncompressed` (native pixel
  data of a level, or of an associated image that is not 8-bit grey or RGB), `malformed`,
  `too-large` (a level of more than 2^22 tiles) or `not-tiled`.
- Undefined-length UN elements (implicit VR sequences, PS3.5 6.2.2) are skipped.
- Hostile input is bounded: the header read stops at 64 MiB, grown in place in 4 MiB
  reads (a header costs its bytes plus one read, not twice its size; a 60 MiB header's
  peak RSS 145 -> 117 MB), per-frame items past NumberOfFrames are refused as they
  come, sequences at 8 levels,
  a file at 4096 optical paths and 4096 (optical path, focal plane) pairs, TILED_FULL
  frames at tiles x planes x NumberOfOpticalPaths, text values the index reads at
  1 KiB, and counts and offsets are checked against the file size (`malformed`
  otherwise). Only the elements the index reads are kept, so a 64 MiB header of
  millions of elements costs at most about 100 MB beyond its bytes, not GBs. A
  slide's levels total at most 2 x 2^22 tiles; levels past that are dropped and
  listed in `skipped`.
- The index holds only per-frame data, bounded by the files' sizes, so a folder of
  many slides indexes in memory proportional to its headers. Each level reports
  `duplicates` and `holes`; its grid-sized tile map is built only when
  a slide is opened (`DicomWsiSource`) or a manifest is written.
- `dispose()` (or disposing the slide that owns the source) rejects reads in flight and
  later with AbortError; the files are the caller's. `attribution` becomes
  `manifest.attribution` (text fields, `url` only when http(s)).
- **ICC colour management.** `DicomWsiSource`, `DicomWebWsiSource` and `TiffSlideSource` serve the slide's ICC profile (the optical path's (0028,2000), or TIFF tag 34675). `registerDcm2niixDecoders` also registers @niivue/dcm2niix's LittleCMS as NVSlide's ICC transform (unless the host registered one), so a slide with a profile is shown in sRGB unless `colorManagement` is off. Call it before opening slides: a slide bakes its profile when it is created. This needs @niivue/dcm2niix 1.4.20261105-rc.3 or later (`iccLut`), the peer floor. `fetchIccProfile(signal)` stops waiting on abort; disposing the source (or the slide that owns it) cancels the read.
- `DicomWsiSource` reads one tile at a time and checks each frame's item tag, so a file
  that changed since indexing fails rather than decoding garbage.
- Supported transfer syntaxes: JPEG baseline/extended (browser), JPEG 2000 and JPEG-LS
  (`registerDcm2niixDecoders`, with `@niivue/dcm2niix` as an optional peer dependency;
  a decoder the host already registered wins). A dcm2niix pool whose workers die is
  replaced, and the tile or profile retried once.
- Slides are shown with row 0 of the total pixel matrix at the top (`displayYAxis: 'down'`),
  as OpenSlide shows them.
- Index speed for the 8 OpenSlide DICOM-WSI test sets (local SSD; Chrome reads through
  a `webkitdirectory` input, in the worker; Bun on the calling thread):

  | Set | Frames | Holes | Bun | Chrome |
  |---|---|---|---|---|
  | Hamamatsu-2 (EOT) | 6,199 | 0 | 2 ms | 11 ms |
  | 3DHISTECH-2 (BOT, sparse, split L0) | 56,233 | 449,040 | 65 ms | 43 ms |
  | Leica-4 (sparse) | 8,546 | 0 | 73 ms | 72 ms |
  | 3DHISTECH-1 | 4,434 | 0 | 100 ms | 210 ms |
  | JP2K-33003-1 (item walk) | 4,569 | 0 | 93 ms | 43 ms |
  | CMU-1-JP2K-ICT (item walk) | 24,813 | 0 | 159 ms | 206 ms |
  | CMU-1-JP2K-33005 (item walk) | 28,284 | 0 | 280 ms | 88 ms |
  | CMU-1-JP2K-RCT (item walk) | 24,813 | 0 | 429 ms | 383 ms |

  Chrome on the main thread (`File.slice`, ~0.1 ms a read whatever its size) took
  0.3-2.9 s for the last six; the page stayed responsive either way (no task over 50 ms).

- Test fixtures: `fixtures/dicom-wsi` (synthetic, about 70 KB, with the generator
  `make_fixtures.py`; `colors.dcm`, `overview.dcm` and `monosigned.dcm` have real JPEG
  frames, made by `cjpeg`, for the browser checks; `label.dcm` is native RGB). A `.json` is its `.dcm` as DICOM JSON, for the parity test.

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
  fetch: (url, init) =>
    fetch(url, { ...init, headers: { ...init?.headers, Authorization: getToken() } }),
}, signal)
const slide = NVSlide.fromSource(source)
```

- Tiles are fetched by WADO-RS `{seriesUrl}/instances/{sop}/frames/{n}`, with the slide's abort signal. A query on `seriesUrl` (an access token) is kept on each frame URL.
- A level whose metadata states no transfer syntax costs one frame request in `open` (all levels at once), which reads the syntax from the bytes. A server that refuses it (HTTP 400, 406 or 415) is assumed to serve JPEG Baseline; other errors fail the open.
- JPEG 2000 and JPEG-LS tiles are requested untranscoded (`transfer-syntax=*`); a tile the server transcoded anyway is refused.
- `fetch` (a `SlideFetch`) serves every request to `seriesUrl`'s origin, the transfer-syntax
  sniff included; a URL on another origin uses `globalThis.fetch`, so credentials never leave
  the series' origin. `headers` (read per request, same origin only) is deprecated in favour
  of `fetch`. `dispose()` aborts fetches in flight; later reads reject AbortError.
  `attribution` becomes `manifest.attribution`.
- Responses are capped at 64 MB, also when streamed without Content-Length. `readFirstPart(response, what)` applies the same cap and returns the first multipart/related part, for a host's own WADO-RS requests.
- ICC profile: the inline value, else the BulkDataURI resolved against `seriesUrl`, through `retrieveBulkData(url, signal)` when given (e.g. OHIF's data source) and the URL is on `seriesUrl`'s origin, else (or when it resolves undefined or empty) fetched. `fetch`, `headers` and the `seriesUrl` query when the URI has none, go only to `seriesUrl`'s origin, so an ICC BulkDataURI on another origin that needs auth is unsupported (it is fetched without credentials). A relative `seriesUrl` resolves against the page.
- One slide per optical path and focal plane, as for local files; a viewer that shows one picks `slides[0]`, the first path and lowest plane, and should say others exist.

## OME-Zarr

```ts
import { loadOmeZarrVolumes, streamOmeZarr } from '@niivue/nv-ext-tile/zarr'

await nv.loadVolumes(await loadOmeZarrVolumes(storeUrl, { level: 2 })) // one whole level
await streamOmeZarr(nv, storeUrl) // or stream bricks; its workers stop once the volume is removed
```

`loadOmeZarrVolumes` loads the channels omero marks active (a missing flag counts as active; all marked inactive loads channel 0). `channels: [i, ...]` loads exactly those, visible; `channels: 'all'` loads every one, inactive ones hidden.

Time series: `timepoint` picks the timepoint loaded. With `lazyTime: true` the others load on demand: each volume carries a `frameSource`, so `await nv.setFrame4D(volume.id, t)` fetches frame `t` for every channel of the store and resolves once it is shown (a newer request cancels an older one; a failed fetch rejects and keeps the frame shown). Decoded frames are cached per store up to `frameCacheBytes` (256 MiB), least recently used evicted first. Once a frame shows, the next one in the direction of travel (t+1, or t-1 while scrubbing back; playback wraps) is prefetched: one frame per channel, only when it fits the budget without evicting, cancelled when the next frame shown makes it stale. Pass the same object as `lazyTime` to two stores (raw + segmentation) to switch them together. A document saves the frame shown as a plain volume. Streamed volumes (`streamOmeZarr`) keep a fixed timepoint.

A store with `image-label` metadata (a segmentation), or any store loaded with `labels: true`, gets the generated `Random` label colormap (ID 0 clear) instead of the omero ramp and window; `labels: false` overrides the detection. A store stating `image-label.colors` gets them exactly through `omeZarrLabelColormap(source.info)`: `nv.addColormap(name, map)`, then the volume's `colormap: name` (IDs the table omits, and IDs below or above it, are clear; colours past a 2097152-ID span are dropped with a warning).

```ts
const time = {}
await nv.loadVolumes([
  ...(await loadOmeZarrVolumes(rawUrl, { lazyTime: time })),
  ...(await loadOmeZarrVolumes(segUrl, { lazyTime: time })),
])
await nv.setFrame4D(nv.volumes[0].id, 5) // raw and seg both show t = 5
```

To share one source (a volume and a slide), open it with `fetchOmeZarrChunkedSource`, pass it to `nv.loadChunkedVolume`, and call `source.dispose()` when done (a slide over it through `VolumeSliceSource` never disposes it): dropping the reference leaves its workers running. `omeZarrChannelOptions(source.zarr, c)` gives a streamed channel the loader's `name`, `colormap`, `calMin`/`calMax` and `visible`.

For a 2D image (one y/x plane per level), `ZarrSlideSource` streams chunks into `NVSlide` as tiles instead:

```ts
import { NVSlide } from '@niivue/niivue'
import { ZarrSlideSource } from '@niivue/nv-ext-tile/zarr'

const source = await ZarrSlideSource.fromUrl(storeUrl) // or fromStore(store); { channel, z, t } as below
const slide = NVSlide.fromSource(source) // disposes the source with the slide
```

Three uint8 channels show as RGB. Other multi-channel stores open as `slide.channels`: omero label, colour (snapped to a colormap), window and `active` (as for volumes; inactive channels start hidden and are not fetched; a store that marks no channel inactive, with no flags or every channel active, shows its first 4 to keep a usable tile budget), composited by `slide.channelBlend` (MAX by default). A single-channel store, or `channel`, shows one channel in grey: a one-entry `channelInfo` (window, `storedToValue`) served as `raw-gray` tiles, so NVSlide applies the window itself (`source.window` is deprecated). Windows come from omero (placeholders such as 0..1 on integer data are ignored), else the 2-98% range (the volume rule) of a sample of the coarsest level: a 4 x 4 grid of chunks spread over it, at most 1024 x 1024 from the middle of each, so a level of up to 4 x 4 chunks is read whole and a background-heavy centre does not collapse the window. int8/int16 and float32 stay native (`sampleType` `i16` / `f32`, windows in data units); uint32, int32 and float64 are quantized to uint16 over the omero min..max, else the sample's min..max; the inverse is `channelInfo[c].storedToValue`, so `NVSlide.sampleAt` reports approximate data values (`exact: false`, `clipped` at the range ends). Visible channels get their windows at open; a hidden channel that needs a data sample reads it when first shown, before its first tile, and states it through `SlideSourceHost.channelInfoChanged` (a window the user set is kept). The group's `attribution` (a NiiVue convention beside `ome`: `title`, `url`, `license`, `credit`, `citation`, `modified`; strings only, `url` only when http(s)) becomes `manifest.attribution`. A segmentation (`image-label`) states `kind: 'label'` and its `image-label.colors` as `labelColors`; label IDs are never quantized: int8/int16 as i16, uint32/int32/float32 as f32, exact up to 2^24 (a tile holding a larger ID fails with a tile error, the open does not), and a float64 or 64-bit integer label image is refused at open.

A store with z or t > 1 opens at `z` / `t` (default omero `defaultZ` / `defaultT`, else 0) and states `source.planes` (with `zPositionsUm` and `tSeconds` when the axes have units); `preparePlane({ z, t })` returns that plane's manifest, whose levels each state `plane`, and tiles are read from the plane their level states (every plane keeps the opened plane's quantization). Raw store bytes (chunks, shard indices, absent chunks) are kept in a `cacheBytes` LRU (64 MiB), so a channel shown again or a tile NVSlide evicted is not fetched again. Chunks that span channels are read once for every requested channel. `fromUrl` reads and decodes tiles on `workers` chunk workers (default half the cores, at most four; they open from the metadata already read), falling back to this thread with `workers: 0`, a custom `fetch`, CSP that blocks workers, or a worker that fails. `source.dispose()` (NVSlide calls it when it owns the source) aborts reads, ends the workers and drops the cache.

Custom fetch (every Zarr option, BREAKING in this release): `fetch: (url, init) => Response`, called as `globalThis.fetch` is; `init` carries the method, the Range header (plain-object `headers`), the abort signal and `cache: 'no-store'` on ranged chunk reads (Chromium's cache served truncated 206 bodies; whole chunks and metadata stay HTTP-cacheable). It replaces `ZarrSlideSource`'s `fetch: (request) => Response` and the loaders' `fetchImpl`. Migrate with `fetch: (url, init) => old(new Request(url, init))`. An old-shape callback left as is, `(request) => fetch(request)`, now gets the URL string and drops `init`: it fetches whole files without the Range header (refused) or the abort signal. A ranged reply that is a 200, starts elsewhere or is short is refused.

Volume reads run in a worker pool (inlined, no asset to deploy; the workers open from the metadata the page already read) with a main-thread fallback. A fetch's `frame` reads that timepoint: `source.frames` is the store's timepoint count, `source.revision` a hash of its structure (axes, levels, dtype, omero) for dedup and restore checks, not a cache validator. `persist` (opt-in, Cache Storage) applies only to an http(s) URL with no query or credentials and no custom `fetch` (otherwise it is ignored with a warning); its budget, like `cacheBytes`, is split across the workers, not multiplied by them. `@niivue/zarrita-rs` (zarrita.js with Rust/WebAssembly codecs, its `inline` entry) is a dependency. `OmeZarrSource.arrays` are built with `@niivue/zarrita-rs/inline`: read them with that entry's `get`. The default `@niivue/zarrita-rs` entry and zarrita.js both throw on them, since each keys its array context with its own private symbol. The worker carries its own copy of the few core helpers it calls (chunk timing, voxel utilities), built from the core this package was built against, so it can lag the core a page installs within the peer range; the main thread always uses the page's core. Details: [docs/ome-zarr-format.md](docs/ome-zarr-format.md). Demos: `ome.zarr.html`, `range.html` and `vox.block.pick.zarr.html` in `apps/demo-ext-tile`.

## Without a bundler

`dist/standalone/` holds `tiff.js`, `dicom.js`, `zarr.js` and `open.js` with geotiff-rs and zarrita-rs (their WASM inlined) bundled in and the Zarr worker inlined. Only `@niivue/niivue` stays a bare import, plus `@niivue/dcm2niix` in `/dicom` and `/tiff`, imported only when a registered decoder first runs. Map them with an import map onto core's standalone build, so the page and the extension share one core (one NVSlide decoder registry, one chunk-timing recorder):

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

Copy `@niivue/niivue`'s `dist/standalone/` to `niivue/`, this package's to `nv-ext-tile/`, and, for JPEG 2000 / JPEG-LS tiles (DICOM and TIFF) and ICC profiles, `@niivue/dcm2niix`'s `dist/` to `dcm2niix/` (its workers and WASM load relative to `index.jpeg.js`). A page using `@niivue/niivue/webgpu` or `/webgl2` maps those entries too; they share core's chunks with `niivue.js`. Without the dcm2niix mapping, tiles that need it fail (the slide counts them in `stats.failures`) and JPEG tiles still decode. `scripts/check-standalone.ts` runs with the build: it rejects any other bare import, any format reaching another's code, and `open.js` loading any format before it is used. `bunx nx e2e nv-ext-tile` checks NIfTI, Zarr, TIFF and DICOM pages built this way under a nested base.

## Hosting an indexed slide

`manifestFromIndex(slide, files, fileUrlFor)` turns an indexed slide into a `dicom-wsi-range-v1` manifest that NVSlide reads by HTTP Range, as the hosted demo slides are served:
- Each tile has its offset and length, or `fragments` for a frame split across fragments.
- Sparse levels list only their present tiles; NVSlide places them by `x`, `y`.
- A level split across files (a concatenation) names each tile's `fileUrl`.

`bun scripts/build-manifest.ts <slide-dir> <id>` indexes `<slide-dir>/files` and writes `<slide-dir>/manifest.json` for the first slide found, with tiles read from `files/<name>` (URL-encoded). Serve the directory with Range and CORS (see below).

## Range, CORS and full downloads

Reads go through geotiff-rs's 64 KiB block cache: the header and each level's tile offset table cost a few blocks, and a tile costs its compressed size rounded out to block boundaries.

A remote server **must** support HTTP Range (`206 Partial Content`). If it answers `200`, `fromUrl` cancels that response and rejects with "server ignored the HTTP Range request"; there is no fallback to downloading the full slide. Cross-origin servers must send `Access-Control-Allow-Origin` and allow the `Range` request header. Exposing `Content-Range` (`Access-Control-Expose-Headers`) is optional: when visible, each response's start offset and length are checked against the request (a short or misplaced body, e.g. one Chromium truncated from its cache, is read once more with `cache: 'no-store'`, then refused); without it, a body longer than the range is refused and a shorter one accepted (the last block may run past EOF). A redirect (a signed CDN URL, as Hugging Face's `/resolve/` answers) is followed once and its target reused for later reads, one round trip instead of two (about 133 to 28 ms median per read on Hugging Face); with a custom `fetch` only a same-origin target is reused, and any failed reply from the target (an expired signed URL, a CORS error) sends the read back to the original URL, which resolves it again; after two targets fail in a row, none is reused. For a server you cannot change, download the file and open it with `fromGeoTIFF(await fromBlob(file))`.

A hosted manifest (`ManifestRangeSource` in core) checks each `206`: a body that is not exactly the range, or a visible `Content-Range` at another start, is read once more with `cache: 'no-store'` and then refused. Chromium can return a truncated body for a Range read it serves partly from its HTTP cache; the retry keeps the warm cache for every read it serves whole. A server without Range support gets a whole-file fallback, refused past 64 MiB.

TIFF and Zarr share two modules: `src/channelDisplay.ts` (quantizing non-uint8/16 samples to uint16 and its inverse `storedToValue`, windows, grey plane copy) and `src/rangeFetch.ts` (Range reply checks: both refuse a `200` to a ranged read).

## Demo

[`apps/demo-ext-tile`](../../apps/demo-ext-tile): `bunx nx dev demo-ext-tile`.

## Development

```bash
bunx nx test nv-ext-tile
bunx nx build nv-ext-tile
bunx nx typecheck nv-ext-tile
```

Tests write small tiled TIFFs in memory (pyramid, SubIFDs, multi-channel OME-TIFF, JPEG/YCbCr, JPEG 2000) and serve them through a fake Range server that records every request. With the OpenSlide Aperio samples in `$OPENSLIDE_APERIO` (`JP2K-33003-1.svs`, `CMU-1-JP2K-33005.svs`), they also check JPEG 2000 colour against OpenSlide; otherwise those tests are skipped.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
