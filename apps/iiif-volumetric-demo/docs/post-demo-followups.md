# Post-demo follow-ups — chunked volumetric WSI

Feedback captured after demoing the chunked-streaming / WSI work on branch
`feat/dicom-wsi-omezarr`. Three items came out of the demo; two were largely
implemented in the same session, one is the remaining open work.

## 1. Higher-res overlay + chunking support for overlays — IMPLEMENTED (needs manual GPU verify)

**Status (2026-06-04):** implemented on both backends; all automated checks
green (lint, typecheck, 381 niivue tests, both builds, boundaries). Remaining:
manual GPU verification in the browser (`bun run dev`, overlay page, "stream
hi-res" toggle, `?backend=webgl2` and `?backend=webgpu`). 3D render only; 2D
slice rendering of the independent overlay is a documented follow-up.

Design + limitations are documented in
`packages/niivue/docs/high-res-streaming.md` section 10.

Key pieces landed:
- `NVImage.chunkOverlayOf` / `chunkOverlayOpacity` (NVTypes).
- Renderer (`wgpu/render.ts`, `gl/render.ts`): `_activeOverlayChunked` second
  chunked entry, `_ensureChunkedVolumeEntry` shared builder, working-set request
  variants, `drawOverlayChunked`, `overlayLayerMode` shader uniform/branch
  (`render.wgsl`, `renderShader.ts`, `volumeShaderLib.ts`), WebGPU
  `OVERLAY_CHUNK_PARAMS_BASE` uniform region.
- Views (`NVViewGPU.ts`, `NVViewGL.ts`): overlay request + draw per 3D tile.
- Demo: `createStreamedStatOverlay`, "stream hi-res" toggle, level split.

---

## 1 (original). Higher-res overlay + chunking support for overlays

The base volume already streams as chunks (residency manager, budget-fitting
level, center-first spiral). The **overlay** does not reach higher resolution:
the chunked-overlay path that exists today (`_updateOverlayChunks` ->
`orient.overlay2TextureChunked`, `wgpu/render.ts:1100`) reslices the overlay
**1:1 onto each base chunk** (`desc.texDims`, the base grid), and takes the
overlay `NVImage` **whole in memory**. So the overlay is doubly capped: detail
finer than the base grid is discarded at reslice, and the source can't itself
be a streamed pyramid.

**Decision (2026-06-04): independent hi-res pyramid.** The overlay streams its
own higher-resolution OME-Zarr/IIIF level — finer than the base — with:
- its own `ChunkPlan` (overlay grid, distinct from the base grid),
- its own `ChunkResidencyManager` working set + frustum / clip-plane culling,
- its own streaming chunk source (so it isn't whole-in-memory),
- ray-march sampling through the overlay's **own** transform (this breaks the
  current 1:1 base-chunk alignment — likely render overlay chunks as their own
  depth-aware draw cubes, mirroring how base chunks already render).

Must land on **both** backends (WebGPU + WebGL2) in the same change per the
parity rule.

Open questions to resolve when picking this up:
- How does the per-chunk upload path (`incremental per-chunk drawing upload`,
  commit `3708476`) generalize to a second streamed layer?
- Reuse the clip-plane-hidden chunk culling (`2794b17`) for the overlay's
  working set too.

Relevant prior commits: `4ccd024` (overlay on a streamed large volume),
`f3d2a93` (oriented microscopy overlay), `d6aab8f` (z-score stat-map overlay),
`5a20f9c` (stream a budget-fitting level).

## 2. Drawing on chunks, including exploded chunks — LARGELY DONE

Drawing now works on a chunked volume and on 3D exploded blocks.

Landed last session:
- `3708476` — incremental per-chunk drawing upload for large volumes
- `26b48c7` — drawing on a chunked volume (demo)
- `2919265` — draw directly on 3D exploded blocks
- `9df7e38` — explode + 3D draw in the drawing demo
- `793a061` — draw on exploded blocks with right-click, free left-drag rotate
- `089f1dd` — don't draw on exploded blocks the clip plane has hidden
- `b7064a1` — land exploded-block drawing on visible tissue, not air/clipped

Remaining: revisit once overlay chunking (item 1) lands, to confirm drawing
still composites correctly against a chunked overlay.

## 3. Leverage the clip plane in the chunk request strategy — DONE

The streaming working set now culls chunks the clip plane has hidden, so we
don't fetch/keep resident geometry that isn't visible.

Landed last session:
- `2a327df` — Phase 3a-3c chunk residency manager and visibility math
- `2794b17` — cull clip-plane-hidden chunks from the streaming working set

## Next action — performance (independent hi-res overlay)

Item 1 landed (commit `b4d68ea`, branch `feat/dicom-wsi-omezarr`). Next session:
make the independent hi-res overlay (and the chunked path generally) more
performant. Candidate areas:
- **Residency budget split** base/overlay (both managers currently use the full
  `maxChunkResidencyBytes`; in 3D both layers are all-resident so VRAM ~doubles).
- **L0 / large all-resident sets** in the 3D render thrash when the working set
  exceeds budget — the 3D tile needs every brick at once. Investigate progressive
  / lower-res-first streaming, or partial-resolution fallback while bricks load.
- **2D-slice independent-overlay rendering** (deferred follow-up) — would let the
  overlay stream only visible bricks, sidestepping the all-resident 3D limit.
- **Per-cube compositing** is a back-to-front approximation; a globally-merged
  base+overlay order would be more correct (and may interact with perf).
- Upload pump is 1 chunk/frame (`CHUNK_UPLOADS_PER_FRAME`); tune for faster fill.

Verify knobs in the overlay demo: `?level=N` (pin level, e.g. L0) and
`?budgetGB=N` (lift residency budget).
