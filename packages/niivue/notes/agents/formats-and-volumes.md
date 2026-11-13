# Formats and volume loading

Moved from `packages/niivue/AGENTS.md`; read it when working on a reader or writer, partial 4D loading, RGB vectors, modulation or overlay blending. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Format extensibility

Each format directory lists its modules in a hand-maintained `_registry.ts` (plain
imports, so the registries load under Bun as well as Vite). To add a new reader:
1. Create a module in the appropriate `readers/` directory
2. Export `extensions` array and `read` function
3. Add it to that directory's `_registry.ts`. `src/registry.test.ts` fails when a
   module file is missing from its registry, or a registry lists a missing file.

A reader must not import the module that registers it (e.g. a connectome reader
importing `connectome/index.ts`): that module builds its extension map from the
registry at load time, so the cycle leaves the registry uninitialized when the
registry is imported first. Put shared helpers in a leaf module
(`connectome/fileData.ts`).

Shared utilities: `NVLoader.buildExtensionMap()` (extension→module maps), `NVGz.maybeDecompress()` (transparent gzip).

**A reader's input may be a Node `Buffer`, whose `slice()` is `subarray()`.** Take
`.buffer` only from a fresh copy (`new Uint8Array(raw.subarray(a, b)).buffer`), or
the caller receives the whole underlying allocation instead of the slice (and, for
a small pooled Buffer, at a non-zero `byteOffset`). Browser loads never hit this —
fetch yields offset-0 buffers — so `mgh.test.ts` passes a `Buffer` explicitly.

Same pattern for: mesh readers (`mesh/readers/`), volume readers (`volume/readers/`), tract readers (`mesh/tracts/readers/`), connectome readers (`mesh/connectome/readers/`), layer readers (`mesh/layers/readers/`), signal readers (`signal/readers/`), volume and mesh writers (`volume/writers/`, `mesh/writers/`), volume transforms (`volume/transforms/`, shared by the main thread and the transform worker) and colormap LUTs (`cmap/luts/`).

### Partial 4D loading (`limitFrames4D`)

A 4D NIfTI whose full extent exceeds V8's ~2 GiB single-`ArrayBuffer` cap (e.g. a
344x344x127x45 float32 PET ≈ 2.5 GiB) can NOT be held in one buffer — decompressing
it throws `RangeError: Array buffer allocation failed`. `limitFrames4D` is therefore
not just a speed-up but the only way to open such a file. When it is finite,
`NVVolume.loadVolume` takes a fast path for a **gzip NIfTI-1**: `loadPartialNiftiGz`
pipes the fetch body through the browser-native `DecompressionStream` and inflates
ONLY the header + the first N frames, stopping early. The common belief that
`DecompressionStream` "must read the whole file" is only true for
`DecompressionStream` + `Response.arrayBuffer()` (which drains the stream); pulling
the decompressed output incrementally and `cancel()`-ing once enough bytes are in
hand stops both the inflate AND the upstream download — so no fflate dependency is
needed (nifti-reader-js's own `decompressHeaderAsync` uses the same technique). The
ORIGINAL header is preserved (its dims still describe the full extent), so
`nii2volume` truncates the supplied img cleanly and still reports `nFrame4D` "N of
`nTotalFrame4D`". Graceful `null` fallback to the normal full load on any miss:
NIfTI-2/byte-swapped, all frames requested (a one-shot whole-file read is faster
than slicing for a complete read), or any decode error. `getFileExt` strips `.gz`
(nii.gz → `NII`), so the gz is detected by the `.gz` filename suffix.
`codecs/NVGzStream.readFirstBytes` does the early-stop read; it takes an
already-decompressed stream (the caller wraps it with `pipeThrough(new
DecompressionStream('gzip'))`), so it is pure stream logic with no
`DecompressionStream` dependency and is unit-tested under the Bun harness (which has
no `DecompressionStream`).

**Shared core + two byte sources.** `loadPartialNifti1(readPrefix, limitFrames4D)`
holds all the header-parse / frame-budget / cap / slice logic; the two entry points
differ only in how they fetch the first N bytes:
- `loadPartialNiftiGz` — gzip: a fresh `DecompressionStream` per `readPrefix` (gunzip
  is forward-only, so each prefix re-inflates from the start).
- `loadPartialNiftiFile` — an UNCOMPRESSED `.nii` from a **local `File`**: `Blob.slice`
  reads only the prefix, so a >2 GiB file is never read as one ArrayBuffer (Chrome
  rejects that with `NotReadableError`, not `RangeError`). File-only — a remote
  uncompressed URL would need HTTP range requests; uncompressed multi-GB volumes are
  virtually always local (remote callers should gzip or use a `.nii.gz`).

**Auto-cap (no `limitFrames4D`, and the "load deferred frames" path).** A user who
does NOT set `limitFrames4D`, or who clicks the graph to load deferred frames
(`loadDeferred4DVolumes`, which re-fetches with no limit), must still not blow the
2 GiB cap. `loadVolume` wraps the full load in try/catch: on a `RangeError` (gz
decompress overflow) OR a `NotReadableError` (Chrome refusing to read a >2 GiB
uncompressed `File` as one ArrayBuffer) it retries the matching partial loader with
`Infinity`, which loads **as many whole frames as fit** under `MAX_VOLUME_BYTES`
(~1.77 GiB, safely below the cap). When the
cap — not the caller — reduces the count, it emits an **always-visible**
`console.warn` (the only justified bypass of the level-gated `log.*`, since silent
data loss must be surfaced regardless of `logLevel`). `loadPartialNiftiGz` accepts
`Infinity` ("as many as fit"); the cap math is `maxFramesUnderCap`.

**Frame count follows the data, not the request.** `nii2volume` clamps `nFrame4D`
to `min(floor(limit)-or-total, framesInImg, nTotalFrame4D)` where `framesInImg` is
the shared `volume/utils.framesInImage(img.byteLength, nVox3D, bpv)` helper (also
used by `loadDeferred4DVolumes`) — so when a capped load supplies fewer frames than
the header advertises, `nFrame4D` reflects the data actually present
(`nTotalFrame4D` keeps the header total). The request is floored so a fractional
`limitFrames4D` can never leak a non-integer `nFrame4D` (which would mis-align the
truncation byte count and the 4D graph / `setFrame4D`). This is essential: without
the clamp the graph plots `nTotalFrame4D` points and reads past the loaded data,
drawing garbage for the unloaded frames. The volume correctly enters the
partial/deferred state (`nFrame4D < nTotalFrame4D` → graph shows the loaded frames +
a deferred indicator). `loadDeferred4DVolumes` re-fetches RAW bytes and rebuilds the
volume through `nii2volume` (NOT by hand-coercing through the stored header) so any
datatype/intent conversion is REAPPLIED — a DT_FLOAT64 4D volume is converted to
Float32 on first load, and reloading raw f64 bytes through the converted header would
corrupt it. It copies only reconstruction-derived fields (img/hdr/nVox3D/frame
counts/intensity stats) and preserves display state (colormap/opacity/`frame4D`). A
dropped `File` has no URL to re-fetch, so `prepareVolume` stashes the original `File`
as runtime-only `_sourceFile` (never serialized — NVDocument allowlists fields) and
the reload re-opens that. A per-volume in-flight guard (`_deferredReloads`) drops
duplicate clicks. When the reload makes **no progress** (the remaining frames still
don't fit under the cap — e.g. a 2.5 GiB drop stuck at 35/40), it collapses
`nTotalFrame4D` to the loaded count so the graph stops offering a deferred action the
user can't satisfy. The deferred graph click (`interactions.ts`) is fire-and-forget
with a `.catch` (and the reload rolls CPU state back if `updateGLVolume` throws).

**Partial loading assumes time frames.** `loadPartialNifti1` treats `dim4*dim5*dim6`
as time frames. RGB-vector (`intent_code` 2003, dim4=3) and MRSI (dim4=spectral) are
NOT time series, so `loadPartialNifti1` now DECLINES an RGB-vector volume (intent-code
gate → full load, which converts to RGBA8). MRSI is not yet gated (detection needs MRS
header fields, not a single intent code) — but it's tiny in practice and unreachable
via the deferred path (RGB/MRSI conversions set `nTotalFrame4D=1`, so the deferred gate
returns before any re-read).

**View `isBusy` is try/finally-guarded.** `NVViewGPU.updateBindGroups` /
`NVViewGL._updateBindings` set `isBusy = true` and reset it in a `finally`, so an early
return (no device / no mesh layout) or a thrown upload `await` can't leave the flag
stuck — the render loop skips while busy, so a stuck flag would freeze drawing. The
deferred reload also re-checks `_destroyed` + that the volume is still mounted after its
async re-fetch, so a reload finishing after `destroy()`/`removeAllVolumes`/document
replacement discards its result instead of mutating a detached volume / uploading to a
torn-down view.

**Save/restore of a partial `File` volume.** `_sourceFile` is runtime-only, so a
restored document can't re-open a dropped File. `NVDocument.serialize` therefore
collapses the *saved* header's frame dims (`dims[4]=nFrame4D`, `dims[5..6]=1`) when a
volume is partial AND non-reloadable (`_sourceFile` present) — the document embeds
only the loaded frames, so the restored volume correctly presents as complete-at-N
with no deferred affordance. This is gated strictly on `_sourceFile`, so a partial
volume from a real URL (e.g. `mpld_asl` with `limitFrames4D`) keeps its full dims and
still deferred-reloads on restore. (Browser-verified; no full NVD round-trip test
yet. The controller now loads under Bun, so one could join `src/loadDocument.*.test.ts`.)

**Known limitations / follow-ups** (from the 2026-06-16 audit; not yet addressed —
all are edge cases or pre-existing, the common paths are verified working):
- **Peak memory on a capped load is now ~1x `imageBytes`** (was ~2x). The image is
  read straight into ONE pre-sized buffer via `codecs/NVGzStream.readWindow` (gzip:
  stream the window `[vox_offset, vox_offset+imageBytes)`, skipping the header, into
  the output and dropping each chunk) or `Blob.slice` (uncompressed `File`). No
  whole-prefix concat and no header-drop `slice` — the two big synchronous multi-GB
  copies are gone (measured ~550 ms faster + ~1.9 GiB less transient on a 2.5 GiB
  PET). `nii2volume` also skips its truncation slice when `img.byteLength ===
  keepBytes` (always true for the partial path now). The per-`ArrayBuffer` 2 GiB
  limit is never exceeded. NOTE: a ~1 s main-thread freeze remains on a multi-GB
  capped load, but it is the **GPU texture upload** (scales linearly with image
  size: ~190/510/990 ms for 5/15/31 frames), NOT the decompression — addressing it
  needs chunked/frame-by-frame texture upload with yields in the view layer
  (separate from the load path).
- **`loadImage()` still full-reads for the signal sniff (partially mitigated).**
  `_dispatchImage` sniffs signal-vs-volume by reading the whole file. Now: it skips
  the sniff entirely when `limitFrames4D` is set (explicit volume intent), and it
  catches a `NotReadableError`/`RangeError` from the whole-read (a >2 GiB file is
  never a 1-D signal) and falls through to the partial volume path. Remaining
  follow-up: for a *readable* large `.nii.gz` with no `limitFrames4D`, the sniff
  still fully decompresses before the volume loader streams frames — a header-only
  classification (`Blob.slice` / `decompressHeaderAsync`) would remove that.
- ~~No automated test exercises the real gzip/`DecompressionStream` partial
  path~~ — `e2e/partial-decode-4d.spec.ts` now does, in real Chromium. It asserts
  on a stream TRUNCATED after frame 0 rather than on memory: a bounded read
  succeeds where a full decode cannot, so the outcome is the measurement. (Memory
  is the wrong instrument here — the decode runs in a Worker, whose heap
  `performance.memory` does not report, and that is exactly how the bug below hid
  through review.) `readFirstBytes`' pure stream logic remains unit-tested under
  Bun, which has no `DecompressionStream`.
- **`DecompressionStream` is feature-detected** (`HAS_DECOMPRESSION_STREAM`):
  `gunzipStream` returns null gracefully if it's missing (no `ReferenceError`), the gz
  partial path then declines, and an oversize gz load emits a specific always-visible
  `console.warn` (browser requirement) instead of an opaque `RangeError`.
- **Partial 5D/6D `File` save/restore flattens to 4D** (intentional). The serialize
  collapse sets `dims[4]=nFrame4D`, `dims[5..6]=1`: only the first `nFrame4D` frames
  were loaded (not a clean multiple of the higher axes), so a flat 4D count is the
  only faithful representation of what the document contains. 4D time series (the
  common case) are unaffected.
- **Deferred reload is now atomic on GPU-upload failure.** `loadDeferred4DVolumes`
  snapshots the replaced CPU fields (`img`/frame counts/intensity stats) and rolls
  them back if `updateGLVolume()` throws, so the model never ends up ahead of the GPU.
- **`loadPartialNiftiGz` fetches the URL up to 3x** (header, optional header-extension
  re-read, image window), relying on `cache:'force-cache'` for byte-identical
  responses. The image read no longer concatenates a whole prefix (it streams via
  `readWindow` into the pre-sized buffer), but it is still a separate fetch from the
  header read. A single forward-only stream — keep one reader alive, read to the
  header, then continue the SAME stream to `bytesToLoad` — would drop the extra
  fetches and the `force-cache` dependency. Deferred (assessed 2026-06-16): the
  stateful cross-read reader/cancel discipline lands on the Bun-untestable path, so
  it warrants its own focused PR + manual large-volume pass.
- **GPU texture upload of a multi-GB capped image blocks the main thread** (~1 s on a
  31-frame 1.9 GiB load; scales with size). The load/decompress path now yields
  (streamed `readWindow`), so the remaining freeze is in the view layer's texture
  upload. A frame-by-frame / chunked upload with `await` yields between batches would
  fix it; not yet done (touches `wgpu/`/`gl/` upload paths, browser-only).

**Both load paths must FORWARD the limit — this was broken.** `limitFrames4D`
bounded retention only, not decoding, because neither caller reached the fast
path: `workers/volumeLoad.worker.ts` reimplemented `loadVolume` (its own
`fetchFile` + reader dispatch), and `volume/loadBridge.ts`'s main-thread fallback
called `loadVolume(url, paired)` with no third argument, which defaults to
`Infinity`. So every frame was fetched and inflated and then discarded by
`nii2volume`; a 105-frame DWI peaked at 601 MB RSS to show one 1.5 MB frame. The
worker now delegates to `loadVolume` (which also gives it the >2 GiB oversize
recovery it lacked) and the fallback forwards the limit. If you add a third
caller, forward it there too.

**`name` is reader metadata, and both paths must forward it.** Some readers are
filename-sensitive (MGH infers label volumes from it, VMR tells `.v16` from
`.vmr`), so `loadVolume` takes an optional `name` that reaches `reader.read`. It
does NOT select the format — reader dispatch and partial-loader eligibility both
read the URL. Pinned by `e2e/reader-name-override.spec.ts`.

**A bad input is not retried on the main thread.** `loadBridge` falls back to a
main-thread load only for INFRASTRUCTURE failure (no Worker, terminated,
transport). A healthy worker that fails on the payload tags the error
`VolumeLoadError`, which the bridge rethrows — otherwise a malformed or missing
file paid for its whole fetch + inflate + parse twice, the second time on the UI
thread.

**Detached-header formats:** AFNI (`.HEAD` + `.BRIK.gz`), NIfTI (`.hdr` + `.img`), NRRD (`.nhdr` + `.*`). The `urlImageData` property provides the image data URL alongside the header URL. For an AFNI `.HEAD` URL with no `urlImageData`, `NVModel.prepareVolume` probes for the `.BRIK`, then `.BRIK.gz`, beside it (`volume/pairedImage.ts`; GET with the body cancelled once the status is known, an HTML 200 counts as missing) and stashes the result in `_urlImageData` exactly like an explicit one. An explicit `urlImageData` is never probed. File loads are not paired.

### V1 RGB vector volumes

Float32 RGB vector volumes (NIfTI `intent_code` 2003, `dim4=3`) are auto-converted to RGBA8 at load time by `convertFloat32RGBVector()`. RGB stores absolute magnitude; alpha encodes sign polarity in 3 LSBs (bit 0=x+, bit 1=y+, bit 2=z+).

**Explicit V1 conversion** (`loadImgV1(volumeIndex, isFlipX?, isFlipY?, isFlipZ?)`): For formats like AFNI that lack NIfTI intent codes. Delegates to `volume/TensorProcessing.ts`.

**V1 slice shader** (`volume.isV1SliceShader` config option): Interprets overlay RGBA as fiber direction data, renders colored lines with smoothstep falloff. Implemented in both `wgpu/slice.wgsl` and `gl/sliceShader.ts`.

### Volume modulation

`setModulationImage(targetId, modulatorId, modulateAlpha = 0)` scales a target
volume's brightness (RGB) or opacity (alpha) by another volume's windowed scalar
values. Works for **both** pre-baked RGB/RGBA volumes (V1 tensors) **and** plain
colormapped scalar overlays — but `modulateAlpha` means different things per type:

- **Scalar overlays:** `modulateAlpha === 0` modulates RGB; non-zero modulates
  ALPHA with exponent `max(1, |modulateAlpha|)` (matching the original NiiVue).
- **RGB/RGBA (V1) volumes:** **RGB only, always** — alpha is preserved for V1
  sign-polarity bits, so a non-zero `modulateAlpha` does NOT alpha-modulate them.

The two code paths are mutually exclusive by target datatype (each compute
function early-returns for the other's datatype, so only one of `_modulationData`
/ `_modulationWeight` is built per target). Both window by the modulator's own
`calMin/calMax`:

- **RGB/RGBA (V1) path:** `computeModulationData()` -> `_modulationData`
  (`Float32Array`, RAS order), applied CPU-side in `prepareRGBAData()`. Only RGB
  is scaled.
- **Scalar overlay path:** `computeModulationWeights()` -> `_modulationWeight`
  (`Float32Array`, **modulator native order**, already raised to the
  `modulateAlpha` exponent, cached by `_modulationWeightKey` — keyed on the
  modulator's buffer identity + offset + datatype + dims + scaling + frame +
  window + exponent, so a swapped/rescaled/re-windowed modulator invalidates the
  cached weight and its GPU texture). The scalar
  colormap GPU prepass (`gl/orientOverlay.ts` / `wgpu/orient.ts` + `orient.wgsl`)
  uploads it as an **R32F weight texture** and samples it through the modulator's
  overlay transform matrix (`buildModulationParams` -> `calculateOverlayTransformMatrix(baseVol, modVol)`)
  — the same mechanism used for the intensity volume, so the modulator may live
  on **any co-registered grid** (it does not need to match the target or
  background dims). Inside the prepass, `modulation == 1` does `rgb *= w`,
  `modulation == 2` does `a *= w`, applied before the overlay-opacity bake.

The prepass texture cache key includes the modulation state
(`modKey`/`_modulationWeightKey`), so toggling/repointing the modulator or
changing its window correctly re-uploads. The weight texture binds to WebGL2
texture unit 4 and WebGPU bind-group binding 6; a 1x1x1 placeholder is bound when
modulation is inactive. Modulation applies to **both overlays and the background
volume** — `updateVolume(...)` threads the full volume list so the background's
prepass (`overlay2Texture`/`volume2Texture`) can resolve and sample the
modulator. Alpha-modulating the background only *shows* as transparency when
`volumeIsAlphaClipDark` is on (the per-voxel background-alpha clip path); RGB
modulation of the background needs no flag.

Demo: `examples/vox.modulate.scalar.html` — grayscale MNI152 + a binary mask
(`mni152_mask.nii.gz`), with a `volume / mask / volume + mask / volume * mask
(modulate)` selector and a background-colour picker. The "modulate" mode
alpha-modulates the **background** by the mask (`volumeIsAlphaClipDark` on) so
anatomy outside the mask becomes transparent and the canvas colour shows through
(2D + 3D), WebGPU+WebGL2 parity. The MRSI mask can now use `setModulationImage`
instead of the bake workaround (see the MRSI invariant below).

**Volume ids are unique per instance.** A volume's `id` defaults to its `name`
(the URL), but `NVModel.addVolume` and `loadVolumes` suffix a repeat `-2`, `-3`,
... (`volume/volumeIds.ts`), so the same file loaded twice (AFNI's QC viewer
loads a stats dataset as the overlay and again, hidden, as its threshold) gets
two ids and `setModulationImage(vols[1].id, vols[2].id)` cannot modulate a
volume by itself. `name` stays the display label. A chunked volume whose explicit
id was suffixed adopts the scene's id after `init()`.

**NVD persistence:** both `modulateAlpha` and `modulationImage` (the modulator
volume-id link) are serialized and restored — the link is reapplied in the
post-load pass (find-by-id at render time), so it survives even if the modulator
volume is restored later in the document. Each volume's `id` is saved too and
restored after its volume is added, so links (including a signal's
`attachedToId`) keep their target when the saved scene held one URL twice; a
document without ids re-derives them from names in volume order. The `_modulationData`/`_modulationWeight`
arrays are derived (never serialized).

**Edge cases / invariants (keep these true):**
- **Label/atlas targets are NOT modulated** — their colormap prepass returns
  before the modulation block, so `buildModulationParams`/`computeModulationWeights`
  early-return for `colormapLabel` targets (no wasted setup).
- **NaN-safe weights** — both compute loops map a NaN/`<=0` window AND any NaN
  modulator voxel (finite window) to weight 0 (transparent), never NaN.
- **Cache key = modulator buffer identity** (WeakMap id) + offset + data
  version (`_dataVersion`) + datatype + dims + scaling + frame + window +
  exponent. An in-place edit reported through `updateVolumeData` or the
  modulator's `isDirty` bumps the version and invalidates it; an unreported
  in-place mutation of `mod.img` is invisible.
- **Affine fast path** (`updateAffineOverlays`, 2-volume case) bails to a full
  update when `vols[0].modulationImage` is set — otherwise a modulated
  background's baked modulator matrix would go stale on an overlay affine change.
- **NVD volume order** is preserved by reconstructing volumes sequentially
  (`addVolume` pushes on async-prepare completion; a parallel restore would
  reorder background vs overlays).

### Overlay blending

With 2+ overlays, `volumeOverlayAlphaBlend` (`OVERLAY_ALPHA_BLEND`) and
`volumeOverlayColorBlend` (`OVERLAY_COLOR_BLEND`) set how they combine before
compositing over the background. GL blends on the CPU (`volume/overlayBlend.ts`
`blendOverlayData`); WebGPU in a compute pass (`wgpu/orient.ts`
`blendOverlaysGPU`, mode via override constants). Colour `OVER` composites
in volume order (later overlays on top); colour `MAX` keeps the per-component
max of the premultiplied colours; every mode but `OVER` is commutative.
`volumeIsChannelStack` blends volumes[0] in as one more overlay (both views'
`_updateOverlayStack` pass every volume, the base draws at opacity 0) so the
fused channels land on the canvas background; ignored with one volume, in
multi-instance mode, and while volumes[0] is chunked unless every volume is
streamed (`chunkSource`): then both renderers fuse each base chunk's drawn
bricks in the upload pump (`view/chunkStackFuse.ts` `pump`; GL
`blendOverlaysGL` in `gl/blendOverlays.ts`, WebGPU `blendOverlaysGPU` in
`wgpu/blendOverlays.ts`, the same accumulate-then-normalise passes; GL reads
back and `blendOverlayData`s only without float render targets) into the
overlay slot (`e2e/render-streamed.spec.ts`). A chunk fuses once all its drawn
channels' bricks are resident, keeps its old fused texture until the new one
lands, follows its brick region across plan swaps, re-fuses when a blend mode
changes, and never draws under another source generation (a frame switch), so
a switch never shows old and new time points side by side. Bricks leave
opacity out; the fuse weights each channel's alpha by it (`stackWeights`, a
per-overlay weight in both GPU blends, `weightAlpha` before the CPU one) and
keys on it, so an opacity change re-fuses without re-uploading bricks.
`e2e/streamed-stack-switch.spec.ts` with `STACK_FUSE_BENCH=1`
benches it; the GL blend matches `blendOverlayData` exactly. Depth picks on a stack
skip the base march (`backOpacity` 0 in the pick shaders) and answer from any
drawn channel; the CPU chunked pick uses `stackPickSampler`. Hidden (or opacity 0) and
PAQD volumes do not join as channels. Stacked channels keep their colormap's
alpha ramp in the orient bake (`modFlags.z` in `orient.wgsl`,
`keepColormapAlpha` in `gl/orientOverlay.ts`);
other overlays get `step(0.00001, a)`. The overlay ray-march takes the
background's step-size correction (`volumeIsOverlayOpacityCorrected`, default
on), so 3D density is independent of `sampleRate`; the drawing and PAQD passes
are not corrected, and a `chunkOverlayOf` overlay (marched by the background
pass) is always corrected. The `overlay-density` scene of `e2e/render-volume.spec.ts` pins it.
Setters rebuild via `updateGLVolume`. For self-modulated fraction maps (`vox.tissues.html`) set
`calMin` 0: the alpha weight is `(f-calMin)/(calMax-calMin)`, so a nonzero
`calMin` breaks alpha == fraction and ADDITIVE no longer sums to 1.
Unknown mode values fall back to MAX / ADDITIVE on both backends. The WebGPU
pass runs in z-slabs sized so the 24 B/voxel f32 accumulator fits
min(`maxStorageBufferBindingSize`, `maxBufferSize`); typical volumes and chunks
are one slab. The chunking threshold is capped at floor(sqrt(that min / 24)) so
one z-slice always fits (2364 at 128 MiB, above the usual 2048 3D limit). Its
per-device pipeline cache holds at most four accumulate pipelines (keyed by
colour mode, the only override that shader reads) and twelve normalise
pipelines (alpha x colour).
- `bun packages/niivue/scripts/check-blend-wgsl.mjs` compiles and runs the blend
  WGSL in system Chrome across all 12 modes, two slabs and four overlay orders,
  compares each result with the CPU `blendOverlayData` (tolerance 1) and exits 1
  on a mismatch. Passed 2026-10-05 (plus a WebGPU visual pass of `vox.tissues.html` /
  `vox.stats-multi.html` in all six then-existing mode pairs), with colour
  `OVER` 2026-10-23, and with colour `MAX` on overlapping channels (z1)
  2026-10-23.
