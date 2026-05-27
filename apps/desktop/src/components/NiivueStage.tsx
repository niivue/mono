import { useEffect, useRef, useState } from 'react'
import type { Backend, ClipPlane, DesktopItem } from '../domain/desktop'
import { rawVolumeUrl } from '../domain/desktop'

interface NiivueStageProps {
  item: DesktopItem | null
  backend: Backend
  colormap: string
  clipPlanes: ClipPlane[]
}

interface NiiVueLike {
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  loadVolumes(volumes: Array<{ url: string; name: string; colormap?: string }>): Promise<unknown>
  setClipPlanes?(planes: number[][]): void
  setClipPlane?(plane: number[]): void
  drawScene(): void
  resize?: () => void
  destroy?: () => void
}

type NiiVueConstructor = new (options?: Record<string, unknown>) => NiiVueLike

const NIVUE_SLICE_TYPE_RENDER = 4
const NIVUE_SHOW_RENDER_ALWAYS = 1

export function NiivueStage({
  item,
  backend,
  colormap,
  clipPlanes
}: NiivueStageProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<NiiVueLike | null>(null)
  const [status, setStatus] = useState('Waiting for a dataset selection.')

  useEffect(() => {
    let cancelled = false
    let localNv: NiiVueLike | null = null

    async function attach(): Promise<void> {
      const canvas = canvasRef.current
      const stage = stageRef.current
      if (!canvas || !item) {
        setStatus('Waiting for a dataset selection.')
        return
      }

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
        await nv.loadVolumes([
          {
            url: rawVolumeUrl(item),
            name: item.label,
            colormap
          }
        ])
        if (cancelled) return
        applyClipPlanes(nv, clipPlanes)
        resizeNiiVue(nv, canvas, stage)
        setStatus(`${item.label} ready.`)
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

  return (
    <div className="nv-render-stage" ref={stageRef}>
      <canvas ref={canvasRef} />
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
