import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react'
import type { ColorMap, NiiVueLocation } from '@niivue/niivue'
import type { Backend, ClipPlane, DesktopItem, JsonValue, VolumeMetadata } from '../domain/desktop'
import { fetchVolumeMetadata, rawVolumeUrl } from '../domain/desktop'

interface NiivueStageProps {
  item: DesktopItem | null
  layers: NiivueRenderLayer[]
  activeClipPlaneId: string
  backend: Backend
  colormap: string
  clipPlanes: ClipPlane[]
  isActive: boolean
  renderWheelMode: 'zoom' | 'clip-plane'
  onClipPlaneDepthChange: (planeId: string, depth: number) => void
  onLocationChange?: (location: NiiVueLocation | null) => void
}

export interface NiivueRenderLayer {
  item: DesktopItem
  kind: 'base' | 'overlay'
  isAtlas?: boolean
  opacity: number
}

interface NiiVueLike {
  canvas?: HTMLCanvasElement
  activeClipPlaneIndex?: number
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  loadVolumes(volumes: NiiVueVolumeOptions[]): Promise<unknown>
  setColormapLabel?(volumeIndex: number, cmap: ColorMap | null): Promise<void>
  setVolume?(volumeIndex: number, options: { colormap?: string; opacity?: number }): Promise<unknown>
  addEventListener?(
    type: 'locationChange',
    listener: (event: CustomEvent<NiiVueLocation>) => void,
    options?: boolean | AddEventListenerOptions
  ): void
  removeEventListener?(
    type: 'locationChange',
    listener: (event: CustomEvent<NiiVueLocation>) => void,
    options?: boolean | EventListenerOptions
  ): void
  azimuth?: number
  elevation?: number
  model?: {
    scene?: {
      scaleMultiplier?: number
    }
  }
  setClipPlanes?(planes: number[][]): void
  setClipPlane?(plane: number[]): void
  drawScene(): void
  resize?: () => void
  destroy?: () => void
}

interface RenderVolumeLevel {
  level: number
  url: string
  shape?: [number, number, number]
}

interface NiiVueVolumeOptions {
  url: string | File
  name: string
  colormap?: string
  opacity?: number
  isColorbarVisible?: boolean
}

interface VolumePrefetch {
  url: string
  file: Promise<File>
}

interface RenderViewSnap {
  id: RenderSnapId
  label: string
  shortLabel: string
  azimuth: number
  elevation: number
  shortcut?: string
}

type RenderSnapId = 'coronal' | 'sagittal' | 'axial'
type NiiVueConstructor = new (options?: Record<string, unknown>) => NiiVueLike

const CLIP_DEPTH_WHEEL_STEP = 0.0015
const NIVUE_SLICE_TYPE_RENDER = 4
const NIVUE_SHOW_RENDER_ALWAYS = 1
const CORONAL_SNAP: RenderViewSnap = {
  id: 'coronal',
  label: 'Coronal',
  shortLabel: 'Cor',
  azimuth: 180,
  elevation: 0,
  shortcut: '1 / Numpad 1'
}
const SAGITTAL_SNAP: RenderViewSnap = {
  id: 'sagittal',
  label: 'Sagittal',
  shortLabel: 'Sag',
  azimuth: -90,
  elevation: 0,
  shortcut: '3 / Numpad 3'
}
const AXIAL_SNAP: RenderViewSnap = {
  id: 'axial',
  label: 'Axial',
  shortLabel: 'Ax',
  azimuth: 0,
  elevation: 90,
  shortcut: '7 / Numpad 7'
}
const RENDER_VIEW_SNAPS = [CORONAL_SNAP, SAGITTAL_SNAP, AXIAL_SNAP]
const OVERLAY_COLORMAPS = ['magma', 'viridis', 'actc'] as const
const atlasColorMapCache = new Map<string, Promise<ColorMap | null>>()
const BLENDER_RENDER_VIEW_SNAPS: Record<string, { normal: RenderViewSnap; reverse: RenderViewSnap }> = {
  Digit1: {
    normal: CORONAL_SNAP,
    reverse: {
      ...CORONAL_SNAP,
      label: 'Posterior coronal',
      azimuth: 0,
      shortcut: 'Ctrl+1'
    }
  },
  Numpad1: {
    normal: CORONAL_SNAP,
    reverse: {
      ...CORONAL_SNAP,
      label: 'Posterior coronal',
      azimuth: 0,
      shortcut: 'Ctrl+Numpad 1'
    }
  },
  Digit3: {
    normal: SAGITTAL_SNAP,
    reverse: {
      ...SAGITTAL_SNAP,
      label: 'Left sagittal',
      azimuth: 90,
      shortcut: 'Ctrl+3'
    }
  },
  Numpad3: {
    normal: SAGITTAL_SNAP,
    reverse: {
      ...SAGITTAL_SNAP,
      label: 'Left sagittal',
      azimuth: 90,
      shortcut: 'Ctrl+Numpad 3'
    }
  },
  Digit7: {
    normal: AXIAL_SNAP,
    reverse: {
      ...AXIAL_SNAP,
      label: 'Inferior axial',
      elevation: -90,
      shortcut: 'Ctrl+7'
    }
  },
  Numpad7: {
    normal: AXIAL_SNAP,
    reverse: {
      ...AXIAL_SNAP,
      label: 'Inferior axial',
      elevation: -90,
      shortcut: 'Ctrl+Numpad 7'
    }
  }
}

export function NiivueStage({
  item,
  layers,
  activeClipPlaneId,
  backend,
  colormap,
  clipPlanes,
  isActive,
  renderWheelMode,
  onClipPlaneDepthChange,
  onLocationChange
}: NiivueStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<NiiVueLike | null>(null)
  const prefetchRef = useRef<VolumePrefetch | null>(null)
  const [status, setStatus] = useState('Waiting for a dataset selection.')
  const [snapId, setSnapId] = useState<RenderSnapId | null>(null)
  const primaryItem = layers[0]?.item ?? item
  const layerLoadKey = layers.map(layerLoadSignature).join('|')

  // Fetch the coarse volume the instant it is selected — at high priority, in
  // parallel with NiiVue init, and ahead of the low-priority 2D preview tiles.
  // We own the bytes and hand them straight to loadVolumes as a File, so NiiVue
  // never issues a second (default-priority) request that would queue behind the
  // previews; the only network request for this volume is this prioritized one.
  useEffect(() => {
    if (!primaryItem) {
      prefetchRef.current = null
      return
    }
    const coarse = renderVolumeLevels(primaryItem)[0]
    if (!coarse) {
      prefetchRef.current = null
      return
    }

    const controller = new AbortController()
    const file = fetchVolumeFile(coarse.url, controller.signal)
    // Avoid an unhandled rejection; loadRenderVolumeLods awaits and reports it.
    file.catch(() => {})
    const prefetch: VolumePrefetch = { url: coarse.url, file }
    prefetchRef.current = prefetch

    return () => {
      controller.abort()
      if (prefetchRef.current === prefetch) prefetchRef.current = null
    }
  }, [primaryItem])

  useEffect(() => {
    let cancelled = false
    let localNv: NiiVueLike | null = null
    let locationListener: ((event: CustomEvent<NiiVueLocation>) => void) | null = null

    async function attach(): Promise<void> {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!canvas || layers.length === 0 || !primaryItem) {
        setSnapId(null)
        setStatus('Waiting for a dataset selection.')
        onLocationChange?.(null)
        return
      }

      setSnapId(null)
      syncCanvasSize(canvas, stage)
      setStatus(`Loading ${layerStackLabel(layers)} with ${backend.toUpperCase()}.`)
      try {
        const NiiVue = await loadNiiVue(backend)
        if (cancelled) return

        const nv = new NiiVue({
          backend,
          backgroundColor: [0.02, 0.024, 0.018, 1],
          clipPlaneColor: [0.95, 0.2, 0.12, 0.7],
          isResizeCanvas: true,
          show3Dcrosshair: false,
          showRender: NIVUE_SHOW_RENDER_ALWAYS,
          sliceType: NIVUE_SLICE_TYPE_RENDER,
          loadingText: ''
        })
        localNv = nv
        nvRef.current = nv
        await nv.attachToCanvas(canvas)
        if (cancelled) return
        if (onLocationChange && nv.addEventListener) {
          locationListener = (event) => {
            if (!cancelled) onLocationChange(event.detail)
          }
          nv.addEventListener('locationChange', locationListener)
        }
        const attachedCanvas = activeCanvasFor(nv, canvas)
        canvasRef.current = attachedCanvas
        resizeNiiVue(nv, attachedCanvas, stage)
        await loadRenderVolumeLods({
          layers,
          nv,
          colormap,
          clipPlanes,
          canvas: attachedCanvas,
          stage,
          prefetch: prefetchRef.current,
          isCancelled: () => cancelled,
          setStatus
        })
        applyActiveClipPlane(nv, clipPlanes, activeClipPlaneId)
      } catch (error) {
        if (!cancelled) {
          nvRef.current = null
          setStatus(error instanceof Error ? error.message : String(error))
        }
      }
    }

    void attach()
    return () => {
      cancelled = true
      if (localNv && nvRef.current === localNv) {
        if (locationListener) {
          localNv.removeEventListener?.('locationChange', locationListener)
        }
        localNv.destroy?.()
        nvRef.current = null
      }
      onLocationChange?.(null)
    }
    // colormap is intentionally omitted: a colormap change is applied in place by
    // the effect below rather than tearing down and reloading the whole volume.
  }, [backend, layerLoadKey, primaryItem, onLocationChange])

  // Apply display changes in place. Recreating the NiiVue instance (as the
  // attach effect does) just to recolor or hide an atlas would re-import the
  // module, re-attach the canvas, and refetch every LOD — far too heavy for a
  // dropdown or checkbox change.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv?.setVolume) return
    void Promise.all(layers.map((layer, index) => (
      nv.setVolume?.(index, {
        colormap: colormapForLayer(layer, index, colormap),
        opacity: layer.opacity
      }) ?? Promise.resolve()
    ))).catch(() => {
      // No volume loaded yet (or backend lacks setVolume); the attach effect
      // already loads with current display options, so this is safe to ignore.
    })
  }, [colormap, layers])

  useEffect(() => {
    const stage = stageRef.current
    const canvas = canvasRef.current
    if (!stage || !canvas) return
    const stageElement = stage
    const canvasElement = canvas
    let frame = 0

    function resize(): void {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const nv = nvRef.current
        if (nv) {
          resizeNiiVue(nv, canvasElement, stageElement)
        } else {
          syncCanvasSize(canvasElement, stageElement)
        }
      })
    }

    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(stageElement)
    window.addEventListener('resize', resize)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    applyActiveClipPlane(nv, clipPlanes, activeClipPlaneId)
    applyClipPlanes(nv, clipPlanes)
    // Redraw to reflect the change, but don't resize the canvas — clip planes
    // move on every wheel tick, and a full resync per tick is what made wheel
    // clipping janky. The ResizeObserver effect owns actual resizes.
    nv.drawScene()
  }, [activeClipPlaneId, clipPlanes])

  useEffect(() => {
    if (!isActive || !primaryItem) return

    function onKeyDown(event: KeyboardEvent): void {
      if (isEditableTarget(event.target)) return
      const snap = blenderSnapForEvent(event)
      if (!snap) return

      event.preventDefault()
      event.stopPropagation()
      snapRenderView(snap)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isActive, primaryItem])

  function snapRenderView(snap: RenderViewSnap): void {
    const nv = nvRef.current
    if (!nv || !('azimuth' in nv) || !('elevation' in nv)) return

    nv.azimuth = snap.azimuth
    nv.elevation = snap.elevation
    setSnapId(snap.id)
    resizeNiiVue(nv, canvasRef.current, stageRef.current)
  }

  function clearSnapSelection(): void {
    if (snapId) setSnapId(null)
  }

  function handleWheelCapture(event: ReactWheelEvent<HTMLDivElement>): void {
    clearSnapSelection()
    const nv = nvRef.current
    if (!nv) return

    if (renderWheelMode === 'clip-plane') {
      // Always handle the wheel ourselves: drive the active plane's depth
      // through React state (the same value the depth slider owns) rather than
      // letting NiiVue mutate hidden internal state. That keeps React the single
      // source of truth, so re-applying clipPlanes never resets another plane.
      event.preventDefault()
      event.stopPropagation()
      const activeIndex = applyActiveClipPlane(nv, clipPlanes, activeClipPlaneId)
      if (activeIndex < 0) return
      const active = clipPlanes.find((plane) => plane.id === activeClipPlaneId)
      if (!active) return
      const depth = clamp(active.depth + event.deltaY * CLIP_DEPTH_WHEEL_STEP, -1, 1)
      if (depth !== active.depth) onClipPlaneDepthChange(activeClipPlaneId, depth)
      return
    }

    event.preventDefault()
    event.stopPropagation()
    zoomRenderWithWheel(nv, event.deltaY)
  }

  return (
    <div
      className="nv-render-stage"
      onPointerDown={clearSnapSelection}
      onWheelCapture={handleWheelCapture}
      ref={stageRef}
    >
      <canvas
        key={backend}
        ref={canvasRef}
        role="img"
        aria-label={primaryItem ? `3D render of ${primaryItem.label}` : 'NiiVue 3D render — no volume selected'}
      />
      <div className="nv-render-snap-controls" aria-label="Snap render view">
        {RENDER_VIEW_SNAPS.map((snap) => (
          <button
            aria-label={`Snap to ${snap.label} view`}
            aria-pressed={snapId === snap.id}
            className={snapId === snap.id ? 'is-active' : ''}
            disabled={!primaryItem}
            key={snap.id}
            onClick={() => snapRenderView(snap)}
            title={`Snap to ${snap.label} (${snap.shortcut})`}
            type="button"
          >
            {snap.shortLabel}
          </button>
        ))}
      </div>
      <div className="nv-render-status" role="status" aria-live="polite">{status}</div>
    </div>
  )
}

async function loadNiiVue(backend: Backend): Promise<NiiVueConstructor> {
  if (backend === 'webgpu') {
    try {
      const module = await import('@niivue/niivue/webgpu')
      return module.default as NiiVueConstructor
    } catch {
      const module = await import('@niivue/niivue')
      return module.default as NiiVueConstructor
    }
  }

  try {
    const module = await import('@niivue/niivue/webgl2')
    return module.default as NiiVueConstructor
  } catch {
    const module = await import('@niivue/niivue')
    return module.default as NiiVueConstructor
  }
}

function blenderSnapForEvent(event: KeyboardEvent): RenderViewSnap | null {
  if (event.altKey || event.metaKey || event.shiftKey) return null

  const snap = BLENDER_RENDER_VIEW_SNAPS[event.code]
  if (!snap) return null

  return event.ctrlKey ? snap.reverse : snap.normal
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)
}

async function loadRenderVolumeLods({
  layers,
  nv,
  colormap,
  clipPlanes,
  canvas,
  stage,
  prefetch,
  isCancelled,
  setStatus
}: {
  layers: NiivueRenderLayer[]
  nv: NiiVueLike
  colormap: string
  clipPlanes: ClipPlane[]
  canvas: HTMLCanvasElement
  stage: HTMLDivElement | null
  prefetch: VolumePrefetch | null
  isCancelled: () => boolean
  setStatus: (status: string) => void
}): Promise<void> {
  const primaryLayer = layers[0]
  if (!primaryLayer) return
  const stackLevels = layers.map((layer) => ({
    layer,
    levels: renderVolumeLevels(layer.item)
  }))
  const atlasMaps = await resolveAtlasColorMaps(layers)
  if (isCancelled()) return

  const levels = stackLevels[0].levels
  let loadedLevel: RenderVolumeLevel | null = null
  let lastError: unknown = null

  for (const [index, level] of levels.entries()) {
    if (isCancelled()) return

    if (loadedLevel) {
      setStatus(`${layerStackLabel(layers)} refining to L${level.level} (${renderLevelShape(level)}).`)
      await waitForIdle()
      if (isCancelled()) return
    }

    const volumes = await Promise.all(stackLevels.map(async ({ layer, levels: layerLevels }, layerIndex) => {
      const layerLevel = layerLevels[Math.min(index, layerLevels.length - 1)]
      let source: string | File = layerLevel.url
      if (layerIndex === 0 && prefetch && prefetch.url === layerLevel.url) {
        try {
          source = await prefetch.file
        } catch {
          // Prefetch failed (e.g. aborted or network error); fall back to the URL
          // so NiiVue fetches it itself and surfaces any real error below.
          source = layerLevel.url
        }
      }
      return {
        url: source,
        name: `${layer.item.label} L${layerLevel.level}`,
        colormap: colormapForLayer(layer, layerIndex, colormap),
        opacity: layer.opacity,
        isColorbarVisible: layerIndex === 0
      }
    }))
    if (isCancelled()) return

    try {
      await nv.loadVolumes(volumes)
      if (isCancelled()) return
      await applyAtlasLabelMaps(nv, atlasMaps)
    } catch (error) {
      lastError = error
      if (!loadedLevel) {
        if (!isCancelled()) {
          setStatus(`${primaryLayer.item.label} L${level.level} failed; trying finer volume.`)
        }
        continue
      }

      if (!isCancelled()) {
        setStatus(`${primaryLayer.item.label} stayed at L${loadedLevel.level}; L${level.level} refinement failed.`)
      }
      return
    }
    if (isCancelled()) return

    loadedLevel = level
    applyClipPlanes(nv, clipPlanes)
    resizeNiiVue(nv, canvas, stage)

    if (index === 0 && levels.length > 1) {
      setStatus(`${layerStackLabel(layers)} visible at L${level.level} (${renderLevelShape(level)}).`)
    } else if (index === levels.length - 1) {
      setStatus(`${layerStackLabel(layers)} ready at L${level.level} (${renderLevelShape(level)}).`)
    }
  }

  if (!loadedLevel && lastError) {
    throw lastError
  }
}

async function fetchVolumeFile(url: string, signal: AbortSignal): Promise<File> {
  const init: RequestInit & { priority?: 'high' | 'low' | 'auto' } = {
    signal,
    cache: 'force-cache',
    priority: 'high'
  }
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`Volume request failed with HTTP ${response.status}.`)
  }
  const buffer = await response.arrayBuffer()
  // Preserve the URL's basename so NiiVue's extension-based format detection
  // (getFileExt reads File.name) behaves exactly as it would for the URL.
  return new File([buffer], volumeFileName(url))
}

function volumeFileName(url: string): string {
  try {
    const path = new URL(url, window.location.href).pathname
    const base = path.slice(path.lastIndexOf('/') + 1)
    return base || 'volume.nii.gz'
  } catch {
    return 'volume.nii.gz'
  }
}

async function resolveAtlasColorMaps(layers: NiivueRenderLayer[]): Promise<Array<ColorMap | null>> {
  return Promise.all(
    layers.map((layer) => {
      if (!layer.isAtlas) return Promise.resolve(null)
      return atlasColorMapForItem(layer.item).catch(() => null)
    })
  )
}

function atlasColorMapForItem(item: DesktopItem): Promise<ColorMap | null> {
  const cacheKey = `${item.id}:${item.metadata}`
  const cached = atlasColorMapCache.get(cacheKey)
  if (cached) return cached

  const pending = fetchVolumeMetadata(item).then(extractAtlasColorMap)
  atlasColorMapCache.set(cacheKey, pending)
  return pending
}

function extractAtlasColorMap(metadata: VolumeMetadata): ColorMap | null {
  const direct = normalizeLabelColorMap(metadata as unknown as JsonValue)
  if (direct) return direct

  for (const sidecar of metadata.sidecars ?? []) {
    const colorMap = normalizeLabelColorMap(sidecar.metadata)
    if (colorMap) return colorMap
  }

  return null
}

async function applyAtlasLabelMaps(
  nv: NiiVueLike,
  atlasMaps: Array<ColorMap | null>
): Promise<void> {
  if (!nv.setColormapLabel) return
  await Promise.all(atlasMaps.map((colorMap, volumeIndex) => {
    if (!colorMap) return Promise.resolve()
    return (nv.setColormapLabel?.(volumeIndex, colorMap) ?? Promise.resolve()).catch(() => undefined)
  }))
}

function normalizeLabelColorMap(value: JsonValue): ColorMap | null {
  if (!isJsonObject(value)) return null
  const R = numericJsonArray(value.R)
  const G = numericJsonArray(value.G)
  const B = numericJsonArray(value.B)
  if (!R || !G || !B || R.length === 0 || G.length !== R.length || B.length !== R.length) {
    return null
  }

  const A = numericJsonArray(value.A)
  if (A && A.length !== R.length) return null
  const I = numericJsonArray(value.I)
  if (I && I.length !== R.length) return null

  const labels = stringJsonArray(value.labels)
  const colorMap: Partial<ColorMap> & Pick<ColorMap, 'R' | 'G' | 'B'> = { R, G, B }
  if (A) colorMap.A = A
  if (I) colorMap.I = I
  if (labels) colorMap.labels = labels
  return colorMap as ColorMap
}

function numericJsonArray(value: JsonValue | undefined): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers = value.map((entry) => typeof entry === 'number' ? entry : Number(entry))
  return numbers.every(Number.isFinite) ? numbers : null
}

function stringJsonArray(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  return value.map((entry) => typeof entry === 'string' ? entry : String(entry))
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function colormapForLayer(layer: NiivueRenderLayer, layerIndex: number, baseColormap: string): string {
  if (layer.isAtlas) return 'actc'
  if (layer.kind === 'base') return baseColormap
  return OVERLAY_COLORMAPS[(layerIndex - 1) % OVERLAY_COLORMAPS.length]
}

function layerLoadSignature(layer: NiivueRenderLayer): string {
  const levels = layer.item.levels.map((level) => `${level.level}:${level.raw ?? ''}`).join(',')
  return `${layer.kind}:${layer.isAtlas ? 'atlas' : 'volume'}:${layer.item.id}:${layer.item.metadata}:${levels}`
}

function layerStackLabel(layers: NiivueRenderLayer[]): string {
  const primary = layers[0]?.item.label ?? 'volume'
  const extras = Math.max(layers.length - 1, 0)
  return extras > 0 ? `${primary} + ${extras} layer${extras === 1 ? '' : 's'}` : primary
}

function renderVolumeLevels(item: DesktopItem): RenderVolumeLevel[] {
  const levels = item.levels
    .filter((level) => level.raw)
    .map((level) => ({
      level: level.level,
      url: level.raw as string,
      shape: level.shape
    }))
    .sort((left, right) => right.level - left.level)

  if (levels.length > 0) return levels

  return [
    {
      level: 0,
      url: rawVolumeUrl(item),
      shape: item.shape
    }
  ]
}

function renderLevelShape(level: RenderVolumeLevel): string {
  return level.shape?.join(' x ') ?? 'volume'
}

function waitForIdle(): Promise<void> {
  return new Promise((resolve) => {
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(() => resolve(), { timeout: 600 })
      return
    }

    setTimeout(resolve, 80)
  })
}

function applyClipPlanes(nv: NiiVueLike, clipPlanes: ClipPlane[]): void {
  const planes = clipPlanes
    .filter((plane) => plane.enabled)
    .map((plane) => [plane.depth, plane.azimuth, plane.elevation])

  if (nv.setClipPlanes) {
    nv.setClipPlanes(planes)
    return
  }

  if (nv.setClipPlane) {
    nv.setClipPlane(planes[0] ?? [2, 0, 0])
  }
}

function applyActiveClipPlane(
  nv: NiiVueLike,
  clipPlanes: ClipPlane[],
  activeClipPlaneId: string
): number {
  const activeIndex = clipPlanes
    .filter((plane) => plane.enabled)
    .findIndex((plane) => plane.id === activeClipPlaneId)

  if (activeIndex >= 0) {
    nv.activeClipPlaneIndex = activeIndex
  }

  return activeIndex
}

function zoomRenderWithWheel(nv: NiiVueLike, deltaY: number): void {
  const scene = nv.model?.scene
  if (!scene) return

  const current = typeof scene.scaleMultiplier === 'number'
    ? scene.scaleMultiplier
    : 1
  scene.scaleMultiplier = clamp(current + deltaY * 0.001, 0.5, 2)
  nv.drawScene()
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function resizeNiiVue(
  nv: NiiVueLike,
  canvas: HTMLCanvasElement | null,
  stage: HTMLDivElement | null
): void {
  if (canvas) syncCanvasSize(canvas, stage)
  nv.resize?.()
  nv.drawScene()
}

function activeCanvasFor(nv: NiiVueLike, fallback: HTMLCanvasElement): HTMLCanvasElement {
  return nv.canvas instanceof HTMLCanvasElement ? nv.canvas : fallback
}

function syncCanvasSize(canvas: HTMLCanvasElement, stage: HTMLDivElement | null): void {
  const source = stage ?? canvas
  const density = Math.max(window.devicePixelRatio || 1, 1)
  const width = Math.max(1, Math.round(source.clientWidth * density))
  const height = Math.max(1, Math.round(source.clientHeight * density))

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}
