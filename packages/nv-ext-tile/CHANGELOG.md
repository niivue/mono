## 1.0.0-rc.65 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.160

## 1.0.0-rc.64 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.159

## 1.0.0-rc.63 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.158

## 1.0.0-rc.62 (2026-11-11)

### Fixes

- **nv-ext-tile:** pin the DICOM slide tile cap to NiiVue's MAX_SLIDE_GRID ([efcba196](https://github.com/niivue/mono/commit/efcba196))
- **nv-ext-tile:** report a truncated UN sequence as malformed ([a1846e43](https://github.com/niivue/mono/commit/a1846e43))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.157

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.61 (2026-11-11)

### Features

- ⚠️  **nv-ext-tile:** OmeZarrSource.arrays are zarrita-rs arrays ([689ad403](https://github.com/niivue/mono/commit/689ad403))
- **nv-ext-tile:** read OME-Zarr with @niivue/zarrita-rs from npm ([a5ddc50b](https://github.com/niivue/mono/commit/a5ddc50b))

### Fixes

- **nv-ext-tile:** read standalone lz4 stores through zarrita-rs rc.1 ([4551baec](https://github.com/niivue/mono/commit/4551baec))

### Breaking Changes

- **nv-ext-tile:** OmeZarrSource.arrays are zarrita-rs arrays  ([689ad403](https://github.com/niivue/mono/commit/689ad403))
  OmeZarrSource.arrays hold @niivue/zarrita-rs arrays.
  Read them with @niivue/zarrita-rs/inline's get, not zarrita.js.
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ds8jyAKyruMG4DGCtUZ8iS

### Updated Dependencies

- Updated niivue to 1.0.0-rc.156

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.60 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.155

## 1.0.0-rc.59 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.154

## 1.0.0-rc.58 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.153

## 1.0.0-rc.57 (2026-11-10)

### Fixes

- **nv-ext-tile:** bound DICOM-WSI header heap, report oversized levels, skip undefined-length UN ([7d27f045](https://github.com/niivue/mono/commit/7d27f045))

### Thank You

- neurolabusc

## 1.0.0-rc.56 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.152

## 1.0.0-rc.55 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.151

## 1.0.0-rc.54 (2026-11-10)

### Features

- **demo-ext-tile:** OME-Zarr slide menu with store credits ([2238ca69](https://github.com/niivue/mono/commit/2238ca69))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.150

### Thank You

- neurolabusc

## 1.0.0-rc.53 (2026-11-10)

### Features

- **nv-ext-tile:** ZarrSlideSource serves multi-channel stores through NVSlide channels ([c9ab2f9a](https://github.com/niivue/mono/commit/c9ab2f9a))

### Fixes

- **nv-ext-tile:** read multi-channel ranges one channel at a time ([e467cffb](https://github.com/niivue/mono/commit/e467cffb))
- **nv-ext-tile:** open many-channel OME-Zarr stores with at most 4 channels visible ([fb697edd](https://github.com/niivue/mono/commit/fb697edd))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.52 (2026-11-10)

### Features

- ⚠️  **niivue:** remove deprecated NVSlide.setWindow and window getter ([#659](https://github.com/niivue/mono/issues/659))

### Breaking Changes

- **niivue:** remove deprecated NVSlide.setWindow and window getter  ([#659](https://github.com/niivue/mono/issues/659))
  `slide.setWindow(lo, hi)` -> `slide.setChannel(0,
  { calMin: lo, calMax: hi })`; `slide.window` -> `slide.channels[0]`.
  setChannel treats a non-finite bound as the default window instead of
  rejecting it, so callers validate their own input.

### Updated Dependencies

- Updated niivue to 1.0.0-rc.149

### Thank You

- neurolabusc

## 1.0.0-rc.51 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.148

## 1.0.0-rc.50 (2026-11-10)

### Fixes

- **nv-ohif:** restore the 32 MiB thumbnail fetch cap ([03365e41](https://github.com/niivue/mono/commit/03365e41))
- **nv-ohif:** ICC bulk data via OHIF data source; wsiThumbnail uses readFirstPart ([#650](https://github.com/niivue/mono/issues/650), [#657](https://github.com/niivue/mono/issues/657))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.49 (2026-11-10)

### Fixes

- **nv-ext-tile:** reject the data-range sample on the first failed read ([1dd00e94](https://github.com/niivue/mono/commit/1dd00e94))
- **nv-ext-tile:** bound the data-range reads to 4 at a time ([6fe6bdc9](https://github.com/niivue/mono/commit/6fe6bdc9))
- **nv-ext-tile:** quantize extreme float ranges without infinite intermediates ([a146361b](https://github.com/niivue/mono/commit/a146361b))
- **nv-ext-tile:** nonzero quantize scale for empty or overflowing samples ([89b33979](https://github.com/niivue/mono/commit/89b33979))
- **nv-ext-tile:** keep a nonzero quantize scale on a flat data-range sample ([102c7624](https://github.com/niivue/mono/commit/102c7624))
- **nv-ext-tile:** cancel ZarrSlideSource.fromUrl requests on abort ([445f67ca](https://github.com/niivue/mono/commit/445f67ca))
- **nv-ext-tile:** bound the OME-Zarr slide data-range sample ([#656](https://github.com/niivue/mono/issues/656))
- **nv-ext-tile:** refuse OME-Zarr slide levels not listed finest first ([d5b63393](https://github.com/niivue/mono/commit/d5b63393))
- **nv-ext-tile:** validate OME-Zarr slide chunks and cap the tile count ([fab34ef3](https://github.com/niivue/mono/commit/fab34ef3))
- **nv-ext-tile:** refuse an OME-Zarr slide level missing the chosen channel ([#656](https://github.com/niivue/mono/issues/656))
- **nv-ext-tile:** reject a ranged OME-Zarr read answered 200 ([2dea4add](https://github.com/niivue/mono/commit/2dea4add))

### Performance

- **nv-ext-tile:** multiply, not divide, in the quantize loop ([90c88fc9](https://github.com/niivue/mono/commit/90c88fc9))
- **nv-ext-tile:** read the sampled data-range chunks in parallel ([b9b491c9](https://github.com/niivue/mono/commit/b9b491c9))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.48 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.147

## 1.0.0-rc.47 (2026-11-10)

### Fixes

- **nv-ext-tile:** take a tied finest level's extent independent of input order ([#649](https://github.com/niivue/mono/pull/649))
- **nv-ext-tile:** read NewSubfileType as a bit field for padded TIFF levels ([f0fc6fa1](https://github.com/niivue/mono/commit/f0fc6fa1))
- **nv-ext-tile:** index a tiled DICOM WSI level that states no ImageType ([#650](https://github.com/niivue/mono/pull/650))
- **nv-ext-tile:** reject TIFF JPEG levels geotiff-rs cannot decode at open ([79a8b530](https://github.com/niivue/mono/commit/79a8b530))
- **nv-ext-tile:** only a reduced-resolution TIFF image can be a padded level ([448f3032](https://github.com/niivue/mono/commit/448f3032))
- **nv-ext-tile:** mark a DICOM WSI level with duplicate frames sparse ([a353a99f](https://github.com/niivue/mono/commit/a353a99f))
- **nv-ext-tile:** join DICOM WSI frames of reference independent of input order ([#649](https://github.com/niivue/mono/pull/649))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.46 (2026-11-10)

### Fixes

- **nv-ext-tile:** keep TIFF levels padded to whole tiles (Philips) ([9215b24f](https://github.com/niivue/mono/commit/9215b24f))

### Thank You

- neurolabusc

## 1.0.0-rc.45 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.146

## 1.0.0-rc.44 (2026-11-10)

### Features

- **nv-ext-tile:** read TIFF with @niivue/geotiff-rs; JPEG 2000 SVS through dcm2niix ([9b41f2af](https://github.com/niivue/mono/commit/9b41f2af))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.145

### Thank You

- neurolabusc

## 1.0.0-rc.43 (2026-11-10)

### Fixes

- **nv-ext-tile:** read an unstated transfer syntax as JPEG when the server refuses stored bytes ([9e1e0e64](https://github.com/niivue/mono/commit/9e1e0e64))

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.42 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.144

## 1.0.0-rc.41 (2026-11-10)

### Features

- **nv-ext-tile:** ZarrSlideSource for 2D OME-Zarr slides ([0bcded27](https://github.com/niivue/mono/commit/0bcded27))

### Fixes

- **nv-ext-tile:** refuse a timepoint a coarser level lacks ([224bd34b](https://github.com/niivue/mono/commit/224bd34b))
- **nv-ext-tile:** a flat centre sample reads the whole level for the range ([c32e56d0](https://github.com/niivue/mono/commit/c32e56d0))
- **nv-ext-tile:** sample the centre of the coarsest level for the data range ([6dc01d9c](https://github.com/niivue/mono/commit/6dc01d9c))
- **nv-ext-tile:** skip non-finite samples in the zarr slide data range ([333af33b](https://github.com/niivue/mono/commit/333af33b))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.40 (2026-11-10)

### Fixes

- **nv-ext-tile:** the frame-of-reference extent check is order-independent ([8a60f496](https://github.com/niivue/mono/commit/8a60f496))
- **nv-ext-tile:** only the 1\1 placeholder skips the extent check ([f1dcaa94](https://github.com/niivue/mono/commit/f1dcaa94))
- **nv-ext-tile:** compare height too when joining frames of reference ([9d9c1a46](https://github.com/niivue/mono/commit/9d9c1a46))
- **nv-ext-tile:** rank focal planes across frames of reference joined into one slide ([e6615c03](https://github.com/niivue/mono/commit/e6615c03))
- **nv-ext-tile:** join pyramid levels split only by frame of reference ([80c477d2](https://github.com/niivue/mono/commit/80c477d2))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.39 (2026-11-10)

### Features

- **nv-ext-tile,nv-mcp:** streamOmeZarr frees its manager and workers ([e8f06ff1](https://github.com/niivue/mono/commit/e8f06ff1))

### Fixes

- **nv-ext-tile:** a replacement stream queues at call time ([1ce37f46](https://github.com/niivue/mono/commit/1ce37f46))
- **nv-ext-tile:** serialize overlapping replacement streams on a viewer ([a98778f1](https://github.com/niivue/mono/commit/a98778f1))
- **nv-ext-tile,nv-mcp:** free a stream removed while it initializes ([2d4cf206](https://github.com/niivue/mono/commit/2d4cf206))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.143

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.38 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.142

## 1.0.0-rc.37 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.141

## 1.0.0-rc.36 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.140

## 1.0.0-rc.35 (2026-11-10)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.139

## 1.0.0-rc.34 (2026-11-10)

### Fixes

- **nv-ext-tile:** sniff DICOMweb levels concurrently, assume JPEG when the sniff is refused ([4e4bf398](https://github.com/niivue/mono/commit/4e4bf398))

### Thank You

- neurolabusc

## 1.0.0-rc.33 (2026-11-10)

### Fixes

- **nv-ext-tile:** show absent TIFF tiles transparent ([cebb178b](https://github.com/niivue/mono/commit/cebb178b))

### Thank You

- neurolabusc

## 1.0.0-rc.32 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.138

## 1.0.0-rc.31 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.137

## 1.0.0-rc.30 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.136

## 1.0.0-rc.29 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.135

## 1.0.0-rc.28 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.134

## 1.0.0-rc.27 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.133

## 1.0.0-rc.26 (2026-11-09)

### Features

- **nv-ohif:** depend on nv-ext-tile/dicom for the WSI tile decoders ([49d65cb4](https://github.com/niivue/mono/commit/49d65cb4))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.132

### Thank You

- neurolabusc

## 1.0.0-rc.25 (2026-11-09)

### Features

- **nv-ext-tile:** DicomWebWsiSource for DICOMweb whole-slide tiles ([fd930f5a](https://github.com/niivue/mono/commit/fd930f5a))

### Fixes

- **nv-ext-tile:** drop padding from a boundary read off the body ([aa7f3b94](https://github.com/niivue/mono/commit/aa7f3b94))
- **nv-ext-tile:** keep a [1,1] PixelSpacing when no volume size replaces it ([6b432167](https://github.com/niivue/mono/commit/6b432167))
- **nv-ext-tile:** require a strict multipart delimiter ending ([dfdc3520](https://github.com/niivue/mono/commit/dfdc3520))
- **nv-ext-tile:** match multipart delimiters per RFC 2046, encode frame URLs ([50e9f1c4](https://github.com/niivue/mono/commit/50e9f1c4))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.131

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.24 (2026-11-09)

### Features

- **nv-ext-tile:** index DICOM-WSI from DICOM JSON metadata ([cce33ed6](https://github.com/niivue/mono/commit/cce33ed6))

### Fixes

- **nv-ext-tile:** prefer a decodable AvailableTransferSyntaxUID ([de5dc17d](https://github.com/niivue/mono/commit/de5dc17d))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.23 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.130

## 1.0.0-rc.22 (2026-11-09)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.129

## 1.0.0-rc.21 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.109

## 1.0.0-rc.20 (2026-11-06)

### Features

- **nv-ext-wsi,demo-ext-wsi:** ICC colour management for DICOM-WSI and TIFF ([70ff4595](https://github.com/niivue/mono/commit/70ff4595))
- **nv-ext-wsi:** hosted DICOM-WSI manifests from the index ([a1ccadbb](https://github.com/niivue/mono/commit/a1ccadbb))
- **nv-ext-wsi:** export the DICOM-WSI index; registerDcm2niixDecoders ([a109ae88](https://github.com/niivue/mono/commit/a109ae88))
- **nv-ext-wsi:** index local DICOM-WSI folders and read their tiles ([0f7c7327](https://github.com/niivue/mono/commit/0f7c7327))

### Fixes

- **nv-ext-wsi:** dispose cancels a TIFF's deferred ICC profile read ([bafb3e95](https://github.com/niivue/mono/commit/bafb3e95))
- **nv-ext-wsi,demo-ext-wsi:** a host ICC transform wins; status shows a profile that is off ([642efbb1](https://github.com/niivue/mono/commit/642efbb1))
- **nv-ext-wsi:** implicit frame order only for TILED_FULL or unpositioned files ([55d7f695](https://github.com/niivue/mono/commit/55d7f695))
- **nv-ext-wsi:** bound derived paths and slide levels; bucket frames once ([6804d182](https://github.com/niivue/mono/commit/6804d182))
- **nv-ext-wsi:** place implicit planes in um; bound planes and tile maps ([cdf28942](https://github.com/niivue/mono/commit/cdf28942))
- **nv-ext-wsi,demo-ext-wsi:** rank stated focal planes across a slide's levels ([e9cf277b](https://github.com/niivue/mono/commit/e9cf277b))
- **nv-ext-wsi,demo-ext-wsi:** rank focal planes; linear nesting test ([6c30eca1](https://github.com/niivue/mono/commit/6c30eca1))
- **nv-ext-wsi,demo-ext-wsi:** external review fixes ([#581](https://github.com/niivue/mono/issues/581))
- **nv-ext-wsi:** bound slides per instance; walk a BOT whose last entry misses ([e2c2008c](https://github.com/niivue/mono/commit/e2c2008c))
- **nv-ext-wsi:** URL-encode file names in hosted manifests ([60b78aaa](https://github.com/niivue/mono/commit/60b78aaa))
- **nv-ext-wsi:** harden the DICOM-WSI index against hostile files; simplify ([33f0ff04](https://github.com/niivue/mono/commit/33f0ff04))
- **nv-ext-wsi:** show DICOM-WSI row 0 at the top ([e5635865](https://github.com/niivue/mono/commit/e5635865))

### Performance

- **nv-ext-wsi:** build tile maps on open, not at indexing ([fa6c51a3](https://github.com/niivue/mono/commit/fa6c51a3))
- **nv-ext-wsi:** faster DICOM-WSI index walks; DICOMDIR is not-tiled ([7c02ec0e](https://github.com/niivue/mono/commit/7c02ec0e))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.108

### Thank You

- neurolabusc

## 1.0.0-rc.19 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.107

## 1.0.0-rc.18 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.106

## 1.0.0-rc.17 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.105

## 1.0.0-rc.16 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.104

## 1.0.0-rc.15 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.103

## 1.0.0-rc.14 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.102

## 1.0.0-rc.13 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.101

## 1.0.0-rc.12 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.100

## 1.0.0-rc.11 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.99

## 1.0.0-rc.10 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.98

## 1.0.0-rc.9 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.97

## 1.0.0-rc.8 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.96

## 1.0.0-rc.7 (2026-11-06)

### Features

- ⚠️  **nv-ext-wsi:** rename @niivue/nv-ext-tiff to @niivue/nv-ext-wsi ([14e8bbfc](https://github.com/niivue/mono/commit/14e8bbfc))

### Breaking Changes

- **nv-ext-wsi:** rename @niivue/nv-ext-tiff to @niivue/nv-ext-wsi  ([14e8bbfc](https://github.com/niivue/mono/commit/14e8bbfc))
  install @niivue/nv-ext-wsi instead of @niivue/nv-ext-tiff.

### Updated Dependencies

- Updated niivue to 1.0.0-rc.95

### Thank You

- neurolabusc

## 1.0.0-rc.6 (2026-11-06)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.94

## 1.0.0-rc.5 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.93

## 1.0.0-rc.4 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.92

## 1.0.0-rc.3 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.91

## 1.0.0-rc.2 (2026-11-05)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.90

## 1.0.0-rc.1 (2026-11-05)

### Features

- **nv-ext-tiff:** stream tiled/pyramidal TIFF and SVS slides via geotiff ([#179](https://github.com/niivue/mono/issues/179))

### Fixes

- **nv-ext-tiff:** keep the alpha channel of RGBA tiles ([8132df4d](https://github.com/niivue/mono/commit/8132df4d))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.89

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc