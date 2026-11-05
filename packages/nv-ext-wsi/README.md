# @niivue/nv-ext-wsi

Formerly `@niivue/nv-ext-tiff`; the API is unchanged.

Stream large tiled/pyramidal TIFF, BigTIFF, OME-TIFF and Aperio SVS whole-slide images into NiiVue's `NVSlide`, one tile at a time, using [geotiff](https://github.com/geotiffjs/geotiff.js).

Core NiiVue already reads TIFF volumes (strips, tiles, LZW, Deflate, PackBits) with no dependencies, but decodes the whole file. This package is for slides too large to fetch: it reads only the IFDs and the tiles in view, over HTTP Range, and adds the compressions core lacks (JPEG with `JPEGTables`, ZSTD, WebP, LERC). Apps that need it pay for `geotiff`; core users do not.

## Installation

```bash
bun add @niivue/nv-ext-wsi
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

```ts
import { NVSlide, SlideRenderer } from '@niivue/niivue'
import { TiffSlideSource } from '@niivue/nv-ext-wsi'
import { fromBlob, Pool } from 'geotiff'

const pool = new Pool() // optional: decode in web workers

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

## What it reads

- **Levels:** OME-TIFF pyramids in `SubIFDs` (first plane only), else every tiled image in the IFD chain, one per width, largest first. Stripped images (SVS thumbnail, label, macro) and tiled images off the base aspect ratio (an SVS macro) are skipped.
- **Pixels:** geotiff's `readRGB` converts RGB, YCbCr, gray, palette and CMYK to 8-bit RGB. Tiles reach `NVSlide` as `raw-rgba`, cropped at the right/bottom edge.
- **Compression:** none, LZW, JPEG, Deflate, PackBits, LERC, ZSTD, WebP (geotiff's decoders). Not supported: old-style JPEG (6) and JPEG 2000 (Aperio 33003/33005), which geotiff cannot decode.
- **Limits:** tiles 16-4096 px per side in multiples of 16 (as TIFF 6.0 requires), at most 2^21 tiles across all levels, unsigned integer samples, RGB 8 bits per sample, no WhiteIsZero; other files are rejected. Only the first 64 IFDs (main chain or SubIFDs) are examined.
- **Decoders trust the compressed stream.** A tile whose JPEG header claims 30000x30000 px can exhaust memory: geotiff offers no bound on decoded size. Only open files you trust, or decode in workers with a `Pool`, so the damage stays in a worker rather than the tab.

Not supported yet: 16-bit and multichannel fluorescence planes (only 8-bit RGB/gray displays correctly), choosing an OME plane other than the first, TIFF z-stacks as streamed volumes (`VolumeChunkSource`), pixel spacing.

## Range, CORS and full downloads

Reads go through geotiff's 64 KiB block cache: the header and each level's tile offset table cost a few blocks, and a tile costs its compressed size rounded out to block boundaries.

A remote server **must** support HTTP Range (`206 Partial Content`). If it answers `200`, `fromUrl` cancels that response and rejects with "server ignored the HTTP Range request"; there is no fallback to downloading the full slide. Cross-origin servers must send `Access-Control-Allow-Origin` and allow the `Range` request header. Exposing `Content-Range` (`Access-Control-Expose-Headers`) is optional: when visible, each response's start offset is checked against the request. For a server you cannot change, download the file and open it with `fromGeoTIFF(await fromBlob(file))`.

## Demo

[`apps/demo-ext-wsi`](../../apps/demo-ext-wsi): `bunx nx dev demo-ext-wsi`.

## Development

```bash
bunx nx test nv-ext-wsi
bunx nx build nv-ext-wsi
bunx nx typecheck nv-ext-wsi
```

Tests write small tiled TIFFs in memory (pyramid, SubIFDs, JPEG/YCbCr) and serve them through a fake Range server that records every request.

## Part of the [NiiVue](https://github.com/niivue) ecosystem
