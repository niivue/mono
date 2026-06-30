import NVViewGL from '@/gl/NVViewGL'
import { log } from '@/logger'
import type NiiVueGPU from '@/NVControlBase'
import type { BackendType, CanvasViewport, NVBounds } from '@/NVTypes'
import NVViewGPU from '@/wgpu/NVViewGPU'
import {
  initInteraction,
  removeInteractionListeners,
  setupDragAndDrop,
  setupResizeHandler,
} from './interactions'

/** Registry of controllers sharing each canvas, for coordinating canvas replacement */
const canvasInstances = new WeakMap<HTMLCanvasElement, Set<NiiVueGPU>>()
/** Tracks which backend a freshly-created canvas was made for, to prevent double-replacement
 *  within a batch while still allowing replacement on a future different-backend switch */
const freshCanvasBackend = new WeakMap<HTMLCanvasElement, BackendType>()

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
): Set<NiiVueGPU> | null {
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

export async function attachTo(
  ctrl: NiiVueGPU,
  id: string,
  isAntiAlias: boolean | null = null,
): Promise<NiiVueGPU> {
  await attachToCanvas(
    ctrl,
    document.getElementById(id) as HTMLCanvasElement,
    isAntiAlias,
  )
  log.debug('attached to element with id: ', id)
  return ctrl
}

export async function attachToCanvas(
  ctrl: NiiVueGPU,
  canvas: HTMLCanvasElement,
  isAntiAlias: boolean | null = null,
): Promise<NiiVueGPU> {
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
    throw new Error('NiiVue requires a valid HTMLCanvasElement')
  }
  if (typeof isAntiAlias === 'boolean') {
    ctrl.opts.isAntiAlias = isAntiAlias
  }
  ctrl.canvas = canvas
  // Register in canvas instance registry for shared canvas coordination
  let instances = canvasInstances.get(canvas)
  if (!instances) {
    instances = new Set()
    canvasInstances.set(canvas, instances)
  }
  instances.add(ctrl)
  if (ctrl.opts.backend === 'webgl2') {
    ctrl.view = new NVViewGL(canvas, ctrl.model, ctrl.opts)
  } else {
    ctrl.view = new NVViewGPU(canvas, ctrl.model, ctrl.opts)
  }
  try {
    await ctrl.view.init() // Single async entry point
    // Load thumbnail before first render so it appears on the initial frame
    if (ctrl.opts.thumbnail) {
      ctrl.model.ui.isThumbnailVisible = true
      ctrl.model.ui.thumbnailUrl = ctrl.opts.thumbnail as string
      await ctrl.view.loadThumbnail(ctrl.model.ui.thumbnailUrl)
    }
    if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
    if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
    setupResizeHandler(ctrl)
    ctrl.view.resize()
    ctrl.emit('viewAttached', {
      canvas,
      backend: (ctrl.opts.backend ?? 'webgpu') as 'webgpu' | 'webgl2',
    })
    return ctrl
  } catch (error) {
    log.error('Failed to initialize view:', error)
    throw error
  }
}

/** Add a controller to the canvas instance registry. Used by single-backend
 *  lifecycle modules (`viewWebGL2`, `viewWebGPU`) so that `setViewport` fan-out
 *  via `getCanvasInstances` reaches every sibling sharing the canvas. */
export function registerCanvasInstance(
  ctrl: NiiVueGPU,
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
export function unregister(ctrl: NiiVueGPU): void {
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

/** Check if this controller is in sub-canvas bounds mode (sharing a canvas) */
function isSharedCanvas(ctrl: NiiVueGPU): boolean {
  const bounds = ctrl.opts.bounds
  return (
    !!bounds &&
    !(
      bounds[0][0] === 0 &&
      bounds[0][1] === 0 &&
      bounds[1][0] === 1 &&
      bounds[1][1] === 1
    )
  )
}

/** Replace the canvas DOM element and update all registered siblings' references */
function replaceCanvasElement(ctrl: NiiVueGPU): void {
  const oldCanvas = ctrl.canvas as HTMLCanvasElement
  // If canvas was freshly created by a sibling for the same backend, skip (no context conflict)
  if (freshCanvasBackend.get(oldCanvas) === ctrl.opts.backend) return
  const parent = oldCanvas.parentNode
  if (!parent) return
  const newCanvas = document.createElement('canvas')
  newCanvas.id = oldCanvas.id
  newCanvas.className = oldCanvas.className
  newCanvas.style.cssText = oldCanvas.style.cssText
  parent.replaceChild(newCanvas, oldCanvas)
  freshCanvasBackend.set(newCanvas, ctrl.opts.backend ?? 'webgpu')
  // Update this controller
  ctrl.canvas = newCanvas
  // Update all siblings sharing the old canvas
  const siblings = canvasInstances.get(oldCanvas)
  if (siblings) {
    for (const sib of siblings) {
      if (sib !== ctrl) {
        sib.canvas = newCanvas
      }
    }
    // Move registry to new canvas
    canvasInstances.delete(oldCanvas)
    canvasInstances.set(newCanvas, siblings)
  }
  // Carry the canvas viewport to the new canvas so backend swaps preserve pan/zoom
  const oldViewport = canvasViewports.get(oldCanvas)
  if (oldViewport) {
    canvasViewports.delete(oldCanvas)
    canvasViewports.set(newCanvas, oldViewport)
  }
}

export async function recreateView(
  ctrl: NiiVueGPU,
  backendChanged = false,
): Promise<void> {
  // 1. Destroy current view
  ctrl.emit('viewDestroyed')
  ctrl.view?.destroy()
  // 2. Clear GPU resources from model (keeps mesh/volume data)
  ctrl.model.clearAllGPUResources()
  // 3. Remove event listeners from old canvas
  removeInteractionListeners(ctrl)
  // 4. Disconnect resize observer
  if (ctrl.resizeObserver) {
    ctrl.resizeObserver.disconnect()
  }
  // 5. Replace the canvas element (required because canvas context is locked)
  //    For shared canvases: only replace if backend changed (context type is locked to canvas)
  //    When replacing a shared canvas, all siblings' references are updated too.
  if (!isSharedCanvas(ctrl) || backendChanged) {
    replaceCanvasElement(ctrl)
  }
  // 6. Create new view with current settings
  if (ctrl.opts.backend === 'webgl2') {
    ctrl.view = new NVViewGL(
      ctrl.canvas as HTMLCanvasElement,
      ctrl.model,
      ctrl.opts,
    )
  } else {
    ctrl.view = new NVViewGPU(
      ctrl.canvas as HTMLCanvasElement,
      ctrl.model,
      ctrl.opts,
    )
  }
  // 7. Initialize the new view
  await ctrl.view.init()
  // 7b. Reload thumbnail if it was active before recreation
  if (ctrl.opts.thumbnail && ctrl.model.ui.isThumbnailVisible) {
    await ctrl.view.loadThumbnail(ctrl.opts.thumbnail as string)
  }
  // 8. Reinstall event handlers on new canvas
  if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
  if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
  setupResizeHandler(ctrl)
  // 9. Rebuild GPU resources
  await ctrl.view.updateBindGroups()
  // 10. Restore drawing texture if a drawing bitmap exists in the model
  if (ctrl.model.drawingVolume) {
    ctrl.refreshDrawing()
  }
  // 10b. Re-push the slide plane (and its annotation) to the new view
  ctrl.restoreSlidePlaneView()
  // 11. Resize and render
  ctrl.view.resize()
  ctrl.drawScene()
  // 12. Notify listeners of the new view
  ctrl.emit('viewAttached', {
    canvas: ctrl.canvas as HTMLCanvasElement,
    backend: (ctrl.opts.backend ?? 'webgpu') as 'webgpu' | 'webgl2',
  })
}

export async function reinitializeView(
  ctrl: NiiVueGPU,
  options: {
    backend?: BackendType
    isAntiAlias?: boolean
    forceDevicePixelRatio?: number
    forceRestart?: boolean
  } = {},
): Promise<boolean> {
  // Default each param to current value
  const newAntiAlias = options.isAntiAlias ?? ctrl.opts.isAntiAlias
  const newBackend = options.backend ?? ctrl.opts.backend
  const newPixelRatio =
    options.forceDevicePixelRatio ?? ctrl.opts.forceDevicePixelRatio ?? -1
  const forceRestart = options.forceRestart ?? true

  // Validate backend
  if (newBackend !== 'webgpu' && newBackend !== 'webgl2') {
    log.warn(`Invalid backend: ${newBackend}. Expected 'webgpu' or 'webgl2'.`)
    return false
  }

  // Check WebGPU availability if switching to it
  if (
    newBackend === 'webgpu' &&
    newBackend !== ctrl.opts.backend &&
    !navigator.gpu
  ) {
    log.warn('WebGPU is not supported in this browser.')
    return false
  }

  const backendChanged = newBackend !== ctrl.opts.backend
  const antiAliasChanged = Boolean(newAntiAlias) !== ctrl.isAntiAlias
  const pixelRatioChanged = newPixelRatio !== ctrl.opts.forceDevicePixelRatio

  // No-op if nothing changed
  if (
    !forceRestart &&
    !backendChanged &&
    !antiAliasChanged &&
    !pixelRatioChanged
  ) {
    return true
  }

  // Update options
  ctrl.opts.backend = newBackend
  ctrl.opts.isAntiAlias = Boolean(newAntiAlias)
  ctrl.opts.forceDevicePixelRatio = newPixelRatio

  try {
    if (forceRestart || backendChanged || antiAliasChanged) {
      // Canvas recreation needed
      await recreateView(ctrl, backendChanged)
    } else {
      // Only pixelRatio changed — resize without recreating
      if (ctrl.view) ctrl.view.forceDevicePixelRatio = newPixelRatio
      ctrl.view?.resize()
    }
    return true
  } catch (err) {
    log.error('Failed to reinitialize view:', err)
    return false
  }
}
