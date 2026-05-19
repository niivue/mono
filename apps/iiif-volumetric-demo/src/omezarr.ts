// Focused demo for OME-Zarr pyramid loading + subvolume access.
//
// Discovers OME-Zarr volumes from /api, lets the user pick one and choose
// which pyramid level to load. The level dropdown is driven by the
// server's native pyramid metadata (probeLevels), and each switch fetches
// `/volumes/{id}/raw?level=N` so the wire path matches what a real client
// would use.
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
//   - Colormap and window edits update the GPU in place via setVolume()
//     and do not refetch — only level/bbox changes hit the wire.
//
// Two automatic behaviours showcase the server's strengths:
//
//   - Auto-LOD: scrolling to zoom in/out triggers a level swap so the
//     server only ever streams the resolution the user can actually see.
//     Heuristic is pixels-per-voxel ≈ 1 in log space — the level whose
//     longest dim divides into roughly 1 voxel per screen pixel wins.
//
//   - Shift-click subvolume: clicking on any feature in the canvas while
//     holding Shift maps the click → L0 voxel coords → 128³ bbox →
//     `/raw?level=0&bbox=...`. The server reads only the intersecting
//     OME-Zarr chunks, so a 1 MB window can come out of a multi-GB
//     volume in tens of milliseconds.
//
// Rendering is the off-the-shelf niivue 3D viewer — the point here is the
// server-side pyramid + subvolume plumbing, not viewer features.

import NiiVue from '@niivue/niivue'

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

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  volume: el<HTMLSelectElement>('volume'),
  level: el<HTMLSelectElement>('level'),
  colormap: el<HTMLSelectElement>('colormap'),
  window: el<HTMLInputElement>('window'),
  bbox: el<HTMLInputElement>('bbox'),
  bboxRandom: el<HTMLButtonElement>('bboxRandom'),
  bboxClear: el<HTMLButtonElement>('bboxClear'),
  autoLod: el<HTMLInputElement>('autoLod'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

const baseUrl = window.location.origin
let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let lastStats: LoadStats | null = null
let lodTimer: ReturnType<typeof setTimeout> | null = null
let lastClickVox: [number, number, number] | null = null
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

main().catch((err: unknown) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})

async function main(): Promise<void> {
  const res = await fetch('/api')
  const api = (await res.json()) as ApiResponse
  volumes = (api.volumes ?? []).filter((v) => v.format === 'ome-zarr')
  if (volumes.length === 0) {
    showFallback(
      'No OME-Zarr volumes in /api. Run `bun run fetch-omezarr` in the server and restart.',
    )
    return
  }
  populateVolumeSelect()
  els.volume.addEventListener('change', () => {
    void selectVolume(els.volume.value)
  })
  els.level.addEventListener('change', () => {
    void reload()
  })
  els.colormap.addEventListener('change', () => {
    void applyDisplay()
  })
  els.window.addEventListener('change', () => {
    void applyDisplay()
  })
  els.bbox.addEventListener('change', () => {
    void reload()
  })
  els.bboxRandom.addEventListener('click', () => {
    const v = currentVolume()
    const lvl = currentLevelShape(v)
    if (!lvl) return
    els.bbox.value = randomBboxString(lvl, 128)
    void reload()
  })
  els.bboxClear.addEventListener('click', () => {
    els.bbox.value = ''
    void reload()
  })
  await ensureNiivue()
  const initial = readInitialVolumeId()
  els.volume.value = initial
  await selectVolume(initial)
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
  return volumes[0]?.id ?? ''
}

async function selectVolume(id: string): Promise<void> {
  const found = volumes.find((v) => v.id === id)
  if (!found) return
  populateLevelSelect(found)
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
    opt.textContent = `L${l.level} · ${l.shape.join('×')}`
    els.level.appendChild(opt)
  }
  // Lazy load: start at the coarsest level so even multi-GB volumes paint
  // immediately. A background upgrade in reload() refines to a comfortable
  // level once the first frame is on-screen.
  const coarsest = lvls[lvls.length - 1]?.level ?? 0
  els.level.value = String(coarsest)
}

function currentVolume(): VolumeApiEntry | null {
  return volumes.find((v) => v.id === els.volume.value) ?? null
}

async function ensureNiivue(): Promise<void> {
  if (nv) return
  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0, 0, 0, 1],
    isColorbarVisible: true,
    isDragDropEnabled: false,
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
      lastClickVox = [vox[0] ?? 0, vox[1] ?? 0, vox[2] ?? 0]
    }
  })

  // Wheel events on the canvas drive niivue's own zoom. We listen on the
  // capture phase so our debounce kicks off even while niivue is still
  // processing the event. The actual evaluation runs after a quiet
  // period — otherwise a single scroll gesture triggers ~10 level
  // swaps, each cancelling the prior fetch.
  els.canvas.addEventListener('wheel', scheduleAutoLod, { passive: true })

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
  const bboxQuery = bbox ? `&bbox=${bbox.join(',')}` : ''
  const url = `${baseUrl}/volumes/${encodeURIComponent(v.id)}/raw?level=${level}${bboxQuery}`
  reloading = true
  let stats: LoadStats
  try {
    stats = await measureLoad(url)
  } catch (err) {
    reloading = false
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(msg)
    return
  }
  if (myEpoch !== reloadEpoch) {
    reloading = false
    return
  }
  lastStats = stats

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
    nv.sliceType = 4
    showCanvas()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(`niivue failed to load level ${level}: ${msg}`)
    reloading = false
    return
  }
  renderHud(v, level)
  reloading = false
  scheduleProgressiveUpgrade(v, level)
}

// Apply colormap + window in place. No fetch, no re-decode — niivue updates
// the GPU textures directly. Called from the colormap/window UI changes so
// fiddling with display doesn't pull bytes off the wire.
async function applyDisplay(): Promise<void> {
  if (!nv || nv.volumes.length === 0) return
  const colormap = els.colormap.value || 'gray'
  const win = parseWindow(els.window.value)
  const opts: {
    colormap: string
    calMin?: number
    calMax?: number
  } = { colormap }
  if (win) {
    opts.calMin = win.min
    opts.calMax = win.max
  }
  await nv.setVolume(0, opts)
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
  const canvasPx = Math.max(
    els.canvas.clientWidth,
    els.canvas.clientHeight,
    256,
  )
  const target = chooseLevel(1, levels, canvasPx)
  if (target >= loadedLevel) return // we're already at or finer than comfort
  upgradeTimer = setTimeout(() => {
    upgradeTimer = null
    if (reloading) return
    if (Number(els.level.value) !== loadedLevel) return
    if (parseBbox(els.bbox.value)) return
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
): number {
  if (!levels.length) return 0
  let best = levels[0]?.level ?? 0
  let bestScore = Number.POSITIVE_INFINITY
  for (const lvl of levels) {
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
  const target = chooseLevel(scale, levels, canvasPx)
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

// Maps the last-known crosshair voxel (in the currently-loaded level's
// coord system) up to L0 coords, builds a 128³ bbox centered there, and
// fires the same reload path the manual bbox controls use. The server
// reads only the OME-Zarr chunks that intersect the slab.
async function fetchSlabAtCursor(): Promise<void> {
  const v = currentVolume()
  if (!v || !lastClickVox) return
  const currentLevelIdx = Number(els.level.value)
  const currentShape = currentLevelShape(v)
  const l0 = v.levels?.find((l) => l.level === 0) ?? null
  if (!currentShape || !l0) return
  const scale: [number, number, number] = [
    l0.shape[0] / currentShape[0],
    l0.shape[1] / currentShape[1],
    l0.shape[2] / currentShape[2],
  ]
  const center = [
    Math.round(lastClickVox[0] * scale[0]),
    Math.round(lastClickVox[1] * scale[1]),
    Math.round(lastClickVox[2] * scale[2]),
  ] as [number, number, number]
  const half = 64
  const bbox: [number, number, number, number, number, number] = [
    Math.max(0, center[0] - half),
    Math.max(0, center[1] - half),
    Math.max(0, center[2] - half),
    Math.min(l0.shape[0], center[0] + half),
    Math.min(l0.shape[1], center[1] + half),
    Math.min(l0.shape[2], center[2] + half),
  ]
  els.bbox.value = bbox.join(',')
  els.level.value = '0'
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
  // Server returns gzipped NIfTI when client accepts it; the browser
  // auto-decompresses. arrayBuffer().byteLength is the decoded size.
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
  const fetchMs = lastStats ? lastStats.fetchMs.toFixed(0) : '-'
  const bytesKb = lastStats
    ? (lastStats.bytes / 1024).toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })
    : '-'
  const bboxRow = bbox
    ? `<div class="row"><span class="key">bbox</span><span>${bbox.slice(0, 3).join(',')} → ${bbox.slice(3).join(',')} (${pct}%)</span></div>`
    : ''
  const lodRow = lastLodEvent
    ? `<div class="row"><span class="key">auto-LOD</span><span>L${lastLodEvent.from} → L${lastLodEvent.to} · ${lastLodEvent.reason}</span></div>`
    : ''
  els.hud.innerHTML = `
    <div class="row"><span class="key">volume</span><strong>${v.id}</strong></div>
    <div class="row"><span class="key">format</span><span>${v.format} · ${v.dtype}</span></div>
    <div class="row"><span class="key">level</span><strong>L${level}</strong> · ${levelShape.join('×')}</div>
    ${bboxRow}
    ${lodRow}
    <div class="row"><span class="key">shape</span><span>${shownShape.join('×')} (${voxels.toLocaleString()} vox)</span></div>
    <div class="row"><span class="key">spacing (mm)</span><span>${formatSpacing(spacing)}</span></div>
    <div class="row"><span class="key">fetched</span><span>${bytesKb} KB in ${fetchMs} ms</span></div>
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
