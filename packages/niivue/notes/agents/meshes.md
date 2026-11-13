# Meshes

Moved from `packages/niivue/AGENTS.md`; read it when working on meshes, tracts, connectomes, mesh layers or mesh shaders. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Three mesh species

Discriminated by `kind: MeshKind`. All share GPU pipeline (`positions`/`indices`/`colors`) but differ in source data:

| Species | `kind` | Source field | Dynamic? |
|---------|--------|-------------|----------|
| Triangulated mesh | `'mesh'` | `mz3` | No |
| Tract/streamline | `'tract'` | `trx` | Yes (radius, sides, decimation) |
| Connectome | `'connectome'` | `jcon` | Yes (node/edge scale, thresholds) |

Exactly one of `mz3`, `trx`, `jcon` is non-null per mesh. Source data is immutable; only derived GPU arrays change. VTK files use `probeVTKContent()` for content-based dispatch (LINES→tract, POLYGONS→mesh).

## Mesh layers (scalar overlays)

CPU-composited scalar overlays on meshes. `perVertexColors` (nullable `Uint32Array`, packed ABGR) preserves file-provided vertex colors for recompositing; null for uniform-color meshes. Layer readers in `mesh/layers/readers/` (CURV, SMP, STC) plus fallthrough to mesh/volume readers. Layers only apply to `kind === 'mesh'`; tract/connectome coloring happens during tessellation/extrusion.

## Mesh shaders

Fragment shaders in `gl/meshShader.ts` (GLSL) and `wgpu/mesh.wgsl` (WGSL): phong, flat, matte, toon, outline, rim, silhouette, crevice, vertexColor, crosscut. Selected per-mesh via `shaderType`. Vertex layout: interleaved `BYTES_PER_VERTEX` bytes (pos `float32x3` + normal `float32x3` + color `unorm8x4`), defined in `mesh/vertexFormat.ts` with the one mesh packer, `packMeshVertices`, and the color encoding, `packColor`. The crosshair cylinder and the orientation cube still pack their own vertices, and the attribute offsets are still literals (#304).

**Normals** are not read from mesh files; `mesh/normals.ts` derives them.
`generateNormals` sums each triangle's unnormalised (area-weighted) cross product
into a `Float32Array`, then negates and normalises (zero sums stay zero); keep the
accumulator type and operation order, which `normals.test.ts` pins bit for bit
against the original. `packMeshVertices` (every upload and live update) calls
`meshNormals(mesh)`, which caches per mesh object in a `WeakMap`. Contract:
normals are recomputed only when `positions` or `indices` is replaced with a new
array or `_positionsVersion` changes; for a version change they are rewritten
into the cached array (`generateNormals(pts, tris, out)`), so live updates do not
allocate. Any other in-place edit of `positions` keeps the cached normals: replace
the array or call `updateMeshPositions`.

**Crosscut shader** (`shaderType: 'crosscut'`): Renders crosshair-aligned ribbons using `fwidth()`-based screen-space line width. Unique render state: **no depth test, no face culling**. `crosscutMM` uniform computed by `view/NVCrosscut.ts`.

**Crosscut2 shader** (`shaderType: 'crosscut2'`): outlines the mesh where it
meets the DISPLAYED voxel plane (`tile.planeNormal`/`planePoint`, oblique when
the background volume is), not a world plane, so the contour holds still while
the crosshair moves within an oblique slice (#92). Built in the vertex stage,
not fragments, because an edge-on surface (the medial wall on an axial slice)
rasterizes to nothing: one instance per triangle of each crossing cluster, six
vertices; the vertex stage intersects the triangle with the plane and expands
the segment into a screen-space quad, or collapses it when the triangle misses.
Planes come from `view/NVCrosscut.crosscutPlanes` as a mat4 uniform (columns
0-2 `[n, d]`, column 3 `[tileW, tileH, widthPx, count]`; 2D tile: its plane; render tile: the
three voxel planes through the crosshair; no volume: world axes). Width is
`mesh.crosscutWidth` (`meshCrosscutWidth`) device px, which also sets the old
`crosscut` ribbon width (#91); width <= 0 draws nothing on both shaders.
`clampCrosscutWidth` clamps it in the setter, the constructor and document
load.

Culling (`mesh/triangleClusters.ts`): triangles are sorted along a Morton curve
of their centroids and grouped `CLUSTER_SIZE` (64) at a time, one bounding box
each; per tile the CPU lists the clusters each plane crosses
(`cluster | plane << PLANE_SHIFT`) and only those are drawn. Why 64: on a pial
surface a plane crosses ~11% of clusters (21% at 256, 7% at 32), and the CPU
bounds test is linear in cluster count.

Data: `mesh.indices` in the model keeps file order; the CPU keeps only a
permutation (4 B/tri) plus bounds. Both backends upload a separate
cluster-ordered index copy (12 B/tri) and never rewrite the mesh's own index
buffer: translucent 3D blending depends on triangle order (an audit caught
WebGPU rewriting it in place; pinned by the `crosscut2-translucent` scene of `e2e/render-mesh.spec.ts`). The copy is padded to whole clusters with
degenerate triangles, so shaders need no bounds check. `meshClusters` cache:
new `indices`/`positions` arrays rebuild; a `_dataVersion` change rebuilds only
if an FNV-1a hash of the indices changed (color/layer edits bump it too);
`_positionsVersion` refreshes bounds only; any other in-place `positions`
edit is unsupported (call `updateMeshPositions` or `updateGLVolume`). `updateGLVolume()` drops every
mesh's clusters (`clearMeshClusters`), since its callers edit in place without
bumping either token (a second audit caught stale bounds there).

WebGPU: group 1 binds the vertex buffer (created with STORAGE usage), the index
copy and the cluster list, which has one 256-aligned region per tile slot
selected by dynamic offset (all `writeBuffer`s land before the pass runs).
`crosscut2Gpu` builds these lazily inside the draw; safe because clusters and
tile count are fixed within a frame, so only a mesh's first draw of a frame can
replace buffers. `override clusterSize/planeShift` are set from the TS
constants. WebGL2: vertex words in an R32UI texture copied GPU-side from the
vertex buffer via PIXEL_UNPACK_BUFFER, indices in another R32UI texture (one
helper, `uploadWordTexture`; NEAREST required or `texelFetch` reads 0); the
cluster list is attribute 0 with divisor `CLUSTER_SIZE` (attribute 0 must be
enabled or desktop GL emulates it and Firefox warns). GLSL ES 3.00 lacks
`unpackUnorm4x8`, so colors are unpacked by hand. Drawn with the tile's full
MVP (it outlines the voxel plane itself, so a slab would only clip it),
no depth test, skipped in the x-ray pass.

Limits: a mesh too large warns once and draws nothing. On WebGPU the cluster
list (one region per tile) must also fit `maxBufferSize`; a mesh that does not
fit this many tiles warns once ('crosscut2: mesh is too large for this many
tiles') and skips its outline until the tile count drops. WebGPU is bounded by
`maxStorageBufferBindingSize` (default 128 MiB, ~4.8M vertices), WebGL2 by
MAX_TEXTURE_SIZE^2 words (~38M vertices at 16384, ~2.4M at 4096), so the
backends can differ on huge meshes.

Cost (M4 Pro, 3 slice tiles 1024^2, 8x rh.pial = 2.4M tris): WebGL2 26.3 ms
unculled -> 2.4 ms culled (old crosscut 4.4); WebGPU 19.3 -> 1.9 ms (old
crosscut 4.7). Memory, only for meshes drawn with crosscut2: WebGPU +12 B/tri
index copy; WebGL2 vertex copy 28 B/vertex + index copy 12 B/tri.

Tests: the `crosscut2-*` scenes of `e2e/render-mesh.spec.ts` (oblique stability, edge-on surface,
in-place index edit + `updateGLVolume`, translucent 3D unchanged),
`src/loadDocument.clamp.test.ts` (width clamp in constructor and document),
`src/mesh/triangleClusters.test.ts`, `src/NVConstants.test.ts`
(`clampCrosscutWidth`).

Known follow-ups:
- WebGPU per-tile mesh uniform offset `i * 256` has no `MAX_TILES` (128)
  guard: a mosaic with >128 tiles (>64 with x-ray) fails `writeBuffer`
  validation for every mesh shader. Pre-existing; needs an issue.
- The old `e2e/live-data-updates.spec.ts` "isDirty edits of a chunked volume
  re-stream its bricks (webgpu)" flaked under parallel workers: it counted
  pixels until two frames agreed. Its successor, the `chunked-dirty` scene of
  `e2e/render-updates.spec.ts`, waits for `whenChunkStreamSettles`; watch it
  for the same flake.
- Optional: bundle `drawWithGpu`'s per-tile crosscut args into one object next
  time a parameter is added.

**Per-mesh slice shader split** (`sliceShaderType`, default `''`): selects the mesh
shader for 2D slice tiles independently of the 3D render view. Empty string means
"inherit `shaderType`" (slices yoked to the render shader); a non-empty name (e.g.
`'crosscut'`) draws a different shader on slices — e.g. crosscut ribbons on slices
while the render panel stays phong (see `examples/freesurfer.crosscut.html`). Both
backends pick the shader per tile via an `isSlice` flag from `tile.axCorSag`
(true for AXIAL/CORONAL/SAGITTAL, false for the RENDER tile), in both the main and
x-ray mesh passes. `setMesh` validates it (empty = inherit; only a non-empty value
is checked against `getAvailableShaders()`), the view layer falls back to
`shaderType` on an unknown name, and it is serialized in NVDocument alongside
`shaderType`. The mesh shaders pin attribute locations (`layout(location=0/1/2)` in
`gl/meshShader.ts`) so the single per-mesh VAO is safe to draw with any mesh
program (slice override, x-ray, depth pick) by construction.

**Mesh slab on 2D slices** (`mesh.thicknessOn2D`, default `Infinity`): a finite positive value draws only mesh within that many mm of the DISPLAYED voxel plane (`tile.planeNormal`/`planePoint`, oblique when the volume is; a world plane through the crosshair without a volume), over the slice. 0 or Infinity draws the tile MVP: everything in front of the slice, the slice hiding the rest. `NVSliceLayout.meshSlabMvp` builds it: `NVTransforms.slabMvp` keeps the tile MVP's x/y rows and replaces its depth row with signed distance from the plane, so near/far clip at ±T along the plane normal (one affine matrix, no shader change). Both views draw it into the depth range [0, `SLAB_DEPTH_MAX`] (`gl.depthRange` / `setViewport`): clipping precedes that mapping, and the slice's own depth is >= 0.16, so the slab lands over it while meshes still occlude each other; the mesh x-ray pass draws in the same range. Issue #451. Demo `examples/tract.shear.html`; tests: the `mesh-slab` and `mesh-xray` scenes of `e2e/render-mesh.spec.ts`, `src/math/NVTransforms.test.ts` (`slabMvp`).
