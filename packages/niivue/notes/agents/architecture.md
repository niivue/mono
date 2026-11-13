# Architecture

Moved from `packages/niivue/AGENTS.md`; read it when working on the controller/model/view split, backend init and fallback, or to find a source file. Paths are relative to `packages/niivue`. A section named here but not found lives in another file of this folder (see the topic list in `AGENTS.md`).

## Architecture (MVC)

**Backend init fallback (both distribution):** `control/viewBoth.ts` `attachToCanvas`
tries the configured backend, then — when WebGPU was requested — falls back to WebGL2
if `init()` throws (e.g. `requestAdapter()` returns null because the browser's graphics
acceleration is off; note `navigator.gpu` can exist yet yield no adapter, so the
pre-init `enforceBackendAvailability` check isn't enough). The failed attempt may lock
the canvas's context type, so the fallback swaps in a fresh canvas via
`replaceCanvasElement` (now `oldCanvas.cloneNode(false)`, preserving width/height/
data-*/aria/tabindex; external listeners on the original canvas are NOT preserved).
A detached canvas (no `parentNode`) is kept unless the failed WebGPU attempt
locked its context; then it is cloned and the clone is published via `viewAttached`.
A backend switch, or an antialias change under WebGL2, clones a detached canvas too.
The fallback is declined for a SHARED canvas (`getCanvasInstances` size > 1) — replacing
it would desync sibling controllers — surfacing the overlay instead. Only `init()` is
fallback-eligible; post-init failures rethrow (a failed thumbnail only logs). On all-backends-fail,
`attachToCanvas` `unregister`s the controller and restores the originally requested
backend (so a later retry starts fresh), then `control/canvasMessage.ts`
(`showCanvasMessage` / `GRAPHICS_UNAVAILABLE_MESSAGE`) overlays a centered DOM message
with concrete fixes (enable hardware acceleration; or Chrome's
`#enable-unsafe-swiftshader`) and the error rethrows. The single-backend distributions
(`viewWebGPU.ts`/`viewWebGL2.ts`) have no fallback but show the same overlay on
failure. A DOM overlay is used (not canvas 2D) because a failed WebGPU/WebGL2
`getContext` can lock the canvas context type. The controller's `destroy()` clears
any overlay. (These `control/` lifecycle paths are DOM-dependent and browser-verified, not
unit-tested under the Bun harness.)

### Key source files

| File | Role |
|------|------|
| `NVControl.ts` | Controller — public API, reactive proxy groups, delegates to `control/` |
| `NVControlBase.ts` | Controller base — reactive proxy groups, all getters/setters/methods |
| `NVModel.ts` | Data model — 8 config groups, volumes, meshes, clip planes |
| `NVTypes.ts` | TypeScript interfaces (`NVImage`, `NVMesh`, config group types, `NiiVueOptions`) |
| `NVConstants.ts` | Runtime constants/enums + group defaults (`LAYOUT_DEFAULTS`, `UI_DEFAULTS`, etc.) |
| `NVDocument.ts` | Document save/load (NVD format, `NVD_DOCUMENT_VERSION`, CBOR-encoded) |
| `control/viewBoth.ts`, `viewSingle.ts`, `viewLifecycle.ts` | View lifecycle (attach, recreate, reinitialize) |
| `control/interactions.ts` | Event handling (mouse, keyboard, drag-drop, resize) |
| `control/dragModes.ts` | Drag mode handlers — contrast, measurement, angle, pan, windowing |
| `view/NVSliceLayout.ts` | Slice layout engine — mosaic, hero, multiplanar tile computation |
| `view/NVRenderVariant.ts` | Compile-time flags that specialize the volume ray-march shader per draw |
| `wgpu/NVViewGPU.ts` | WebGPU renderer with compute pipelines |
| `gl/NVViewGL.ts` | WebGL2 fallback (substantially complete) |
| `NVEvents.ts` | Event types — `NVEventMap`, typed `CustomEvent` dispatching |
| `annotation/` | Vector annotation system — shapes, clipping, undo/redo |

Both backends have matching render layers: `mesh`, `font`, `line`, `colorbar`, `orient`, `crosshair`, `thumbnail` — each in `wgpu/` and `gl/` directories. All render entities extend `NVRenderer` (`src/view/NVRenderer.ts`) with `init()` (stores GPU context, sets `isReady`), `draw()` (guarded by `isReady`), and parameterless `destroy()` (uses stored context). Stateless utilities remain module-level exports. WebGPU bind-group helpers are in `wgpu/pipeline.ts`; a pipeline bound to a single uniform buffer uses `uniformOnlyLayout` + `uniformBindGroup`. Shared GL plumbing is in `gl/glUtil.ts`: `createIndexedGeometry`/`uploadIndexed` for one interleaved float buffer plus uint32 indices, and `deleteGLObjects` for `destroy()`. GL mesh x-ray passes call `mesh.drawWithGpu` with `xray = true`; WebGPU bakes the depth test into pipelines, so it draws x-ray meshes with `meshXRayPipelines`. Backend-neutral CPU logic (layout, chunk fetch/prefetch, tile walks, bench timing) goes in a shared module under `view/`, `volume/` or `slide/` instead of being copied into `gl/` and `wgpu/`; e.g. `volume/chunkFetch.ts` serves both chunk uploaders, and `slide/tileGutter.ts` plans the slide tiles' seam-hiding 1-texel gutter that `gl/` and `wgpu/tileGutter.ts` execute.

```typescript
// Base class — shared lifecycle contract
export abstract class NVRenderer {
  private _isReady = false
  get isReady(): boolean { return this._isReady }
  protected set isReady(value: boolean) { this._isReady = value }
  abstract init(...args: unknown[]): void | Promise<void>
  abstract draw(...args: unknown[]): void
  abstract destroy(): void
  resize(..._args: unknown[]): void {}  // no-op default
}
```

Key conventions: `init()` stores the GPU context, `destroy()` is parameterless (uses stored context), `isReady` (public get, protected set) guards all draw calls.

**Colorbar layout:** The colorbar block allocator reads the actual rasterized font size via `ColorbarLayout.fontPx` (0 = unknown). Each backend's `resize` stores `fontRenderer.fontPx` in `_fontPx` on the shared `NVColorbarRenderer` base (`view/NVColorbarRenderer.ts`), whose `getLayout()` passes it on, so `resolveFontSize` can pick `max(actual, legacy)` — defaults keep the pre-audit look while a cranked-up `fontScale` grows the allocation to avoid overflow. Bottom cushion scales as `max(1, 0.1 * fontSize)`, and single-row colorbars no longer allocate a spurious trailing `gap`.

**Fonts (Unicode):**
- `src/view/NVFont.ts` parses atlases sparsely by Unicode code point, and `buildTextLayout` iterates strings by code point (not UTF-8 bytes), so CJK and other non-Latin glyphs render correctly when present in the atlas. Swap the active font at runtime via `nv1.setFont(nextFont)` for an in-memory atlas, or `nv1.setFontFromUrl({ atlas, metrics })` to fetch a PNG+JSON pair from URLs — both rebuild the view because the atlas texture is GPU-owned.
- The only bundled font is `ubuntu` (ASCII), re-exported from `src/assets/fonts/index.ts` and used as the default by `NVControlBase`. Community atlases (including CJK-capable fonts like Poem) live at `https://github.com/niivue/fonts` and are fetched on demand via `setFontFromUrl` — see `examples/font.html`. `scripts/generate-assets.js` writes one wrapper per `*.json` + `*.png` pair in `src/assets/fonts/` and regenerates the barrel.

**Remote assets (fonts, colormaps, matcaps):** The controller exposes URL-aware loaders so apps can pull assets from CDNs at runtime: `nv1.setFontFromUrl({ atlas, metrics })` (options-object — atlas/metrics can't transpose silently), `nv1.addColormap(name, cmap)` / `nv1.addColormapFromUrl(url, name?)` (registers a `{ R, G, B, A?, I?, labels? }` LUT visible to volumes, mesh layers, colorbars, connectomes, tracts; name derived from filename if omitted, dispatches `colormapAdded`), and the existing `nv1.loadMatcap(nameOrUrl)`. `model.volume.matcap` holds a URL, but `NVDocument` saves a matcap found in `opts.matcaps` by its name and `loadDocument` looks the name up again (`src/documentMatcap.ts`; the constructor, the `volumeMatcap` setter and `loadMatcap` use the same case-insensitive `matcapFromName`): a dev server serves a bundled JPG as a page path that 404s elsewhere, and a production build inlines it as a data URL that bloats every document. A matcap image that fails to load draws the instance default (first `opts.matcaps` entry), then white, with a warning. Cross-origin image loads go through `applyCORS(img)` in `src/NVLoader.ts`, which unconditionally sets `img.crossOrigin = 'anonymous'` before `img.src =` in the four image loaders (WebGPU `bitmap2texture`, WebGL2 matcap/thumbnail/font). This is spec-safe for same-origin, `blob:`, and `data:`, and enables GPU texture uploads from hosts like `raw.githubusercontent.com` — provided the server sends `Access-Control-Allow-Origin`.

**Multi-instance isolation:** Shared GPU modules use `WeakMap<GPUDevice|WebGL2RenderingContext, ...>` to cache resources per device/context. Their `destroy(device)` / `destroy(gl)` functions take the device/context parameter to clean up per-instance resources.

**Scene synchronization:** `broadcastTo(targets?, opts?)` syncs scene state between controller instances. `SyncOpts` controls granularity: `'3d'`, `'2d'`, `clipPlane`, `sliceType`, `calMin`, `calMax`. Uses `_syncDirty` flag to prevent bidirectional race conditions.

**Shared canvas (bounds):** Multiple instances can share a `<canvas>` via normalized `[[x1,y1],[x2,y2]]` bounds (`NVBounds` type, y=0 bottom, y=1 top). WebGL2 uses scissor-based clipping with `preserveDrawingBuffer: true`. WebGPU renders to intermediate textures then copies to canvas at bounds offset, with `SharedGPUContext` sharing device across instances. `control/canvasRegistry.ts` tracks siblings and the per-canvas viewport, shared by every lifecycle. `clientToBoundsPixel()` transforms full-canvas coords to bounds-local for hit testing.

**Future opportunity — WebGPU `clip-distances`:** a commented-out block in `src/wgpu/NVViewGPU.ts` (just above `requestDevice`) sketches a hardware-accelerated mesh clip plane path gated on the `clip-distances` feature. Adapter support is still patchy (notably Safari), so the code is parked. Activation guidance lives next to the block.

**Known issue — Safari WebGPU with MSAA:** WebKit's WebGPU (Safari, every iOS browser) runs the fragment shader once per MSAA sample, so `isAntiAlias: true` makes the volume ray-march about 4x slower (#381). It is still present in Safari Technology Preview 255 (November 2026). WebGL2 MSAA has no such cost, so `isAntiAlias` defaults to `true` and core pages default to the WebGL2 backend. Core does not detect WebKit: a page that picks `backend: 'webgpu'` (or imports `@niivue/niivue/webgpu`, whose default backend is WebGPU) without `isAntiAlias: false` (e.g. `examples/cinematic/`) hits the slowdown on WebKit. We work around it rather than splitting the volume into a single-sample pass: the demos that default to WebGPU (the slide examples, `apps/demo-ext-tile/src/main.ts`, `range.js`, `ome.zarr.js` and `vox.block.pick.zarr.js`, `apps/dandi-demo/src/dandi.js`, and the `bounds`, `ome.tiff`, `vox.block.pick`, `vox.draw.explode`, `vox.events`, `vox.gestures`, `vox.gradopacity.explode` and `vox.min.webgpu` examples) and the example pages with an AntiAlias checkbox (`backend`, `dev`, `vox.draw`, `vox.tiled`) turn anti-aliasing off on WebKit, on both backends as `slides.js` does; `?aa=on|off` overrides in the slides, demo-ext-tile, range and dandi demos. Other pages with a WebGPU switch keep the default, so switching them to WebGPU on WebKit runs with MSAA. Retest every couple of months, comparing `isAntiAlias: true` against `false` on the WebGPU backend; once Safari is fixed, remove those WebKit checks. `SlideRendererGPU.create(canvas, { antialias })` (`src/wgpu/slide.ts`) draws into a 4x multisample target resolved to the canvas; the slides demo and demo-ext-tile pass their Anti-alias setting to both renderers.
