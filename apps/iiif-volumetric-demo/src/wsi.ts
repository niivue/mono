// DICOM-WSI deep-zoom viewer.
//
// A whole slide is served by the IIIF volumetric server as a multiscale
// pyramid of depth-1 RGB volumes (see packages/niivue/docs/dicom-wsi.md). This
// page renders it the way a pathologist navigates a slide: a whole-slide
// overview, then click-to-zoom into a high-resolution window.
//
// Each view is a single niivue RGB volume drawn as a 2D axial slice (the slide
// face). Coarse pyramid levels that fit a single GPU texture load whole; finer
// levels load only a centred window via the server's bbox subvolume read, so
// the 2.66-gigapixel base level never has to be materialised. (Streaming the
// whole base level as tiled chunks needs RGB support in niivue's chunked
// path — a tracked follow-up; this viewer stays on the single-texture path.)

import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

// Largest level we load whole; bigger levels load a centred window of WINDOW
// pixels. Both stay within the common 2048 3D-texture limit.
const MAX_EDGE = 2048
const WINDOW = 1024

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
})

let volumes: WsiVolume[] = []
let current: WsiVolume | null = null
let levelIdx = 0
let centerL0: [number, number] = [0, 0]
// Maps a displayed voxel (i, j) back to base-level pixels: l0 = origin + vox*scale.
let view = { originX: 0, originY: 0, scale: 1 }
// The base-level pixel rectangle currently on screen, for the minimap box.
let region = { x: 0, y: 0, w: 0, h: 0 }
let lastVox: [number, number] | null = null
let loadToken = 0

function maxLevel(v: WsiVolume): number {
  return Math.max(...v.levels.map((l) => l.level))
}

function baseLevel(v: WsiVolume): ApiLevel {
  return v.levels.find((l) => l.level === 0) ?? v.levels[0]
}
function levelAt(v: WsiVolume, idx: number): ApiLevel {
  return v.levels.find((l) => l.level === idx) ?? v.levels[0]
}
// Downsample factor of a level relative to the base (≈ powers of two).
function levelFactor(v: WsiVolume, lvl: ApiLevel): number {
  return baseLevel(v).shape[0] / lvl.shape[0]
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
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
  // Coarsest first (overview) down to the base (finest) so the dropdown reads
  // like a zoom ladder.
  const ordered = [...v.levels].sort((a, b) => b.level - a.level)
  for (const l of ordered) {
    const opt = document.createElement('option')
    opt.value = String(l.level)
    const f = levelFactor(v, l)
    opt.textContent = `${l.shape[0]}×${l.shape[1]}  (1/${Math.round(f)} of base)`
    els.level.appendChild(opt)
  }
}

function selectVolume(v: WsiVolume): void {
  current = v
  populateLevels(v)
  const base = baseLevel(v)
  centerL0 = [base.shape[0] / 2, base.shape[1] / 2]
  // Zoom slider spans 0 (overview) .. maxLevel (base); value is the zoom-in
  // amount, so we invert against levelIdx when reading/writing it.
  els.zoom.max = String(maxLevel(v))
  // Minimap: the coarsest level rendered to a small PNG by the IIIF Image API.
  els.miniImg.src = `/iiif/image/${encodeURIComponent(v.id)}/level/${maxLevel(v)}/axial/0/full/240,/0/default.png`
  els.minimap.hidden = false
  // Start at the coarsest level — the whole-slide overview.
  levelIdx = maxLevel(v)
  void loadView()
}

async function loadView(): Promise<void> {
  if (!current) return
  const v = current
  const lvl = levelAt(v, levelIdx)
  const [W, H] = [lvl.shape[0], lvl.shape[1]]
  const f = levelFactor(v, lvl)
  els.level.value = String(levelIdx)

  let url = `/volumes/${encodeURIComponent(v.id)}/raw.nii.gz?level=${levelIdx}`
  let dispW = W
  let dispH = H
  if (W <= MAX_EDGE && H <= MAX_EDGE) {
    // Whole level fits one texture.
    view = { originX: 0, originY: 0, scale: f }
  } else {
    // Centred window in this level's pixels.
    const winW = Math.min(WINDOW, W)
    const winH = Math.min(WINDOW, H)
    const cx = centerL0[0] / f
    const cy = centerL0[1] / f
    const x0 = clamp(Math.round(cx - winW / 2), 0, W - winW)
    const y0 = clamp(Math.round(cy - winH / 2), 0, H - winH)
    url += `&bbox=${x0},${y0},0,${x0 + winW},${y0 + winH},1`
    view = { originX: x0 * f, originY: y0 * f, scale: f }
    dispW = winW
    dispH = winH
  }

  const token = ++loadToken
  setHud(`loading level ${levelIdx} (${dispW}×${dispH})…`)
  try {
    await nv.loadVolumes([{ url }])
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  if (token !== loadToken) return
  // Base-pixel rectangle on screen, for the minimap viewport box.
  region = {
    x: view.originX,
    y: view.originY,
    w: dispW * view.scale,
    h: dispH * view.scale,
  }
  nv.sliceType = SLICE_TYPE.AXIAL
  nv.drawScene()
  updateInfo(v, lvl, dispW, dispH)
  updateMinimap(v)
}

// Position the minimap viewport box over the overview thumbnail.
function updateMinimap(v: WsiVolume): void {
  const base = baseLevel(v)
  const pct = (a: number, b: number) => `${clamp((100 * a) / b, 0, 100)}%`
  els.miniBox.style.left = pct(region.x, base.shape[0])
  els.miniBox.style.top = pct(region.y, base.shape[1])
  els.miniBox.style.width = pct(region.w, base.shape[0])
  els.miniBox.style.height = pct(region.h, base.shape[1])
  els.zoom.value = String(maxLevel(v) - levelIdx)
}

function updateInfo(
  v: WsiVolume,
  lvl: ApiLevel,
  dispW: number,
  dispH: number,
): void {
  const f = levelFactor(v, lvl)
  const whole =
    view.originX === 0 && view.originY === 0 && dispW === lvl.shape[0]
  els.mag.textContent = `1/${Math.round(f)} of base`
  const cx = Math.round(centerL0[0])
  const cy = Math.round(centerL0[1])
  setHud(
    `${v.id}\n` +
      `level ${lvl.level} of ${v.levels.length} · ${dispW}×${dispH} ${whole ? '(whole slide)' : '(window)'}\n` +
      `base ${baseLevel(v).shape[0]}×${baseLevel(v).shape[1]} · center @ base px ${cx},${cy}`,
  )
  els.zoomIn.disabled = levelIdx === 0
}

// Step one level finer (zoom in) keeping the current center.
function zoomInCentered(): void {
  if (!current || levelIdx === 0) return
  levelIdx = Math.max(0, levelIdx - 1)
  void loadView()
}

// Recenter on the clicked feature and step one level finer (zoom in).
function zoomInAtLastClick(): void {
  if (!current || !lastVox) return
  centerL0 = [
    view.originX + lastVox[0] * view.scale,
    view.originY + lastVox[1] * view.scale,
  ]
  levelIdx = Math.max(0, levelIdx - 1)
  void loadView()
}

nv.addEventListener('locationChange', (e: Event) => {
  const vox = (e as CustomEvent<{ vox?: number[] }>).detail?.vox
  if (Array.isArray(vox) && vox.length >= 2) {
    lastVox = [vox[0] ?? 0, vox[1] ?? 0]
  }
})

els.volume.addEventListener('change', () => {
  const v = volumes.find((x) => x.id === els.volume.value)
  if (v) selectVolume(v)
})
els.level.addEventListener('change', () => {
  levelIdx = Number(els.level.value)
  void loadView()
})
els.overview.addEventListener('click', () => {
  if (!current) return
  const base = baseLevel(current)
  centerL0 = [base.shape[0] / 2, base.shape[1] / 2]
  levelIdx = maxLevel(current)
  void loadView()
})
els.zoomIn.addEventListener('click', zoomInCentered)
// Double-click the slide to dive into that spot.
els.canvas.addEventListener('dblclick', zoomInAtLastClick)

// Zoom slider: value is the zoom-in amount (0 = overview), level is inverted.
els.zoom.addEventListener('input', () => {
  if (!current) return
  const next = maxLevel(current) - Number(els.zoom.value)
  if (next === levelIdx) return
  levelIdx = next
  void loadView()
})

// Click the minimap to jump the view to that point on the slide.
els.minimap.addEventListener('click', (e: MouseEvent) => {
  if (!current) return
  const base = baseLevel(current)
  const r = els.minimap.getBoundingClientRect()
  const fx = clamp((e.clientX - r.left) / r.width, 0, 1)
  const fy = clamp((e.clientY - r.top) / r.height, 0, 1)
  centerL0 = [fx * base.shape[0], fy * base.shape[1]]
  void loadView()
})

function setHud(text: string): void {
  els.hud.textContent = text
}

async function main(): Promise<void> {
  await nv.attachToCanvas(els.canvas)
  nv.sliceType = SLICE_TYPE.AXIAL
  await loadApi()
}

void main()
