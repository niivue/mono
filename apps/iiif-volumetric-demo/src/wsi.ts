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
// and never drifts. A window MARGIN larger than the viewport is loaded so small
// zooms/pans stay within the texture; a debounced settle pass swaps the pyramid
// level (and reloads the window) only when the texture would get too blurry /
// too coarse or the view nears the window edge, picking the level whose pixels
// are ~1:1 with the screen. Coarse levels that fit one GPU texture load whole;
// finer levels load only the visible window via the server's bbox subvolume
// read, so the 2.66-gigapixel base level is never materialised. (Streaming the
// whole base level as tiled chunks needs RGB support in niivue's chunked path —
// a tracked follow-up.)

import NiiVue, { DRAG_MODE, SLICE_TYPE } from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

// Single-texture cap (common 2048 3D-texture limit) and the smallest visible
// span we allow (don't zoom past ~48 base px across the viewport).
const MAX_EDGE = 2048
const MIN_SPAN = 48
// How long after the last wheel tick we re-evaluate the level (ms).
const SETTLE_MS = 160

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
})

let volumes: WsiVolume[] = []
let current: WsiVolume | null = null
// The viewport over the slide, in base-level pixels.
let centerL0: [number, number] = [0, 0]
let spanL0 = 1 // visible width across the viewport, in base px
// The window currently uploaded to niivue, in base-level pixels, plus the
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

// Load a window this many times larger than the visible viewport, so panning
// and zooming a little move within the loaded texture without a reload.
const MARGIN = 1.8
// Reload to a finer/coarser level when a texel grows past / shrinks below these
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
  // If the window for this span won't fit one texture, step coarser (bigger
  // level index = bigger downsample = smaller window) until it does.
  while (
    chosen < maxLevel(v) &&
    (span * MARGIN) / factorOf(v, levelAt(v, chosen)) > MAX_EDGE
  ) {
    chosen += 1
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

// Load a window (MARGIN larger than the viewport) at the level whose pixels are
// ~1:1 with the screen for the current span, then aim niivue's pan/zoom at the
// viewport so the visible framing is preserved across the swap.
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

  let winW = Math.min(Math.ceil((spanL0 * MARGIN) / f), lvl.shape[0], MAX_EDGE)
  let winH = Math.min(
    Math.ceil((spanL0 * aspect * MARGIN) / f),
    lvl.shape[1],
    MAX_EDGE,
  )
  const whole = winW >= lvl.shape[0] && winH >= lvl.shape[1]
  let url = `/volumes/${encodeURIComponent(v.id)}/raw.nii.gz?level=${lvl.level}`
  let x0 = 0
  let y0 = 0
  if (whole) {
    winW = lvl.shape[0]
    winH = lvl.shape[1]
  } else {
    x0 = clamp(Math.round(centerL0[0] / f - winW / 2), 0, lvl.shape[0] - winW)
    y0 = clamp(Math.round(centerL0[1] / f - winH / 2), 0, lvl.shape[1] - winH)
    url += `&bbox=${x0},${y0},0,${x0 + winW},${y0 + winH},1`
  }

  const token = ++loadToken
  try {
    await nv.loadVolumes([{ url }])
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
  nv.drawScene()
  els.level.value = String(lvl.level)
  syncUi()
}

// After interaction settles, fold niivue's live pan/zoom into the viewport and
// reload only when the texture is too blurry / too wasteful, or the view has
// drifted near the loaded window's edge. Otherwise niivue keeps showing the
// pan/zoom smoothly and we just refresh the readouts.
function onSettle(): void {
  if (!current) return
  const v = current
  const texelPx = (loaded.factor * canvasW()) / spanL0
  const wantLevel = pickLevel(v, spanL0)
  const halfW = spanL0 / 2
  const halfH = (spanL0 * canvasAspect()) / 2
  const edge = spanL0 * 0.08
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
let dragLast: { x: number; y: number } | null = null
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
// Level dropdown jumps the zoom so a window of that level fills the view:
// coarse levels => wide span (overview), fine levels => narrow span (zoomed).
els.level.addEventListener('change', () => {
  if (!current) return
  const lvl = levelAt(current, Number(els.level.value))
  // Span that lands on this level: a window of it (plus margin) must fit one
  // texture, so cap the span so pickLevel actually chooses this level.
  spanL0 = Math.min(MAX_EDGE / MARGIN, lvl.shape[0]) * factorOf(current, lvl)
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
