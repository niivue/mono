import type { UIKitOverlayRenderer } from '@niivue/niivue'
import type { UIKitHost } from '@niivue/uikit'
import { UIKitMagnifierOverlay } from '@niivue/uikit'

// Cornerstone defaults: Magnify 250 px box at magnifySize 10; AdvancedMagnify
// radius 125 at zoomFactor 3 (placed glass there; here it follows the pointer).
const LENS: Record<string, { radiusCss: number; zoom: number }> = {
  Magnify: { radiusCss: 125, zoom: 10 },
  AdvancedMagnify: { radiusCss: 125, zoom: 3 },
}

type Host = UIKitHost & {
  registerOverlayRenderer(r: UIKitOverlayRenderer): () => void
}

/** Shows a pointer-following lens while OHIF's active tool is a magnifier. */
export function createMagnifyBinding(nv: Host) {
  let detach: (() => void) | null = null
  const off = () => {
    detach?.()
    detach = null
  }
  return {
    setTool(tool: string | undefined): void {
      off()
      const opts = LENS[tool ?? '']
      if (!opts) return
      // Registered last, so it magnifies the annotation overlay too.
      const lens = new UIKitMagnifierOverlay(opts)
      const unregister = nv.registerOverlayRenderer(lens)
      const unattach = lens.attach(nv)
      detach = () => {
        unattach()
        unregister()
        nv.drawScene()
      }
    },
    dispose: off,
  }
}
