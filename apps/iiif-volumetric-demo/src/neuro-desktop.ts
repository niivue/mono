// Neuro infinite desktop: 1,600-tile grid sampled from OpenNeuro subjects.
// Uses manual pointer + wheel handlers (no NVCanvasViewportController) and
// drives a minimap rectangle that maps to the [-2, 2] world.

import type { CanvasViewport, NVInstance } from '@niivue/niivue/webgl2'
import NiiVue from '@niivue/niivue/webgl2'

interface VolumeLevel {
  level: number
  shape: [number, number, number]
}

interface VolumeApiEntry {
  id: string
  format: string
  shape: [number, number, number]
  dtype: string
  levels: VolumeLevel[]
}

interface ApiResponse {
  volumes?: VolumeApiEntry[]
}

interface TileInstance extends NVInstance {
  id: string
  volumeId: string
  bounds: [[number, number], [number, number]]
  colormap: string
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const canvas = el<HTMLCanvasElement>('nv-canvas')
const navModeEl = el<HTMLSelectElement>('navMode')
const colormapEl = el<HTMLSelectElement>('colormap')
const logEl = el<HTMLDivElement>('debug-log')
const statusEl = el<HTMLDivElement>('status')
const zoomInBtn = el<HTMLButtonElement>('zoomIn')
const zoomOutBtn = el<HTMLButtonElement>('zoomOut')
const minimapViewport = el<HTMLDivElement>('minimap-viewport')
const minimapContainer = el<HTMLDivElement>('minimap-container')

function log(msg: string): void {
  const div = document.createElement('div')
  div.textContent = msg
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

main().catch((err: unknown) => {
  console.error(err)
  const msg = err instanceof Error ? err.message : String(err)
  log(`FATAL: ${msg}`)
})

async function main(): Promise<void> {
  log('Initializing Robust Neuro Desktop...')
  const api = (await fetch('/api').then((r) => r.json())) as ApiResponse
  const volumeDefs = (api.volumes ?? []).filter(
    (v) =>
      v.id.startsWith('ds000228') ||
      v.id.startsWith('ds000030') ||
      v.id.startsWith('ds000001'),
  )

  if (volumeDefs.length === 0) {
    log('Error: No volumes found.')
    return
  }

  statusEl.textContent = `${volumeDefs.length} subjects found. Rendering 1,600 instances.`

  const nv = new NiiVue({
    backgroundColor: [0, 0, 0, 1],
    showBoundsBorder: false,
    isColorbarVisible: false,
    isInteractionEnabled: true,
    isDragDropEnabled: false,
    is3DCrosshairVisible: false,
    azimuth: 120,
    elevation: 20,
  })
  await nv.attachToCanvas(canvas)
  nv.sliceType = 4

  log('Loading volume data...')
  const volumeData: { url: string; colormap: string; name: string }[] = []
  for (const v of volumeDefs) {
    const last = v.levels[v.levels.length - 1]
    const lvl = v.levels.find((l) => l.level === 3) ?? last
    if (!lvl) continue
    volumeData.push({
      url: `/volumes/${v.id}/raw?level=${lvl.level}`,
      colormap: 'Gray',
      name: v.id,
    })
  }
  await nv.loadVolumes(volumeData)

  const COLS = 40
  const ROWS = 40
  const worldSize = 4.0
  const start = -worldSize / 2
  const tileW = worldSize / COLS
  const tileH = worldSize / ROWS

  const instances: TileInstance[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const volDef = volumeDefs[(r * COLS + c) % volumeDefs.length]
      if (!volDef) continue
      instances.push({
        id: `tile-${r}-${c}`,
        volumeId: volDef.id,
        bounds: [
          [start + c * tileW, start + r * tileH],
          [start + (c + 1) * tileW, start + (r + 1) * tileH],
        ],
        colormap: (r + c) % 2 === 0 ? 'Gray' : 'viridis',
      })
    }
  }
  nv.setInstances(instances)

  const viewport: CanvasViewport = { pan: [0, 0], zoom: 1 }
  let currentMode: 'world' | 'instance' = 'world'
  let selectedTileIndex = -1

  const updateMinimap = (): void => {
    const aspect = canvas.clientWidth / canvas.clientHeight || 1
    const z = viewport.zoom
    const [px, py] = viewport.pan

    const halfW = (aspect > 1 ? aspect : 1) / (z * worldSize)
    const halfH = (aspect > 1 ? 1 : 1 / aspect) / (z * worldSize)

    const centerX = 0.5 - px / worldSize
    const centerY = 0.5 - py / worldSize

    minimapViewport.style.left = `${(centerX - halfW) * 100}%`
    minimapViewport.style.top = `${(centerY - halfH) * 100}%`
    minimapViewport.style.width = `${halfW * 2 * 100}%`
    minimapViewport.style.height = `${halfH * 2 * 100}%`
  }

  let isDragging = false
  canvas.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button === 0) isDragging = true
  })
  window.addEventListener('mouseup', () => {
    isDragging = false
  })

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (!isDragging || currentMode !== 'world') return
    const dx = e.movementX / (canvas.clientWidth * viewport.zoom)
    const dy = e.movementY / (canvas.clientHeight * viewport.zoom)
    viewport.pan[0] += dx
    viewport.pan[1] += dy
    nv.setViewport(viewport)
    updateMinimap()
  })

  canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      viewport.zoom = Math.max(0.05, Math.min(1000, viewport.zoom * factor))
      nv.setViewport(viewport)
      updateMinimap()
    },
    { passive: false },
  )

  minimapContainer.onmousedown = (e: MouseEvent): void => {
    const rect = minimapContainer.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height

    const worldX = (mx - 0.5) * worldSize
    const worldY = (my - 0.5) * worldSize

    viewport.pan = [-worldX, -worldY]
    nv.setViewport(viewport)
    updateMinimap()
  }

  // Selection event: emitted at runtime by niivue's interaction layer
  // but not yet enumerated in NVEventMap. Use the untyped overload.
  nv.addEventListener('tileSelected', (event: Event) => {
    const detail = (event as CustomEvent<{ index: number }>).detail
    selectedTileIndex = detail.index
    const inst = instances[selectedTileIndex]
    if (!inst) return

    log(`Selected: ${inst.volumeId}`)

    const [[x0, y0], [x1, y1]] = inst.bounds
    const centerX = (x0 + x1) / 2
    const centerY = (y0 + y1) / 2

    viewport.pan = [-centerX, -centerY]
    viewport.zoom = Math.max(viewport.zoom, 10)
    nv.setViewport(viewport)
    updateMinimap()
  })

  navModeEl.onchange = (): void => {
    currentMode = navModeEl.value === 'instance' ? 'instance' : 'world'
    // mono niivue has no runtime enableInteraction/disableInteraction.
    // Mode change only gates pointer-pan world updates above.
    if (currentMode === 'world') {
      nv.setViewport(viewport)
    }
    log(`Mode: ${currentMode}`)
  }

  const runZoom = (factor: number): void => {
    viewport.zoom = Math.max(0.05, Math.min(1000, viewport.zoom * factor))
    if (selectedTileIndex !== -1) {
      const sel = instances[selectedTileIndex]
      if (sel) {
        const [[x0, y0], [x1, y1]] = sel.bounds
        viewport.pan = [-(x0 + x1) / 2, -(y0 + y1) / 2]
      }
    }
    nv.setViewport(viewport)
    updateMinimap()
  }
  zoomInBtn.onclick = (): void => runZoom(1.5)
  zoomOutBtn.onclick = (): void => runZoom(0.75)

  colormapEl.onchange = (event: Event): void => {
    const target = event.target as HTMLSelectElement
    const val = target.value
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i]
      if (!inst) continue
      if (val === 'alternate') {
        const r = Math.floor(i / COLS)
        const c = i % COLS
        inst.colormap = (r + c) % 2 === 0 ? 'Gray' : 'viridis'
      } else {
        inst.colormap = val
      }
    }
    nv.setInstances([...instances])
  }

  nv.setViewport(viewport)
  updateMinimap()
  log('Desktop Ready. Drag to pan, Wheel to zoom.')
}
