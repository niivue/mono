// Backend-neutral canvas bookkeeping: which controllers share a canvas, and the
// canvas viewport they pan and zoom together. Kept apart from viewBoth.ts so the
// single-backend entries (`@niivue/niivue/webgl2`, `/webgpu`) do not import the
// other backend's renderer through it (#175).

import type NiiVue from '@/NVControlBase'
import type { CanvasViewport, NVBounds } from '@/NVTypes'

/** Registry of controllers sharing each canvas, for coordinating canvas replacement */
const canvasInstances = new WeakMap<HTMLCanvasElement, Set<NiiVue>>()

/** Identity viewport: no pan, no zoom — reproduces pre-viewport behavior */
const IDENTITY_VIEWPORT: Readonly<CanvasViewport> = Object.freeze({
  pan: [0, 0] as [number, number],
  zoom: 1,
})

/** Per-canvas virtual camera: pans/zooms all sibling instances together */
const canvasViewports = new WeakMap<HTMLCanvasElement, CanvasViewport>()

/** Read the canvas viewport, or the identity transform if none is set */
export function getCanvasViewport(
  canvas: HTMLCanvasElement | null | undefined,
): CanvasViewport {
  if (!canvas) return { pan: [0, 0], zoom: 1 }
  const v = canvasViewports.get(canvas)
  if (!v) return { pan: [0, 0], zoom: 1 }
  return { pan: [v.pan[0], v.pan[1]], zoom: v.zoom }
}

/** True when the viewport is the identity transform (fast path skip) */
export function isIdentityViewport(v: CanvasViewport): boolean {
  return v.pan[0] === 0 && v.pan[1] === 0 && v.zoom === 1
}

/** Set the canvas viewport. Returns true if value changed. */
export function setCanvasViewport(
  canvas: HTMLCanvasElement | null | undefined,
  viewport: CanvasViewport,
): boolean {
  if (!canvas) return false
  const cur = canvasViewports.get(canvas)
  const px = viewport.pan[0]
  const py = viewport.pan[1]
  const z = viewport.zoom
  if (cur && cur.pan[0] === px && cur.pan[1] === py && cur.zoom === z)
    return false
  if (isIdentityViewport({ pan: [px, py], zoom: z })) {
    canvasViewports.delete(canvas)
  } else {
    canvasViewports.set(canvas, { pan: [px, py], zoom: z })
  }
  return true
}

/** Iterate all controllers sharing a canvas (for fanning out viewport changes) */
export function getCanvasInstances(
  canvas: HTMLCanvasElement | null | undefined,
): Set<NiiVue> | null {
  if (!canvas) return null
  return canvasInstances.get(canvas) ?? null
}

/** Bounds-pixel rect after viewport transform. Mirrors the math in NVViewGPU/NVViewGL `_computeBoundsPixels`. */
export type BoundsPixelRect = {
  left: number
  top: number
  width: number
  height: number
  isOffscreen: boolean
}

/** Project normalized world bounds through the canvas viewport into pixel space. */
export function computeBoundsPixelRect(
  canvas: HTMLCanvasElement,
  bounds: NVBounds | null | undefined,
): BoundsPixelRect {
  const cw = canvas.width
  const ch = canvas.height
  const vp = getCanvasViewport(canvas)
  const worldX1 = bounds ? bounds[0][0] : 0
  const worldY1 = bounds ? bounds[0][1] : 0
  const worldX2 = bounds ? bounds[1][0] : 1
  const worldY2 = bounds ? bounds[1][1] : 1
  const z = vp.zoom
  const px = vp.pan[0]
  const py = vp.pan[1]
  const sx1 = (worldX1 - 0.5) * z + 0.5 + px
  const sx2 = (worldX2 - 0.5) * z + 0.5 + px
  const sy1 = (worldY1 - 0.5) * z + 0.5 + py
  const sy2 = (worldY2 - 0.5) * z + 0.5 + py
  const left = Math.round(sx1 * cw)
  const right = Math.round(sx2 * cw)
  const top = Math.round((1 - sy2) * ch)
  const bottom = Math.round((1 - sy1) * ch)
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
    isOffscreen: right <= 0 || left >= cw || bottom <= 0 || top >= ch,
  }
}

export { IDENTITY_VIEWPORT }

/** Add a controller to the canvas instance registry. Used by single-backend
 *  lifecycle modules (`viewWebGL2`, `viewWebGPU`) so that `setViewport` fan-out
 *  via `getCanvasInstances` reaches every sibling sharing the canvas. */
export function registerCanvasInstance(
  ctrl: NiiVue,
  canvas: HTMLCanvasElement,
): void {
  let instances = canvasInstances.get(canvas)
  if (!instances) {
    instances = new Set()
    canvasInstances.set(canvas, instances)
  }
  instances.add(ctrl)
}

/** Remove a controller from the canvas instance registry (called on destroy) */
export function unregister(ctrl: NiiVue): void {
  if (!ctrl.canvas) return
  const instances = canvasInstances.get(ctrl.canvas)
  if (instances) {
    instances.delete(ctrl)
    if (instances.size === 0) {
      canvasInstances.delete(ctrl.canvas)
      canvasViewports.delete(ctrl.canvas)
    }
  }
}

/** Move a canvas's registered controllers and viewport to its replacement. */
export function moveCanvasRegistration(
  oldCanvas: HTMLCanvasElement,
  newCanvas: HTMLCanvasElement,
): void {
  const siblings = canvasInstances.get(oldCanvas)
  if (siblings) {
    canvasInstances.delete(oldCanvas)
    canvasInstances.set(newCanvas, siblings)
  }
  const viewport = canvasViewports.get(oldCanvas)
  if (viewport) {
    canvasViewports.delete(oldCanvas)
    canvasViewports.set(newCanvas, viewport)
  }
}

/** True when another controller is registered on this controller's canvas.
 *  Bounds alone are not enough: a lone bounded controller owns its canvas, and
 *  a full-frame one can share with a bounded sibling. */
export function isSharedCanvas(ctrl: NiiVue): boolean {
  const instances = getCanvasInstances(ctrl.canvas)
  return !!instances && [...instances].some((c) => c !== ctrl)
}

/** Swap the controller's canvas for a context-free clone, repointing its
 *  siblings, registry and viewport. Callers decide whether a detached canvas
 *  is swapped: only a backend or antialias change needs it, since both are
 *  locked into the canvas's context. */
export function replaceCanvas(ctrl: NiiVue): HTMLCanvasElement {
  const oldCanvas = ctrl.canvas as HTMLCanvasElement
  // cloneNode(false) copies all attributes (id, class, style, width/height,
  // data-*, aria-*, tabindex) but not the locked rendering context. External
  // listeners on the original canvas are lost.
  const newCanvas = oldCanvas.cloneNode(false) as HTMLCanvasElement
  oldCanvas.parentNode?.replaceChild(newCanvas, oldCanvas)
  for (const sib of getCanvasInstances(oldCanvas) ?? []) sib.canvas = newCanvas
  ctrl.canvas = newCanvas
  moveCanvasRegistration(oldCanvas, newCanvas)
  return newCanvas
}
