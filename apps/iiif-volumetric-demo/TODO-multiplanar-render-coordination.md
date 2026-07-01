# TODO: Multiplanar → 3D render coordination (WYSIWYG clip)

Status: **PARTIALLY DONE & COMMITTED.** Holes and box-bleed are fixed. The one
remaining item is crosshair-centred render framing (see "REMAINING" below).

Branch: `feat/iiif-volumetric-server`.

## Goal

In multiplanar view, the 3D render quadrant should show **only what the zoomed 2D
slices capture** (WYSIWYG). Pan/zoom the 2D slices → the 3D render clips to that
world sub-box and frames it.

## Done (committed)

1. **Plan filtered to the visible box** (`omezarr.ts` `buildMultiLodPlan`): in
   multiplanar with 2D zoom > 1, keep only bricks intersecting the box
   `commonShape/zoom` centred on `lastFocusFrac`. Zoom 1 → no clip. Tighter focus
   radius `diagonal/(2*zoom)` so only the box is forced finest.
2. **Render framing zoom** (`applyMultiplanarZoom`): `scaleMultiplier = zoom` so
   the 3D camera magnifies with the 2D slices.
3. **niivue: true-orthographic zoom** (`math/NVTransforms.ts`
   `calculateMvpMatrix`): only the frustum extent (l/r/t/b) shrinks with zoom;
   camera distance + near/far stay tied to the UNZOOMED extent (`baseScale`), so
   the camera never enters the cube → fixes the empty-space/holes that appeared
   when zooming past ~1.4x. Byte-identical at zoom 1. Both backends (shared fn).
4. **niivue: focus/LOD box lines clipped to the render tile**
   (`view/NVSliceLayout.ts` `buildFocusBoxLines` + `clipSegmentToRect`): the line
   renderer draws full-canvas, so a magnified box used to bleed its edges across
   the 2D slice tiles. Now Liang-Barsky-clipped to the tile rect.

## REMAINING (the committed caveat)

The correct bricks load, but the render frames around the **volume centre** (the
global transform), so an **off-centre** zoomed region renders partly OFF-SCREEN.
Next step: **rebase the render origin on the crosshair** — centre the 3D render on
the focus box instead of the volume centre.

Plan: use `scene.renderPan` (a clip-space/NDC post-projection translation; see the
renderPan block in `calculateMvpMatrix`). Demo-side: project the box-centre mm
through the current render MVP to NDC, set `renderPan = -(ndc.x, ndc.y)` so the
box centres in the tile. Needs the render MVP — either reconstruct from
azimuth/elevation/scaleMultiplier/pivot/furthestFromPivot, or add a small niivue
helper that projects an mm point to render NDC. Recompute on zoom/crosshair change
(same debounce as the plan rebuild).

## Deferred (separate)

Exact pixel-WYSIWYG edge: replace the brick-granular plan filter with a real
render clip-**BOX** (an AABB the ray-march trims `sampleRange` to) in both shaders
(`wgpu/render.wgsl` + `gl/renderShader.ts`). Current edge is brick-granular
(overshoots ~1 brick). Alternative: 6 axis-aligned clip planes (`MAX_CLIP_PLANES =
6`, AND-combined in `clipSampleRange`) — but conflicts with the clip-plane drag UI.

Cutaway-clip iteration budget (latent, both backends): in `clipMode == 2`
(cutaway) the fine ray-march loop in `rayMarchPass` (`gl/renderShader.ts` ~L98,
`wgpu/render.wgsl` ~L73) steps through the cut-out interval `[clipLo, clipHi]` at
fine resolution via `clipPassSkip` + `continue`, so a large hole can exhaust the
2048-iteration cap inside the skipped region and truncate valid geometry behind
the cut. Fix = advance `samplePos` directly past `clipHi` on entering the hole
instead of stepping through it (solid mode already breaks at `clipHi`). ~2 lines
each backend, parity-preserving.

## Client-only / NVSlide feature backlog

Context: feature-gap scan against local Neuroglancer (`ac71c2a`) and Napari
(`7c24e4a`) checkouts after loading `pawpawsaurus` in all three viewers. These
are planning items; do not mark complete until implemented and verified in both
WebGL2 and WebGPU where rendering is involved.

### Highest priority

- [ ] Generalize the client-only source pipeline:
  `source -> metadata -> multiscale levels -> chunks/tiles -> fetch/decode/cache`.
  Keep OME-Zarr volumes, DICOM-WSI tiles, and future slide/volume adapters behind
  one small runtime model instead of page-specific loaders.
- [ ] Add a Neuroglancer-style chunk/tile scheduler with explicit request states:
  pending, downloading, decoded/system memory, GPU resident, failed, and evicted.
  Include stale-request cancellation via `AbortController`.
- [ ] Add priority and prefetch policy:
  visible working set first, view-centre first, optional neighborhood prefetch,
  and lower priority for off-screen or stale levels.
- [ ] Unify and expose existing memory budgets across the client-only runtime:
  volume GPU residency already has byte budgets + LRU eviction, and `NVSlide`
  already has a bounded `ImageBitmap` cache. Fill remaining gaps for decoded CPU
  bytes, shared stats, and consistent budget controls across volumes/slides.
- [ ] Make client-only viewer state serializable:
  dataset URL/manifest, selected level, backend, layout/render mode, camera,
  contrast/window, colormap, slide/volume opacity, and spatial transforms.

### Data format compatibility

- [ ] Expand OME-Zarr support beyond the current POC path:
  Zarr v2 and v3 detection, OME multiscales, `coordinateTransformations`,
  dimension names, units, and robust dtype handling.
- [ ] Investigate Zarr v3 `sharding_indexed` and codec coverage (`bytes`, `zstd`,
  `blosc`, `gzip`, `transpose`) so hosted stores do not require preprocessing.
- [ ] Keep DICOM-WSI client-only loading manifest-based for now, but document the
  exact manifest contract and server requirements.
- [ ] Consider adapters for Neuroglancer Precomputed and DeepZoom after the
  OME-Zarr/DICOM-WSI path is stable.

### Layer and transform model

- [ ] Promote `NVSlideSpatialTransform` into a first-class transform object with
  `pixelToWorld`, `worldToPixel`, units, and validation helpers.
- [ ] Define a small layer model inspired by Napari:
  volume, slide, labels/annotations, mesh/surface, with visibility, opacity,
  blending, transforms, and metadata.
- [ ] Integrate `NVSlide` rendering into the NiiVue render cycle so slides can be
  rendered standalone or registered onto a base image/volume.
- [ ] Add client-only annotations that can live in slide pixels and/or mapped
  world space: points, polylines, polygons, labels, and measurement overlays.

### Rendering and UX parity

- [ ] Keep WebGL2/WebGPU parity for tile and chunk rendering, including shader
  controls and visual output.
- [ ] Add apples-to-apples comparison fixtures:
  same source, same level, same camera, same contrast/window, same render mode
  across NiiVue, Neuroglancer, and Napari.
- [ ] Expose render controls comparable to the other tools where useful:
  MIP/translucent/iso modes, interpolation, gamma, clipping planes/clip box,
  opacity, and colormap/window presets.
- [ ] Preserve the current client-only diagnostics:
  range status, request counts, cache hits/bytes, decoded bytes, GPU residency,
  failures, and recent requests.

## Resume checklist

- Pre-finish gate before any push (AGENTS.md): `nx affected -t format lint
  typecheck test build` + codespell (CI ignore list includes `LOD`) +
  `check-boundaries`.
- Keep WebGPU/WebGL2 parity if the fix touches shaders.
- See also the project memory note `multilod-volumetric`.
