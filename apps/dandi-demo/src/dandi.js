// Two views of ONE DANDI Archive OME-Zarr store, streamed straight from S3.
//
// The point of the demo is the shared seam. `fetchOmeZarrChunkedSource` opens a
// dandiset's OME-Zarr pyramid once and returns a `ChunkedVolumeSource`; that one
// object then feeds BOTH panes:
//
//   left   nv.loadChunkedVolume(source)          multi-LOD volume rendering
//   right  NVSlide.fromSource(                   deep-zoom of one plane
//            new VolumeSliceSource(source, ...))
//
// Because it is the same source instance, both panes share one zarrita byte
// cache: a brick the volume view already pulled is free for the slide view, and
// the other way round. Nothing is downloaded whole -- a 17 GB light-sheet store
// opens as fast as a 100 MB one, because only the visible bricks and tiles are
// fetched.
//
// Both panes run on WebGPU; add `?backend=webgl2` for WebGL2, `?aa=on|off` to
// override the anti-aliasing default.
//
// Caveat worth knowing (and shown in the HUD): a volumetric pyramid is chunked
// CUBICALLY, so reading one plane at the finest level decodes a whole slab of
// 64^3 or 128^3 chunks and throws most of it away. Coarse levels are cheap; the
// finest level of a gigavoxel store is not. The tile size is aligned to the
// store's own chunk grid so neighbouring tiles at least share decodes.

import NiiVue, {
  lookupColorMap,
  NVSlide,
  NVSlideController,
  SLICE_TYPE,
  SlideRenderer,
  SlideRendererGPU,
  slideOverlayContent,
  VolumeSliceSource,
} from '@niivue/niivue'
import { fetchOmeZarrChunkedSource } from '@niivue/nv-ext-tile/zarr'
// The crosshair marker is a UIKit widget: the slide renderers expose the same
// `overlayDraw` hook a NiiVue canvas does, so it composes onto the standalone
// deep-zoom pane exactly as it does there.
import { loadDefaultFont, UIKitCrosshairOverlay } from '@niivue/uikit'

const params = new URLSearchParams(location.search)
// Resolved up front: without a WebGPU adapter NiiVue falls back to WebGL2,
// which needs WebGL2's smaller streaming budget (DEFAULT_RESIDENCY_BYTES).
const backend =
  params.get('backend') !== 'webgl2' &&
  (await navigator.gpu?.requestAdapter().catch(() => null))
    ? 'webgpu'
    : 'webgl2'
// WebKit (Safari, and every iOS browser) misrenders WebGPU with anti-aliasing
// on, so it defaults off there and on elsewhere.
const isWebKit =
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent) // iOS Edge (EdgiOS) is WebKit
const isAntiAlias = params.has('aa') ? params.get('aa') === 'on' : !isWebKit

// DANDI serves every zarr asset from one public, CORS-enabled bucket, keyed by
// the asset's zarr id -- no API call and no credentials needed to stream one.
// ?local reads a copy synced into public/zarr/<zarrId> instead (development):
//   aws s3 sync --no-sign-request s3://dandiarchive/zarr/<zarrId> public/zarr/<zarrId>
const DANDI_ZARR = params.has('local')
  ? new URL('zarr', location.href).href.replace(/\/$/, '')
  : 'https://dandiarchive.s3.amazonaws.com/zarr'

// Verified live (shape / chunks / dtype read from each level's .zarray). Both
// dandisets are CC-BY-4.0; the credit line is rendered in the page footer.
const DATASETS = {
  // Served by the dev-images Vite plugin (dev server only): the OCT stores'
  // geometry, generated on localhost, for iterating without waiting on S3.
  synthetic: {
    label: 'Synthetic gyroid, 301^3 float32',
    zarrId: 'synthetic-v1',
    url: '/tiles/synthetic-v1.ome.zarr/',
    size: '106 MB, generated locally',
    axis: 'z',
  },
  'synthetic-oct': {
    label: 'Synthetic gyroid, 1716 x 1470 x 561 float32',
    zarrId: 'synthetic-oct-v1',
    url: '/tiles/synthetic-oct-v1.ome.zarr/',
    size: '4.5 GB, generated locally',
    axis: 'z',
  },
  oct: {
    label: '000722 human brain OCT',
    zarrId: 'acffe53b-4849-4cc2-a01d-06e424896745',
    dandiset: '000722',
    asset: 'sub-I46/micr/sub-I46_sample-somatosensory_chunk-01_OCT.ome.zarr',
    size: '4.5 GB',
    // Serial-section OCT of somatosensory cortex: 20 um isotropic, float32
    // reflectivity, six levels, 64^3 chunks.
    axis: 'z',
    credit:
      'Chollet, Etienne; Yael Balbastre; Mauri, Chiara; Magnain, Caroline; ' +
      'Fischl, Bruce; Wang, Hui (2024). sOCT of the Human Somatosensory ' +
      'Cortex and Vessel Segmentation. DANDI archive, CC-BY-4.0.',
  },
  'oct-small': {
    label: '000722 OCT, small block',
    zarrId: '2aedcf87-6903-4080-9ccc-c17f1f13bc82',
    dandiset: '000722',
    asset: 'sub-I46/micr/sub-I46_sample-somatosensory_chunk-02_OCT.ome.zarr',
    size: '106 MB',
    axis: 'z',
    credit:
      'Chollet, Etienne; Yael Balbastre; Mauri, Chiara; Magnain, Caroline; ' +
      'Fischl, Bruce; Wang, Hui (2024). sOCT of the Human Somatosensory ' +
      'Cortex and Vessel Segmentation. DANDI archive, CC-BY-4.0.',
  },
  neun: {
    label: '000026 SPIM NeuN slab',
    zarrId: 'c3418ed4-de7e-4c37-9bab-f7da215f90e7',
    dandiset: '000026',
    asset:
      'sub-I45/ses-SPIM/micr/' +
      'sub-I45_ses-SPIM_sample-BrocaAreaS35_stain-NeuN_SPIM.ome.zarr',
    size: '30.5 GB',
    // 207 x 10693 x 10915 uint16 at 3.6 um: a thick SECTION rather than a block,
    // so one z plane is a 117 megapixel image -- the largest tile set here, and
    // the closest thing in DANDI to a classic whole-slide scan. The pyramid is
    // anisotropic (z is never downsampled, xy halves five times), which both the
    // slide manifest and the multi-LOD planner map per axis.
    axis: 'z',
    credit:
      'Mazzamuto, Giacomo; Costantini, Irene; Pavone, Francesco Saverio; ' +
      'Hof, Patrick R.; Boas, David A.; Fischl, Bruce; et al. (2025). Human ' +
      'brain cell census for BA 44/45. DANDI archive, CC-BY-4.0.',
  },
  hipct: {
    label: '000026 HiP-CT block',
    zarrId: '5c37c233-222f-4e60-96e7-a7536e08ef61',
    dandiset: '000026',
    asset: 'sub-I58/ses-Hip-CT/micr/sub-I58_sample-01_chunk-01_hipCT.ome.zarr',
    size: '1.0 TB',
    // Hierarchical phase-contrast tomography, 10656 x 9413 x 9413 uint16 at
    // 15.13 um isotropic. A terabyte that opens in a second: nearly cubic, so
    // it is the one store here that is large in BOTH panes at once. Its coarsest
    // level (666 x 588 x 588) is past the core's coarse-floor cap, so the
    // volumetric pane starts empty and fills as bricks arrive instead of
    // fading up from a whole-volume fallback.
    axis: 'z',
    credit:
      'Mazzamuto, Giacomo; Costantini, Irene; Pavone, Francesco Saverio; ' +
      'Hof, Patrick R.; Boas, David A.; Fischl, Bruce; et al. (2025). Human ' +
      'brain cell census for BA 44/45. DANDI archive, CC-BY-4.0.',
  },
  spim: {
    label: '000108 light-sheet SPIM',
    zarrId: 'f7e3a560-c4a6-4652-b8c8-66afe580e4cb',
    dandiset: '000108',
    asset:
      'sub-MITU01/ses-20210521h17m17s06/micr/' +
      'sub-MITU01_ses-20210521h17m17s06_sample-52_stain-YO_run-1_chunk-9_SPIM.ome.zarr',
    size: '17.7 GB',
    // 42371 x 2048 x 2048 uint16 strip. A z plane is a 20:1 ribbon, so the
    // deep-zoom pane defaults to a sagittal (x) plane: a square 2048^2 section.
    axis: 'x',
    credit:
      'Kamentsky, Lee; Marx, Slayton; Park, Juhyuk; Su-Arcaro, Clover; ' +
      'Moukheiber, Mira; Zhao, Victor (2023). Light sheet imaging of the ' +
      'human brain. DANDI archive, CC-BY-4.0.',
  },
}

// VRAM ceilings, the same split range.js uses: a WebGL2 context dies long before
// a WebGPU one does, so the residency cap has to be much smaller there.
const MULTILOD_BUDGET_BYTES = 2048 * 1024 * 1024
const DEFAULT_RESIDENCY_BYTES =
  backend === 'webgpu' ? 8192 * 1024 * 1024 : 1280 * 1024 * 1024
// Store-level byte cache shared by both panes (raw zarr chunk responses).
const ZARR_CACHE_BYTES = 512 * 1024 * 1024
// Disk budget for the cross-session tier. Every other cache here dies with the
// tab; this one survives it, so a reload of a dataset already visited streams
// from the local disk instead of S3. It is bounded, LRU, and clearable from the
// console with `clearPersistentByteCaches()`.
const ZARR_PERSIST_BYTES = 512 * 1024 * 1024
const SLIDE_CACHE_BYTES = 192 * 1024 * 1024
// Rebuilding the slide is cheap but it drops in-flight tiles, so a crosshair
// DRAG should not rebuild it once per mouse move.
const PLANE_DEBOUNCE_MS = 140
const AXIS_INDEX = { x: 0, y: 1, z: 2 }
const PLANE_AXES = { x: [1, 2], y: [0, 2], z: [0, 1] }
const AXIS_NAME = ['x', 'y', 'z']

// The volumetric pane opens on the 3D render: it is the view that shows a
// streamed brick set arriving as a whole, and the one the zoom slider drives.
// The slice views stay one dropdown away for anyone who wants to read a plane.
// Render-only hands the whole pane to the volume, where 1.00x leaves a rotated
// cube's corners hanging off the edges. 0.80x frames the extent with a margin.
const DEFAULT_3D_ZOOM = 0.8

const VIEWS = {
  render: SLICE_TYPE.RENDER,
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
}

function el(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node
}

const els = {
  backendSelect: document.getElementById('backendSelect'),
  aaSelect: document.getElementById('aaSelect'),
  slideFilter: el('slideFilter'),
  dataset: el('dataset'),
  axis: el('axis'),
  plane: el('plane'),
  planeVal: el('planeVal'),
  follow: el('follow'),
  view: el('view'),
  detail: el('detail'),
  plan: el('plan'),
  swap: el('swap'),
  colormap: el('colormap'),
  window: el('window'),
  zoom: el('zoom'),
  zoomVal: el('zoomVal'),
  fit: el('fit'),
  volumePrimary: el('volumePrimary'),
  volumeSecondary: el('volumeSecondary'),
  slidePrimary: el('slidePrimary'),
  slideSecondary: el('slideSecondary'),
  crosshair: el('crosshair'),
  canvas: el('nv-canvas'),
  slideCanvas: el('slide-canvas'),
  volBusy: el('volBusy'),
  volBusyLabel: el('volBusyLabel'),
  volHud: el('volHud'),
  slideBusy: el('slideBusy'),
  slideBusyLabel: el('slideBusyLabel'),
  slideHud: el('slideHud'),
  fallback: el('fallback'),
  provenance: el('provenance'),
}

// The backend menu reloads with ?backend=, since the page builds its
// renderers once (#488). Wired before anything loads, so it works even if
// loading fails.
// Anti-aliasing is a context attribute, fixed when the view is created, so it
// reloads the same way.
function reloadWith(key, value) {
  const url = new URL(location.href)
  url.searchParams.set(key, value)
  location.href = url.href
}
els.backendSelect.value = backend
els.backendSelect.onchange = () =>
  reloadWith('backend', els.backendSelect.value)
els.aaSelect.value = isAntiAlias ? 'on' : 'off'
els.aaSelect.onchange = () => reloadWith('aa', els.aaSelect.value)

let nv = null
let slideView = null
// Monotonic: a dataset switch bumps it so a superseded load's async tail is
// discarded instead of installing itself over the newer scene.
let loadToken = 0
let chunkSource = null
let activeCv = null
let slide = null
let slideFrame = 0
let slideFitted = false
let planeIndex = 0
let planeTimer = 0
// Null until a dataset load resolves one. NVChunkedVolume derives a 2%-98%
// window from the coarse floor it builds anyway, so the demo reads the window
// back off the volume instead of paying for a probe fetch of its own.
let windowRange = null
let slideInput = null
// The plane source behind `slide`, for the contrast box's intensity read.
let sliceSource = null
let crosshair = null
// The volume pane's crosshair, in RAS voxels, mirrored into the slide pane. Held
// in voxels rather than screen pixels: a level swap must not move it.
let crosshairVox = null

// ---------------------------------------------------------------- utilities

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatValue(value) {
  const magnitude = Math.abs(value)
  if (magnitude === 0) return '0'
  if (magnitude < 0.01 || magnitude >= 1e5) return value.toExponential(2)
  return value.toFixed(magnitude < 1 ? 4 : 1)
}

function showFallback(message) {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function clearFallback() {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

// A 256-entry opaque RGBA ramp for the slide tiles, built from the same named
// colormap the volumetric pane uses so the two panes agree on colour. The core
// LUT builder is not part of the public surface, so this is the demo's own
// (equivalent) interpolation; alpha is forced opaque because a slide tile is
// the whole image, not an overlay.
function slideLut(name) {
  const lut = new Uint8Array(1024)
  const cmap = lookupColorMap(name)
  if (!cmap?.I || cmap.I.length < 2) {
    for (let i = 0; i < 256; i++) {
      lut[i * 4] = i
      lut[i * 4 + 1] = i
      lut[i * 4 + 2] = i
      lut[i * 4 + 3] = 255
    }
    return lut
  }
  const { R, G, B, I } = cmap
  for (let k = 0; k < I.length - 1; k++) {
    const lo = I[k]
    const hi = I[k + 1]
    const span = hi - lo || 1
    for (let j = lo; j <= hi && j < 256; j++) {
      const f = (j - lo) / span
      lut[j * 4] = Math.round(R[k] + f * (R[k + 1] - R[k]))
      lut[j * 4 + 1] = Math.round(G[k] + f * (G[k + 1] - G[k]))
      lut[j * 4 + 2] = Math.round(B[k] + f * (B[k + 1] - B[k]))
      lut[j * 4 + 3] = 255
    }
  }
  return lut
}

function parseWindow(text, fallback) {
  const parts = String(text)
    .split(',')
    .map((part) => Number(part.trim()))
  if (parts.length !== 2 || !parts.every(Number.isFinite)) return fallback
  return parts[0] < parts[1] ? parts : fallback
}

// The finest-level voxel counts along each display axis.
function shape() {
  return chunkSource ? chunkSource.levels[0].shape : [1, 1, 1]
}

// The store's own chunk edge, in DISPLAY axis order. Aligning the slide tiles to
// it means two neighbouring tiles never decode the same chunk twice.
function displayChunkShape() {
  const { arrays, indices, order } = chunkSource.zarr
  const chunks = arrays[0].chunks
  const at = (position) =>
    position < 0 ? 1 : chunks[indices.spatial[position]]
  return [at(order.x), at(order.y), at(order.z)]
}

// For a CHUNK-ALIGNED tile the decoded bytes work out to `edge^2 * chunkDepth *
// bytesPerVoxel` -- the tile area times the chunk extent along the plane normal.
// So pick the largest aligned edge that stays inside a per-tile decode budget.
// The bytes fetched for a given screen area are the same whichever edge wins
// (the chunk is the atom either way); a smaller tile just splits them into more,
// smaller pieces, so the pane fills progressively instead of stalling on one
// 17 MB decode. That is what makes the 128^3-chunked terabyte stores usable.
const TILE_DECODE_BUDGET_BYTES = 8 * 1024 * 1024
const MAX_TILE_EDGE = 512

function tileSizeForAxis(axis) {
  const [u, v] = PLANE_AXES[axis]
  const chunks = displayChunkShape()
  const edge = Math.max(chunks[u], chunks[v])
  if (!Number.isInteger(edge) || edge < 1) return 256
  const bytesPerVoxel =
    TYPED_ARRAYS[chunkSource.datatypeCode]?.BYTES_PER_ELEMENT ?? 1
  const slab = Math.max(1, chunks[AXIS_INDEX[axis]]) * bytesPerVoxel
  let tile = edge
  while (
    tile * 2 <= MAX_TILE_EDGE &&
    4 * tile * tile * slab <= TILE_DECODE_BUDGET_BYTES
  ) {
    tile *= 2
  }
  return tile
}

// ------------------------------------------------------------ source loading

// NIfTI datatype code -> typed array, used to size a tile decode in bytes.
const TYPED_ARRAYS = {
  2: Uint8Array,
  4: Int16Array,
  8: Int32Array,
  16: Float32Array,
  512: Uint16Array,
  768: Uint32Array,
}

function datasetUrl(def) {
  // zarrita (and the chunk workers) need an absolute URL.
  if (def.url) return new URL(def.url, location.href).href
  return `${DANDI_ZARR}/${def.zarrId}/`
}

// ------------------------------------------------------------- volumetric pane

function populateDetail() {
  els.detail.replaceChildren()
  for (const [index, level] of chunkSource.levels.entries()) {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = `L${level.level} ${level.shape.join(' x ')}`
    els.detail.appendChild(option)
  }
  els.detail.value = '0'
}

async function loadVolumetric(def, token) {
  activeCv?.dispose()
  activeCv = null
  const stale = nv.volumes.map((volume) => volume.id)
  const cv = await nv.loadChunkedVolume(chunkSource, {
    id: `${def.zarrId}#${token}`,
    name: def.label,
    // Passing neither bound lets the core place the window from the coarse
    // floor; passing both (a user edit, or a reload of an open dataset) is
    // taken as "I know this store" and suppresses that.
    ...(windowRange ? { calMin: windowRange[0], calMax: windowRange[1] } : {}),
    colormap: els.colormap.value,
    // The Plan and Swap menus pick the streaming strategy, so their trade-offs
    // can be compared on one store; 'focus' (the default) refines around the
    // crosshair the slide pane moves.
    budgetPlan: els.plan.value,
    swapPolicy: els.swap.value,
    budgetBytes: MULTILOD_BUDGET_BYTES,
    minLevel: Number(els.detail.value) || 0,
    coarseFloor: true,
  })
  if (token !== loadToken) {
    cv.dispose()
    await removeVolumes([cv.volume.id])
    return
  }
  activeCv = cv
  windowRange ??= [cv.volume.calMin, cv.volume.calMax]
  await removeVolumes(stale)
  await activeCv.applyCoarseFloor()
}

// `nv.addVolume` stores a SHALLOW COPY of the NVImage it is handed
// (`NVModel.prepareVolume`), so the object a chunked handle exposes as
// `cv.volume` is NOT the object sitting in `nv.volumes`. Address volumes by
// `id`, the way the core itself does -- an identity match silently yields -1
// and turns every `setVolume` into a no-op.
function volumeIndexById(id) {
  if (!nv) return -1
  return nv.volumes.findIndex((volume) => volume.id === id)
}

// `loadChunkedVolume` is ADDITIVE and the controller exposes no single-volume
// removal, so displaced streamed volumes go out through the model plus one GL
// refresh. Walk high-to-low so an earlier removal cannot shift a pending index.
async function removeVolumes(ids) {
  if (!nv || ids.length === 0) return
  const drop = new Set(ids)
  const volumes = nv.volumes
  let removed = false
  for (let i = volumes.length - 1; i >= 0; i--) {
    if (drop.has(volumes[i].id)) {
      nv.model.removeVolume(i)
      removed = true
    }
  }
  if (removed) await nv.updateGLVolume()
}

// ------------------------------------------------------------- deep-zoom pane

function rebuildSlide({ keepViewport = true } = {}) {
  if (!chunkSource || !windowRange) return
  const axis = els.axis.value
  const previous = slide
  const viewport = keepViewport && previous ? { ...previous.viewport } : null
  previous?.removeEventListener('change', requestSlideRender)
  previous?.dispose?.()
  slideView?.renderer?.clearTextures?.()
  // Slide coordinates only mean something within one plane orientation, so a
  // measurement survives a plane step (same axes) but not an axis swap.
  if (!keepViewport) slideInput?.clearMeasurements()
  const [u, v] = PLANE_AXES[axis]
  const spacing = chunkSource.levels[0].spacing
  const source = new VolumeSliceSource(chunkSource, {
    axis,
    index: planeIndex,
    window: windowRange,
    lut: slideLut(els.colormap.value),
    tileSize: tileSizeForAxis(axis),
    id: els.dataset.value,
    name: `${DATASETS[els.dataset.value].label} (${axis} ${planeIndex})`,
    // ChunkedVolumeLevel.spacing carries the OME-Zarr scale in MICROMETRES (the
    // core adapter documents the field as mm; the OME-Zarr path fills it with
    // um), so convert here rather than mislabel the plane's physical size.
    pixelSpacingMM: [spacing[u] / 1000, spacing[v] / 1000],
  })
  sliceSource = source
  slide = NVSlide.fromSource(source, {
    maxCacheBytes: SLIDE_CACHE_BYTES,
    targetScreenPixelsPerTilePixel: 0.75,
    ...(viewport ? { viewport } : {}),
  })
  slide.addEventListener('change', requestSlideRender)
  if (!viewport) slideFitted = false
  requestSlideRender()
}

function slideScreen() {
  const rect = els.slideCanvas.getBoundingClientRect()
  return {
    widthCss: Math.max(1, rect.width),
    heightCss: Math.max(1, rect.height),
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

function resizeSlideCanvas(screen) {
  const dpr = screen.devicePixelRatio ?? 1
  const width = Math.max(1, Math.floor(screen.widthCss * dpr))
  const height = Math.max(1, Math.floor(screen.heightCss * dpr))
  if (els.slideCanvas.width !== width) els.slideCanvas.width = width
  if (els.slideCanvas.height !== height) els.slideCanvas.height = height
}

async function createSlideView() {
  if (backend === 'webgpu' && 'gpu' in navigator) {
    const renderer = await SlideRendererGPU.create(els.slideCanvas)
    if (renderer) return { kind: 'gpu', renderer }
    console.warn('WebGPU unavailable for the slide pane; using WebGL2')
  }
  const gl = els.slideCanvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
  })
  if (!gl) throw new Error('WebGL2 is not available')
  const renderer = new SlideRenderer()
  renderer.init(gl)
  return { kind: 'gl', gl, renderer }
}

function requestSlideRender() {
  if (slideFrame !== 0) return
  slideFrame = window.requestAnimationFrame(() => {
    slideFrame = 0
    renderSlide()
  })
}

function renderSlide() {
  if (!slideView) return
  const screen = slideScreen()
  resizeSlideCanvas(screen)
  if (slide) {
    if (!slideFitted) {
      slide.fitToScreen(screen)
      slideFitted = true
    }
    slide.clampViewport(screen)
    updateCrosshair(screen)
    updateFieldOfView(screen)
    // Rulers and the contrast box, drawn by core in NiiVue's own style.
    slideView.renderer.overlay = slideOverlayContent(
      slide,
      screen,
      slideInput,
      {
        measureLineColor: nv.measureLineColor,
        measureTextColor: nv.measureTextColor,
        rulerWidth: nv.rulerWidth,
        selectionBoxColor: nv.selectionBoxColor,
      },
    )
    if (slideView.kind === 'gpu') {
      slideView.renderer.render([slide], screen)
    } else {
      slideView.renderer.draw(slideView.gl, [slide], screen)
    }
  }
  updateSlideHud(screen)
}

// -------------------------------------------------------------------- linking

function setPlane(index, { fromCrosshair = false } = {}) {
  const axis = els.axis.value
  const count = shape()[AXIS_INDEX[axis]]
  const next = Math.max(0, Math.min(count - 1, Math.round(index)))
  if (next === planeIndex) return
  planeIndex = next
  els.plane.value = String(next)
  els.planeVal.textContent = String(next)
  if (fromCrosshair) {
    // Coalesce a crosshair DRAG into one rebuild: every rebuild drops the
    // slide's in-flight tile requests, so rebuilding per pointer move would
    // stream nothing to completion.
    if (planeTimer !== 0) window.clearTimeout(planeTimer)
    planeTimer = window.setTimeout(() => {
      planeTimer = 0
      rebuildSlide()
    }, PLANE_DEBOUNCE_MS)
    return
  }
  rebuildSlide()
}

function syncPlaneControl() {
  const axis = els.axis.value
  const count = shape()[AXIS_INDEX[axis]]
  els.plane.min = '0'
  els.plane.max = String(Math.max(0, count - 1))
  els.plane.value = String(planeIndex)
  els.planeVal.textContent = String(planeIndex)
}

// Crosshair -> plane. The streamed volume is built on a positive-diagonal
// centred affine, so a RAS voxel index IS the source's finest-level voxel index
// and no remapping is needed.
function onLocationChange(event) {
  if (!els.follow.checked || !chunkSource) return
  const vox = event.detail?.vox
  if (!vox) return
  const depthAxis = AXIS_INDEX[els.axis.value]
  // A 3D render pick lands on the first visible voxel along the ray, usually
  // the dim outer edge of the slab. Keep the slide's plane: take the pick
  // in-plane only and move the volume crosshair onto that plane, which comes
  // back here as a plain (non-render) location.
  if (event.detail.axCorSag === SLICE_TYPE.RENDER) {
    const onPlane = [vox[0], vox[1], vox[2]]
    onPlane[depthAxis] = planeIndex
    nv.crosshairPos = nv.vox2frac(onPlane)
    return
  }
  // Recorded before the plane changes: the marker is what tells you WHERE a 3D
  // depth-pick landed in-plane, and on a slab whose short axis spans ~10 screen
  // pixels that is the only feedback distinguishing "the pick missed" from "the
  // pick landed on an empty edge plane".
  crosshairVox = [vox[0], vox[1], vox[2]]
  requestSlideRender()
  setPlane(vox[depthAxis], { fromCrosshair: true })
}

// Slide point -> crosshair. Slide points are base-level pixels in the plane's
// own (u, v) display axes; with displayYAxis 'up' the slide y IS the data v
// coordinate, so the two in-plane axes drop straight into the voxel.
function slideCrosshair(point) {
  if (!els.follow.checked || !slide || !nv || !activeCv) return
  const dims = shape()
  const [u, v] = PLANE_AXES[els.axis.value]
  const vox = [0, 0, 0]
  vox[AXIS_INDEX[els.axis.value]] = planeIndex
  vox[u] = Math.max(0, Math.min(dims[u] - 1, Math.floor(point.x)))
  vox[v] = Math.max(0, Math.min(dims[v] - 1, Math.floor(point.y)))
  nv.crosshairPos = nv.vox2frac(vox)
}

// ----------------------------------------------------------------------- HUDs

function setBusy(node, label, text, busy) {
  node.classList.toggle('on', busy)
  if (busy) label.textContent = text
}

// Main-thread stall monitor. The phase timings below can only see the spans
// NiiVue owns, and chunk DECODE happens inside zarrita where they cannot reach.
// This measures the gap the other way round: any frame the browser fails to
// deliver on time is main-thread work, whoever did it. Compare its total to the
// instrumented `upload` total and the difference is what a decode worker could
// still be hiding.
const FRAME_BUDGET_MS = 24
let stallTotalMs = 0
let stallWorstMs = 0
let lastFrameMs = 0

function watchFrames(now) {
  if (lastFrameMs !== 0) {
    const over = now - lastFrameMs - FRAME_BUDGET_MS
    if (over > 0) {
      stallTotalMs += over
      if (over > stallWorstMs) stallWorstMs = over
    }
  }
  lastFrameMs = now
  requestAnimationFrame(watchFrames)
}
requestAnimationFrame(watchFrames)

function resetStalls() {
  stallTotalMs = 0
  stallWorstMs = 0
  lastFrameMs = 0
}

function stallCost() {
  if (stallTotalMs === 0) return 'none over ' + FRAME_BUDGET_MS + ' ms'
  return `${Math.round(stallTotalMs)} ms total, worst ${Math.round(stallWorstMs)} ms`
}

function brickCost() {
  const t = nv?.chunkTimingStats?.()
  const reads = t?.phases.read.count ?? 0
  if (!t || reads === 0) return '-'
  // Sub-millisecond means are the interesting result here (a texture upload
  // that rounds to 0 ms is most of the answer to "is a decode worker worth
  // it?"), so keep a decimal until the mean is big enough not to need one.
  const ms = (total, n) => {
    if (n <= 0) return '0'
    const each = total / n
    return each < 10 ? each.toFixed(1) : String(Math.round(each))
  }
  // Reads and uploads are different populations: the volume's bricks and the
  // slide's tiles both read from this store, but only the volume's reads become
  // brick textures. So each figure is divided by its own count, never mixed.
  const uploads = t.phases.upload.count
  const net = `net ${ms(t.netBusyMs, reads)} ms/read x${reads}`
  const main = `main ${ms(t.mainThreadMs, uploads)} ms/upload x${uploads}`
  return `${net}, ${main}, ${Math.round(t.mainThreadMs)} ms total`
}

// What the chunk worker pool took off the render thread. `mainThreadMs` above
// already excludes it, so this row is what that exclusion is worth: with the
// pool off it reads "off" and `main` carries the whole cost.
function workerCost() {
  const t = nv?.chunkTimingStats?.()
  if (!t) return '-'
  if (t.offThreadMs <= 0) return 'off'
  const blocking = t.mainThreadMs + t.offThreadMs
  const share = blocking > 0 ? Math.round((100 * t.offThreadMs) / blocking) : 0
  return `${Math.round(t.offThreadMs)} ms off-thread (${share}% of streaming work)`
}

// Whether the store-level byte budget is earning its keep. A run of all
// misses is ambiguous on its own -- the budget may be too small to hold the
// working set, or the access pattern may simply never revisit a chunk -- and
// the two want opposite fixes. Evictions tell them apart: many evictions with
// no hits is thrash, no evictions with no hits means there was nothing to
// reuse.
function byteCacheCost() {
  // `byteCacheStats()` rather than `byteCache.stats`: with the chunk worker
  // pool on, the caches live on the workers and there is no single LRU on this
  // thread to read. It answers for either arrangement.
  const c = chunkSource?.byteCacheStats?.() ?? chunkSource?.byteCache?.stats
  if (!c) return 'off'
  const looks = c.hits + c.misses
  const rate = looks > 0 ? Math.round((100 * c.hits) / looks) : 0
  return `${rate}% of ${looks} (${formatBytes(c.bytes)} of ${formatBytes(
    c.maxBytes,
  )}, ${c.evicted} evicted)`
}

// The decoded tier holds a brick's SOURCE bytes for as long as it is cheap to,
// so a brick the GPU evicts is demoted rather than destroyed. A hit here is a
// brick that came back for the cost of a texture upload alone -- no network, no
// codec, no assemble -- which is what makes a scrub back over ground you just
// covered cheaper than seeing it the first time. Read it next to `byte cache`:
// that one saves the network, this one also saves the decode.
function decodedTierCost(stats) {
  const d = stats?.decoded
  if (!d || d.maxBytes === 0) return 'off'
  const looks = d.hits + d.misses
  const rate = looks > 0 ? Math.round((100 * d.hits) / looks) : 0
  return `${rate}% of ${looks} (${formatBytes(d.bytes)} of ${formatBytes(
    d.maxBytes,
  )}, ${d.evicted} dropped)`
}

// The persistent tier is the only cache here that outlives the tab. Read the
// row as a warm-start meter: on a first visit it is all misses and writes, and
// on a reload of the same dataset the hits are round trips to S3 that never
// happened. `off` means no Cache Storage -- a non-secure context, or a browser
// that declined -- not that the tier failed.
function persistCost() {
  const p = chunkSource?.persistStats?.()
  if (!p || p.maxBytes === 0) return 'off'
  const looks = p.hits + p.misses
  const rate = looks > 0 ? Math.round((100 * p.hits) / looks) : 0
  return `${rate}% of ${looks} (${formatBytes(p.bytes)} of ${formatBytes(
    p.maxBytes,
  )} on disk, ${p.writes} written)`
}

function updateVolumeHud() {
  if (!chunkSource || !nv) return
  const def = DATASETS[els.dataset.value]
  const stats = nv.chunkStreamStats()
  const plan = activeCv?.currentPlan ?? null
  const dims = shape()
  const levels = plan
    ? [...new Set(plan.chunks.map((chunk) => chunk.sourceLevel))].sort(
        (a, b) => a - b,
      )
    : []
  const inFlight = stats ? stats.pending + stats.inFlight : 0
  setBusy(
    els.volBusy,
    els.volBusyLabel,
    `streaming ${inFlight} brick${inFlight === 1 ? '' : 's'}`,
    inFlight > 0,
  )
  els.volHud.innerHTML = `
    <div class="title">${def.label}</div>
    <div class="row"><span class="key">backend</span><span>${
      nv?.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
    }</span></div>
    <div class="row"><span class="key">store</span><span>${def.size}, ${
      chunkSource.levels.length
    } levels</span></div>
    <div class="row"><span class="key">finest</span><span>${dims.join(
      ' x ',
    )}</span></div>
    <div class="row"><span class="key">bricks</span><span>${
      stats ? `${stats.resident}/${stats.total} resident` : 'planning'
    }</span></div>
    <div class="row"><span class="key">levels</span><span>${
      levels.length > 0 ? levels.map((l) => `L${l}`).join(' ') : '-'
    }</span></div>
    <div class="row"><span class="key">queue</span><span>${
      stats
        ? `${stats.pending} queued, ${stats.inFlight} in flight, ${stats.staleDropped} stale`
        : '-'
    }</span></div>
    <div class="row"><span class="key">prefetch</span><span>${
      stats ? `${stats.predicted} predicted ahead` : '-'
    }</span></div>
    <div class="row"><span class="key">retiring</span><span>${
      stats ? `${stats.retiring} (${formatBytes(stats.retiringBytes)})` : '-'
    }</span></div>
    <div class="row"><span class="key">decoded tier</span><span>${decodedTierCost(
      stats,
    )}</span></div>
    <div class="row"><span class="key">stream cost</span><span>${brickCost()}</span></div>
    <div class="row"><span class="key">byte cache</span><span>${byteCacheCost()}</span></div>
    <div class="row"><span class="key">disk cache</span><span>${persistCost()}</span></div>
    <div class="row"><span class="key">workers</span><span>${workerCost()}</span></div>
    <div class="row"><span class="key">stalls</span><span>${stallCost()}</span></div>
    <div class="row"><span class="key">window</span><span>${
      windowRange
        ? `${formatValue(windowRange[0])} .. ${formatValue(windowRange[1])}`
        : '-'
    }</span></div>
  `
}

function formatLength(um) {
  if (um >= 1000) return `${um / 1000} mm`
  if (um >= 1) return `${Number(um.toPrecision(3))} um`
  return `${Number(um.toPrecision(2))} um`
}

// Slide base pixels -> device pixels, the space the overlay draws in.
function slideToDevice(point, screen) {
  const { xCss, yCss } = slide.slideToScreen(point.x, point.y, screen)
  const dpr = screen.devicePixelRatio ?? 1
  return [xCss * dpr, yCss * dpr]
}

// The crosshair marker is the UIKit crosshair widget (`UIKitCrosshairOverlay`),
// drawn into the slide frame. Without it the slide pane gives
// no feedback at all about a link from the volume pane: a 3D depth-pick that
// lands on an empty edge plane looks identical to one that did not register.
const CROSSHAIR_LABEL_PX = 15
// Device pixels a minor graduation aims for. Ticks much tighter than this stop
// resolving on screen; much wider and the arms carry too few to read as a scale.
const TARGET_TICK_PX = 22

// Round a raw step up to the next 1/2/5 of its decade, the spacing a printed
// scale would use. Without it a zoom would graduate in 3.7 um steps.
function niceStep(raw) {
  const decade = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5]) {
    if (m * decade >= raw) return m * decade
  }
  return 10 * decade
}

// The crosshair's graduation, in the units the pane is actually at: micrometres
// until a tick is worth a whole millimetre. `pxPerUnit` is per axis because
// `pixelSpacingMM` is (the NeuN slab never downsamples z), so a tick means the
// same distance on both arms even when the plane is anisotropic.
function crosshairGraduation(screen) {
  const spacing = slide.manifest.pixelSpacingMM
  if (!spacing) return null
  const devicePerBase = slide.viewport.scale * (screen.devicePixelRatio ?? 1)
  // Device pixels per micrometre, per plane axis.
  const perUm = [
    devicePerBase / (spacing[0] * 1000),
    devicePerBase / (spacing[1] * 1000),
  ]
  if (!(perUm[0] > 0) || !(perUm[1] > 0)) return null
  // The horizontal axis sets the unit for both, so one label reads for the pair.
  const wantUm = niceStep(TARGET_TICK_PX / perUm[0])
  return wantUm >= 1000
    ? {
        units: 'mm',
        pxPerUnit: [perUm[0] * 1000, perUm[1] * 1000],
        unitsPerTick: wantUm / 1000,
      }
    : { units: 'um', pxPerUnit: perUm, unitsPerTick: wantUm }
}

// Set BEFORE the slide draws: the overlay renders inside that same frame, so
// geometry written afterwards would trail the tiles by one frame during a pan.
function updateCrosshair(screen) {
  if (!crosshair) return
  // Unlinked panes navigate independently, so a marker carried over from the
  // volume pane would point at a position this slide is not showing.
  const mode = els.crosshair.value
  if (!slide || !crosshairVox || !els.follow.checked || mode === 'off') {
    crosshair.clear()
    return
  }
  const [u, v] = PLANE_AXES[els.axis.value]
  // Voxel centre, matching the floor() the slide-click inverse applies.
  const point = { x: crosshairVox[u] + 0.5, y: crosshairVox[v] + 0.5 }
  const dpr = screen.devicePixelRatio ?? 1
  const graduation = mode === 'plain' ? null : crosshairGraduation(screen)
  crosshair.setCrosshair({
    at: slideToDevice(point, screen),
    // The volume pane's own crosshair colour, so the two markers read as one.
    color: nv.crosshairColor,
    thickness: 2 * dpr,
    gapPx: 10 * dpr,
    showTicks: graduation !== null,
    showTickNumbers: graduation !== null && mode === 'numbers',
    tickLength: 5 * dpr,
    sizePx: CROSSHAIR_LABEL_PX * dpr,
    ...(graduation ?? {}),
  })
}

// The crosshair voxel as x y z, the plane's own axis fixed at the plane, so a
// report names the exact point clicked.
function crosshairLabel() {
  const vox = crosshairVox ?? [Number.NaN, Number.NaN, Number.NaN]
  const depth = AXIS_INDEX[els.axis.value]
  return AXIS_NAME.map((name, i) => {
    const value = i === depth ? planeIndex : vox[i]
    return `${name} ${Number.isFinite(value) ? Math.round(value) : '-'}`
  }).join(', ')
}

function updateSlideHud(screen) {
  if (!slide) return
  // The drawn level: one over the tile-cache budget shows a coarser one.
  const { level, tiles } = slide.visibleTiles(screen)
  const stats = slide.stats
  setBusy(
    els.slideBusy,
    els.slideBusyLabel,
    `streaming ${slide.pendingCount} tile${slide.pendingCount === 1 ? '' : 's'}`,
    slide.pendingCount > 0,
  )
  if (!level) return
  const visible = tiles.length
  const spacing = slide.manifest.pixelSpacingMM
  const scale = slide.viewport.scale
  const zoom =
    scale >= 1 ? `${scale.toFixed(2)}x` : `1:${(1 / scale).toFixed(1)}`
  // `screenToSlide` maps one CSS pixel to `1 / scale` BASE pixels, so a screen
  // pixel spans the base spacing over the zoom -- the level's downsample does
  // not enter it. How coarse the SAMPLED data is at that zoom is a separate
  // quantity, reported on the level row as um per source texel.
  const baseUm = spacing ? spacing[0] * 1000 : null
  const umPerPixel = baseUm === null ? null : baseUm / Math.max(scale, 1e-6)
  const umPerTexel = baseUm === null ? null : baseUm * level.downsample
  const [u, v] = PLANE_AXES[els.axis.value]
  els.slideHud.innerHTML = `
    <div class="title">${AXIS_NAME[u]}${AXIS_NAME[v]} plane, ${crosshairLabel()}</div>
    <div class="row"><span class="key">plane</span><span>${
      slide.manifest.width
    } x ${slide.manifest.height} px</span></div>
    <div class="row"><span class="key">level</span><span>L${level.index} ${
      level.width
    } x ${level.height}, tile ${level.tileWidth}${
      umPerTexel ? ` (${formatLength(umPerTexel)}/texel)` : ''
    }</span></div>
    <div class="row"><span class="key">zoom</span><span>${zoom}${
      umPerPixel ? ` (${umPerPixel.toFixed(2)} um/px)` : ''
    }</span></div>
    <div class="row"><span class="key">tiles</span><span>${visible} visible, ${
      slide.pendingCount
    } pending</span></div>
    <div class="row"><span class="key">decoded</span><span>${formatBytes(
      stats.wireBytes,
    )} of voxels</span></div>
    <div class="row"><span class="key">cache</span><span>${formatBytes(
      stats.cacheBytes,
    )} / ${stats.cacheHits} hits</span></div>
  `
}

// ------------------------------------------------------------------ lifecycle

async function loadDataset() {
  const token = ++loadToken
  const def = DATASETS[els.dataset.value]
  clearFallback()
  setBusy(els.volBusy, els.volBusyLabel, 'opening store', true)
  setBusy(els.slideBusy, els.slideBusyLabel, 'opening store', true)
  slide?.removeEventListener('change', requestSlideRender)
  slide?.dispose?.()
  slide = null
  slideView?.renderer?.clearTextures?.()
  slideInput?.clearMeasurements()
  // A voxel index from the outgoing store means nothing in the incoming one.
  crosshairVox = null
  // Per-brick phase timings are process-wide totals, so a dataset switch starts
  // a fresh measurement window rather than averaging two stores together.
  nv?.resetChunkTiming()
  resetStalls()
  // The outgoing store may own a pool of chunk workers. Switching datasets
  // without releasing it leaks four workers -- and their byte caches -- per
  // switch, so the release happens here rather than at some later teardown.
  chunkSource?.dispose?.()
  chunkSource = null
  try {
    const source = await fetchOmeZarrChunkedSource(datasetUrl(def), {
      cacheBytes: ZARR_CACHE_BYTES,
      persist: { maxBytes: ZARR_PERSIST_BYTES },
      ignoreMissingLevels: true,
      // Every store listed is Zarr v2; saying so skips the zarr.json probe
      // (a 404 in the console on each load).
      zarrVersion: 2,
    })
    // A switch that landed while this one was opening owns the panes now; this
    // store has no reader, so let go of its workers instead of orphaning them.
    if (token !== loadToken) {
      source.dispose?.()
      return
    }
    chunkSource = source
    windowRange = null
    els.axis.value = def.axis
    planeIndex = Math.floor(shape()[AXIS_INDEX[def.axis]] / 2)
    syncPlaneControl()
    populateDetail()
    updateProvenance(def)
    await loadVolumetric(def, token)
    if (token !== loadToken) return
    els.window.value = `${formatValue(windowRange[0])},${formatValue(
      windowRange[1],
    )}`
    // Park the crosshair on the plane the slide opens at, so the two panes agree
    // from the first frame rather than after the first click.
    const dims = shape()
    const vox = dims.map((n) => Math.floor(n / 2))
    vox[AXIS_INDEX[def.axis]] = planeIndex
    nv.crosshairPos = nv.vox2frac(vox)
    rebuildSlide({ keepViewport: false })
  } catch (err) {
    if (token !== loadToken) return
    console.error(err)
    showFallback(err instanceof Error ? err.message : String(err))
    setBusy(els.volBusy, els.volBusyLabel, '', false)
    setBusy(els.slideBusy, els.slideBusyLabel, '', false)
  }
}

function updateProvenance(def) {
  els.provenance.replaceChildren()
  if (!def.dandiset) {
    els.provenance.textContent = `Generated by the dev server (${def.size}).`
    return
  }
  const lead = document.createElement('span')
  lead.textContent = 'Streamed from the DANDI Archive: '
  const link = document.createElement('a')
  link.href = `https://dandiarchive.org/dandiset/${def.dandiset}`
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = `dandiset ${def.dandiset}`
  const asset = document.createElement('span')
  asset.textContent = ` / ${def.asset} (${def.size}). ${def.credit}`
  els.provenance.append(lead, link, asset)
}

function applyWindow() {
  if (!windowRange) return
  const next = parseWindow(els.window.value, windowRange)
  const changed = next[0] !== windowRange[0] || next[1] !== windowRange[1]
  windowRange = next
  if (!changed) return
  const index = activeCv ? volumeIndexById(activeCv.volume.id) : -1
  if (index >= 0) {
    nv.setVolume(index, { calMin: windowRange[0], calMax: windowRange[1] })
  }
  rebuildSlide()
}

// The wheel over the 3D tile writes `scene.scaleMultiplier` directly and clamps
// it to [0.5, 2] -- the slider's own range, so the two agree instead of the
// slider offering a zoom the next wheel tick would snap away. Both the wheel and
// the public setter emit `change`, so one listener keeps the slider honest
// however the zoom moved.
function syncZoomControl(value) {
  els.zoom.value = String(value)
  els.zoomVal.textContent = `${value.toFixed(2)}x`
}

function onNiivueChange(event) {
  const property = event.detail?.property
  if (property === 'crosshairColor') requestSlideRender()
  if (property !== 'scaleMultiplier') return
  syncZoomControl(Number(event.detail.value))
}

function applyColormap() {
  const index = activeCv ? volumeIndexById(activeCv.volume.id) : -1
  if (index >= 0) {
    nv.setVolume(index, { colormap: els.colormap.value })
  }
  rebuildSlide()
}

// The slide pane's field of view, outlined on the volume pane: the pane's four
// corners (clipped to the plane) as voxels on the slide's plane, then mm.
let fovKey = ''
function updateFieldOfView(screen) {
  if (!nv || !slide || !chunkSource) return
  const [u, v] = PLANE_AXES[els.axis.value]
  const dims = shape()
  const clip = (value, n) => Math.max(0, Math.min(n, value))
  const corners = [
    [0, 0],
    [screen.widthCss, 0],
    [screen.widthCss, screen.heightCss],
    [0, screen.heightCss],
  ].map(([x, y]) => {
    const p = slide.screenToSlide(x, y, screen)
    const vox = [0, 0, 0]
    vox[AXIS_INDEX[els.axis.value]] = planeIndex
    vox[u] = clip(p.x, dims[u]) - 0.5
    vox[v] = clip(p.y, dims[v]) - 0.5
    return nv.vox2mm(vox)
  })
  if (corners.some((c) => !c)) return
  // Only a real change reaches NiiVue, which redraws on every set.
  const key = `${els.follow.checked}:${corners
    .flat()
    .map((n) => n.toFixed(3))
    .join()}`
  if (key === fovKey) return
  fovKey = key
  nv.planeOutlines = els.follow.checked
    ? [{ cornersMM: corners, color: [0.2, 0.9, 1, 1], width: 2 }]
    : []
}

// ---------------------------------------------------------------- slide input

// A windowing drag on the slide steps the window as NiiVue's does (0.5% of the
// span the drag started from per CSS pixel: x widens, y lowers the centre). The
// text follows live; both panes apply on release, since a slide rebuild drops
// its in-flight tiles and a chunked volume's window change re-streams every
// brick.
let windowDrag = null
function onSlideWindow(dx, dy, done) {
  if (!windowRange) return
  windowDrag ??= { start: [...windowRange], now: [...windowRange] }
  const step = (windowDrag.start[1] - windowDrag.start[0]) * 0.005
  const [lo, hi] = windowDrag.now
  const width = Math.max(step, hi - lo + dx * step)
  const centre = (lo + hi) / 2 - dy * step
  windowDrag.now = [centre - width / 2, centre + width / 2]
  setWindowText(windowDrag.now)
  if (!done) return
  windowDrag = null
  applyWindow()
}

function setWindowText([lo, hi]) {
  els.window.value = `${formatValue(lo)},${formatValue(hi)}`
}

// A contrast box sets the window to the intensity range inside it, as NiiVue's
// contrast drag does, read at the level the slide is showing.
async function onSlideContrast(box) {
  const source = sliceSource
  if (!slide || !source) return
  const level = slide.visibleTiles(slideScreen()).level?.index ?? 0
  const range = await source.intensityRange(
    { x0: box.start.x, y0: box.start.y, x1: box.end.x, y1: box.end.y },
    level,
  )
  // A dataset, axis or plane change while reading makes this range stale.
  if (!range || source !== sliceSource) return
  setWindowText(range)
  applyWindow()
}

slideInput = new NVSlideController(els.slideCanvas, {
  slide: () => slide,
  screen: slideScreen,
  primaryDragMode: Number(els.slidePrimary.value),
  secondaryDragMode: Number(els.slideSecondary.value),
  onCrosshair: slideCrosshair,
  onWindow: onSlideWindow,
  onContrast: (box) => {
    void onSlideContrast(box)
  },
  onChange: requestSlideRender,
})
els.volumePrimary.addEventListener('change', () => {
  if (nv) nv.primaryDragMode = Number(els.volumePrimary.value)
})
els.volumeSecondary.addEventListener('change', () => {
  if (nv) nv.secondaryDragMode = Number(els.volumeSecondary.value)
})
els.slidePrimary.addEventListener('change', () => {
  slideInput.primaryDragMode = Number(els.slidePrimary.value)
})
els.slideSecondary.addEventListener('change', () => {
  slideInput.secondaryDragMode = Number(els.slideSecondary.value)
})

// -------------------------------------------------------------- control wiring

// The synthetic stores exist only on the dev server, where the 4.5 GB one is the
// default; the published demo opens on the OCT.
if (import.meta.env.DEV) els.dataset.value = 'synthetic-oct'
else {
  for (const option of els.dataset.querySelectorAll(
    'option[value^="synthetic"]',
  ))
    option.remove()
}

els.slideFilter.addEventListener('change', () => {
  if (!slideView) return
  slideView.renderer.isNearestInterpolation =
    els.slideFilter.value === 'nearest'
  requestSlideRender()
})

els.dataset.addEventListener('change', () => {
  void loadDataset()
})
els.axis.addEventListener('change', () => {
  planeIndex = Math.floor(shape()[AXIS_INDEX[els.axis.value]] / 2)
  syncPlaneControl()
  rebuildSlide({ keepViewport: false })
})
els.plane.addEventListener('input', () => {
  setPlane(Number(els.plane.value))
  // Carry the volume crosshair to the new plane, so both panes agree on depth.
  if (!els.follow.checked || !nv || !crosshairVox) return
  const onPlane = [...crosshairVox]
  onPlane[AXIS_INDEX[els.axis.value]] = planeIndex
  nv.crosshairPos = nv.vox2frac(onPlane)
})
els.follow.addEventListener('change', requestSlideRender)
els.view.addEventListener('change', () => {
  if (nv) nv.sliceType = VIEWS[els.view.value] ?? SLICE_TYPE.RENDER
})
els.detail.addEventListener('change', () => {
  activeCv?.setMaxDetail(Number(els.detail.value) || 0)
})
els.plan.addEventListener('change', () => {
  void activeCv?.setBudgetPlan(els.plan.value)
})
els.swap.addEventListener('change', () => {
  activeCv?.setSwapPolicy(els.swap.value)
})
els.zoom.addEventListener('input', () => {
  if (nv) nv.scaleMultiplier = Number(els.zoom.value)
})
els.crosshair.addEventListener('change', requestSlideRender)
els.colormap.addEventListener('change', applyColormap)
els.window.addEventListener('change', applyWindow)
els.fit.addEventListener('click', () => {
  slideFitted = false
  requestSlideRender()
})
window.addEventListener('resize', requestSlideRender)

async function main() {
  // ?dataset=<key> opens on that Dandiset (e.g. ?dataset=spim), when the menu
  // offers it (the synthetic stores are dev-server only).
  const wanted = params.get('dataset')
  if ([...els.dataset.options].some((o) => o.value === wanted))
    els.dataset.value = wanted
  nv = new NiiVue({
    backend,
    isAntiAlias,
    backgroundColor: [0.02, 0.03, 0.03, 1],
    isColorbarVisible: true,
    sliceType: VIEWS[els.view.value] ?? SLICE_TYPE.RENDER,
    maxTextureDimension3D: 256,
    maxChunkResidencyBytes: DEFAULT_RESIDENCY_BYTES,
    // Faint crosshair arms through the volume, as mesh x-ray draws them.
    meshXRay: 0.25,
    primaryDragMode: Number(els.volumePrimary.value),
    secondaryDragMode: Number(els.volumeSecondary.value),
  })
  await nv.attachToCanvas(els.canvas)
  // Show the backend running, after any fallback.
  els.backendSelect.value = nv.backend
  nv.addEventListener('locationChange', onLocationChange)
  nv.addEventListener('change', onNiivueChange)
  nv.scaleMultiplier = DEFAULT_3D_ZOOM
  syncZoomControl(nv.scaleMultiplier)
  slideView = await createSlideView()
  // One font fetch for the pane, shared by both widgets (each still owns its own
  // GPU resources on whichever backend the slide renderer came up on).
  const font = await loadDefaultFont()
  crosshair = new UIKitCrosshairOverlay(font)
  slideView.renderer.overlayDraw = (frame) => crosshair.drawOverlay(frame)
  slideView.renderer.isNearestInterpolation =
    els.slideFilter.value === 'nearest'
  await loadDataset()
  // Both panes stream asynchronously with no completion event, so the HUDs poll.
  // Cheap: two innerHTML writes a few times a second.
  // The render pump goes FIRST: a throw while building the HUD string must not
  // be able to stop the slide from redrawing.
  window.setInterval(() => {
    requestSlideRender()
    updateVolumeHud()
  }, 250)
}

main().catch((err) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})
