// Rendered OpenNeuro grid. Loads up to 72 NIfTI volumes into one NiiVue
// instance and lays them out as a 2-D `setInstances` grid with an overview
// minimap and per-tile azimuth/elevation controls.

import type { CanvasViewport, NVInstance } from '@niivue/niivue/webgl2'
import NiiVue from '@niivue/niivue/webgl2'

const MAX_VOLUMES = 72
const MIN_ZOOM = 1
const MAX_ZOOM = 96
const ZOOM_SLIDER_MAX = 1000
const FOCUS_TILE_FRACTION = 0.68

interface VolumeLevel {
  level: number
  shape?: [number, number, number]
  ready?: boolean
}

interface VolumeApiEntry {
  id: string
  format: string
  shape: [number, number, number]
  dtype: string
  levels?: VolumeLevel[]
}

interface ApiResponse {
  niivuegpu?: { mounted?: boolean }
  volumes?: VolumeApiEntry[]
}

interface TileInstance extends NVInstance {
  id: string
  volume: VolumeApiEntry
  index: number
  col: number
  row: number
  level: number
  volumeId: string
  bounds: [[number, number], [number, number]]
  rotation: [number, number, number, number]
  viewport: CanvasViewport
}

interface Pointer {
  id: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  moved: boolean
}

interface ViewerState {
  api: ApiResponse | null
  nv: NiiVue | null
  volumes: VolumeApiEntry[]
  loadedKeys: Set<string>
  instances: TileInstance[]
  cols: number
  rows: number
  viewport: CanvasViewport
  selectedIndex: number
  pointer: Pointer | null
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  overview: el<HTMLCanvasElement>('overview'),
  loading: el<HTMLDivElement>('loading'),
  status: el<HTMLDivElement>('status'),
  count: el<HTMLDivElement>('stat-count'),
  grid: el<HTMLDivElement>('stat-grid'),
  zoom: el<HTMLDivElement>('stat-zoom'),
  dataset: el<HTMLSelectElement>('dataset'),
  colormap: el<HTMLSelectElement>('colormap'),
  zoomIn: el<HTMLButtonElement>('zoom-in'),
  zoomOut: el<HTMLButtonElement>('zoom-out'),
  zoomSlider: el<HTMLInputElement>('zoom-slider'),
  fitGrid: el<HTMLButtonElement>('fit-grid'),
  zoomSelected: el<HTMLButtonElement>('zoom-selected'),
  selectedTitle: el<HTMLHeadingElement>('selected-title'),
  selectedShape: el<HTMLElement>('selected-shape'),
  selectedLevel: el<HTMLElement>('selected-level'),
  selectedDtype: el<HTMLElement>('selected-dtype'),
  selectedTile: el<HTMLElement>('selected-tile'),
  rotationControls: el<HTMLDivElement>('rotation-controls'),
  selectedAzimuth: el<HTMLInputElement>('selected-azimuth'),
  selectedAzimuthValue: el<HTMLOutputElement>('selected-azimuth-value'),
  selectedElevation: el<HTMLInputElement>('selected-elevation'),
  selectedElevationValue: el<HTMLOutputElement>('selected-elevation-value'),
}

const state: ViewerState = {
  api: null,
  nv: null,
  volumes: [],
  loadedKeys: new Set(),
  instances: [],
  cols: 1,
  rows: 1,
  viewport: { pan: [0, 0], zoom: 1 },
  selectedIndex: -1,
  pointer: null,
}

main().catch((err: unknown) => showError(err))

async function main(): Promise<void> {
  setupEvents()
  els.status.textContent = 'Loading API catalog'
  state.api = await fetchJson<ApiResponse>('/api')
  // The original POC also checked niivuegpu mount; mono ships its own niivue
  // build via the bundled import so we skip that guard here.

  state.nv = new NiiVue({
    backgroundColor: [0, 0, 0, 1],
    isColorbarVisible: false,
    isDragDropEnabled: false,
    isInteractionEnabled: false,
    is3DCrosshairVisible: false,
    showBoundsBorder: false,
    sliceType: 4,
    volumeIllumination: 0.58,
    volumeIsNearestInterpolation: false,
  })
  await state.nv.attachToCanvas(els.canvas)
  state.nv.sliceType = 4

  await loadDataset(els.dataset.value)
}

function setupEvents(): void {
  window.addEventListener('resize', () => {
    state.nv?.resize()
    drawOverview()
  })

  els.canvas.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    els.canvas.setPointerCapture(event.pointerId)
    els.canvas.classList.add('dragging')
    state.pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
    }
  })

  els.canvas.addEventListener('pointermove', (event: PointerEvent) => {
    if (!state.pointer || state.pointer.id !== event.pointerId) return
    event.preventDefault()
    const dx = event.clientX - state.pointer.lastX
    const dy = event.clientY - state.pointer.lastY
    state.pointer.lastX = event.clientX
    state.pointer.lastY = event.clientY
    if (
      Math.hypot(
        event.clientX - state.pointer.startX,
        event.clientY - state.pointer.startY,
      ) > 4
    ) {
      state.pointer.moved = true
    }
    panByPixels(dx, dy)
  })

  for (const type of ['pointerup', 'pointercancel'] as const) {
    els.canvas.addEventListener(type, (event: PointerEvent) => {
      if (!state.pointer || state.pointer.id !== event.pointerId) return
      const pointer = state.pointer
      try {
        els.canvas.releasePointerCapture(event.pointerId)
      } catch (_) {
        // capture may already be released
      }
      state.pointer = null
      els.canvas.classList.remove('dragging')
      if (!pointer.moved && type === 'pointerup') {
        selectAt(event.clientX, event.clientY)
      }
    })
  }

  els.canvas.addEventListener('dblclick', (event: MouseEvent) => {
    event.preventDefault()
    const index = tileIndexAt(event.clientX, event.clientY)
    if (index >= 0) {
      selectTile(index)
      focusTile(index)
    }
  })

  els.canvas.addEventListener(
    'wheel',
    (event: WheelEvent) => {
      event.preventDefault()
      zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.0012))
    },
    { passive: false },
  )

  els.zoomIn.addEventListener('click', () => zoomAtCenter(1.45))
  els.zoomOut.addEventListener('click', () => zoomAtCenter(1 / 1.45))
  els.zoomSlider.addEventListener('input', () => {
    setZoomAtCenter(sliderToZoom(Number(els.zoomSlider.value)))
  })
  els.fitGrid.addEventListener('click', fitGrid)
  els.zoomSelected.addEventListener('click', () => {
    if (state.selectedIndex >= 0) focusTile(state.selectedIndex)
  })
  els.selectedAzimuth.addEventListener(
    'input',
    updateSelectedRotationFromSliders,
  )
  els.selectedElevation.addEventListener(
    'input',
    updateSelectedRotationFromSliders,
  )
  els.colormap.addEventListener('change', () => {
    void applyColormap()
  })
  els.dataset.addEventListener('change', () => {
    void loadDataset(els.dataset.value)
  })

  els.overview.addEventListener('pointerdown', (event: PointerEvent) => {
    const rect = els.overview.getBoundingClientRect()
    const x = (event.clientX - rect.left) / rect.width
    const y = 1 - (event.clientY - rect.top) / rect.height
    state.viewport.pan = [0.5 - x, 0.5 - y]
    applyViewport()
  })
}

async function loadDataset(filter: string): Promise<void> {
  els.loading.classList.remove('hidden')
  els.status.textContent = 'Selecting OpenNeuro volumes'
  state.selectedIndex = -1
  updateSelection()

  const all = (state.api?.volumes ?? [])
    .filter((volume) => volume.format === 'nifti')
    .sort((a, b) => a.id.localeCompare(b.id))
  let volumes = selectVolumes(all, filter)
  if (volumes.length === 0 && filter !== 'all') {
    volumes = selectVolumes(all, 'all')
  }
  if (volumes.length === 0) {
    throw new Error('No NIfTI volumes are registered in /api.')
  }
  volumes = volumes.slice(0, MAX_VOLUMES)
  state.volumes = volumes
  state.loadedKeys.clear()

  const layout = gridLayout(volumes.length)
  state.cols = layout.cols
  state.rows = layout.rows
  state.instances = buildInstances(volumes, layout.cols, layout.rows)

  els.status.textContent = `Loading ${volumes.length} rendered volumes`
  if (state.nv) {
    await state.nv.loadVolumes(
      volumes.map((volume) => {
        const level = displayLevel(volume)
        const key = volumeLevelKey(volume, level)
        state.loadedKeys.add(key)
        return {
          url: rawLevelUrl(volume.id, level),
          name: key,
          colormap: els.colormap.value,
          isColorbarVisible: false,
        }
      }),
    )
    state.nv.setInstances(state.instances)
  }
  fitGrid()
  els.loading.classList.add('hidden')
  els.status.textContent = datasetLabel(filter, volumes.length)
  updateStats()
}

function selectVolumes(
  volumes: VolumeApiEntry[],
  filter: string,
): VolumeApiEntry[] {
  if (filter === 'all') return volumes
  if (filter === 'openneuro') {
    return volumes.filter((volume) => /^ds\d+/i.test(volume.id))
  }
  return volumes.filter((volume) => volume.id.startsWith(filter))
}

function datasetLabel(filter: string, count: number): string {
  if (filter === 'all') return `${count} registered NIfTI volumes`
  if (filter === 'openneuro') return `${count} OpenNeuro NIfTI volumes`
  return `${count} anatomical scans from ${filter}`
}

function gridLayout(count: number): { cols: number; rows: number } {
  const rect = els.canvas.getBoundingClientRect()
  const aspect = Math.max(
    0.6,
    Math.min(2.4, rect.width / Math.max(1, rect.height)),
  )
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * aspect)))
  const rows = Math.max(1, Math.ceil(count / cols))
  return { cols, rows }
}

function buildInstances(
  volumes: VolumeApiEntry[],
  cols: number,
  rows: number,
): TileInstance[] {
  const gap = Math.min(0.0035, 0.04 / Math.max(cols, rows))
  const tileW = 1 / cols
  const tileH = 1 / rows
  return volumes.map((volume, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const level = displayLevel(volume)
    const x0 = col * tileW + gap
    const y0 = 1 - (row + 1) * tileH + gap
    const x1 = (col + 1) * tileW - gap
    const y1 = 1 - row * tileH - gap
    return {
      id: `openneuro-tile-${index}`,
      volume,
      index,
      col,
      row,
      level,
      volumeId: volumeLevelKey(volume, level),
      bounds: [
        [x0, y0],
        [x1, y1],
      ],
      rotation: [118 + (index % 5) * 4, 18 + (index % 3) * 6, 0, 0],
      viewport: { pan: [0, 0], zoom: 1.28 },
    }
  })
  // The `rotation` value is consumed by NiiVue as a 4-tuple even though the
  // POC packed only [azimuth, elevation]. The tile renderer uses the first
  // two entries; trailing zeros are inert.
}

function displayLevel(volume: VolumeApiEntry): number {
  const levels = (volume.levels ?? [])
    .filter((level) => level.ready !== false)
    .map((level) => Number(level.level))
    .filter((level) => Number.isInteger(level) && level >= 0)
    .sort((a, b) => a - b)
  return levels.length > 0 ? (levels[levels.length - 1] ?? 0) : 0
}

async function applyColormap(): Promise<void> {
  const nv = state.nv
  if (!nv) return
  const volumes = nv.model.getVolumes()
  for (const volume of volumes) {
    volume.colormap = els.colormap.value
  }
  await nv.updateGLVolume()
}

function panByPixels(dx: number, dy: number): void {
  const rect = els.canvas.getBoundingClientRect()
  state.viewport.pan[0] += dx / Math.max(1, rect.width * state.viewport.zoom)
  state.viewport.pan[1] -= dy / Math.max(1, rect.height * state.viewport.zoom)
  clampViewport()
  applyViewport()
}

function zoomAtCenter(factor: number): void {
  const rect = els.canvas.getBoundingClientRect()
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor)
}

function zoomAt(clientX: number, clientY: number, factor: number): void {
  setZoomAt(clientX, clientY, state.viewport.zoom * factor)
}

function setZoomAtCenter(nextZoom: number): void {
  const rect = els.canvas.getBoundingClientRect()
  setZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, nextZoom)
}

function setZoomAt(clientX: number, clientY: number, nextZoom: number): void {
  const before = screenToWorld(clientX, clientY)
  const rect = els.canvas.getBoundingClientRect()
  const sx = (clientX - rect.left) / rect.width
  const sy = (clientY - rect.top) / rect.height
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM)

  state.viewport.zoom = zoom
  state.viewport.pan[0] = (sx - 0.5) / zoom + 0.5 - before.x
  state.viewport.pan[1] = (1 - sy - 0.5) / zoom + 0.5 - before.y
  clampViewport()
  applyViewport()
}

function focusTile(index: number): void {
  const instance = state.instances[index]
  if (!instance) return
  const [[x0, y0], [x1, y1]] = instance.bounds
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const tileW = x1 - x0
  const tileH = y1 - y0
  const zoom = clamp(
    Math.min(FOCUS_TILE_FRACTION / tileW, FOCUS_TILE_FRACTION / tileH),
    MIN_ZOOM,
    MAX_ZOOM,
  )
  state.viewport.zoom = zoom
  state.viewport.pan = [0.5 - cx, 0.5 - cy]
  applyViewport()
}

function fitGrid(): void {
  state.viewport = { pan: [0, 0], zoom: 1 }
  applyViewport()
}

function applyViewport(): void {
  state.nv?.setViewport(state.viewport)
  updateStats()
  drawOverview()
}

function clampViewport(): void {
  const z = state.viewport.zoom
  const maxPan = Math.max(0, 0.5 - 0.5 / z)
  state.viewport.pan[0] = clamp(state.viewport.pan[0], -maxPan, maxPan)
  state.viewport.pan[1] = clamp(state.viewport.pan[1], -maxPan, maxPan)
}

function selectAt(clientX: number, clientY: number): void {
  const index = tileIndexAt(clientX, clientY)
  if (index >= 0) selectTile(index)
}

function tileIndexAt(clientX: number, clientY: number): number {
  const point = screenToWorld(clientX, clientY)
  return state.instances.findIndex((instance) => {
    const [[x0, y0], [x1, y1]] = instance.bounds
    return point.x >= x0 && point.x <= x1 && point.y >= y0 && point.y <= y1
  })
}

function screenToWorld(
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const rect = els.canvas.getBoundingClientRect()
  const sx = (clientX - rect.left) / Math.max(1, rect.width)
  const sy = (clientY - rect.top) / Math.max(1, rect.height)
  return {
    x: (sx - 0.5) / state.viewport.zoom + 0.5 - state.viewport.pan[0],
    y: (1 - sy - 0.5) / state.viewport.zoom + 0.5 - state.viewport.pan[1],
  }
}

function selectTile(index: number): void {
  state.selectedIndex = index
  updateSelection()
  drawOverview()
}

function updateSelection(): void {
  const instance = state.instances[state.selectedIndex]
  if (!instance) {
    els.selectedTitle.textContent = 'None'
    els.selectedShape.textContent = '-'
    els.selectedLevel.textContent = '-'
    els.selectedDtype.textContent = '-'
    els.selectedTile.textContent = '-'
    syncRotationControls(null)
    return
  }
  const volume = instance.volume
  els.selectedTitle.textContent = volume.id
  els.selectedShape.textContent = Array.isArray(volume.shape)
    ? volume.shape.join(' x ')
    : '-'
  els.selectedLevel.textContent = `L${instance.level}`
  els.selectedDtype.textContent = volume.dtype || '-'
  els.selectedTile.textContent = `${instance.col + 1}, ${instance.row + 1}`
  syncRotationControls(instance)
}

function updateSelectedRotationFromSliders(): void {
  const instance = state.instances[state.selectedIndex]
  if (!instance) return

  const azimuth = Number(els.selectedAzimuth.value)
  const elevation = Number(els.selectedElevation.value)
  instance.rotation = [azimuth, elevation, 0, 0]
  syncRotationControls(instance)
  state.nv?.setInstances(state.instances)
}

function syncRotationControls(instance: TileInstance | null): void {
  const isEnabled = Boolean(instance)
  els.rotationControls.classList.toggle('is-disabled', !isEnabled)
  els.selectedAzimuth.disabled = !isEnabled
  els.selectedElevation.disabled = !isEnabled

  if (!instance) {
    els.selectedAzimuth.value = '0'
    els.selectedElevation.value = '0'
    els.selectedAzimuthValue.textContent = '-'
    els.selectedElevationValue.textContent = '-'
    els.selectedAzimuth.removeAttribute('aria-valuetext')
    els.selectedElevation.removeAttribute('aria-valuetext')
    return
  }

  const [azimuthRaw = 0, elevationRaw = 0] = instance.rotation
  const normalizedAzimuth = Math.round(clamp(azimuthRaw, 0, 360))
  const clampedElevation = Math.round(clamp(elevationRaw, -90, 90))
  els.selectedAzimuth.value = String(normalizedAzimuth)
  els.selectedElevation.value = String(clampedElevation)
  els.selectedAzimuthValue.textContent = `${normalizedAzimuth} deg`
  els.selectedElevationValue.textContent = `${clampedElevation} deg`
  els.selectedAzimuth.setAttribute(
    'aria-valuetext',
    `${normalizedAzimuth} degrees`,
  )
  els.selectedElevation.setAttribute(
    'aria-valuetext',
    `${clampedElevation} degrees`,
  )
}

function updateStats(): void {
  els.count.textContent = `${state.instances.length} volumes`
  els.grid.textContent = `${state.cols} x ${state.rows}`
  els.zoom.textContent = `zoom ${state.viewport.zoom.toFixed(2)}`
  els.zoomSlider.value = String(zoomToSlider(state.viewport.zoom))
  els.zoomSlider.setAttribute(
    'aria-valuetext',
    `${state.viewport.zoom.toFixed(2)}x`,
  )
}

function drawOverview(): void {
  const canvas = els.overview
  const rect = canvas.getBoundingClientRect()
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  if (
    canvas.width !== Math.round(width * dpr) ||
    canvas.height !== Math.round(height * dpr)
  ) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = 'rgba(0,0,0,0.32)'
  ctx.fillRect(0, 0, width, height)

  const pad = 9
  const gw = width - pad * 2
  const gh = height - pad * 2
  ctx.strokeStyle = 'rgba(143,224,189,0.22)'
  ctx.strokeRect(pad + 0.5, pad + 0.5, gw - 1, gh - 1)

  for (const instance of state.instances) {
    const [[x0, y0], [x1, y1]] = instance.bounds
    const x = pad + x0 * gw
    const y = pad + (1 - y1) * gh
    const w = Math.max(1, (x1 - x0) * gw)
    const h = Math.max(1, (y1 - y0) * gh)
    ctx.fillStyle =
      instance.index === state.selectedIndex
        ? 'rgba(240,196,111,0.94)'
        : 'rgba(143,224,189,0.36)'
    ctx.fillRect(x, y, w, h)
  }

  const view = visibleWorldRect()
  ctx.strokeStyle = 'rgba(128,184,255,0.9)'
  ctx.lineWidth = 1.5
  ctx.strokeRect(
    pad + view.x0 * gw,
    pad + (1 - view.y1) * gh,
    (view.x1 - view.x0) * gw,
    (view.y1 - view.y0) * gh,
  )
}

function visibleWorldRect(): {
  x0: number
  x1: number
  y0: number
  y1: number
} {
  const z = state.viewport.zoom
  return {
    x0: clamp(0.5 - state.viewport.pan[0] - 0.5 / z, 0, 1),
    x1: clamp(0.5 - state.viewport.pan[0] + 0.5 / z, 0, 1),
    y0: clamp(0.5 - state.viewport.pan[1] - 0.5 / z, 0, 1),
    y1: clamp(0.5 - state.viewport.pan[1] + 0.5 / z, 0, 1),
  }
}

function rawLevelUrl(id: string, level: number): string {
  return `/volumes/${encodeURIComponent(id)}/raw.nii.gz?level=${level}`
}

function volumeLevelKey(volume: VolumeApiEntry, level: number): string {
  return `${volume.id}:L${level}`
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return (await res.json()) as T
}

function showError(err: unknown): void {
  console.error(err)
  els.loading.classList.remove('hidden')
  const msg =
    err instanceof Error ? err.message : 'OpenNeuro grid failed to load.'
  els.loading.textContent = msg
  els.status.textContent = 'OpenNeuro grid unavailable'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function sliderToZoom(value: number): number {
  const t = clamp(value / ZOOM_SLIDER_MAX, 0, 1)
  return MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM) ** t
}

function zoomToSlider(zoom: number): number {
  const safeZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
  const t = Math.log(safeZoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM)
  return Math.round(t * ZOOM_SLIDER_MAX)
}
