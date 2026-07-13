import type { NiiVueOptions } from '@niivue/niivue'
import NiiVueGPU, { SLICE_TYPE } from '@niivue/niivue'
import { useEffect, useRef, useState } from 'react'
import { displaySetToNiivue } from './displaySetToNiivue'
import type { OhifViewportProps } from './ohif-types'

// Default NiiVue config for the OHIF viewport. Opens multiplanar (set after attach)
// so an OHIF user sees the three orthogonal planes; the toolbar (later) can switch to
// 3D render etc.
const DEFAULT_OPTIONS: Partial<NiiVueOptions> = {
  backgroundColor: [0, 0, 0, 1],
}

/**
 * The NiiVue viewport React component OHIF hangs a display set in.
 *
 * Phase 1: renders NIfTI/volume-URL display sets by loading the URL directly. A
 * display set we can't yet load (DICOM) shows a placeholder — Phase 2 will build an
 * NVImage from OHIF's in-memory cornerstone volume instead.
 *
 * NiiVue's core is framework-agnostic, so this owns a plain <canvas> + a `NiiVueGPU`
 * instance directly (React 18) rather than depending on `@niivue/nvreact` (React 19).
 */
export function NiivueViewport(props: OhifViewportProps) {
  const { displaySets, viewportId } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const nvRef = useRef<NiiVueGPU | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  // Create / tear down the NiiVue instance with the canvas.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const canvas = document.createElement('canvas')
    canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%'
    container.appendChild(canvas)

    const nv = new NiiVueGPU(DEFAULT_OPTIONS)
    nvRef.current = nv
    nv.attachToCanvas(canvas).then(() => {
      nv.sliceType = SLICE_TYPE.MULTIPLANAR
    })

    const ro = new ResizeObserver(() => nv.resize())
    ro.observe(container)

    return () => {
      ro.disconnect()
      nv.destroy()
      canvas.width = 0
      canvas.height = 0
      canvas.remove()
      nvRef.current = null
    }
  }, [])

  // Load the display set(s) hung in this viewport whenever they change.
  useEffect(() => {
    const nv = nvRef.current
    if (!nv) return
    const specs = displaySets
      .map((ds) => displaySetToNiivue(ds))
      .filter((s): s is NonNullable<typeof s> => s !== null)

    // No loadable (Phase-1) display set -> show the placeholder. If OHIF hung a
    // display set at all, treat a total miss as "needs the DICOM bridge".
    if (specs.length === 0) {
      setUnsupported(displaySets.length > 0)
      return
    }
    setUnsupported(false)
    // First spec is the base volume; any others load as overlays.
    nv.loadVolumes(specs).catch(() => {
      setUnsupported(true)
    })
  }, [displaySets])

  return (
    <div
      data-viewport-id={viewportId}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {unsupported ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#9aa',
            font: '14px sans-serif',
            textAlign: 'center',
            padding: '1rem',
            pointerEvents: 'none',
          }}
        >
          This series isn't a NiiVue volume URL yet. DICOM support (building an
          NiiVue volume from OHIF's loaded series) is coming.
        </div>
      ) : null}
    </div>
  )
}
