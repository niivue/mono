// DICOM-WSI deep-zoom viewer.
//
// A whole slide is served by the IIIF volumetric server as a multiscale
// pyramid of depth-1 RGB volumes (see packages/niivue/docs/dicom-wsi.md). This
// page renders it the way a pathologist navigates a slide: a whole-slide
// overview that you fluidly zoom and pan into, OpenSeadragon-style.
//
// The view is tracked as a viewport over the slide — a centre and a span, both
// in base-level pixels — which the wheel (centred zoom) and drag (pan) handlers
// own directly, re-aiming niivue's 2D pan/zoom each frame so motion is smooth
// and never drifts. The pyramid level whose pixels are ~1:1 with the screen is
// loaded as a chunked RGB *streaming* volume over a window of that level (`img`
// is null, a `chunkSource` fetches tiles via the server's bbox subvolume read).
// niivue tiles it and — thanks to the 2D-slice viewport cull — streams only the
// on-screen tiles, so even the 2.66-gigapixel base level pans at full
// resolution within the residency budget, fetching only the visible tiles
// (verified: a base-level view fetches ~6 tiles, not the whole level). The
// window is bounded to niivue's 256-chunk cap; we reload it only when the view
// nears its edge (pan) or a texel gets too blurry/coarse (zoom level swap).

import NiiVue, {
  DRAG_MODE,
  type NVImage,
  SLICE_TYPE,
  type VolumeChunkSource,
} from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

// The view loads a chunked RGB streaming volume: niivue tiles it at CHUNK_EDGE
// and — via the 2D viewport cull — streams only the on-screen tiles. niivue
// caps a volume at 256 chunks, so we load a *window* of the level (much larger
// than a single 2048 texture, up to WINDOW_MAX px ⇒ ≤ (WINDOW_MAX/CHUNK_EDGE)²
// chunks) centred on the viewport, and reload it only when the view nears the
// window edge or crosses a zoom level. So even the gigapixel base level pans at
// full resolution within the residency budget, fetching only visible tiles.
const CHUNK_EDGE = 512
const WINDOW_MAX = 12 * CHUNK_EDGE // 6144 px ⇒ ≤ 12×12 = 144 chunks
const MARGIN = 2.2 // window covers this many times the viewport
const RESIDENCY_BYTES = 1_500_000_000
// Smallest visible span we allow (don't zoom past ~48 base px across the view).
const MIN_SPAN = 48
// How long after the last wheel tick we re-evaluate the level (ms).
const SETTLE_MS = 160
// Debug A/B: ?nofloor disables the coarse whole-slide floor so the streaming
// gap on a level swap is visible (for verifying the floor's effect).
const NO_FLOOR = new URLSearchParams(location.search).has('nofloor')

interface ApiLevel {
  level: number
  shape: [number, number, number]
  spacing: [number, number, number]
}
interface WsiVolume {
  id: string
  format: string
  dtype: string
  shape: [number, number, number]
  levels: ApiLevel[]
}

const els = {
  canvas: document.getElementById('nv') as HTMLCanvasElement,
  volume: document.getElementById('volume') as HTMLSelectElement,
  level: document.getElementById('level') as HTMLSelectElement,
  zoom: document.getElementById('zoom') as HTMLInputElement,
  overview: document.getElementById('overview') as HTMLButtonElement,
  zoomIn: document.getElementById('zoomIn') as HTMLButtonElement,
  mag: document.getElementById('mag') as HTMLSpanElement,
  hud: document.getElementById('hud') as HTMLDivElement,
  fallback: document.getElementById('fallback') as HTMLDivElement,
  minimap: document.getElementById('minimap') as HTMLDivElement,
  miniImg: document.getElementById('miniImg') as HTMLImageElement,
  miniBox: document.getElementById('miniBox') as HTMLDivElement,
}

const backend = getBackendFromUrl()
const nv = new NiiVue({
  backend,
  backgroundColor: [0.05, 0.05, 0.06, 1],
  isColorbarVisible: false,
  is3DCrosshairVisible: false,
  // We drive pan and zoom ourselves (see the wheel/pointer handlers), so keep
  // niivue's own drag/zoom behaviour out of the way.
  primaryDragMode: DRAG_MODE.none,
  // Force every level to tile at CHUNK_EDGE so niivue streams it; cap how much
  // tile data stays resident.
  maxTextureDimension3D: CHUNK_EDGE,
  maxChunkResidencyBytes: RESIDENCY_BYTES,
})

let volumes: WsiVolume[] = []
let current: WsiVolume | null = null
// The viewport over the slide, in base-level pixels.
let centerL0: [number, number] = [0, 0]
let spanL0 = 1 // visible width across the viewport, in base px
// The level currently streamed to niivue, in base-level pixels, plus the
// base-px-per-mm scale niivue's pan2Dxyzmm uses (spacing is [1,1,1] for WSI,
// so this is just the level downsample factor, but we keep it general).
let loaded = {
  level: 0,
  factor: 1,
  baseX: 0,
  baseY: 0,
  baseW: 1,
  baseH: 1,
  basePerMmU: 1,
  basePerMmV: 1,
  spanAtLoad: 1,
}
let loadToken = 0
let settleTimer: ReturnType<typeof setTimeout> | null = null
// Set while a drag-pan is in progress; suppresses window reloads mid-drag.
let dragLast: { x: number; y: number } | null = null

// Swap to a finer/coarser level when a texel grows past / shrinks below these
// many screen pixels (a wide dead-band so small zooms don't thrash levels).
const TEXEL_BLUR = 1.7
const TEXEL_WASTE = 0.38

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}
function baseLevel(v: WsiVolume): ApiLevel {
  return v.levels.find((l) => l.level === 0) ?? v.levels[0]
}
function maxLevel(v: WsiVolume): number {
  return Math.max(...v.levels.map((l) => l.level))
}
function levelAt(v: WsiVolume, idx: number): ApiLevel {
  return v.levels.find((l) => l.level === idx) ?? v.levels[0]
}
function factorOf(v: WsiVolume, lvl: ApiLevel): number {
  return baseLevel(v).shape[0] / lvl.shape[0]
}
function canvasW(): number {
  return els.canvas.clientWidth || 1
}
function canvasAspect(): number {
  return (els.canvas.clientHeight || 1) / canvasW()
}

// Pick the pyramid level whose pixels are ~1:1 with the screen for this span:
// the coarsest level that is still at least screen resolution (so the texture
// is sharp but we move the least data). When zoomed past the base resolution,
// the base level (finest) is the best we can do.
function pickLevel(v: WsiVolume, span: number): number {
  const idealF = span / canvasW() // base px per screen px
  let chosen = 0
  let chosenF = 1
  for (const l of v.levels) {
    const f = factorOf(v, l)
    if (f <= idealF && f >= chosenF) {
      chosen = l.level
      chosenF = f
    }
  }
  return chosen
}

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}
function setHud(text: string): void {
  els.hud.textContent = text
}

async function loadApi(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: WsiVolume[] }
  volumes = (json.volumes ?? []).filter((v) => v.format === 'dicom-wsi')
  if (volumes.length === 0) {
    showFallback(
      'No DICOM-WSI volumes in /api. Run `nx run iiif-volumetric-server:fetch-dicom-wsi` and restart the server.',
    )
    return
  }
  els.volume.replaceChildren()
  for (const v of volumes) {
    const opt = document.createElement('option')
    opt.value = v.id
    const base = baseLevel(v)
    opt.textContent = `${v.id} (${base.shape[0]}×${base.shape[1]}, ${v.levels.length} levels)`
    els.volume.appendChild(opt)
  }
  selectVolume(volumes[0])
}

function populateLevels(v: WsiVolume): void {
  els.level.replaceChildren()
  for (const l of [...v.levels].sort((a, b) => b.level - a.level)) {
    const opt = document.createElement('option')
    opt.value = String(l.level)
    opt.textContent = `${l.shape[0]}×${l.shape[1]}  (1/${Math.round(factorOf(v, l))})`
    els.level.appendChild(opt)
  }
}

function selectVolume(v: WsiVolume): void {
  current = v
  populateLevels(v)
  // New slide: drop the previous slide's floor (loadViewport rebuilds it).
  void nv.setBaseCoarseFloor(null)
  const base = baseLevel(v)
  centerL0 = [base.shape[0] / 2, base.shape[1] / 2]
  spanL0 = base.shape[0] // whole slide
  els.miniImg.src = `/iiif/image/${encodeURIComponent(v.id)}/level/${maxLevel(v)}/axial/0/full/240,/0/default.png`
  els.minimap.hidden = false
  void loadViewport()
}

// Position niivue's 2D pan/zoom so the loaded window shows `span` base px
// centred on (cx, cy). We own pan and zoom entirely (niivue's own wheel zoom is
// disabled via primaryDragMode `none`), so the viewport state is authoritative
// and this is the only thing that drives niivue's view. Derivation: niivue's
// ortho shows visible-width = volumeWidthMM / zoom centred at
// volumeCentreMM - pan; expressed relative to the window centre (which maps to
// the volume centre regardless of the affine origin) that inverts to the below.
function setNiivueView(cx: number, cy: number, span: number): void {
  const p = nv.pan2Dxyzmm as unknown as number[]
  p[3] = loaded.baseW / span
  p[0] = (loaded.baseX + loaded.baseW / 2 - cx) / loaded.basePerMmU
  p[1] = (loaded.baseY + loaded.baseH / 2 - cy) / loaded.basePerMmV
}

// Base px shown per screen pixel at the current span.
function basePerScreenPx(): number {
  return spanL0 / canvasW()
}

// Fetch one chunk's RGB bytes from the server's bbox subvolume read. niivue
// requests chunks by their voxel range within the loaded window (texOrigin +
// texDims, halo included); add the window origin to get the level bbox. raw.bin
// returns rgb24 (3 bytes/voxel), which niivue expands to RGBA8.
function fetchRGBChunk(
  id: string,
  level: number,
  originX: number,
  originY: number,
  desc: { texOrigin: readonly number[]; texDims: readonly number[] },
  bytesPerVoxel: number,
): Promise<Uint8Array> {
  const bbox = [
    originX + desc.texOrigin[0],
    originY + desc.texOrigin[1],
    desc.texOrigin[2],
    originX + desc.texOrigin[0] + desc.texDims[0],
    originY + desc.texOrigin[1] + desc.texDims[1],
    desc.texOrigin[2] + desc.texDims[2],
  ]
  const url = `/volumes/${encodeURIComponent(id)}/raw.bin?level=${level}&bbox=${bbox.join(',')}`
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const expected =
      desc.texDims[0] * desc.texDims[1] * desc.texDims[2] * bytesPerVoxel
    if (buf.byteLength !== expected) {
      throw new Error(
        `chunk ${bbox} got ${buf.byteLength}B, expected ${expected}`,
      )
    }
    return buf
  })
}

// Build a logical, fully-streamed RGB volume for a window [x0,y0,winW,winH] of
// one pyramid level: dims and transforms describe the window, but `img` is null
// and a `chunkSource` fetches its tiles on demand (offset by the window origin
// into the level). niivue tiles it (CHUNK_EDGE) and streams only the on-screen
// tiles. Modelled on the OME-Zarr streaming volume, minus the scalar-only
// colormap/window state (colour ignores them).
function createStreamingRGBVolume(
  v: WsiVolume,
  lvl: ApiLevel,
  x0: number,
  y0: number,
  winW: number,
  winH: number,
): NVImage {
  const shape: [number, number, number] = [winW, winH, 1]
  const spacing = lvl.spacing
  const dims = [3, shape[0], shape[1], shape[2], 1, 1, 1, 1]
  const pixDims = [1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1]
  const affine = [
    [spacing[0], 0, 0, 0],
    [0, spacing[1], 0, 0],
    [0, 0, spacing[2], 0],
    [0, 0, 0, 1],
  ]
  const dimsMM = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ] as [number, number, number]
  const longest = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
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
  const cache = new Map<number, Promise<Uint8Array>>()
  const chunkSource: VolumeChunkSource = (request) => {
    const hit = cache.get(request.chunkIndex)
    if (hit) return hit
    const next = fetchRGBChunk(
      v.id,
      lvl.level,
      x0,
      y0,
      request.desc,
      request.bytesPerVoxel,
    )
    cache.set(request.chunkIndex, next)
    return next
  }
  const minMM: [number, number, number] = [
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
  ]
  const maxMM: [number, number, number] = [
    (shape[0] - 0.5) * spacing[0],
    (shape[1] - 0.5) * spacing[1],
    (shape[2] - 0.5) * spacing[2],
  ]
  // The url/name is niivue's per-volume chunk-cache key, so it must encode the
  // window — otherwise panning to a new window of the same level collides with
  // the old entry and niivue reuses the old window's chunks (the view "snaps
  // back" to where the pan started).
  const key = `${v.id} L${lvl.level} ${x0},${y0},${winW},${winH}`
  return {
    name: key,
    id: key,
    url: `wsi-stream://${encodeURIComponent(v.id)}/L${lvl.level}/${x0},${y0},${winW},${winH}`,
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
      datatypeCode: 128, // DT_RGB24
      numBitsPerVoxel: 24,
      slice_start: 0,
      vox_offset: 352,
      scl_slope: 1,
      scl_inter: 0,
      slice_end: 0,
      slice_code: 0,
      xyzt_units: 10,
      cal_max: 255,
      cal_min: 0,
      slice_duration: 0,
      toffset: 0,
      description: 'DICOM-WSI streamed level',
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
    nVox3D: shape[0] * shape[1] * shape[2],
    extentsMin: minMM,
    extentsMax: maxMM,
    calMin: 0,
    calMax: 255,
    robustMin: 0,
    robustMax: 255,
    globalMin: 0,
    globalMax: 255,
    pixDimsRAS: pixDims.slice(0, 4),
    dimsRAS: dims.slice(0, 4),
    permRAS: [1, 2, 3],
    matRAS,
    obliqueRAS: identity,
    frac2mm,
    frac2mmOrtho: frac2mm,
    extentsMinOrtho: minMM,
    extentsMaxOrtho: maxMM,
    mm2ortho: identity,
    img2RASstep: [1, shape[0], shape[0] * shape[1]],
    img2RASstart: [0, 0, 0],
    toRAS: identity,
    toRASvox: identity,
    mm000: minMM,
    mm100: [maxMM[0], minMM[1], minMM[2]],
    mm010: [minMM[0], maxMM[1], minMM[2]],
    mm001: [minMM[0], minMM[1], maxMM[2]],
    oblique_angle: 0,
    maxShearDeg: 0,
    volScale: [dimsMM[0] / longest, dimsMM[1] / longest, dimsMM[2] / longest],
    frame4D: 0,
    nFrame4D: 1,
    nTotalFrame4D: 1,
    colormap: 'gray',
    isTransparentBelowCalMin: false,
    opacity: 1,
    modulateAlpha: 0,
    isColorbarVisible: false,
    isLegendVisible: false,
    colormapLabel: null,
    chunkSource,
  } as unknown as NVImage
}

// Build a coarse floor for the *same* window region the fine window covers, a
// few pyramid levels coarser so the whole region fits in one texture. Because
// it spans the identical mm box as the fine window, it aligns with an identity
// placement: the slice samples it where fine tiles haven't streamed yet, so a
// level swap shows near-final (mildly blurry) detail immediately and sharpens
// as the fine window streams. One small bbox fetch (~1/16+ of the fine data);
// `img` is populated so setBaseCoarseFloor orients it as a single texture.
async function createWindowFloorVolume(
  v: WsiVolume,
  baseRegion: { x: number; y: number; w: number; h: number },
): Promise<NVImage> {
  // Coarsest-enough factor so the region fits one texture; pick the finest
  // (sharpest) available level that still fits.
  const need = Math.max(baseRegion.w, baseRegion.h) / CHUNK_EDGE
  const fits = v.levels.filter((l) => factorOf(v, l) >= need)
  const floorLvl = fits.length
    ? fits.reduce((a, b) => (factorOf(v, b) < factorOf(v, a) ? b : a))
    : v.levels.reduce((a, b) => (factorOf(v, b) > factorOf(v, a) ? b : a))
  const ff = factorOf(v, floorLvl)
  const fx = Math.floor(baseRegion.x / ff)
  const fy = Math.floor(baseRegion.y / ff)
  const fw = Math.max(
    1,
    Math.min(Math.ceil(baseRegion.w / ff), floorLvl.shape[0] - fx),
  )
  const fh = Math.max(
    1,
    Math.min(Math.ceil(baseRegion.h / ff), floorLvl.shape[1] - fy),
  )
  const url = `/volumes/${encodeURIComponent(v.id)}/raw.bin?level=${floorLvl.level}&bbox=${fx},${fy},0,${fx + fw},${fy + fh},1`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`floor GET ${url} -> ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const floor = createStreamingRGBVolume(v, floorLvl, fx, fy, fw, fh)
  floor.img = bytes as unknown as NVImage['img']
  floor.name = `${v.id} floor L${floorLvl.level} ${fx},${fy},${fw},${fh}`
  floor.id = floor.name
  floor.url = `wsi-floor://${encodeURIComponent(v.id)}/L${floorLvl.level}/${fx},${fy},${fw},${fh}`
  return floor
}

// Load a chunked-RGB streaming window of the level whose pixels are ~1:1 with
// the screen — a window large enough to give panning room but bounded to niivue's
// 256-chunk cap — then aim niivue's pan/zoom at the viewport. niivue streams
// only the on-screen tiles; we reload only when the view nears the window edge
// (pan) or crosses a zoom level.
async function loadViewport(): Promise<void> {
  if (!current) return
  const v = current
  const base = baseLevel(v)
  spanL0 = clamp(spanL0, MIN_SPAN, base.shape[0])
  centerL0 = [
    clamp(centerL0[0], 0, base.shape[0]),
    clamp(centerL0[1], 0, base.shape[1]),
  ]
  const lvl = levelAt(v, pickLevel(v, spanL0))
  const f = factorOf(v, lvl)
  const aspect = canvasAspect()

  // Window (in this level's px), bounded to WINDOW_MAX so chunk count stays
  // under niivue's cap, centred on the viewport.
  const winW = Math.min(
    Math.ceil((spanL0 * MARGIN) / f),
    lvl.shape[0],
    WINDOW_MAX,
  )
  const winH = Math.min(
    Math.ceil((spanL0 * aspect * MARGIN) / f),
    lvl.shape[1],
    WINDOW_MAX,
  )
  const x0 = clamp(
    Math.round(centerL0[0] / f - winW / 2),
    0,
    lvl.shape[0] - winW,
  )
  const y0 = clamp(
    Math.round(centerL0[1] / f - winH / 2),
    0,
    lvl.shape[1] - winH,
  )

  const token = ++loadToken
  try {
    await nv.loadVolumes([createStreamingRGBVolume(v, lvl, x0, y0, winW, winH)])
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  if (token !== loadToken) return
  loaded = {
    level: lvl.level,
    factor: f,
    baseX: x0 * f,
    baseY: y0 * f,
    baseW: winW * f,
    baseH: winH * f,
    basePerMmU: f / (lvl.spacing[0] || 1),
    basePerMmV: f / (lvl.spacing[1] || 1),
    spanAtLoad: spanL0,
  }
  nv.sliceType = SLICE_TYPE.AXIAL
  setNiivueView(centerL0[0], centerL0[1], spanL0)
  // Coarse floor of the SAME window region (a few levels coarser, identity-
  // aligned): shows near-final detail behind the streaming window so a level
  // swap (or panning into un-streamed tiles) never blanks, sharpening as the
  // fine tiles arrive. Rebuilt per window load (small fetch).
  try {
    if (NO_FLOOR) throw new Error('floor disabled (?nofloor)')
    const floor = await createWindowFloorVolume(v, {
      x: x0 * f,
      y: y0 * f,
      w: winW * f,
      h: winH * f,
    })
    if (token === loadToken) await nv.setBaseCoarseFloor(floor)
  } catch {
    // Non-fatal: without a floor the window just blanks-while-streaming.
  }
  nv.drawScene()
  els.level.value = String(lvl.level)
  syncUi()
}

// After interaction settles, reload the streaming window when a texel would get
// too blurry / too coarse (swap level) or the viewport nears the window edge
// (pan). Within the window niivue streams the on-screen tiles, so small
// pans/zooms don't reload.
function onSettle(): void {
  if (!current) return
  // Don't reload mid-drag: loadVolumes swaps the volume and momentarily resets
  // niivue's pan, which reads as the view snapping back. Pan/stream within the
  // loaded window during the drag; the pointerup settle reloads if needed.
  if (dragLast) return
  const v = current
  const texelPx = (loaded.factor * canvasW()) / spanL0
  const wantLevel = pickLevel(v, spanL0)
  const halfW = spanL0 / 2
  const halfH = (spanL0 * canvasAspect()) / 2
  const edge = spanL0 * 0.1
  const outOfWindow =
    centerL0[0] - halfW < loaded.baseX + edge ||
    centerL0[0] + halfW > loaded.baseX + loaded.baseW - edge ||
    centerL0[1] - halfH < loaded.baseY + edge ||
    centerL0[1] + halfH > loaded.baseY + loaded.baseH - edge
  const blurry = texelPx > TEXEL_BLUR && wantLevel < loaded.level
  const wasteful = texelPx < TEXEL_WASTE && wantLevel > loaded.level
  if (blurry || wasteful || outOfWindow) {
    void loadViewport()
  } else {
    nv.drawScene()
    syncUi()
  }
}

function scheduleSettle(): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(onSettle, SETTLE_MS)
}

function syncUi(): void {
  if (!current) return
  const v = current
  const base = baseLevel(v)
  const span = spanL0
  const spanH = span * canvasAspect()
  const cx = centerL0[0]
  const cy = centerL0[1]
  // Minimap box: the visible rectangle in base px, as a fraction of the slide.
  const pct = (a: number, b: number) => `${clamp((100 * a) / b, 0, 100)}%`
  els.miniBox.style.left = pct(cx - span / 2, base.shape[0])
  els.miniBox.style.top = pct(cy - spanH / 2, base.shape[1])
  els.miniBox.style.width = pct(span, base.shape[0])
  els.miniBox.style.height = pct(spanH, base.shape[1])
  // Zoom slider: 0 = whole slide, 1000 = MIN_SPAN, log-scaled.
  const t = Math.log(base.shape[0] / span) / Math.log(base.shape[0] / MIN_SPAN)
  els.zoom.value = String(Math.round(clamp(t, 0, 1) * 1000))
  const lvl = levelAt(v, loaded.level)
  els.mag.textContent = `level ${lvl.level} · 1/${Math.round(loaded.factor)} of base`
  setHud(
    `${v.id}\n` +
      `viewing ${Math.round(span)}×${Math.round(spanH)} base px @ level ${lvl.level} (${lvl.shape[0]}×${lvl.shape[1]})\n` +
      `base ${base.shape[0]}×${base.shape[1]} · center ${Math.round(cx)},${Math.round(cy)}`,
  )
}

// Recenter the viewport on a feature, optionally zooming in a step.
function jumpTo(baseX: number, baseY: number, zoomFactor: number): void {
  if (!current) return
  const base = baseLevel(current)
  centerL0 = [clamp(baseX, 0, base.shape[0]), clamp(baseY, 0, base.shape[1])]
  spanL0 = clamp(spanL0 * zoomFactor, MIN_SPAN, base.shape[0])
  void loadViewport()
}

// Render the current viewport on the loaded texture (smooth, no reload), then
// arm the settle pass that decides whether to swap the level / window.
function applyView(): void {
  setNiivueView(centerL0[0], centerL0[1], spanL0)
  nv.drawScene()
  syncUi()
  scheduleSettle()
}

// Wheel = smooth centred zoom. We keep the centre fixed and shrink/grow the
// span, then re-aim niivue's view — so it never drifts (niivue's own crosshair-
// anchored wheel zoom is disabled). The settle pass swaps the pyramid level
// once the texture would get too blurry / too coarse.
els.canvas.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    if (!current) return
    const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15
    spanL0 = clamp(spanL0 * factor, MIN_SPAN, baseLevel(current).shape[0])
    applyView()
  },
  { passive: true },
)

// Drag = pan. We move the viewport centre by the drag delta (converted from
// screen px to base px) and re-aim niivue — smooth within the loaded window;
// the settle pass reloads when the view nears the window edge.
els.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
  dragLast = { x: e.clientX, y: e.clientY }
  els.canvas.setPointerCapture(e.pointerId)
})
els.canvas.addEventListener('pointermove', (e: PointerEvent) => {
  if (!dragLast || !current) return
  const base = baseLevel(current)
  const k = basePerScreenPx()
  // niivue's axial slice has +Y up (frac2mm Y is positive, not radiological),
  // so dragging down moves toward larger data Y — hence +dy on Y, -dx on X.
  centerL0 = [
    clamp(centerL0[0] - (e.clientX - dragLast.x) * k, 0, base.shape[0]),
    clamp(centerL0[1] + (e.clientY - dragLast.y) * k, 0, base.shape[1]),
  ]
  dragLast = { x: e.clientX, y: e.clientY }
  applyView()
})
els.canvas.addEventListener('pointerup', (e: PointerEvent) => {
  dragLast = null
  els.canvas.releasePointerCapture(e.pointerId)
  scheduleSettle()
})

els.volume.addEventListener('change', () => {
  const v = volumes.find((x) => x.id === els.volume.value)
  if (v) selectVolume(v)
})
// Level dropdown jumps the zoom to ~1:1 with the chosen level (coarse => wide
// span / zoomed out, fine => narrow span / zoomed in).
els.level.addEventListener('change', () => {
  if (!current) return
  const lvl = levelAt(current, Number(els.level.value))
  spanL0 = clamp(
    factorOf(current, lvl) * canvasW(),
    MIN_SPAN,
    baseLevel(current).shape[0],
  )
  void loadViewport()
})
// Zoom slider: log-scaled span from whole slide to MIN_SPAN.
els.zoom.addEventListener('input', () => {
  if (!current) return
  const base = baseLevel(current)
  const t = Number(els.zoom.value) / 1000
  spanL0 = base.shape[0] * (MIN_SPAN / base.shape[0]) ** t
  void loadViewport()
})
els.overview.addEventListener('click', () => {
  if (!current) return
  const base = baseLevel(current)
  centerL0 = [base.shape[0] / 2, base.shape[1] / 2]
  spanL0 = base.shape[0]
  void loadViewport()
})
els.zoomIn.addEventListener('click', () => {
  jumpTo(centerL0[0], centerL0[1], 0.5)
})
// Double-click to dive in a step at the current centre. (In pan-drag mode a
// click pans rather than picking a voxel, so we zoom on the centre; use the
// wheel for cursor-anchored zoom and the minimap to recentre.)
els.canvas.addEventListener('dblclick', () => {
  jumpTo(centerL0[0], centerL0[1], 0.5)
})
// Click the minimap to jump the view there. The minimap is flipped vertically
// in CSS to match niivue's +Y-up axial slice, so invert the click's Y.
els.minimap.addEventListener('click', (e: MouseEvent) => {
  if (!current) return
  const base = baseLevel(current)
  const r = els.minimap.getBoundingClientRect()
  jumpTo(
    clamp((e.clientX - r.left) / r.width, 0, 1) * base.shape[0],
    (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * base.shape[1],
    1,
  )
})

async function main(): Promise<void> {
  await nv.attachToCanvas(els.canvas)
  nv.sliceType = SLICE_TYPE.AXIAL
  await loadApi()
}

void main()
