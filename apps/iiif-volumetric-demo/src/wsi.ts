// DICOM-WSI deep-zoom viewer.
//
// A whole slide is served by the IIIF volumetric server as a multiscale
// pyramid of depth-1 RGB volumes (see packages/niivue/docs/dicom-wsi.md). This
// page renders it the way a pathologist navigates a slide: a whole-slide
// overview that you fluidly zoom and pan into, OpenSeadragon-style.
//
// Smoothness comes from niivue's built-in 2D pan/zoom (cursor-anchored wheel
// zoom + drag pan, enabled by DRAG_MODE.pan) acting on the currently-loaded
// texture. Sharpness comes from an auto-LOD layer on top: the view is tracked
// as a viewport over the slide — a centre and a span, both in base-level
// pixels — and when the zoom crosses a pyramid boundary the underlying window
// is reloaded at the level whose pixels are ~1:1 with the screen, scale-matched
// so the swap keeps the same framing (only the detail sharpens). Coarse levels
// that fit one GPU texture load whole; finer levels load only the visible
// window via the server's bbox subvolume read, so the 2.66-gigapixel base level
// is never materialised. (Streaming the whole base level as tiled chunks needs
// RGB support in niivue's chunked path — a tracked follow-up.)

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
  // Enables niivue's 2D cursor-anchored wheel zoom + drag pan.
  primaryDragMode: DRAG_MODE.pan,
})

let volumes: WsiVolume[] = []
let current: WsiVolume | null = null
// The viewport over the slide, in base-level pixels.
let centerL0: [number, number] = [0, 0]
let spanL0 = 1 // visible width across the viewport, in base px
// The window currently uploaded to niivue.
let loaded = { level: 0, factor: 1, baseX: 0, baseY: 0, baseW: 1, baseH: 1 }
let loadToken = 0
let settleTimer: ReturnType<typeof setTimeout> | null = null

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
function canvasAspect(): number {
  const w = els.canvas.clientWidth || 1
  const h = els.canvas.clientHeight || 1
  return h / w
}

// Pick the finest pyramid level whose window for this span still fits one
// texture — i.e. the sharpest level that isn't wastefully upsampled.
function pickLevel(v: WsiVolume, span: number): number {
  const ordered = [...v.levels].sort((a, b) => a.level - b.level) // finest first
  for (const l of ordered) {
    if (span / factorOf(v, l) <= MAX_EDGE) return l.level
  }
  return maxLevel(v)
}

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}
function setHud(text: string): void {
  els.hud.textContent = text
}
function niivueZoom(): number {
  const z = (nv.pan2Dxyzmm as unknown as number[])[3]
  return typeof z === 'number' && z > 0 ? z : 1
}
function resetNiivueView(): void {
  const p = nv.pan2Dxyzmm as unknown as number[]
  p[0] = 0
  p[1] = 0
  p[2] = 0
  p[3] = 1
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

// Load the window for the current (centerL0, spanL0) viewport at the best
// level, scale-matched so resetting niivue's zoom to 1 keeps the framing.
async function loadViewport(): Promise<void> {
  if (!current) return
  const v = current
  const base = baseLevel(v)
  spanL0 = clamp(spanL0, MIN_SPAN, base.shape[0])
  const lvl = levelAt(v, pickLevel(v, spanL0))
  const f = factorOf(v, lvl)
  const spanH = spanL0 * canvasAspect()

  let winW = Math.min(Math.ceil(spanL0 / f), lvl.shape[0], MAX_EDGE)
  let winH = Math.min(Math.ceil(spanH / f), lvl.shape[1], MAX_EDGE)
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
  }
  nv.sliceType = SLICE_TYPE.AXIAL
  resetNiivueView()
  nv.drawScene()
  els.level.value = String(lvl.level)
  syncUi()
}

// Convert niivue's live pan/zoom into the viewport, swapping the level if the
// zoom has crossed a pyramid boundary. Runs after the wheel settles.
function onSettle(): void {
  if (!current) return
  const z = niivueZoom()
  spanL0 = clamp(loaded.baseW / z, MIN_SPAN, baseLevel(current).shape[0])
  if (pickLevel(current, spanL0) !== loaded.level) {
    // Crossed a level boundary — reload sharper/coarser, scale-matched.
    void loadViewport()
  } else {
    // Same level: niivue is already showing the zoom smoothly; just refresh
    // the readouts and the minimap box.
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
  // Effective visible span tracks niivue's live zoom between reloads.
  const span = clamp(loaded.baseW / niivueZoom(), MIN_SPAN, base.shape[0])
  const spanH = span * canvasAspect()
  // Minimap box: the visible rectangle in base px, as a fraction of the slide.
  const pct = (a: number, b: number) => `${clamp((100 * a) / b, 0, 100)}%`
  els.miniBox.style.left = pct(centerL0[0] - span / 2, base.shape[0])
  els.miniBox.style.top = pct(centerL0[1] - spanH / 2, base.shape[1])
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
      `base ${base.shape[0]}×${base.shape[1]} · center ${Math.round(centerL0[0])},${Math.round(centerL0[1])}`,
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

// niivue handles the wheel zoom; we just re-evaluate the level once it settles.
els.canvas.addEventListener('wheel', scheduleSettle, { passive: true })

els.volume.addEventListener('change', () => {
  const v = volumes.find((x) => x.id === els.volume.value)
  if (v) selectVolume(v)
})
// Level dropdown jumps the zoom so a window of that level fills the view:
// coarse levels => wide span (overview), fine levels => narrow span (zoomed).
els.level.addEventListener('change', () => {
  if (!current) return
  const lvl = levelAt(current, Number(els.level.value))
  spanL0 = Math.min(MAX_EDGE, lvl.shape[0]) * factorOf(current, lvl)
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
// Click the minimap to jump the view there.
els.minimap.addEventListener('click', (e: MouseEvent) => {
  if (!current) return
  const base = baseLevel(current)
  const r = els.minimap.getBoundingClientRect()
  jumpTo(
    clamp((e.clientX - r.left) / r.width, 0, 1) * base.shape[0],
    clamp((e.clientY - r.top) / r.height, 0, 1) * base.shape[1],
    1,
  )
})

async function main(): Promise<void> {
  await nv.attachToCanvas(els.canvas)
  nv.sliceType = SLICE_TYPE.AXIAL
  await loadApi()
}

void main()
