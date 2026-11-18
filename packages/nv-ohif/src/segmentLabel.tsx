import { lookupColorMap } from '@niivue/niivue'
import { useEffect, useState } from 'react'
import { getNiivueEntry } from './niivueRegistry'
import type { OhifExtensionManager } from './ohif-types'
import { drawingValueAt, toolMode } from './segEdit'

// OHIF's SegmentLabelTool (toggleSegmentLabel): while it is Active in the
// pane's tool group, hovering a segment shows its label by the pointer.

/** The label of drawing value `value` in colormap `name` (panelColormap's labels). */
export function segmentLabel(name: string, value: number): string | undefined {
  const cmap = lookupColorMap(name) as {
    I?: number[]
    labels?: string[]
  } | null
  const i = cmap?.I ? cmap.I.indexOf(value) : value
  return value > 0 && i >= 0 ? cmap?.labels?.[i] || undefined : undefined
}

export function SegmentLabel({
  viewportId,
  isLoaded,
  extensionManager,
}: {
  viewportId: string
  isLoaded: boolean
  extensionManager: OhifExtensionManager | undefined
}) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string }>()
  useEffect(() => {
    const nv = isLoaded ? getNiivueEntry(viewportId)?.nv : undefined
    const canvas = nv?.canvas
    if (!nv || !canvas) return
    const onMove = (e: PointerEvent) => {
      const entry = getNiivueEntry(viewportId)
      const on =
        entry &&
        e.buttons === 0 &&
        toolMode(
          extensionManager,
          entry.toolGroupId ?? 'default',
          // cornerstoneTools.SegmentLabelTool.toolName
          'SegmentLabelTool',
        ) === 'Active'
      const value = on ? drawingValueAt(nv, e.clientX, e.clientY) : 0
      const text = value ? segmentLabel(nv.drawColormap, value) : undefined
      const r = canvas.getBoundingClientRect()
      setHover(
        text
          ? { x: e.clientX - r.left, y: e.clientY - r.top, text }
          : undefined,
      )
    }
    const onLeave = () => setHover(undefined)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    return () => {
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
    }
  }, [viewportId, isLoaded, extensionManager])
  if (!hover) return null
  return (
    <div
      data-segment-label={hover.text}
      style={{
        position: 'absolute',
        left: hover.x + 12,
        top: hover.y + 12,
        padding: '2px 6px',
        borderRadius: 4,
        background: 'rgba(0,0,0,0.7)',
        color: '#fff',
        font: '12px sans-serif',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {hover.text}
    </div>
  )
}
