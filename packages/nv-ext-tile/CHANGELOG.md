## 1.0.0-rc.101 (2026-11-13)

### Fixes

- **nv-mcp:** add_isosurface leaves the timepoint to the store, names the chosen channel ([aed19aa6](https://github.com/niivue/mono/commit/aed19aa6))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.192

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.100 (2026-11-13)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.191

## 1.0.0-rc.99 (2026-11-13)

### Fixes

- **nv-ext-tile:** tie the placement test to the chunked source; doc touch-ups ([5eb4c2b0](https://github.com/niivue/mono/commit/5eb4c2b0))
- **nv-ext-tile:** place whole OME-Zarr levels like streamed ones ([f609ad8b](https://github.com/niivue/mono/commit/f609ad8b))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.190

### Thank You

- neurolabusc

## 1.0.0-rc.98 (2026-11-13)

### Refactors

- ⚠️  **nv-ext-tile:** drop 14 consumer-less /zarr entry exports ([e5842397](https://github.com/niivue/mono/commit/e5842397))

### Breaking Changes

- **nv-ext-tile:** drop 14 consumer-less /zarr entry exports  ([e5842397](https://github.com/niivue/mono/commit/e5842397))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.189

### Thank You

- neurolabusc

## 1.0.0-rc.97 (2026-11-13)

### Fixes

- **nv-ext-tile:** route sharded OME-Zarr reads by shard so each shard is probed once ([6b295f94](https://github.com/niivue/mono/commit/6b295f94))

### Thank You

- neurolabusc

## 1.0.0-rc.96 (2026-11-13)

### Features

- **nv-ext-tile:** vendor placement on by default; open Ventana iScan padded levels ([9e9c2be7](https://github.com/niivue/mono/commit/9e9c2be7))
- **nv-ext-tile:** apply DICOM ImageOrientationSlide to WSI slides ([46aef03a](https://github.com/niivue/mono/commit/46aef03a))

### Fixes

- **nv-ext-tile:** keep the persistent tier for a page-relative OME-Zarr URL ([7a926cb2](https://github.com/niivue/mono/commit/7a926cb2))
- **nv-ext-tile:** take a padded level only when iScan names it a level ([3d00255d](https://github.com/niivue/mono/commit/3d00255d))
- **nv-ext-tile:** turn each DICOM-WSI level by its own ImageOrientationSlide ([04967704](https://github.com/niivue/mono/commit/04967704))
- **nv-ext-tile:** key openSlide's DICOM index over the whole input ([ccf9df25](https://github.com/niivue/mono/commit/ccf9df25))
- **nv-ext-tile:** resolve a page-relative OME-Zarr URL against the page ([b06ed42a](https://github.com/niivue/mono/commit/b06ed42a))
- **nv-ext-tile:** look up an associated image's file by its index key ([e496ec8d](https://github.com/niivue/mono/commit/e496ec8d))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.188

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.95 (2026-11-13)

### Features

- ⚠️  **nv-ext-tile:** remove deprecated DicomWebWsiOptions.headers ([9a1611de](https://github.com/niivue/mono/commit/9a1611de))

### Breaking Changes

- **nv-ext-tile:** remove deprecated DicomWebWsiOptions.headers  ([9a1611de](https://github.com/niivue/mono/commit/9a1611de))

### Thank You

- neurolabusc

## 1.0.0-rc.94 (2026-11-13)

### Fixes

- **niivue,nv-ext-tile:** cancel lazy-frame prefetch when its volume leaves ([cc9a8884](https://github.com/niivue/mono/commit/cc9a8884))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.187

### Thank You

- neurolabusc

## 1.0.0-rc.93 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.186

## 1.0.0-rc.92 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.185

## 1.0.0-rc.91 (2026-11-12)

### Features

- **niivue, nv-ext-tile:** tile lane A slide sources (opener, fetch contract, transport checks, grey/signed, vendor layouts) ([fca4aed8](https://github.com/niivue/mono/commit/fca4aed8))

### Fixes

- **niivue:** a manifest's own origin gets the custom fetch with a cross-origin baseUrl ([c43372a7](https://github.com/niivue/mono/commit/c43372a7))
- **nv-ext-tile:** hold every custom fetch to its signal in slideFetch ([6b12c8d7](https://github.com/niivue/mono/commit/6b12c8d7))
- **nv-ext-tile:** opening a hosted manifest settles on abort when a custom fetch ignores it ([3243bb3e](https://github.com/niivue/mono/commit/3243bb3e))
- **nv-ext-tile:** same-named local files keep distinct keys; rank slides without a spread ([06bdc395](https://github.com/niivue/mono/commit/06bdc395))
- **nv-ext-tile:** only a caller abort rejects indexing; mixed slides list in input order ([def0549f](https://github.com/niivue/mono/commit/def0549f))
- **nv-ext-tile:** pass a custom fetch straight to the Zarr loader after main's (url, init) ZarrFetch ([58c665f3](https://github.com/niivue/mono/commit/58c665f3))
- **nv-ext-tile:** a disposed TIFF source refuses its cached ICC profile; an abort mid-read rejects thread-side indexing ([6b32c84e](https://github.com/niivue/mono/commit/6b32c84e))
- **nv-ext-tile:** DicomPlaneStack ICC profile follows the initial plane ([39a66ba2](https://github.com/niivue/mono/commit/39a66ba2))
- **nv-ext-tile:** PR 746 review fixes (sub-8-bit grey, Philips regex, capped reads) ([0a9d883f](https://github.com/niivue/mono/commit/0a9d883f))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.184

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.90 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.183

## 1.0.0-rc.89 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.182

## 1.0.0-rc.88 (2026-11-12)

### Features

- **nv-ext-tile:** Zarr byte cache, worker decode, native types and lazy channels ([5dea525b](https://github.com/niivue/mono/commit/5dea525b))

### Fixes

- **nv-ext-tile:** label colormap starts and ends on a clear entry ([d7263e7d](https://github.com/niivue/mono/commit/d7263e7d))
- **nv-ext-tile:** a cut label table ends on a clear entry so dropped IDs show clear ([cf67f918](https://github.com/niivue/mono/commit/cf67f918))
- **nv-ext-tile:** label colormaps that always register, one per added segmentation ([721d63b3](https://github.com/niivue/mono/commit/721d63b3))
- **nv-ext-tile:** drop hidden-channel results after dispose; count bodies without Content-Length ([7dc87cf9](https://github.com/niivue/mono/commit/7dc87cf9))
- **nv-ext-tile:** PR 745 review fixes for budget, aborts and worker byte counts ([6ff7f9f8](https://github.com/niivue/mono/commit/6ff7f9f8))

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.87 (2026-11-12)

### Features

- **niivue, nv-ext-tile:** tiled-image P0 foundation (split, shared helpers, contracts, baseline) ([7d843ee1](https://github.com/niivue/mono/commit/7d843ee1))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.181

### Thank You

- neurolabusc

## 1.0.0-rc.86 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.180

## 1.0.0-rc.85 (2026-11-12)

### Features

- **niivue:** pure cyan and yellow channel ramps ([66b20d23](https://github.com/niivue/mono/commit/66b20d23))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.179

### Thank You

- neurolabusc

## 1.0.0-rc.84 (2026-11-12)

### Features

- lazy OME-Zarr time (VolumeFrameSource) and label stores ([5d13803f](https://github.com/niivue/mono/commit/5d13803f))

### Fixes

- **nv-ext-tile,demo-ext-tile:** PR 737 r3 review fixes ([f268bc47](https://github.com/niivue/mono/commit/f268bc47))
- **nv-ext-tile:** PR 737 r2 frame cache fixes ([4d887fc5](https://github.com/niivue/mono/commit/4d887fc5))
- **niivue,nv-ext-tile:** PR 737 review fixes for lazy OME-Zarr frames ([8eb4bf79](https://github.com/niivue/mono/commit/8eb4bf79))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.178

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.83 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.177

## 1.0.0-rc.82 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.176

## 1.0.0-rc.81 (2026-11-12)

### Features

- **nv-ext-tile:** fill DICOM-WSI holes with the recommended absent colour ([454b7a26](https://github.com/niivue/mono/commit/454b7a26))

### Fixes

- **nv-ext-tile:** reject a non-VM-3 binary absent-pixel CIELab value ([7bc18364](https://github.com/niivue/mono/commit/7bc18364))
- **nv-ext-tile:** an empty CIELab component is not 0 ([6c93e490](https://github.com/niivue/mono/commit/6c93e490))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.175

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.80 (2026-11-12)

### Features

- **nv-ext-tile:** 2-98% slide windows and storedToValue for quantized channels ([685750ee](https://github.com/niivue/mono/commit/685750ee))

### Fixes

- **nv-ext-tile:** jitter the window sample within each stride ([f0092091](https://github.com/niivue/mono/commit/f0092091))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.174

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.79 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.173

## 1.0.0-rc.78 (2026-11-12)

### Performance

- **nv-ext-tile:** index local DICOM-WSI folders in a worker, in 1 MiB blocks ([181696f0](https://github.com/niivue/mono/commit/181696f0))

### Thank You

- neurolabusc

## 1.0.0-rc.77 (2026-11-12)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.172

## 1.0.0-rc.76 (2026-11-11)

### Features

- **nv-ext-tile:** multi-channel OME-TIFF slides ([dd46acda](https://github.com/niivue/mono/commit/dd46acda))

### Fixes

- **nv-ext-tile:** reject OME-TIFF channels with mixed PhotometricInterpretation; Codex 728-r2 ([b4efc5b9](https://github.com/niivue/mono/commit/b4efc5b9))
- **nv-ext-tile:** keep multi-channel WhiteIsZero TIFF planes white at 0; Codex 728-r1 ([bb2f0e11](https://github.com/niivue/mono/commit/bb2f0e11))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.171

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

## 1.0.0-rc.75 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.170

## 1.0.0-rc.74 (2026-11-11)

### Fixes

- Codex r1 on PR 725, stream ramps and minimap press ([7a8ec295](https://github.com/niivue/mono/commit/7a8ec295))
- **nv-ext-tile:** style a streamed OME-Zarr channel from its omero metadata ([c2724456](https://github.com/niivue/mono/commit/c2724456))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.169

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.73 (2026-11-11)

### Features

- **nv-ext-tile:** honour omero active channels for OME-Zarr volumes and slides ([39a3ef34](https://github.com/niivue/mono/commit/39a3ef34))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.168

### Thank You

- neurolabusc

## 1.0.0-rc.72 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.167

## 1.0.0-rc.71 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.166

## 1.0.0-rc.70 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.165

## 1.0.0-rc.69 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.164

## 1.0.0-rc.68 (2026-11-11)

### Updated Dependencies

- Updated niivue to 1.0.0-rc.163

## 1.0.0-rc.67 (2026-11-11)

### Fixes

- main typecheck after #700 + TS bump; drop stale zarrita-compare lock entries ([#700](https://github.com/niivue/mono/issues/700))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.162

### Thank You

- Chris Drake
- Claude Opus 5.5

## 1.0.0-rc.66 (2026-11-11)

### Fixes

- guard missing OffscreenCanvas; keep tiny native Pixel Data not-tiled ([b308657c](https://github.com/niivue/mono/commit/b308657c))
- **nv-ext-tile:** report a DICOM header cut off by the end of the file as malformed ([b3cdc35b](https://github.com/niivue/mono/commit/b3cdc35b))

### Updated Dependencies

- Updated niivue to 1.0.0-rc.161

### Thank You

- Chris Drake
- Claude Opus 5.5
- neurolabusc

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