// Focused demo for OME-Zarr pyramid loading + subvolume access.
//
// Discovers OME-Zarr volumes from /api, lets the user pick one and choose
// which pyramid level to load. The level dropdown is driven by the
// server's native pyramid metadata (probeLevels), and each switch fetches
// `/volumes/{id}/raw.nii.gz?level=N` for regular levels, or streams visible
// bricks from `/volumes/{id}/raw.bin?level=N&bbox=...` for whole levels that
// are too large to materialize without freezing the page.
//
// Load strategy (lazy / progressive):
//
//   - First paint uses the coarsest available level so even multi-GB
//     volumes show something within a few hundred ms. L0 of a typical
//     fibsem volume is ~1.9 GB; L3 is ~3.7 MB.
//   - After the coarse render lands, a background upgrade fetches a
//     "comfortable" mid level (closest to 1 voxel per screen pixel at
//     the current zoom). The upgrade is cancelled if the user touches
//     level/bbox or scrolls, so user intent always wins.
//   - Colormap and window edits trigger a reload of the current level so
//     the 3D render texture is rebuilt — the bytes come from browser cache,
//     so this is cheap at the coarse levels the demo paints first.
//   - Manual L0/full-detail selection remains available as a streamed whole
//     level or legacy full-level load. A separate Subvol control can route the
//     same level through focused or 3×3 grid bbox reads:
//     `/raw.nii.gz?level=N&bbox=...`.
//
// Two automatic behaviours showcase the server's strengths:
//
//   - Auto-LOD: scrolling to zoom in/out triggers a level swap among
//     full-levels that fit the interactive render budget. Deep detail comes
//     from the explicit subvolume selector.
//
//   - Shift-click subvolume: clicking on any feature in the canvas while
//     holding Shift maps the click → L0 voxel coords → 128³ bbox →
//     `/raw.nii.gz?level=0&bbox=...`. The server reads only the intersecting
//     OME-Zarr chunks, so a 1 MB window can come out of a multi-GB
//     volume in tens of milliseconds.
//
// Rendering is the off-the-shelf niivue 3D viewer — the point here is the
// server-side pyramid + subvolume plumbing, not viewer features.

import NiiVue, {
  type ChunkPlan,
  chunkVolumeGrid,
  chunkVolumeMultiLOD,
  type NVImage,
  type VolumeChunkExplode,
  type VolumeChunkSource,
} from '@niivue/niivue'

import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()

interface VolumeLevel {
  level: number
  shape: [number, number, number]
  spacing: [number, number, number]
  bytes: number | null
}

interface VolumeApiEntry {
  id: string
  format: string
  shape: [number, number, number]
  spacing: [number, number, number]
  dtype: string
  levels?: VolumeLevel[]
}

interface ApiResponse {
  volumes?: VolumeApiEntry[]
}

interface LoadStats {
  bytes: number
  fetchMs: number
  decodeMs: number
}

type Shape3 = [number, number, number]
type Bbox6 = [number, number, number, number, number, number]

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  volume: el<HTMLSelectElement>('volume'),
  level: el<HTMLSelectElement>('level'),
  subvolume: el<HTMLSelectElement>('subvolume'),
  explodedToggle: el<HTMLInputElement>('explodedToggle'),
  explodeEx: el<HTMLInputElement>('explodeEx'),
  explodeEy: el<HTMLInputElement>('explodeEy'),
  explodeEz: el<HTMLInputElement>('explodeEz'),
  explodePlan: el<HTMLSpanElement>('explodePlan'),
  colormap: el<HTMLSelectElement>('colormap'),
  window: el<HTMLInputElement>('window'),
  bbox: el<HTMLInputElement>('bbox'),
  bboxRandom: el<HTMLButtonElement>('bboxRandom'),
  bboxClear: el<HTMLButtonElement>('bboxClear'),
  autoLod: el<HTMLInputElement>('autoLod'),
  zoom: el<HTMLInputElement>('zoom'),
  panX: el<HTMLInputElement>('panX'),
  panY: el<HTMLInputElement>('panY'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
  busy: el<HTMLDivElement>('busy'),
}

const baseUrl = window.location.origin
let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let lastStats: LoadStats | null = null
let lodTimer: ReturnType<typeof setTimeout> | null = null
let lastFocusFrac: [number, number, number] | null = null
let loadedLevelShape: Shape3 | null = null
let loadedBbox: Bbox6 | null = null
let autoBboxValue: string | null = null
let lastSubvolumeLabel: string | null = null
// Set true while reload() is mid-flight so the wheel handler doesn't
// stampede the server with overlapping level swaps during a single zoom.
let reloading = false
// Surfaced in the HUD so demos can show "we just swapped L2 → L1 because
// you zoomed in". Cleared on next reload().
let lastLodEvent: { from: number; to: number; reason: string } | null = null
// Scheduled background refinement from the coarsest level to a "comfortable"
// mid level after the first paint. Cancelled if the user interacts before
// it fires (manual level change, scroll, bbox edit).
let upgradeTimer: ReturnType<typeof setTimeout> | null = null
// Token bumped on every user-driven reload so an in-flight progressive
// upgrade can detect "I'm stale, drop me".
let reloadEpoch = 0
// Volumes that have had the punchy default window applied. niivue's
// auto-calibration leaves a translucent low-intensity haze that dims the
// 3D render; we re-window onto the upper half of the robust range once,
// on first load, unless the user has set a window explicitly.
const autoWindowed = new Set<string>()
// GPU 3D-texture limit. A level whose longest dim exceeds this can't fit a
// single texture — niivue falls back to a slower tiled path, and the level
// is multi-GB anyway. We mark such levels in the dropdown and keep auto-LOD
// off them (deep detail is meant to come from the subvolume path).
// Read from the live GL context after niivue attaches; 2048 is the safe
// WebGL2/WebGPU floor used until then.
let maxTexDim = 2048
// Full OME-Zarr levels above this estimated render footprint are flagged in
// the UI so the user can choose a subvolume before rendering. "Full level"
// remains available for parity with the old whole-volume path.
const FULL_LEVEL_RENDER_BYTE_BUDGET = 256 * 1024 * 1024
const AUTO_SUBVOLUME_EDGE = 192
const GRID_SUBVOLUME_DIVS = 3
const STREAMING_CHUNK_EDGE = 256
const STREAMING_CHUNK_HALO: Shape3 = [3, 3, 3]
const STREAMING_CHUNK_LIMIT = 256
const EXPLODED_GRID_LONG_AXIS_BLOCKS = 4
// Multi-resolution (Neuroglancer-style) rendering: a focused octree of bricks
// finest near the focus, coarser further out, covering the whole volume.
const MULTILOD_CELL_EDGE = 128
const MULTILOD_DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024
const MULTILOD_HALO: Shape3 = [1, 1, 1]
const DEFAULT_OME_ZARR_ID = 'pawpawsaurus.ome.zarr'

const initialParams = new URLSearchParams(window.location.search)
if (
  initialParams.get('mode') === 'exploded' ||
  initialParams.get('explode') === '1'
) {
  els.explodedToggle.checked = true
}
for (const [param, input] of [
  ['ex', els.explodeEx],
  ['ey', els.explodeEy],
  ['ez', els.explodeEz],
] as const) {
  const value = initialParams.get(param)
  if (value && Number.isFinite(Number(value))) input.value = value
}
syncExplodeLabels()

main().catch((err: unknown) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})

async function main(): Promise<void> {
  const res = await fetch('/api')
  const api = (await res.json()) as ApiResponse
  // OME-Zarr and DICOM-WSI both expose a multiscale pyramid + bbox subvolume
  // reads, so the same chunk-streaming path serves both. DICOM-WSI is rgb24
  // (a depth-1 colour slab) and rides niivue's RGB chunked-upload support.
  volumes = (api.volumes ?? []).filter(
    (v) => v.format === 'ome-zarr' || v.format === 'dicom-wsi',
  )
  if (volumes.length === 0) {
    showFallback(
      'No OME-Zarr or DICOM-WSI volumes in /api. Run `bun run fetch-omezarr` ' +
        'or `fetch-dicom-wsi` in the server and restart.',
    )
    return
  }
  populateVolumeSelect()
  els.volume.addEventListener('change', () => {
    void selectVolume(els.volume.value)
  })
  els.level.addEventListener('change', () => {
    clearAutoBbox()
    populateSubvolumeSelect(currentVolume())
    applySubvolumeSelection(currentVolume())
    renderExplodePlan(currentVolume())
    void reload()
  })
  els.subvolume.addEventListener('change', () => {
    applySubvolumeSelection(currentVolume())
    renderExplodePlan(currentVolume())
    void reload()
  })
  els.explodedToggle.addEventListener('change', () => {
    syncExplodeLabels()
    renderExplodePlan(currentVolume())
    void reload()
  })
  for (const input of [els.explodeEx, els.explodeEy, els.explodeEz]) {
    input.addEventListener('input', () => {
      syncExplodeLabels()
      applyExplodeToLoadedVolume()
    })
  }
  els.colormap.addEventListener('change', () => {
    void reload()
  })
  els.window.addEventListener('change', () => {
    void reload()
  })
  els.bbox.addEventListener('change', () => {
    markCustomSubvolume('custom bbox')
    void reload()
  })
  els.bboxRandom.addEventListener('click', () => {
    const v = currentVolume()
    const lvl = currentLevelShape(v)
    if (!lvl) return
    markCustomSubvolume('random 128³')
    els.bbox.value = randomBboxString(lvl, 128)
    void reload()
  })
  els.bboxClear.addEventListener('click', () => {
    autoBboxValue = null
    lastSubvolumeLabel = null
    els.subvolume.value = 'full'
    els.bbox.value = ''
    void reload()
  })
  els.zoom.addEventListener('input', () => {
    applyZoomFromSlider()
  })
  els.panX.addEventListener('input', () => {
    applyPanFromSliders()
  })
  els.panY.addEventListener('input', () => {
    applyPanFromSliders()
  })
  await ensureNiivue()
  maxTexDim = readMaxTexDim()
  const initial = readInitialVolumeId()
  els.volume.value = initial
  await selectVolume(initial)
}

// niivue attached its rendering context to the canvas; for the WebGL2
// backend we can re-request it (browsers hand back the same context) and
// read the real MAX_3D_TEXTURE_SIZE. WebGPU returns null here — we keep
// the conservative 2048 floor in that case.
function readMaxTexDim(): number {
  const gl = els.canvas.getContext('webgl2')
  if (gl) {
    const v = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE)
    if (typeof v === 'number' && v > 0) return v
  }
  return 2048
}

// True when the level's longest spatial dim won't fit a single 3D texture.
function levelOversized(shape: [number, number, number]): boolean {
  return Math.max(shape[0], shape[1], shape[2]) > maxTexDim
}

// niivue's hard cap on GPU bytes for a chunked (tiled) volume — mirrors the
// CHUNKED_VOLUME_BYTE_CAP constant in its gl/render.ts and wgpu backend.
// Past this, loadVolumes throws "too large to render" on every machine.
const CHUNKED_VOLUME_BYTE_CAP = 1_500_000_000

function bytesPerVoxel(dtype: string): number {
  switch (dtype) {
    case 'uint8':
    case 'int8':
      return 1
    case 'uint16':
    case 'int16':
      return 2
    case 'uint32':
    case 'int32':
    case 'float32':
      return 4
    case 'float64':
      return 8
    case 'rgb24':
      return 3 // DICOM-WSI colour; uploaded as RGBA8 (4B) on the GPU
    default:
      return 2
  }
}

// True when a full-level load would blow niivue's chunked-volume memory cap.
// Those levels are still usable in this demo; they go through bbox subvolume
// URLs so neither the server nor niivue materialises the full native level.
function levelTooLargeToRender(
  shape: [number, number, number],
  dtype: string,
): boolean {
  if (!levelOversized(shape)) return false
  return estimateRenderBytes(shape, dtype) > CHUNKED_VOLUME_BYTE_CAP
}

function estimateRenderBytes(
  shape: [number, number, number],
  dtype: string,
): number {
  const voxels = shape[0] * shape[1] * shape[2]
  return voxels * (bytesPerVoxel(dtype) + 8)
}

function levelNeedsSubvolume(
  shape: [number, number, number],
  dtype: string,
): boolean {
  return (
    levelTooLargeToRender(shape, dtype) ||
    estimateRenderBytes(shape, dtype) > FULL_LEVEL_RENDER_BYTE_BUDGET
  )
}

function canStreamWholeLevel(shape: [number, number, number]): boolean {
  return (
    Math.max(shape[0], shape[1], shape[2]) > STREAMING_CHUNK_EDGE &&
    estimateStreamingChunkCount(shape) <= STREAMING_CHUNK_LIMIT
  )
}

function estimateStreamingChunkCount(shape: [number, number, number]): number {
  const grid = estimateStreamingGrid(shape)
  return grid[0] * grid[1] * grid[2]
}

function populateVolumeSelect(): void {
  els.volume.innerHTML = ''
  for (const v of volumes) {
    const opt = document.createElement('option')
    opt.value = v.id
    const levelCount = v.levels?.length ?? 1
    opt.textContent = `${v.id} (${v.shape.join('×')}, ${v.dtype}, ${levelCount} level${levelCount === 1 ? '' : 's'})`
    els.volume.appendChild(opt)
  }
}

function readInitialVolumeId(): string {
  const params = new URLSearchParams(window.location.search)
  const wanted = params.get('id')
  if (wanted && volumes.some((v) => v.id === wanted)) return wanted
  if (volumes.some((v) => v.id === DEFAULT_OME_ZARR_ID)) {
    return DEFAULT_OME_ZARR_ID
  }
  return volumes[0]?.id ?? ''
}

async function selectVolume(id: string): Promise<void> {
  const found = volumes.find((v) => v.id === id)
  if (!found) return
  // Window and bbox are voxel-range / index specific to one volume. Carrying
  // them to a different volume renders nothing (e.g. a uint16 window on a
  // uint8 volume puts every voxel below calMin). Clear them so the new
  // volume gets its own auto-window on first paint.
  els.window.value = ''
  els.bbox.value = ''
  autoBboxValue = null
  lastSubvolumeLabel = null
  populateLevelSelect(found)
  populateSubvolumeSelect(found)
  applySubvolumeSelection(found)
  renderExplodePlan(found)
  await reload()
}

function populateLevelSelect(v: VolumeApiEntry): void {
  els.level.innerHTML = ''
  const lvls = v.levels?.length
    ? v.levels
    : [
        {
          level: 0,
          shape: v.shape,
          spacing: v.spacing,
          bytes: null,
        },
      ]
  for (const l of lvls) {
    const opt = document.createElement('option')
    opt.value = String(l.level)
    let tag = ''
    if (levelTooLargeToRender(l.shape, v.dtype)) tag = ' · huge'
    else if (levelNeedsSubvolume(l.shape, v.dtype)) tag = ' · use subvol'
    else if (levelOversized(l.shape)) tag = ' · large, slow'
    opt.textContent = `L${l.level} · ${l.shape.join('×')}${tag}`
    els.level.appendChild(opt)
  }
  // Lazy load: start at the coarsest level so even multi-GB volumes paint
  // immediately. A background upgrade in reload() refines to a comfortable
  // level once the first frame is on-screen.
  const coarsest = lvls[lvls.length - 1]?.level ?? 0
  els.level.value = String(coarsest)
}

function populateSubvolumeSelect(v: VolumeApiEntry | null): void {
  els.subvolume.innerHTML = ''
  if (!v) return
  const shape = currentLevelShape(v) ?? v.shape
  const needsSubvolume = levelNeedsSubvolume(shape, v.dtype)
  const canStream = canStreamWholeLevel(shape)
  const hasPyramid = (v.levels?.length ?? 0) > 1
  if (hasPyramid) {
    addSubvolumeOption('multilod', 'multi-resolution (focus + coarse surround)')
  }
  if (canStream) {
    addSubvolumeOption(
      'stream',
      `whole level · streamed ${STREAMING_CHUNK_EDGE}³ bricks`,
    )
  }
  addSubvolumeOption(
    'full',
    needsSubvolume ? 'full level legacy · may pause' : 'full level',
  )
  const focusEdge = chooseAutoSubvolumeEdge(shape, v.dtype)
  addSubvolumeOption('focus', `focus ${focusEdge}³`)

  const header = document.createElement('option')
  header.disabled = true
  header.textContent = '3×3 grid'
  els.subvolume.appendChild(header)

  for (let i = 0; i < GRID_SUBVOLUME_DIVS * GRID_SUBVOLUME_DIVS; i++) {
    const bbox = buildGridSubvolumeBbox(shape, i)
    const size = bboxSize(bbox)
    const pct = (
      (100 * size[0] * size[1] * size[2]) /
      voxelCount(shape)
    ).toFixed(1)
    addSubvolumeOption(`tile:${i}`, gridSubvolumeLabel(shape, i, size, pct))
  }

  els.subvolume.value = hasPyramid
    ? 'multilod'
    : needsSubvolume
      ? canStream
        ? 'stream'
        : 'focus'
      : 'full'
}

function addSubvolumeOption(value: string, text: string): void {
  const opt = document.createElement('option')
  opt.value = value
  opt.textContent = text
  els.subvolume.appendChild(opt)
}

function currentVolume(): VolumeApiEntry | null {
  return volumes.find((v) => v.id === els.volume.value) ?? null
}

function isStreamingMode(): boolean {
  return els.subvolume.value === 'stream'
}

function currentChunkExplode(): VolumeChunkExplode | undefined {
  if (!els.explodedToggle.checked) return undefined
  return {
    enabled: true,
    scale: [
      readExplodeScale(els.explodeEx),
      readExplodeScale(els.explodeEy),
      readExplodeScale(els.explodeEz),
    ],
  }
}

function readExplodeScale(input: HTMLInputElement): number {
  const value = Number(input.value)
  if (!Number.isFinite(value)) return 1
  return Math.max(1, value)
}

function shouldUseExplodedGrid(shape: Shape3, bbox: Bbox6 | null): boolean {
  return !bbox && els.explodedToggle.checked && canUseExplodedGrid(shape)
}

function canUseExplodedGrid(shape: Shape3): boolean {
  return explodedGridDimsForShape(shape) !== null
}

function createExplodedGridPlan(
  shape: Shape3,
): NonNullable<NVImage['chunkPlan']> {
  const gridDims = explodedGridDimsForShape(shape)
  if (!gridDims) {
    throw new Error(`No exploded grid fits shape ${shape.join('×')}`)
  }
  return chunkVolumeGrid(
    shape,
    gridDims,
    STREAMING_CHUNK_EDGE,
    STREAMING_CHUNK_HALO,
  )
}

function explodedGridDimsForShape(shape: Shape3): Shape3 | null {
  const longest = Math.max(shape[0], shape[1], shape[2])
  const gridDims: Shape3 = [
    aspectBlockCount(shape[0], longest),
    aspectBlockCount(shape[1], longest),
    aspectBlockCount(shape[2], longest),
  ]
  while (!explodedGridFits(shape, gridDims)) {
    if (blockCount(gridDims) >= STREAMING_CHUNK_LIMIT) return null
    const axis = axisNeedingMoreBlocks(shape, gridDims)
    if (gridDims[axis] >= shape[axis]) return null
    gridDims[axis] += 1
    if (blockCount(gridDims) > STREAMING_CHUNK_LIMIT) return null
  }
  return gridDims
}

function aspectBlockCount(dim: number, longest: number): number {
  if (longest <= 0) return 1
  return clampInt(
    Math.round((dim / longest) * EXPLODED_GRID_LONG_AXIS_BLOCKS),
    1,
    dim,
  )
}

function axisNeedingMoreBlocks(shape: Shape3, gridDims: Shape3): 0 | 1 | 2 {
  let axis: 0 | 1 | 2 = 0
  let worst = Number.NEGATIVE_INFINITY
  for (const a of [0, 1, 2] as const) {
    const texDim = explodedGridMaxTexDim(shape, gridDims, a)
    const overage = texDim - STREAMING_CHUNK_EDGE
    if (overage <= 0) continue
    const blockDim = shape[a] / gridDims[a]
    const score = overage + blockDim * 0.001
    if (score > worst) {
      axis = a
      worst = score
    }
  }
  return axis
}

function explodedGridFits(shape: Shape3, gridDims: Shape3): boolean {
  for (const a of [0, 1, 2] as const) {
    if (gridDims[a] < 1 || gridDims[a] > shape[a]) return false
    if (explodedGridMaxTexDim(shape, gridDims, a) > STREAMING_CHUNK_EDGE) {
      return false
    }
  }
  return true
}

function explodedGridMaxTexDim(
  shape: Shape3,
  gridDims: Shape3,
  axis: 0 | 1 | 2,
): number {
  const stride = Math.ceil(shape[axis] / gridDims[axis])
  let halo = 0
  if (gridDims[axis] === 2) halo = STREAMING_CHUNK_HALO[axis]
  else if (gridDims[axis] > 2) halo = 2 * STREAMING_CHUNK_HALO[axis]
  return stride + halo
}

function blockCount(gridDims: Shape3): number {
  return gridDims[0] * gridDims[1] * gridDims[2]
}

function applyExplodeToLoadedVolume(): void {
  syncExplodeLabels()
  const v = currentVolume()
  renderExplodePlan(v)
  if (!nv) return
  const vol = nv.volumes[0]
  if (vol) {
    vol.chunkExplode = currentChunkExplode()
  }
  if (v) renderHud(v, Number(els.level.value))
  nv.drawScene()
}

function syncExplodeLabels(): void {
  el<HTMLSpanElement>('valEx').textContent = els.explodeEx.value
  el<HTMLSpanElement>('valEy').textContent = els.explodeEy.value
  el<HTMLSpanElement>('valEz').textContent = els.explodeEz.value
}

function renderExplodePlan(v: VolumeApiEntry | null): void {
  if (!v) {
    els.explodePlan.textContent = ''
    return
  }
  const shape = currentLevelShape(v) ?? v.shape
  const bbox = parseBbox(els.bbox.value)
  if (shouldUseExplodedGrid(shape, bbox)) {
    const grid = explodedGridDimsForShape(shape) ?? [1, 1, 1]
    els.explodePlan.textContent = `${grid.join('×')} = ${blockCount(grid)} blocks`
    return
  }
  if (bbox && els.explodedToggle.checked && canUseExplodedGrid(shape)) {
    const grid = explodedGridDimsForShape(shape) ?? [1, 1, 1]
    els.explodePlan.textContent = `clear subvol for ${grid.join('×')} blocks`
    return
  }
  if (!isStreamingMode()) {
    const grid = explodedGridDimsForShape(shape)
    els.explodePlan.textContent = grid
      ? `${grid.join('×')} blocks when exploded`
      : 'streamed bricks only'
    return
  }
  const grid = estimateStreamingGrid(shape)
  const total = grid[0] * grid[1] * grid[2]
  els.explodePlan.textContent = els.explodedToggle.checked
    ? `${grid.join('×')} = ${total} bricks`
    : `${grid.join('×')} streamed bricks`
}

function estimateStreamingGrid(shape: Shape3): Shape3 {
  return [
    Math.ceil(
      shape[0] /
        Math.max(1, STREAMING_CHUNK_EDGE - 2 * STREAMING_CHUNK_HALO[0]),
    ),
    Math.ceil(
      shape[1] /
        Math.max(1, STREAMING_CHUNK_EDGE - 2 * STREAMING_CHUNK_HALO[1]),
    ),
    Math.ceil(
      shape[2] /
        Math.max(1, STREAMING_CHUNK_EDGE - 2 * STREAMING_CHUNK_HALO[2]),
    ),
  ]
}

async function ensureNiivue(): Promise<void> {
  if (nv) return
  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0, 0, 0, 1],
    isColorbarVisible: true,
    is3DCrosshairVisible: true,
    isDragDropEnabled: false,
    maxTextureDimension3D: STREAMING_CHUNK_EDGE,
    meshXRay: 0,
  })
  nv.opts.isDragDropEnabled = false
  await nv.attachToCanvas(els.canvas)

  // locationChange emits whenever the crosshair moves — niivue snaps it
  // to the click point. We just cache the voxel coords for shift-click
  // fetches; the actual fetch fires from the canvas click handler so the
  // user has explicit intent (not every locationChange should re-fetch).
  nv.addEventListener('locationChange', (evt: Event) => {
    const detail = (evt as CustomEvent<{ vox?: number[] }>).detail
    const vox = detail?.vox
    if (Array.isArray(vox) && vox.length >= 3) {
      rememberFocusFromVoxel([vox[0] ?? 0, vox[1] ?? 0, vox[2] ?? 0])
      // In multi-resolution mode, move the finest bricks to the new look-at
      // point once the crosshair settles.
      scheduleMultiLodRefocus()
    }
  })

  // Wheel events on the canvas drive niivue's own zoom. We listen on the
  // capture phase so our debounce kicks off even while niivue is still
  // processing the event. The actual evaluation runs after a quiet
  // period — otherwise a single scroll gesture triggers ~10 level
  // swaps, each cancelling the prior fetch.
  els.canvas.addEventListener('wheel', scheduleAutoLod, { passive: true })

  // Wheel drives niivue's zoom directly. Mirror the post-wheel value into the
  // zoom slider so the UI tracks the camera. Pan/orientation are slider- or
  // drag-driven respectively; there's no wheel/drag path that changes pan.
  els.canvas.addEventListener(
    'wheel',
    () => {
      requestAnimationFrame(syncCameraSliders)
    },
    { passive: true },
  )

  // Shift-click anywhere on the canvas pulls a 128³ slab at L0 centered
  // on the click. Use the most recent locationChange coords — niivue
  // updates these on mousedown, so they're current by click time.
  els.canvas.addEventListener('click', (evt: MouseEvent) => {
    if (!evt.shiftKey) return
    void fetchSlabAtCursor()
  })
}

async function reload(): Promise<void> {
  // User-driven reload — invalidate any pending background upgrade and
  // bump the epoch so an in-flight upgrade discards its result.
  cancelUpgrade()
  reloadEpoch += 1
  const myEpoch = reloadEpoch
  const v = currentVolume()
  if (!v || !nv) return
  const level = Number(els.level.value)
  const bbox = parseBbox(els.bbox.value)
  const shape = currentLevelShape(v) ?? v.shape
  // Multi-resolution mode owns its own octree of bricks; the explode toggle
  // spreads THOSE bricks (not a single-level grid), so it must be handled here
  // before the legacy exploded-grid / stream path.
  if (els.subvolume.value === 'multilod') {
    await reloadMultiLod(v, myEpoch)
    return
  }
  const explodedGrid = shouldUseExplodedGrid(shape, bbox)
  const streaming = isStreamingMode() || explodedGrid
  const loadingSubvolume = Boolean(bbox)
  const oversized = !loadingSubvolume && levelOversized(shape)
  if (streaming) {
    await reloadStreamingLevel(v, level, shape, myEpoch)
    return
  }
  setBusy(
    loadingSubvolume
      ? `loading L${level} subvolume…`
      : oversized
        ? `loading L${level} — large, please wait…`
        : `loading L${level}…`,
  )
  const bboxQuery = bbox ? `&bbox=${bbox.join(',')}` : ''
  const url = `${baseUrl}/volumes/${encodeURIComponent(v.id)}/raw.nii.gz?level=${level}${bboxQuery}`
  reloading = true
  let stats: LoadStats
  try {
    stats = await measureLoad(url)
  } catch (err) {
    reloading = false
    if (myEpoch === reloadEpoch) setBusy(null)
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(msg)
    return
  }
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  lastStats = stats

  // The bytes are now in cache; what remains — decode, RGBA build, GPU
  // upload — runs synchronously and freezes the page. Switch the badge to
  // say so and yield a frame so the message paints before the freeze.
  setBusy(
    loadingSubvolume
      ? `rendering L${level} subvolume…`
      : oversized
        ? `rendering L${level} — large volume, the page will pause briefly…`
        : `rendering L${level}…`,
  )
  await yieldPaint()
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }

  // Reload via the URL so niivue's pipeline (fetch → decode → upload) runs.
  // The measured timings above are a parallel fetch we use just to surface
  // bytes/decode time in the HUD; niivue refetches from cache.
  const colormap = els.colormap.value || 'gray'
  const win = parseWindow(els.window.value)
  const opts: {
    url: string
    colormap: string
    calMin?: number
    calMax?: number
  } = { url, colormap }
  if (win) {
    opts.calMin = win.min
    opts.calMax = win.max
  }
  try {
    await nv.loadVolumes([opts])
    if (myEpoch !== reloadEpoch) {
      reloading = false
      return
    }
    const vol = nv.volumes[0]
    if (vol) {
      vol.chunkExplode = currentChunkExplode()
    }
    nv.sliceType = 4
    loadedLevelShape = shape
    loadedBbox = bbox
    showCanvas()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(`niivue failed to load level ${level}: ${msg}`)
    reloading = false
    if (myEpoch === reloadEpoch) setBusy(null)
    return
  }
  // First paint of a volume: niivue auto-calibrated a wide 2-98% window
  // that renders the low-intensity matrix as translucent haze, dulling the
  // whole image. Re-window onto the upper half of the robust range so dense
  // structure reads as bright. setVolume rebuilds the RGBA texture from the
  // already-decoded image — no second fetch/decode, unlike a full reload().
  // Skipped if the user set a window.
  if (!autoWindowed.has(v.id) && !els.window.value && nv.volumes[0]) {
    autoWindowed.add(v.id)
    const w = punchyWindow(nv.volumes[0])
    if (w) {
      els.window.value = `${w.min},${w.max}`
      setBusy(`rendering L${level}${loadingSubvolume ? ' subvolume' : ''}…`)
      await yieldPaint()
      await nv.setVolume(0, { calMin: w.min, calMax: w.max })
      if (myEpoch !== reloadEpoch) {
        reloading = false
        return
      }
    }
  }
  renderHud(v, level)
  reloading = false
  setBusy(null)
  // loadVolumes can reset the camera/zoom, so the sliders may now be stale.
  syncCameraSliders()
  scheduleProgressiveUpgrade(v, level)
}

async function reloadStreamingLevel(
  v: VolumeApiEntry,
  level: number,
  shape: [number, number, number],
  myEpoch: number,
): Promise<void> {
  if (!nv) return
  reloading = true
  lastStats = null
  const explodedGrid = explodedGridDimsForShape(shape)
  setBusy(
    els.explodedToggle.checked && explodedGrid
      ? `streaming L${level} ${explodedGrid.join('×')} exploded blocks…`
      : `streaming L${level} visible bricks…`,
  )
  await yieldPaint()
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  await ensureStreamingWindow(v)
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  const volume = createStreamingVolume(v, level, shape)
  try {
    await nv.loadVolumes([volume])
    if (myEpoch !== reloadEpoch) {
      reloading = false
      return
    }
    nv.sliceType = 4
    loadedLevelShape = shape
    loadedBbox = null
    showCanvas()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(`niivue failed to stream level ${level}: ${msg}`)
    reloading = false
    if (myEpoch === reloadEpoch) setBusy(null)
    return
  }
  renderHud(v, level)
  reloading = false
  setBusy(null)
  syncCameraSliders()
}

// Multi-resolution render: stream a single heterogeneous octree of bricks that
// covers the whole volume — finest at the focus, coarser outward.
async function reloadMultiLod(
  v: VolumeApiEntry,
  myEpoch: number,
  preserveView = false,
): Promise<void> {
  if (!nv) return
  reloading = true
  lastStats = null
  setBusy('streaming multi-resolution bricks…')
  await yieldPaint()
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  // Resident coarse level powers both the auto-window and the surface-pick march.
  await ensureCoarsePickData(v)
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  await ensureStreamingWindow(v)
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  const volume = createMultiLodVolume(v)
  if (!volume) {
    showFallback('multi-resolution mode needs a multiscale pyramid')
    reloading = false
    if (myEpoch === reloadEpoch) setBusy(null)
    return
  }
  // Refocus reloads should not snap the camera or crosshair back to centre —
  // capture them before loadVolumes (which resets the view) and restore after.
  const cam = preserveView ? captureView() : null
  try {
    await nv.loadVolumes([volume])
    if (myEpoch !== reloadEpoch) {
      reloading = false
      return
    }
    nv.sliceType = 4
    if (cam) restoreView(cam)
    loadedLevelShape = (volume.dimsRAS?.slice(1, 4) as Shape3) ?? null
    loadedBbox = null
    showCanvas()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(`niivue failed to stream multi-resolution: ${msg}`)
    reloading = false
    if (myEpoch === reloadEpoch) setBusy(null)
    return
  }
  renderHud(v, 0)
  reloading = false
  setBusy(null)
  syncCameraSliders()
}

interface ViewState {
  azimuth: number
  elevation: number
  scale: number
  crosshair: [number, number, number]
}

type CameraView = {
  azimuth: number
  elevation: number
  scaleMultiplier: number
  crosshairPos: ArrayLike<number>
}

function captureView(): ViewState | null {
  if (!nv) return null
  const n = nv as unknown as CameraView
  const c = n.crosshairPos
  return {
    azimuth: n.azimuth,
    elevation: n.elevation,
    scale: n.scaleMultiplier,
    crosshair: [c[0] ?? 0.5, c[1] ?? 0.5, c[2] ?? 0.5],
  }
}

function restoreView(s: ViewState): void {
  if (!nv) return
  const n = nv as unknown as CameraView
  n.azimuth = s.azimuth
  n.elevation = s.elevation
  n.scaleMultiplier = s.scale
  n.crosshairPos = s.crosshair
}

// Re-stream the multi-LOD octree centred on the new crosshair after the user
// stops moving it, so the finest bricks follow the look-at point. Debounced
// (one rebuild per gesture) and view-preserving (camera/crosshair are kept).
let refocusTimer: ReturnType<typeof setTimeout> | null = null
function scheduleMultiLodRefocus(): void {
  if (els.subvolume.value !== 'multilod') return
  if (refocusTimer !== null) clearTimeout(refocusTimer)
  refocusTimer = setTimeout(() => {
    refocusTimer = null
    if (!nv || reloading || els.subvolume.value !== 'multilod') return
    const v = currentVolume()
    if (!v) return
    reloadEpoch += 1
    void reloadMultiLod(v, reloadEpoch, true)
  }, 300)
}

function createStreamingVolume(
  v: VolumeApiEntry,
  level: number,
  shape: [number, number, number],
  planOverride?: ChunkPlan,
): NVImage {
  const lvl = v.levels?.find((l) => l.level === level)
  const spacing = lvl?.spacing ?? v.spacing
  const dtype = niftiDatatype(v.dtype)
  const win = parseWindow(els.window.value)
  const calMin = win?.min ?? dtype.displayMin
  const calMax = win?.max ?? dtype.displayMax
  const dims = [3, shape[0], shape[1], shape[2], 1, 1, 1, 1]
  const pixDims = [1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1]
  const chunkPlan =
    planOverride ??
    (shouldUseExplodedGrid(shape, null)
      ? createExplodedGridPlan(shape)
      : undefined)
  const planKey = planOverride
    ? `multilod-${planOverride.chunks.length}`
    : chunkPlan
      ? `grid-${chunkPlan.gridDims.join('x')}`
      : `edge-${STREAMING_CHUNK_EDGE}`
  const affine = [
    [spacing[0], 0, 0, 0],
    [0, spacing[1], 0, 0],
    [0, 0, spacing[2], 0],
    [0, 0, 0, 1],
  ]
  const dimsMM: Shape3 = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ]
  const longestAxis = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
  const matRAS = new Float32Array([
    spacing[0],
    0,
    0,
    0,
    0,
    spacing[1],
    0,
    0,
    0,
    0,
    spacing[2],
    0,
    0,
    0,
    0,
    1,
  ])
  const frac2mm = new Float32Array([
    dimsMM[0],
    0,
    0,
    0,
    0,
    dimsMM[1],
    0,
    0,
    0,
    0,
    dimsMM[2],
    0,
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
    1,
  ])
  const identity = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ])
  const chunkCache = new Map<number, Promise<Uint8Array>>()
  const chunkSource: VolumeChunkSource = (request) => {
    const cached = chunkCache.get(request.chunkIndex)
    if (cached) return cached
    // Multi-LOD bricks each carry their own pyramid level; single-level plans
    // leave sourceLevel undefined and fall back to this volume's level.
    const brickLevel = request.desc.sourceLevel ?? level
    const next = fetchRawChunk(
      v.id,
      brickLevel,
      request.desc,
      request.bytesPerVoxel,
    )
    chunkCache.set(request.chunkIndex, next)
    return next
  }
  const name = `${v.id} L${level} streamed`
  const url = `omezarr-stream://${encodeURIComponent(v.id)}/L${level}?plan=${planKey}&cm=${encodeURIComponent(els.colormap.value)}&w=${encodeURIComponent(els.window.value)}`
  return {
    name,
    id: name,
    url,
    img: null,
    hdr: {
      littleEndian: true,
      dim_info: 0,
      dims,
      pixDims,
      intent_p1: 0,
      intent_p2: 0,
      intent_p3: 0,
      intent_code: 0,
      datatypeCode: dtype.code,
      numBitsPerVoxel: dtype.bits,
      slice_start: 0,
      vox_offset: 352,
      scl_slope: 1,
      scl_inter: 0,
      slice_end: 0,
      slice_code: 0,
      xyzt_units: 10,
      cal_max: calMax,
      cal_min: calMin,
      slice_duration: 0,
      toffset: 0,
      description: 'OME-Zarr streamed logical volume',
      aux_file: '',
      qform_code: 0,
      sform_code: 1,
      quatern_b: 0,
      quatern_c: 0,
      quatern_d: 0,
      qoffset_x: 0,
      qoffset_y: 0,
      qoffset_z: 0,
      affine,
      intent_name: '',
      magic: 'n+1',
    },
    originalAffine: affine.map((row) => [...row]),
    dims: dims.slice(0, 4),
    nVox3D: voxelCount(shape),
    extentsMin: [-0.5 * spacing[0], -0.5 * spacing[1], -0.5 * spacing[2]],
    extentsMax: [
      (shape[0] - 0.5) * spacing[0],
      (shape[1] - 0.5) * spacing[1],
      (shape[2] - 0.5) * spacing[2],
    ],
    calMin,
    calMax,
    robustMin: calMin,
    robustMax: calMax,
    globalMin: dtype.displayMin,
    globalMax: dtype.displayMax,
    pixDimsRAS: pixDims.slice(0, 4),
    dimsRAS: dims.slice(0, 4),
    permRAS: [1, 2, 3],
    matRAS,
    obliqueRAS: identity,
    frac2mm,
    frac2mmOrtho: frac2mm,
    extentsMinOrtho: [-0.5 * spacing[0], -0.5 * spacing[1], -0.5 * spacing[2]],
    extentsMaxOrtho: [
      (shape[0] - 0.5) * spacing[0],
      (shape[1] - 0.5) * spacing[1],
      (shape[2] - 0.5) * spacing[2],
    ],
    mm2ortho: identity,
    img2RASstep: [1, shape[0], shape[0] * shape[1]],
    img2RASstart: [0, 0, 0],
    toRAS: identity,
    toRASvox: identity,
    mm000: [-0.5 * spacing[0], -0.5 * spacing[1], -0.5 * spacing[2]],
    mm100: [
      (shape[0] - 0.5) * spacing[0],
      -0.5 * spacing[1],
      -0.5 * spacing[2],
    ],
    mm010: [
      -0.5 * spacing[0],
      (shape[1] - 0.5) * spacing[1],
      -0.5 * spacing[2],
    ],
    mm001: [
      -0.5 * spacing[0],
      -0.5 * spacing[1],
      (shape[2] - 0.5) * spacing[2],
    ],
    oblique_angle: 0,
    maxShearDeg: 0,
    volScale: [
      dimsMM[0] / longestAxis,
      dimsMM[1] / longestAxis,
      dimsMM[2] / longestAxis,
    ],
    frame4D: 0,
    nFrame4D: 1,
    nTotalFrame4D: 1,
    colormap: els.colormap.value || 'gray',
    isTransparentBelowCalMin: true,
    opacity: 1,
    modulateAlpha: 0,
    isColorbarVisible: true,
    isLegendVisible: false,
    colormapLabel: null,
    chunkPlan,
    chunkSource,
    chunkExplode: currentChunkExplode(),
  } as NVImage
}

// GPU byte budget for the resident multi-LOD brick set; ?budgetGB overrides.
function multiLodBudgetBytes(): number {
  const gb = Number(initialParams.get('budgetGB'))
  if (Number.isFinite(gb) && gb > 0) return Math.round(gb * 1024 * 1024 * 1024)
  return MULTILOD_DEFAULT_BUDGET_BYTES
}

// Build the heterogeneous multi-LOD chunk plan for a volume's pyramid. The
// finest available level is the common reference grid; bricks within `radius`
// (finest voxels) of `focusCenter` render at the finest level, coarsening
// outward. `focusCenter` defaults to the volume centre (Stage 1); later stages
// drive it from the crosshair / visible slice extents.
function buildMultiLodPlan(
  v: VolumeApiEntry,
  focusCenter?: Shape3,
): ChunkPlan | null {
  const levels = (v.levels ?? []).slice().sort((a, b) => a.level - b.level)
  if (levels.length === 0) return null
  const levelDims = levels.map((l) => l.shape)
  const commonShape = levelDims[0]
  // Focus on the crosshair / look-at point (cached as a [0,1] fraction of the
  // common grid by locationChange) so the finest bricks sit where the user is
  // looking; fall back to the volume centre before the first interaction.
  const center: Shape3 =
    focusCenter ??
    (lastFocusFrac
      ? [
          lastFocusFrac[0] * commonShape[0],
          lastFocusFrac[1] * commonShape[1],
          lastFocusFrac[2] * commonShape[2],
        ]
      : [commonShape[0] / 2, commonShape[1] / 2, commonShape[2] / 2])
  const radius = MULTILOD_CELL_EDGE * 1.5
  return chunkVolumeMultiLOD(levelDims, { center, radius }, readMaxTexDim(), {
    cellEdge: MULTILOD_CELL_EDGE,
    haloSize: MULTILOD_HALO,
    budgetBytes: multiLodBudgetBytes(),
  })
}

// Create a streaming NVImage whose chunk plan is the multi-LOD octree. Geometry
// is built from the finest (common) grid; each brick fetches from its own level
// via desc.sourceLevel in createStreamingVolume's chunkSource.
function createMultiLodVolume(
  v: VolumeApiEntry,
  focusCenter?: Shape3,
): NVImage | null {
  const plan = buildMultiLodPlan(v, focusCenter)
  if (!plan) return null
  const commonShape = plan.volumeDims as Shape3
  const vol = createStreamingVolume(v, 0, commonShape, plan)
  // Window-aware surface pick: depth-pick marches this coarse sampler to the
  // first visible voxel under the cursor (see ensureCoarsePickData).
  vol.pickSampler = makeCoarsePickSampler(v)
  return vol
}

// A scalar view over raw.bin bytes for the given dtype (little-endian, matching
// the typed arrays on x86/ARM). Colour (rgb24) has no meaningful scalar window.
function streamScalarView(
  buf: ArrayBuffer,
  dtype: string,
): ArrayLike<number> | null {
  switch (dtype) {
    case 'uint8':
      return new Uint8Array(buf)
    case 'int8':
      return new Int8Array(buf)
    case 'uint16':
      return new Uint16Array(buf)
    case 'int16':
      return new Int16Array(buf)
    case 'uint32':
      return new Uint32Array(buf)
    case 'int32':
      return new Int32Array(buf)
    case 'float32':
      return new Float32Array(buf)
    case 'rgb24':
      return null
    default:
      return new Uint16Array(buf)
  }
}

// The coarsest pyramid level, resident in memory. Reused for the auto-window
// percentiles AND the depth-pick surface march (first window-visible voxel).
let coarsePick: {
  id: string
  data: ArrayLike<number>
  shape: Shape3
  extentsMin: Shape3
  extentsMax: Shape3
} | null = null

// Fetch + cache the coarsest level for `v` (once per volume). The mm box uses
// the FINEST grid (the multi-LOD volume's geometry), since the coarse level
// covers the same physical extent.
async function ensureCoarsePickData(v: VolumeApiEntry): Promise<void> {
  if (coarsePick?.id === v.id) return
  const levels = (v.levels ?? []).slice().sort((a, b) => a.level - b.level)
  if (levels.length === 0) return
  const finest = levels[0]
  const coarse = levels[levels.length - 1]
  const [sx, sy, sz] = coarse.shape
  const url = `${baseUrl}/volumes/${encodeURIComponent(v.id)}/raw.bin?level=${coarse.level}&bbox=0,0,0,${sx},${sy},${sz}`
  try {
    const res = await fetch(url)
    if (!res.ok) return
    const data = streamScalarView(await res.arrayBuffer(), v.dtype)
    if (!data || data.length === 0) return
    const fsp = finest.spacing
    const fsh = finest.shape
    coarsePick = {
      id: v.id,
      data,
      shape: coarse.shape,
      extentsMin: [-0.5 * fsp[0], -0.5 * fsp[1], -0.5 * fsp[2]],
      extentsMax: [
        (fsh[0] - 0.5) * fsp[0],
        (fsh[1] - 0.5) * fsp[1],
        (fsh[2] - 0.5) * fsp[2],
      ],
    }
  } catch {
    // leave coarsePick as-is; pick falls back to the bounding-box surface
  }
}

// A window-aware value lookup in world mm over the resident coarse level, used
// by the depth-pick surface march. Returns the voxel value when visible (>=
// calMin), else 0 (transparent). Reads the current window each call so it tracks
// window edits.
function makeCoarsePickSampler(
  v: VolumeApiEntry,
): ((x: number, y: number, z: number) => number) | undefined {
  const cp = coarsePick
  if (!cp || cp.id !== v.id) return undefined
  const { data, shape, extentsMin, extentsMax } = cp
  const [cs0, cs1, cs2] = shape
  const sx = extentsMax[0] - extentsMin[0] || 1
  const sy = extentsMax[1] - extentsMin[1] || 1
  const sz = extentsMax[2] - extentsMin[2] || 1
  const fallbackMin = niftiDatatype(v.dtype).displayMin
  return (x, y, z) => {
    const fx = (x - extentsMin[0]) / sx
    const fy = (y - extentsMin[1]) / sy
    const fz = (z - extentsMin[2]) / sz
    if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1 || fz < 0 || fz >= 1) return 0
    const vx = Math.min(cs0 - 1, Math.floor(fx * cs0))
    const vy = Math.min(cs1 - 1, Math.floor(fy * cs1))
    const vz = Math.min(cs2 - 1, Math.floor(fz * cs2))
    const value = data[vx + vy * cs0 + vz * cs0 * cs1]
    const calMin = parseWindow(els.window.value)?.min ?? fallbackMin
    return value >= calMin && value > 0 ? value : 0
  }
}

// Data-driven display window for a streamed volume: the full image is never in
// memory, so sample the (tiny) resident coarsest level and take robust
// percentiles. p80 as the low end pushes the bulk background/matrix below
// calMin (transparent), p99.5 as the high end avoids a few bright outliers
// blowing out the contrast — revealing the dense interior structure.
async function computeStreamingWindow(
  v: VolumeApiEntry,
): Promise<{ min: number; max: number } | null> {
  await ensureCoarsePickData(v)
  if (coarsePick?.id !== v.id) return null
  const view = coarsePick.data
  if (view.length === 0) return null
  // Subsample to cap the sort cost on large coarse levels.
  const stride = Math.max(1, Math.floor(view.length / 200_000))
  const samples: number[] = []
  for (let i = 0; i < view.length; i += stride) {
    const x = view[i]
    if (Number.isFinite(x)) samples.push(x)
  }
  if (samples.length === 0) return null
  samples.sort((a, b) => a - b)
  const pct = (p: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(p * (samples.length - 1)))]
  const min = Math.round(pct(0.8))
  const max = Math.round(pct(0.995))
  if (!(max > min)) return null
  return { min, max }
}

// Set a data-driven window for a streamed volume the first time it is shown,
// unless the user has typed one. Shared by the multi-LOD and legacy stream paths.
async function ensureStreamingWindow(v: VolumeApiEntry): Promise<void> {
  if (els.window.value || autoWindowed.has(v.id)) return
  const w = await computeStreamingWindow(v)
  if (!w) return
  autoWindowed.add(v.id)
  els.window.value = `${w.min},${w.max}`
}

async function fetchRawChunk(
  id: string,
  level: number,
  desc: { texOrigin: Shape3; texDims: Shape3 },
  bytesPerVoxel: number,
): Promise<Uint8Array> {
  const bbox: Bbox6 = [
    desc.texOrigin[0],
    desc.texOrigin[1],
    desc.texOrigin[2],
    desc.texOrigin[0] + desc.texDims[0],
    desc.texOrigin[1] + desc.texDims[1],
    desc.texOrigin[2] + desc.texDims[2],
  ]
  const url = `${baseUrl}/volumes/${encodeURIComponent(id)}/raw.bin?level=${level}&bbox=${bbox.join(',')}`
  const t0 = performance.now()
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  const buf = await res.arrayBuffer()
  const expectedBytes =
    desc.texDims[0] * desc.texDims[1] * desc.texDims[2] * bytesPerVoxel
  if (buf.byteLength !== expectedBytes) {
    throw new Error(
      `raw chunk ${bbox.join(',')} returned ${buf.byteLength} bytes, expected ${expectedBytes}`,
    )
  }
  lastStats = {
    bytes: (lastStats?.bytes ?? 0) + buf.byteLength,
    fetchMs: (lastStats?.fetchMs ?? 0) + (performance.now() - t0),
    decodeMs: 0,
  }
  return new Uint8Array(buf)
}

function niftiDatatype(dtype: string): {
  code: number
  bits: number
  displayMin: number
  displayMax: number
} {
  switch (dtype) {
    case 'uint8':
      return { code: 2, bits: 8, displayMin: 0, displayMax: 255 }
    case 'int8':
      return { code: 256, bits: 8, displayMin: -128, displayMax: 127 }
    case 'uint16':
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
    case 'int16':
      return { code: 4, bits: 16, displayMin: -32768, displayMax: 32767 }
    case 'uint32':
      return { code: 768, bits: 32, displayMin: 0, displayMax: 4294967295 }
    case 'int32':
      return {
        code: 8,
        bits: 32,
        displayMin: -2147483648,
        displayMax: 2147483647,
      }
    case 'float32':
      return { code: 16, bits: 32, displayMin: 0, displayMax: 1 }
    case 'rgb24':
      // DICOM-WSI colour: NIfTI DT_RGB24. niivue uploads it straight to RGBA8
      // (cal_min/max and colormap are ignored for colour volumes).
      return { code: 128, bits: 24, displayMin: 0, displayMax: 255 }
    default:
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
  }
}

function applySubvolumeSelection(v: VolumeApiEntry | null): void {
  if (!v) return
  const shape = currentLevelShape(v) ?? v.shape
  const mode = els.subvolume.value
  autoBboxValue = null
  lastSubvolumeLabel = null

  if (mode === 'full') {
    els.bbox.value = ''
    return
  }

  if (mode === 'stream') {
    els.bbox.value = ''
    lastSubvolumeLabel = `streamed ${STREAMING_CHUNK_EDGE}³ bricks`
    return
  }

  if (mode === 'focus') {
    const bbox = buildAutoSubvolumeBbox(shape, v.dtype)
    autoBboxValue = bbox.join(',')
    els.bbox.value = autoBboxValue
    lastSubvolumeLabel = `focus ${bboxSize(bbox).join('×')}`
    return
  }

  const tile = parseTileValue(mode)
  if (tile !== null) {
    const bbox = buildGridSubvolumeBbox(shape, tile)
    autoBboxValue = bbox.join(',')
    els.bbox.value = autoBboxValue
    lastSubvolumeLabel = `tile ${tile + 1}/9`
    return
  }

  if (mode === 'custom' && parseBbox(els.bbox.value)) {
    lastSubvolumeLabel = 'custom bbox'
  }
}

function buildAutoSubvolumeBbox(
  shape: [number, number, number],
  dtype: string,
): Bbox6 {
  const center = focusCenterForShape(shape)
  const edge = chooseAutoSubvolumeEdge(shape, dtype)
  return centeredBbox(shape, center, edge)
}

function chooseAutoSubvolumeEdge(
  shape: [number, number, number],
  dtype: string,
): number {
  let edge = Math.min(AUTO_SUBVOLUME_EDGE, ...shape)
  while (
    edge > 64 &&
    estimateRenderBytes([edge, edge, edge], dtype) >
      FULL_LEVEL_RENDER_BYTE_BUDGET
  ) {
    edge = Math.floor(edge * 0.8)
  }
  return Math.max(16, edge)
}

function focusCenterForShape(shape: [number, number, number]): Shape3 {
  const frac = lastFocusFrac ?? [0.5, 0.5, 0.5]
  return [
    clampInt(Math.floor(frac[0] * shape[0]), 0, shape[0] - 1),
    clampInt(Math.floor(frac[1] * shape[1]), 0, shape[1] - 1),
    clampInt(Math.floor(frac[2] * shape[2]), 0, shape[2] - 1),
  ]
}

function centeredBbox(
  shape: [number, number, number],
  center: [number, number, number],
  edge: number,
): Bbox6 {
  const spans = [0, 1, 2].map((axis) => {
    const size = Math.min(edge, shape[axis] ?? edge)
    const maxStart = Math.max(0, (shape[axis] ?? size) - size)
    const start = clampInt(
      Math.floor((center[axis] ?? 0) - size / 2),
      0,
      maxStart,
    )
    return [start, start + size] as const
  })
  return [
    spans[0][0],
    spans[1][0],
    spans[2][0],
    spans[0][1],
    spans[1][1],
    spans[2][1],
  ]
}

function bboxSize(bbox: Bbox6): Shape3 {
  return [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
}

function buildGridSubvolumeBbox(
  shape: [number, number, number],
  tile: number,
): Bbox6 {
  const [axisA, axisB] = gridAxes(shape)
  const i = tile % GRID_SUBVOLUME_DIVS
  const j = Math.floor(tile / GRID_SUBVOLUME_DIVS)
  const bbox: Bbox6 = [0, 0, 0, shape[0], shape[1], shape[2]]
  const a = partitionSpan(shape[axisA], GRID_SUBVOLUME_DIVS, i)
  const b = partitionSpan(shape[axisB], GRID_SUBVOLUME_DIVS, j)
  bbox[axisA] = a[0]
  bbox[axisA + 3] = a[1]
  bbox[axisB] = b[0]
  bbox[axisB + 3] = b[1]
  return bbox
}

function gridSubvolumeLabel(
  shape: [number, number, number],
  tile: number,
  size: [number, number, number],
  pct: string,
): string {
  const [axisA, axisB] = gridAxes(shape)
  const i = tile % GRID_SUBVOLUME_DIVS
  const j = Math.floor(tile / GRID_SUBVOLUME_DIVS)
  return `tile ${tile + 1}/9 · ${axisName(axisA)}${i + 1}/${axisName(axisB)}${j + 1} · ${size.join('×')} · ${pct}%`
}

function gridAxes(shape: [number, number, number]): [0 | 1 | 2, 0 | 1 | 2] {
  const axes: Array<0 | 1 | 2> = [0, 1, 2]
  axes.sort((a, b) => shape[b] - shape[a])
  return [axes[0] ?? 0, axes[1] ?? 1]
}

function axisName(axis: 0 | 1 | 2): string {
  return axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'
}

function partitionSpan(
  length: number,
  parts: number,
  index: number,
): [number, number] {
  const start = Math.floor((length * index) / parts)
  const end = Math.floor((length * (index + 1)) / parts)
  return [start, Math.max(start + 1, end)]
}

function parseTileValue(value: string): number | null {
  const match = /^tile:(\d+)$/.exec(value)
  if (!match) return null
  const tile = Number(match[1])
  if (!Number.isInteger(tile)) return null
  const max = GRID_SUBVOLUME_DIVS * GRID_SUBVOLUME_DIVS
  if (tile < 0 || tile >= max) return null
  return tile
}

function voxelCount(shape: [number, number, number]): number {
  return shape[0] * shape[1] * shape[2]
}

function rememberFocusFromVoxel(vox: [number, number, number]): void {
  if (!loadedLevelShape) return
  const ox = loadedBbox?.[0] ?? 0
  const oy = loadedBbox?.[1] ?? 0
  const oz = loadedBbox?.[2] ?? 0
  lastFocusFrac = [
    clamp01((ox + vox[0] + 0.5) / loadedLevelShape[0]),
    clamp01((oy + vox[1] + 0.5) / loadedLevelShape[1]),
    clamp01((oz + vox[2] + 0.5) / loadedLevelShape[2]),
  ]
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}

function clampInt(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo
  return Math.max(lo, Math.min(hi, value))
}

function clearAutoBbox(): void {
  if (autoBboxValue && els.bbox.value === autoBboxValue) {
    els.bbox.value = ''
  }
  autoBboxValue = null
  lastSubvolumeLabel = null
}

function markCustomSubvolume(label: string): void {
  autoBboxValue = null
  lastSubvolumeLabel = label
  const existing = [...els.subvolume.options].find((o) => o.value === 'custom')
  const opt = existing ?? document.createElement('option')
  opt.value = 'custom'
  opt.textContent = label
  if (!existing) els.subvolume.appendChild(opt)
  els.subvolume.value = 'custom'
}

// Drive niivue's 3D zoom from the slider. Independent of mouse interactions,
// so the user can keep zooming even while a right-click clip-plane drag is
// in progress. The setter triggers drawScene; we also kick auto-LOD so the
// pyramid level catches up.
function applyZoomFromSlider(): void {
  if (!nv) return
  const v = Number(els.zoom.value)
  if (!Number.isFinite(v) || v <= 0) return
  ;(nv as unknown as { scaleMultiplier: number }).scaleMultiplier = v
  scheduleAutoLod()
}

// Drive niivue's 3D pan from the panX/panY sliders. nv.renderPan is a
// clip-space translation applied after projection, so the values are in NDC
// units ([-1, 1] spans the full viewport). Independent of mouse interactions
// — works even while a right-click clip-plane drag is in progress.
function applyPanFromSliders(): void {
  if (!nv) return
  const x = Number(els.panX.value)
  const y = Number(els.panY.value)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  ;(nv as unknown as { renderPan: [number, number] }).renderPan = [x, y]
}

// Pull niivue's current zoom back into the slider so wheel-driven changes
// stay in sync. Pan isn't touched by wheel/drag, so we don't sync it.
function syncCameraSliders(): void {
  if (!nv) return
  const z = readViewerScale(nv)
  if (Number.isFinite(z) && z > 0) {
    const min = Number(els.zoom.min) || 0.5
    const max = Number(els.zoom.max) || 8
    els.zoom.value = String(Math.max(min, Math.min(max, z)))
  }
}

// Derives a "punchy" window from niivue's auto-calibrated intensity range.
// The render alpha is baked from intensity, so the wide 2-98% auto window
// leaves the low-intensity bulk as translucent haze. Windowing to the upper
// half of the robust range drops that haze; the max is stretched to the
// global peak so the brightest structure saturates to white.
function punchyWindow(vol: unknown): { min: number; max: number } | null {
  const v = vol as { calMin?: unknown; calMax?: unknown; globalMax?: unknown }
  const lo = v.calMin
  const hi = v.calMax
  if (typeof lo !== 'number' || typeof hi !== 'number' || hi <= lo) {
    return null
  }
  const gmax = v.globalMax
  const max = typeof gmax === 'number' && gmax > hi ? gmax : hi
  return { min: Math.round(lo + 0.5 * (hi - lo)), max: Math.round(max) }
}

// After the coarse first paint, fetch a "comfortable" level in the
// background so the user sees a sharper image without paying for L0 up
// front. The choice is the same heuristic auto-LOD uses at scale=1, so
// the result roughly matches one voxel per screen pixel at native zoom.
function scheduleProgressiveUpgrade(
  v: VolumeApiEntry,
  loadedLevel: number,
): void {
  cancelUpgrade()
  const levels = v.levels
  if (!levels || levels.length < 2) return
  if (parseBbox(els.bbox.value)) return // explicit subvolume — user picked the level
  if (isStreamingMode()) return
  const canvasPx = Math.max(
    els.canvas.clientWidth,
    els.canvas.clientHeight,
    256,
  )
  const target = chooseLevel(1, levels, canvasPx, v.dtype)
  if (target >= loadedLevel) return // we're already at or finer than comfort
  upgradeTimer = setTimeout(() => {
    upgradeTimer = null
    if (reloading) return
    if (Number(els.level.value) !== loadedLevel) return
    if (parseBbox(els.bbox.value)) return
    if (isStreamingMode()) return
    lastLodEvent = {
      from: loadedLevel,
      to: target,
      reason: 'progressive upgrade',
    }
    els.level.value = String(target)
    void reload()
  }, 280)
}

function cancelUpgrade(): void {
  if (upgradeTimer) {
    clearTimeout(upgradeTimer)
    upgradeTimer = null
  }
}

// Picks the pyramid level whose voxel-per-screen-pixel ratio is closest
// to 1 in log space. Anything coarser is pixelated; anything finer wastes
// bandwidth. Uses the longest spatial dim as the reference because
// niivue scales the volume to fit the view height, more or less.
function chooseLevel(
  scale: number,
  levels: VolumeLevel[],
  canvasPx: number,
  dtype: string,
): number {
  if (!levels.length) return 0
  // Auto-LOD and the progressive upgrade never land on full levels that need
  // the subvolume path. Deep detail comes from manual L0 selection or
  // shift-click, both of which request a bounded bbox instead.
  const usable = levels.filter((l) => !levelNeedsSubvolume(l.shape, dtype))
  const pool = usable.length > 0 ? usable : levels
  let best = pool[0]?.level ?? 0
  let bestScore = Number.POSITIVE_INFINITY
  for (const lvl of pool) {
    const longest = Math.max(...lvl.shape)
    if (longest <= 0) continue
    const pixPerVox = (canvasPx * scale) / longest
    if (pixPerVox <= 0) continue
    const score = Math.abs(Math.log2(pixPerVox))
    if (score < bestScore) {
      bestScore = score
      best = lvl.level
    }
  }
  return best
}

// Debounced wheel handler. niivue mutates its zoom state synchronously
// during the wheel event, so by the time the timer fires `scaleMultiplier`
// (3D mode) or `pan2Dxyzmm[3]` (2D mode) reflects the post-zoom value.
function scheduleAutoLod(): void {
  // User scrolled — kill any pending progressive upgrade so it doesn't fire
  // a redundant fetch right before auto-LOD picks the real target.
  cancelUpgrade()
  if (!els.autoLod.checked) return
  if (!nv) return
  if (parseBbox(els.bbox.value)) return // Don't override an explicit subvolume
  if (isStreamingMode()) return
  if (lodTimer) clearTimeout(lodTimer)
  lodTimer = setTimeout(evaluateAutoLod, 160)
}

function evaluateAutoLod(): void {
  lodTimer = null
  if (reloading) return
  const v = currentVolume()
  if (!v || !nv) return
  const levels = v.levels
  if (!levels || levels.length < 2) return
  const scale = readViewerScale(nv)
  const canvasPx = Math.max(
    els.canvas.clientWidth,
    els.canvas.clientHeight,
    256,
  )
  const target = chooseLevel(scale, levels, canvasPx, v.dtype)
  const current = Number(els.level.value)
  if (target === current) return
  lastLodEvent = {
    from: current,
    to: target,
    reason: `scale=${scale.toFixed(2)}`,
  }
  els.level.value = String(target)
  void reload()
}

// niivue's zoom lives in two places depending on slice mode. We try the
// 3D scalar first (sliceType=4 = render mode, which the demo uses) and
// fall back to the 2D pan zoom scalar for multiplanar.
function readViewerScale(viewer: NiiVue): number {
  const rec = viewer as unknown as {
    scaleMultiplier?: number
    scene?: { pan2Dxyzmm?: number[] }
  }
  if (typeof rec.scaleMultiplier === 'number' && rec.scaleMultiplier > 0) {
    return rec.scaleMultiplier
  }
  const pan = rec.scene?.pan2Dxyzmm
  const z = pan?.[3]
  if (typeof z === 'number' && z > 0) return z
  return 1
}

// Maps the last-known focus point into L0 coords, builds a 128³ bbox centered
// there, and fires the same reload path the manual bbox controls use. The
// server reads only the OME-Zarr chunks that intersect the slab.
async function fetchSlabAtCursor(): Promise<void> {
  const v = currentVolume()
  if (!v || !lastFocusFrac) return
  const currentLevelIdx = Number(els.level.value)
  const l0 = v.levels?.find((l) => l.level === 0) ?? null
  if (!l0) return
  const center = focusCenterForShape(l0.shape)
  const bbox = centeredBbox(l0.shape, center, 128)
  els.level.value = '0'
  populateSubvolumeSelect(v)
  markCustomSubvolume('shift-click 128³')
  els.bbox.value = bbox.join(',')
  lastLodEvent = {
    from: currentLevelIdx,
    to: 0,
    reason: `shift-click @ L0(${center.join(',')})`,
  }
  await reload()
}

async function measureLoad(url: string): Promise<LoadStats> {
  const t0 = performance.now()
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`)
  }
  const buf = await res.arrayBuffer()
  const t1 = performance.now()
  // The .nii.gz route returns gzip-wrapped NIfTI without Content-Encoding so
  // niivue can identify and decompress it from the URL. byteLength is wire
  // size, which is what the demo HUD cares about for transfer cost.
  return { bytes: buf.byteLength, fetchMs: t1 - t0, decodeMs: 0 }
}

function renderHud(v: VolumeApiEntry, level: number): void {
  const lvl = v.levels?.find((l) => l.level === level)
  const levelShape = lvl?.shape ?? v.shape
  const spacing = lvl?.spacing ?? v.spacing
  const bbox = parseBbox(els.bbox.value)
  const shownShape: [number, number, number] = bbox
    ? [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
    : levelShape
  const voxels = shownShape[0] * shownShape[1] * shownShape[2]
  const levelVox = levelShape[0] * levelShape[1] * levelShape[2]
  const pct = bbox ? ((100 * voxels) / levelVox).toFixed(2) : null
  const allLevels = v.levels ?? [
    { level: 0, shape: v.shape, spacing: v.spacing, bytes: null },
  ]
  const levelRows = allLevels
    .map((l) => {
      const cls = l.level === level ? ' class="lv active"' : ' class="lv"'
      return `<div${cls}><span>L${l.level}</span><span>${l.shape.join('×')}</span><span>${formatSpacingShort(l.spacing)}</span></div>`
    })
    .join('')
  const explodedGridDims = shouldUseExplodedGrid(levelShape, bbox)
    ? explodedGridDimsForShape(levelShape)
    : null
  const explodedGrid = explodedGridDims !== null
  const streaming = isStreamingMode() || explodedGrid
  const fetchMs = lastStats ? lastStats.fetchMs.toFixed(0) : '-'
  const bytesKb = lastStats
    ? (lastStats.bytes / 1024).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })
    : '-'
  const fetchedText = streaming
    ? lastStats
      ? `${bytesKb} KB streamed across ${explodedGrid ? 'exploded blocks' : 'visible bricks'}`
      : `streaming ${explodedGrid ? 'exploded blocks' : 'visible bricks'}`
    : `${bytesKb} KB in ${fetchMs} ms`
  const bboxRow = bbox
    ? `<div class="row"><span class="key">bbox</span><span>${bbox.slice(0, 3).join(',')} → ${bbox.slice(3).join(',')} (${pct}%)</span></div>`
    : ''
  const subvolumeText = explodedGrid
    ? `${explodedGridDims?.join('×') ?? 'aspect'} exploded blocks`
    : lastSubvolumeLabel
  const subvolumeRow =
    (bbox || streaming) && subvolumeText
      ? `<div class="row"><span class="key">subvol</span><span>${subvolumeText}</span></div>`
      : ''
  const explode = nv?.volumes[0]?.chunkPlan ? currentChunkExplode() : undefined
  const explodeRow = explode?.scale
    ? `<div class="row"><span class="key">explode</span><span>${explode.scale.map((n) => n.toFixed(1)).join('×')}</span></div>`
    : ''
  const lodRow = lastLodEvent
    ? `<div class="row"><span class="key">auto-LOD</span><span>L${lastLodEvent.from} → L${lastLodEvent.to} · ${lastLodEvent.reason}</span></div>`
    : ''
  els.hud.innerHTML = `
    <div class="row"><span class="key">volume</span><strong>${v.id}</strong></div>
    <div class="row"><span class="key">format</span><span>${v.format} · ${v.dtype}</span></div>
    <div class="row"><span class="key">level</span><strong>L${level}</strong> · ${levelShape.join('×')}</div>
    ${bboxRow}
    ${subvolumeRow}
    ${explodeRow}
    ${lodRow}
    <div class="row"><span class="key">shape</span><span>${shownShape.join('×')} (${voxels.toLocaleString()} vox)</span></div>
    <div class="row"><span class="key">spacing (mm)</span><span>${formatSpacing(spacing)}</span></div>
    <div class="row"><span class="key">fetched</span><span>${fetchedText}</span></div>
    <div class="levels">${levelRows}</div>
  `
}

function currentLevelShape(
  v: VolumeApiEntry | null,
): [number, number, number] | null {
  if (!v) return null
  const level = Number(els.level.value)
  const lvl = v.levels?.find((l) => l.level === level)
  return lvl?.shape ?? v.shape
}

function parseBbox(
  s: string,
): [number, number, number, number, number, number] | null {
  const trimmed = s.trim()
  if (!trimmed) return null
  const parts = trimmed.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 6 || parts.some((n) => !Number.isFinite(n))) return null
  return parts as [number, number, number, number, number, number]
}

function randomBboxString(
  shape: [number, number, number],
  size: number,
): string {
  const dims = [0, 1, 2].map((i) => {
    const s = Math.min(size, shape[i] ?? size)
    const maxStart = Math.max(0, (shape[i] ?? s) - s)
    const start = Math.floor(Math.random() * (maxStart + 1))
    return [start, start + s] as const
  })
  return [
    dims[0][0],
    dims[1][0],
    dims[2][0],
    dims[0][1],
    dims[1][1],
    dims[2][1],
  ].join(',')
}

function formatSpacing(s: [number, number, number]): string {
  return s.map((n) => n.toExponential(2)).join(', ')
}

function formatSpacingShort(s: [number, number, number]): string {
  const max = Math.max(...s.map(Math.abs))
  if (max === 0) return '0,0,0'
  if (max < 1e-3) return s.map((n) => `${(n * 1e6).toFixed(1)}nm`).join(' ')
  if (max < 1) return s.map((n) => `${(n * 1e3).toFixed(1)}µm`).join(' ')
  return s.map((n) => `${n.toFixed(2)}mm`).join(' ')
}

function parseWindow(s: string): { min: number; max: number } | null {
  if (!s) return null
  const parts = s.split(',').map((n) => Number(n))
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null
  const [min, max] = parts as [number, number]
  return { min, max }
}

function showFallback(msg: string): void {
  els.fallback.hidden = false
  els.fallback.textContent = msg
  els.canvas.style.display = 'none'
}

function showCanvas(): void {
  els.fallback.hidden = true
  els.fallback.textContent = ''
  els.canvas.style.display = 'block'
}

// Loading badge. A level swap fetches, decodes and uploads the volume —
// a coarse level is a sub-second flicker, but an oversized one runs for
// tens of seconds with the main thread blocked during the GPU upload.
// The badge tells the user the demo is working, not wedged.
function setBusy(label: string | null): void {
  if (label) {
    els.busy.textContent = label
    els.busy.hidden = false
  } else {
    els.busy.hidden = true
  }
}

// niivue's decode + RGBA build + 3D-texture upload runs synchronously and
// blocks the main thread — the page is frozen for its duration. Awaiting two
// animation frames lets the browser paint a pending DOM update (the busy
// badge) so the freeze is explained, not mistaken for a wedged tab.
function yieldPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}
