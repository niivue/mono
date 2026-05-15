// Infinite tiled volume desktop. One NiiVue instance hosts a grid of
// 10,000 instances streaming between LODs as the user pans/zooms.

import { NVCanvasViewportController } from '@niivue/niivue/viewport'
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

interface VolumeLoadSpec {
  url: string
  colormap: string
  name: string
}

interface TileInstance extends NVInstance {
  id: string
  volumeId: string
  bounds: [[number, number], [number, number]]
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
const zoomInBtn = el<HTMLButtonElement>('zoomIn')
const zoomOutBtn = el<HTMLButtonElement>('zoomOut')
const screenshotBtn = el<HTMLButtonElement>('screenshot')

function log(msg: string): void {
  const div = document.createElement('div')
  div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  logEl.appendChild(div)
  logEl.scrollTop = logEl.scrollHeight
}

main().catch((err: unknown) => {
  console.error(err)
  const msg = err instanceof Error ? err.message : String(err)
  log(`FATAL: ${msg}`)
})

async function main(): Promise<void> {
  log('Starting Infinite Desktop (Composited)...')
  const api = (await fetch('/api').then((r) => r.json())) as ApiResponse
  const volumeDefs = api.volumes ?? []
  if (volumeDefs.length === 0) return

  const nv = new NiiVue({
    backgroundColor: [0.1, 0.1, 0.1, 1],
    showBoundsBorder: false,
    isColorbarVisible: false,
    isInteractionEnabled: true,
    isDragDropEnabled: false,
    is3DCrosshairVisible: false,
    azimuth: 0,
    elevation: 0,
  })
  await nv.attachToCanvas(canvas)
  nv.sliceType = 4

  log(`Loading ${volumeDefs.length} unique volumes...`)
  const volumeData: VolumeLoadSpec[] = []
  for (const v of volumeDefs) {
    const levelsToLoad = v.levels.map((l) => l.level)
    for (const level of levelsToLoad) {
      volumeData.push({
        url: `/volumes/${v.id}/raw?level=${level}`,
        colormap: 'Gray',
        name: `${v.id}_L${level}`,
      })
    }
  }
  await nv.loadVolumes(volumeData)

  const cols = 100
  const rows = 100
  const tileW = 1.0 / cols
  const tileH = 1.0 / rows

  const instances: TileInstance[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const volDef = volumeDefs[(r * cols + c) % volumeDefs.length]
      if (!volDef) continue
      const lowLevel = Math.max(...volDef.levels.map((l) => l.level))
      instances.push({
        id: `tile-${r}-${c}`,
        volumeId: `${volDef.id}_L${lowLevel}`,
        bounds: [
          [c * tileW, r * tileH],
          [(c + 1) * tileW, (r + 1) * tileH],
        ],
      })
    }
  }

  log(`Initializing ${instances.length} tile instances...`)
  nv.setInstances(instances)

  // The runtime fires this on tile click; we don't have a typed event for
  // it yet in mono niivue, so use the untyped overload.
  nv.addEventListener('tileSelected', (event: Event) => {
    const detail = (event as CustomEvent<{ index: number; volumeId: string }>)
      .detail
    log(`Selected Tile: ${detail.index} (Volume: ${detail.volumeId})`)
  })

  let viewport: CanvasViewport = { pan: [0, 0], zoom: 1 }
  let currentMode: 'world' | 'instance' = 'world'

  let lastResUpdate = 0
  const updateResolution = (vp: CanvasViewport): void => {
    const now = Date.now()
    if (now - lastResUpdate < 200) return
    lastResUpdate = now

    const z = vp.zoom
    const [px, py] = vp.pan

    const aspect = canvas.clientWidth / canvas.clientHeight
    const halfW = (aspect > 1 ? aspect : 1) / z
    const halfH = (aspect > 1 ? 1 : 1 / aspect) / z
    const centerX = 0.5 - px
    const centerY = 0.5 - py

    const vMinX = centerX - halfW
    const vMaxX = centerX + halfW
    const vMinY = centerY - halfH
    const vMaxY = centerY + halfH

    let changedCount = 0
    for (const inst of instances) {
      const [[x0, y0], [x1, y1]] = inst.bounds
      const isVisible = !(x1 < vMinX || x0 > vMaxX || y1 < vMinY || y0 > vMaxY)

      const parts = inst.volumeId.split('_L')
      const volIdBase = parts[0]
      if (!volIdBase) continue
      const volDef = volumeDefs.find((v) => v.id === volIdBase)
      if (!volDef) continue

      const availableLevels = volDef.levels.map((l) => l.level)
      let targetLevel = Math.max(...availableLevels)

      if (isVisible) {
        if (z > 20 && availableLevels.includes(0)) targetLevel = 0
        else if (z > 10 && availableLevels.includes(1)) targetLevel = 1
        else if (z > 5 && availableLevels.includes(2)) targetLevel = 2
      }

      const newVolId = `${volIdBase}_L${targetLevel}`
      if (inst.volumeId !== newVolId) {
        inst.volumeId = newVolId
        changedCount++
      }
    }
    if (changedCount > 0) {
      log(`Streaming: ${changedCount} tiles updated.`)
      nv.setInstances(instances)
    }
  }

  const controller = new NVCanvasViewportController(canvas, {
    apply: (vp: CanvasViewport): void => {
      if (currentMode === 'world') {
        viewport = vp
        nv.setViewport(viewport)
        updateResolution(viewport)
      }
    },
    getViewport: (): CanvasViewport => viewport,
    panButton: 0,
    minZoom: 0.0001,
    maxZoom: 500,
    inertia: true,
  })
  controller.attach()

  zoomInBtn.onclick = (): void => {
    const next: CanvasViewport = { ...viewport, zoom: viewport.zoom * 1.5 }
    controller.setViewport(next, { animate: true })
  }
  zoomOutBtn.onclick = (): void => {
    const next: CanvasViewport = { ...viewport, zoom: viewport.zoom / 1.5 }
    controller.setViewport(next, { animate: true })
  }

  screenshotBtn.onclick = (): void => {
    log('Capturing screenshot...')
    nv.drawScene()
    canvas.toBlob(async (blob) => {
      if (!blob) {
        log('Screenshot failed: empty blob')
        return
      }
      const resp = await fetch('/dev/save-screenshot', {
        method: 'POST',
        body: blob,
      })
      const json = (await resp.json()) as { path?: string }
      log(`Saved: ${json.path ?? '(unknown path)'}`)
    }, 'image/png')
  }

  navModeEl.onchange = (): void => {
    currentMode = navModeEl.value === 'instance' ? 'instance' : 'world'
    log(`Navigation Mode: ${currentMode}`)
    // mono niivue has no runtime enable/disableInteraction toggle;
    // interaction is set at construction. Mode change is now a no-op
    // beyond gating the world-pan viewport apply above.
  }
  navModeEl.value = 'world'
  navModeEl.onchange(new Event('change'))

  colormapEl.onchange = (event: Event): void => {
    const target = event.target as HTMLSelectElement
    const cm = target.value
    log(`Applying colormap ${cm} to all volumes...`)
    for (let i = 0; i < volumeData.length; i++) {
      void nv.setVolume(i, { colormap: cm })
    }
  }

  log('Grid ready. Use +/- or Wheel to zoom, Drag to pan.')
}
