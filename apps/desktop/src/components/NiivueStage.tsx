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
}

type NiiVueConstructor = new (options?: Record<string, unknown>) => NiiVueLike

export function NiivueStage({
  item,
  backend,
  colormap,
  clipPlanes
}: NiivueStageProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const nvRef = useRef<NiiVueLike | null>(null)
  const [status, setStatus] = useState('Waiting for a dataset selection.')

  useEffect(() => {
    let cancelled = false

    async function attach(): Promise<void> {
      const canvas = canvasRef.current
      if (!canvas || !item) {
        setStatus('Waiting for a dataset selection.')
        return
      }

      setStatus(`Loading ${item.label} with ${backend.toUpperCase()}.`)
      try {
        const NiiVue = await loadNiiVue(backend)
        if (cancelled) return

        const nv = new NiiVue({
          backend,
          isResizeCanvas: true,
          show3Dcrosshair: true,
          loadingText: ''
        })
        nvRef.current = nv
        await nv.attachToCanvas(canvas)
        await nv.loadVolumes([
          {
            url: rawVolumeUrl(item),
            name: item.label,
            colormap
          }
        ])
        applyClipPlanes(nv, clipPlanes)
        nv.drawScene()
        setStatus(`${item.label} ready.`)
      } catch (error) {
        nvRef.current = null
        setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void attach()
    return () => {
      cancelled = true
    }
  }, [backend, colormap, item])

  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    applyClipPlanes(nv, clipPlanes)
    nv.drawScene()
  }, [clipPlanes])

  return (
    <div className="nv-render-stage">
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

