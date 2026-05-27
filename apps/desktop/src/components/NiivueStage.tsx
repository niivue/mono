import { useEffect, useRef, useState } from 'react'
import type { Backend, ClipPlane, DesktopItem } from '../domain/desktop'
import { rawVolumeUrl } from '../domain/desktop'

interface NiivueStageProps {
  item: DesktopItem | null
  backend: Backend
  colormap: string
  clipPlanes: ClipPlane[]
  isActive: boolean
}

interface NiiVueLike {
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  loadVolumes(volumes: Array<{ url: string; name: string; colormap?: string }>): Promise<unknown>
  azimuth?: number
  elevation?: number
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

const NIVUE_SLICE_TYPE_RENDER = 4
const NIVUE_SHOW_RENDER_ALWAYS = 1
const CORONAL_SNAP: RenderViewSnap = {
  id: 'coronal',
  label: 'Coronal',
  shortLabel: 'Cor',
  azimuth: 180,
  elevation: 0,
  shortcut: 'Numpad 1'
}
const SAGITTAL_SNAP: RenderViewSnap = {
  id: 'sagittal',
  label: 'Sagittal',
  shortLabel: 'Sag',
  azimuth: -90,
  elevation: 0,
  shortcut: 'Numpad 3'
}
const AXIAL_SNAP: RenderViewSnap = {
  id: 'axial',
  label: 'Axial',
  shortLabel: 'Ax',
  azimuth: 0,
  elevation: 90,
  shortcut: 'Numpad 7'
}
const RENDER_VIEW_SNAPS = [CORONAL_SNAP, SAGITTAL_SNAP, AXIAL_SNAP]
const BLENDER_RENDER_VIEW_SNAPS: Record<string, { normal: RenderViewSnap; reverse: RenderViewSnap }> = {
  Numpad1: {
    normal: CORONAL_SNAP,
    reverse: {
      ...CORONAL_SNAP,
      label: 'Posterior coronal',
      azimuth: 0,
      shortcut: 'Ctrl+Numpad 1'
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
  backend,
  colormap,
  clipPlanes,
  isActive
}: NiivueStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<NiiVueLike | null>(null)
  const [status, setStatus] = useState('Waiting for a dataset selection.')
  const [snapId, setSnapId] = useState<RenderSnapId | null>(null)

  useEffect(() => {
    let cancelled = false
    let localNv: NiiVueLike | null = null

    async function attach(): Promise<void> {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!canvas || !item) {
        setSnapId(null)
        setStatus('Waiting for a dataset selection.')
        return
      }

      setSnapId(null)
      syncCanvasSize(canvas, stage)
      setStatus(`Loading ${item.label} with ${backend.toUpperCase()}.`)
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
        resizeNiiVue(nv, canvas, stage)
        await loadRenderVolumeLods({
          item,
          nv,
          colormap,
          clipPlanes,
          canvas,
          stage,
          isCancelled: () => cancelled,
          setStatus
        })
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
        localNv.destroy?.()
        nvRef.current = null
      }
    }
  }, [backend, colormap, item])

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
    applyClipPlanes(nv, clipPlanes)
    resizeNiiVue(nv, canvasRef.current, stageRef.current)
  }, [clipPlanes])

  useEffect(() => {
    if (!isActive || !item) return

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
  }, [isActive, item])

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

  return (
    <div className="nv-render-stage" ref={stageRef}>
      <canvas ref={canvasRef} onPointerDown={clearSnapSelection} onWheel={clearSnapSelection} />
      <div className="nv-render-snap-controls" aria-label="Snap render view">
        {RENDER_VIEW_SNAPS.map((snap) => (
          <button
            aria-label={`Snap to ${snap.label} view`}
            aria-pressed={snapId === snap.id}
            className={snapId === snap.id ? 'is-active' : ''}
            disabled={!item}
            key={snap.id}
            onClick={() => snapRenderView(snap)}
            title={`Snap to ${snap.label} (${snap.shortcut})`}
            type="button"
          >
            {snap.shortLabel}
          </button>
        ))}
      </div>
      <div className="nv-render-status">{status}</div>
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
  item,
  nv,
  colormap,
  clipPlanes,
  canvas,
  stage,
  isCancelled,
  setStatus
}: {
  item: DesktopItem
  nv: NiiVueLike
  colormap: string
  clipPlanes: ClipPlane[]
  canvas: HTMLCanvasElement
  stage: HTMLDivElement | null
  isCancelled: () => boolean
  setStatus: (status: string) => void
}): Promise<void> {
  const levels = renderVolumeLevels(item)

  for (const [index, level] of levels.entries()) {
    if (isCancelled()) return

    if (index > 0) {
      setStatus(`${item.label} refining to L${level.level} (${renderLevelShape(level)}).`)
      await waitForIdle()
      if (isCancelled()) return
    }

    try {
      await nv.loadVolumes([
        {
          url: level.url,
          name: `${item.label} L${level.level}`,
          colormap
        }
      ])
    } catch (error) {
      if (index === 0) throw error
      if (!isCancelled()) {
        const lastLevel = levels[index - 1]
        setStatus(`${item.label} stayed at L${lastLevel.level}; L${level.level} refinement failed.`)
      }
      return
    }
    if (isCancelled()) return

    applyClipPlanes(nv, clipPlanes)
    resizeNiiVue(nv, canvas, stage)

    if (index === 0 && levels.length > 1) {
      setStatus(`${item.label} visible at L${level.level} (${renderLevelShape(level)}).`)
    } else if (index === levels.length - 1) {
      setStatus(`${item.label} ready at L${level.level} (${renderLevelShape(level)}).`)
    }
  }
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

function resizeNiiVue(
  nv: NiiVueLike,
  canvas: HTMLCanvasElement | null,
  stage: HTMLDivElement | null
): void {
  if (canvas) syncCanvasSize(canvas, stage)
  nv.resize?.()
  nv.drawScene()
}

function syncCanvasSize(canvas: HTMLCanvasElement, stage: HTMLDivElement | null): void {
  const source = stage ?? canvas
  const density = Math.max(window.devicePixelRatio || 1, 1)
  const width = Math.max(1, Math.round(source.clientWidth * density))
  const height = Math.max(1, Math.round(source.clientHeight * density))

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}
