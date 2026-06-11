# Background-volume orient-texture cache (and matcap reload fix)

Branch: `perf/cache-background-volume-texture`. This document explains the
change for agents and developers working on the volume render path. Read it
before touching `updateVolume`, the orient caches, or matcap handling in
either backend.

## Problem

`VolumeRenderer.updateVolume()` runs inside `updateGLVolume()` (via
`view.updateBindGroups()`), which fires on every `setVolume`-class change
(colormap, cal_min/max, opacity, frame4D, ...) and on **every pointermove
tick of a windowing drag** (`dragForWindowing` in `src/control/dragModes.ts`
calls `ctrl.updateGLVolume()` directly).

For the **background volume (layer 0)** each such tick used to pay the full
path through `overlay2Texture` / `orient.volume2Texture`:

- CPU datatype conversion. For float64 volumes the **entire 4D array** is
  converted to float32 before the frame is subarrayed
  (`src/gl/orientOverlay.ts`, `convertTo.from(sourceArray)`).
- Re-upload of the raw scalar texture to the GPU.
- The orient render/compute pass (calibration + colormap lookup).
- Allocation of fresh input, colormap and output textures, with the raw input
  texture **deleted at the end of every call** -- so nothing was reusable.

This is the half-second-class cost (for large volumes) per windowing-drag
tick. The codebase already solved exactly this problem for single non-RGBA
overlays with `OverlayTextureCache` (`src/gl/orientOverlay.ts`,
`prepareOverlayTextureCache`) and `OrientTextureCache` (`src/wgpu/orient.ts`,
`prepareOrientTextureCache`), but the background volume did not use it.

Additionally, `updateVolume()` deleted and re-loaded the **matcap texture**
on every call -- on WebGL2 an async `Image` fetch+decode whenever a matcap is
set, on WebGPU a `createImageBitmap` + copy.

## Change

1. **Background volume goes through the existing orient-texture cache.**
   `updateVolume()` now calls `prepareOverlayTextureCache` (WebGL2) /
   `prepareOrientTextureCache` + `dispatchOrient` (WebGPU) with the
   background volume as both source and target and `overlayOpacity = 0`,
   storing the result in a new private `volumeOrientCache` field (separate
   from `overlayOrientCache`). `volumeTexture` is the cache's
   `outputTexture`. No new caching mechanism was invented; the invalidation
   contract is the one the repo already ships.
2. **RGB/RGBA background volumes (datatype 128 / 2304) bypass the cache** and
   keep the direct-upload path (`isRgbaDatatype` guard); the cache mechanism
   only supports scalar datatypes. Switching a scalar volume in for an RGBA
   one (or vice versa) destroys/rebuilds correctly via `clearVolume()`.
3. **Matcap texture is cached by source string.** A private `matcapKey`
   records the matcap URL/data-URL the current texture was created from;
   `updateVolume()` reloads only when the string changes (including the `''`
   fallback texture). `loadMatcap()` updates the key too.

## Cache invalidation contract (unchanged, now also for layer 0)

The cache is reused only when ALL of these match the previous call;
otherwise it is destroyed and rebuilt:

- `hdr.datatypeCode` and the derived shader/pipeline type
- `frame4D`
- `img.buffer` **identity** (replacing the typed array/buffer invalidates;
  in-place mutation of the same buffer does NOT -- same caveat as overlays)
- input dims (`hdr.dims[1..3]`) and output dims (`dimsRAS[1..3]`)
- colormap key (`colormap:colormapNegative`, or label-LUT identity)

On reuse, only uniforms are rewritten (cal_min/max, scl slope/intercept,
opacity, transform matrix) and the orient pass re-renders into the existing
output texture. This is what makes windowing drags cheap.

If you add a code path that mutates the background volume's voxels in place
(same `img.buffer`), you must force invalidation yourself -- e.g. by
replacing `vol.img` or calling `clearVolume()` on the renderer.

## New/changed API surface (both backends)

- `VolumeRenderer.clearVolume(gl?)` -- destroys the non-cached volume texture
  and the volume orient cache. Used by `updateVolume` (RGBA path) and
  `destroy()`.
- `private deleteNonCachedVolumeTexture` / `destroyNonCachedVolumeTexture` --
  deletes `volumeTexture` only if it is not the cache's output texture
  (mirrors the overlay equivalents).
- `updateVolume()` semantics are otherwise unchanged: same signature, still
  recomputes the gradient texture from the (possibly re-rendered) volume
  texture afterwards.

## Invariants to preserve

- `volumeTexture` may be owned by `volumeOrientCache`. Never call
  `gl.deleteTexture(volumeTexture)` / `volumeTexture.destroy()` directly;
  go through `clearVolume()` or the non-cached delete helpers, exactly like
  the overlay path does.
- All current external consumers of `volumeTexture` (slice renderer bind
  groups, depth pick, background masking, drawing growcut) are read-only.
  Keep it that way: anything that wants to *replace* the texture must
  understand cache ownership.
- On WebGPU, `prepareOrientTextureCache` only writes uniforms on reuse; the
  caller must `dispatchOrient` afterwards (done in `updateVolume`).
- On WebGPU the bind-group identity cache in `updateBindGroup` keys on
  texture object identity; cache reuse keeps the same `outputTexture` object,
  so bind groups are also reused. Do not "refresh" the output texture object
  on reuse or you defeat that.
- The texture-identity rule also matters on the GL side for
  `maskOverlayByBackground` (in-place readback/modify): it operates on
  whatever `volumeTexture`/`overlayTexture` point to, which remains correct
  because re-renders happen in place.

## Known pre-existing issue (not introduced here)

WebGPU background masking (`NVViewGPU.updateBindGroups`, `isBackgroundMasking`
path) destroys the overlay texture returned by the **overlay** orient cache
and replaces `overlayTexture` with a new masked texture, while
`overlayOrientCache` still references the destroyed texture. The overlay
cache reuse path can then render into a destroyed texture. This predates this
branch (it concerns the overlay cache, not the new volume cache; the volume
texture is only read by the mask pass). Worth a separate fix upstream.

## Behavior notes

- Windowing drag / cal_min/max / opacity / colormap-invariant changes: no CPU
  conversion, no raw upload, no allocations -- one orient pass per tick.
- Colormap change: cache rebuild (new colormap key). Same total cost as
  before the change.
- frame4D change: cache rebuild. A future improvement could keep the raw 4D
  texture resident and only re-slice, but that changes the cache key contract.
- Memory: the raw input texture and LUTs now stay alive for the background
  volume (previously freed after each update). That is the same trade the
  overlay cache already makes; for a 256^3 int16 volume it is ~32 MB GPU.

## Testing

`bunx nx run niivue:{format,lint,typecheck,test,build}` all pass. There are no
GPU-context unit tests in this package (bun test runs without WebGL/WebGPU);
to verify visually, run `bun run dev`, load a volume, and drag with the
windowing mode active while watching frame times. For A/B numbers use the
benchmark harness described in `docs/perf.md` (`bun run bench:compare` gates
against `main`).

## Relationship to other perf work

The sibling branch `perf/lazy-gradient-texture` removes the unconditional
gradient recompute from `updateVolume` (skipped while
`model.volume.illumination` is 0). The two branches edit the same
`updateVolume` functions and will conflict textually on merge; the semantics
compose cleanly (with both applied, a windowing tick on a default session
does one orient pass and nothing else). Note that with this branch alone, the
gradient is still recomputed from the re-rendered volume texture on every
update -- intentionally unchanged here.
