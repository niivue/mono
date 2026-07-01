import NVViewGL from '@/gl/NVViewGL'
import { log } from '@/logger'
import type NiiVueGPU from '@/NVControlBase'
import type { BackendType, CanvasViewport, NVBounds } from '@/NVTypes'
import NVViewGPU from '@/wgpu/NVViewGPU'
import {
  clearCanvasMessage,
  GRAPHICS_UNAVAILABLE_MESSAGE,
  showCanvasMessage,
} from './canvasMessage'
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
  clearCanvasMessage(canvas)
  registerCanvasInstance(ctrl, canvas)

  // Attempt the configured backend, then (when WebGPU was requested) fall back to
  // WebGL2. The 'both' distribution bundles both views, so a WebGPU init failure —
  // e.g. requestAdapter() returning null when the browser's graphics acceleration is
  // disabled — degrades to WebGL2 instead of leaving a dead, blank canvas. Only the
  // `init()` call is fallback-eligible; post-init failures (thumbnail, etc.) rethrow.
  const requestedBackend = ctrl.opts.backend
  const order: ('webgpu' | 'webgl2')[] =
    ctrl.opts.backend === 'webgl2' ? ['webgl2'] : ['webgpu', 'webgl2']
  let lastError: unknown
  for (let i = 0; i < order.length; i++) {
    const backend = order[i]
    ctrl.opts.backend = backend
    if (i > 0) {
      // The fallback must swap in a fresh canvas (the failed attempt may have locked
      // the context type). Replacing a SHARED canvas would desync sibling controllers
      // (their view + listeners stay on the old canvas), so decline the fallback in
      // that case and let the overlay surface instead.
      if ((canvasInstances.get(canvas)?.size ?? 0) > 1) {
        log.warn('Cannot fall back to webgl2 on a shared canvas; aborting')
        break
      }
      replaceCanvasElement(ctrl)
      canvas = ctrl.canvas as HTMLCanvasElement
      registerCanvasInstance(ctrl, canvas)
      log.warn(
        `${order[i - 1]} backend unavailable; falling back to ${backend}`,
      )
    }
    ctrl.view =
      backend === 'webgl2'
        ? new NVViewGL(canvas, ctrl.model, ctrl.opts)
        : new NVViewGPU(canvas, ctrl.model, ctrl.opts)
    try {
      await ctrl.view.init() // Single async entry point
      break
    } catch (error) {
      lastError = error
      log.error(`Failed to initialize ${backend} view:`, error)
      try {
        ctrl.view?.destroy()
      } catch {
        // a view that failed mid-init may not destroy cleanly; ignore
      }
      ctrl.view = null
    }
  }

  const view = ctrl.view
  if (!view) {
    // Every available backend failed. Don't leave the controller registered, and
    // restore the originally requested backend so a later retry starts fresh.
    unregister(ctrl)
    ctrl.opts.backend = requestedBackend
    // Show centered guidance, then rethrow so callers still observe the failure.
    showCanvasMessage(
      ctrl.canvas as HTMLCanvasElement,
      GRAPHICS_UNAVAILABLE_MESSAGE,
    )
    throw (
      lastError ?? new Error('NiiVue: failed to initialize a graphics backend')
    )
  }

  // Load thumbnail before first render so it appears on the initial frame
  if (ctrl.opts.thumbnail) {
    ctrl.model.ui.isThumbnailVisible = true
    ctrl.model.ui.thumbnailUrl = ctrl.opts.thumbnail as string
    await view.loadThumbnail(ctrl.model.ui.thumbnailUrl)
  }
  if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
  if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
  setupResizeHandler(ctrl)
  view.resize()
  ctrl.emit('viewAttached', {
    canvas: ctrl.canvas as HTMLCanvasElement,
    backend: (ctrl.opts.backend ?? 'webgpu') as 'webgpu' | 'webgl2',
  })
  return ctrl
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
  // cloneNode(false) copies ALL attributes (id, class, style, width/height, data-*,
  // aria-*, tabindex, ...) but NOT event listeners or the (locked) rendering context
  // — which is exactly what we need: a clean canvas with the caller's element
  // contract preserved. NOTE: external listeners on the original canvas are lost.
  const newCanvas = oldCanvas.cloneNode(false) as HTMLCanvasElement
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
