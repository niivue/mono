import NVViewGL from '@/gl/NVViewGL'
import { log } from '@/logger'
import type NiiVue from '@/NVControlBase'
import type { BackendType } from '@/NVTypes'
import NVViewGPU from '@/wgpu/NVViewGPU'
import {
  clearCanvasMessage,
  GRAPHICS_UNAVAILABLE_MESSAGE,
  showCanvasMessage,
} from './canvasMessage'
import {
  getCanvasInstances,
  isSharedCanvas,
  moveCanvasRegistration,
  registerCanvasInstance,
  replaceCanvas,
  unregister,
} from './canvasRegistry'
import {
  initInteraction,
  removeInteractionListeners,
  setupDragAndDrop,
  setupResizeHandler,
} from './interactions'

// Part of the ViewLifecycle this module is (NVControl imports it whole).
export { unregister }

export async function attachTo(
  ctrl: NiiVue,
  id: string,
  isAntiAlias: boolean | null = null,
): Promise<NiiVue> {
  await attachToCanvas(
    ctrl,
    document.getElementById(id) as HTMLCanvasElement,
    isAntiAlias,
  )
  log.debug('attached to element with id: ', id)
  return ctrl
}

export async function attachToCanvas(
  ctrl: NiiVue,
  canvas: HTMLCanvasElement,
  isAntiAlias: boolean | null = null,
): Promise<NiiVue> {
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
  // Whether the failed attempt locked the canvas to its context type.
  let contextLocked = false
  // ctrl.view is the readiness signal every GPU-touching path tests
  // (`if (!this.view) return`), so it is published only once init() resolves.
  // Exposing it earlier lets a concurrent load reach half-built buffers (#61).
  let view: NVViewGL | NVViewGPU | null = null
  ctrl.view = null
  for (let i = 0; i < order.length; i++) {
    const backend = order[i]
    ctrl.opts.backend = backend
    if (i > 0) {
      // The fallback must swap in a fresh canvas (the failed attempt may have locked
      // the context type). Replacing a SHARED canvas would desync sibling controllers
      // (their view + listeners stay on the old canvas), so decline the fallback in
      // that case and let the overlay surface instead.
      if ((getCanvasInstances(canvas)?.size ?? 0) > 1) {
        log.warn('Cannot fall back to webgl2 on a shared canvas; aborting')
        break
      }
      replaceCanvasElement(ctrl, contextLocked)
      canvas = ctrl.canvas as HTMLCanvasElement
      registerCanvasInstance(ctrl, canvas)
      log.warn(
        `${order[i - 1]} backend unavailable; falling back to ${backend}`,
      )
    }
    const candidate =
      backend === 'webgl2'
        ? new NVViewGL(canvas, ctrl.model, ctrl.opts)
        : new NVViewGPU(canvas, ctrl.model, ctrl.opts)
    try {
      await candidate.init() // Single async entry point
      view = candidate
      break
    } catch (error) {
      lastError = error
      log.error(`Failed to initialize ${backend} view:`, error)
      // A WebGPU view that got its context before failing leaves the canvas
      // unable to give WebGL2 one; destroy() clears the field, so read it first.
      contextLocked = candidate instanceof NVViewGPU && !!candidate.context
      try {
        candidate.destroy()
      } catch {
        // a view that failed mid-init may not destroy cleanly; ignore
      }
    }
  }
  ctrl.view = view
  // Hooks go on before the resize() below draws the first frame: a preloaded
  // chunked volume starts streaming on it (see NiiVue._wireViewHooks).
  ctrl._wireViewHooks()

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
    backend: (ctrl.opts.backend ?? 'webgl2') as 'webgpu' | 'webgl2',
  })
  return ctrl
}

/**
 * Replace the canvas DOM element and update all registered siblings'
 * references. `cloneDetached` is for a backend switch: the old context type is
 * locked to the canvas, so even a detached one must be swapped (the clone is
 * published as `ctrl.canvas` and through `viewAttached`).
 */
function replaceCanvasElement(ctrl: NiiVue, cloneDetached = false): void {
  const canvas = ctrl.canvas as HTMLCanvasElement
  // A detached canvas stays put: the caller holds it and nothing can swap it in.
  if (!canvas.parentNode && !cloneDetached) return
  replaceCanvas(ctrl)
}

/**
 * Undo a failed backend switch on a shared canvas: the siblings' views still
 * live on the old canvas, so put it back and reinstall their handlers.
 */
function restoreSharedCanvas(
  ctrl: NiiVue,
  oldCanvas: HTMLCanvasElement,
  siblings: NiiVue[],
): void {
  const current = ctrl.canvas as HTMLCanvasElement
  if (current !== oldCanvas) {
    current.parentNode?.replaceChild(oldCanvas, current)
    for (const c of getCanvasInstances(current) ?? []) c.canvas = oldCanvas
    moveCanvasRegistration(current, oldCanvas)
  }
  for (const sib of siblings) {
    if (sib.opts.isInteractionEnabled === false) continue
    initInteraction(sib)
    setupDragAndDrop(sib)
  }
}

export async function recreateView(
  ctrl: NiiVue,
  backendChanged = false,
): Promise<void> {
  // 1. Destroy current view
  ctrl.emit('viewDestroyed')
  ctrl.view?.destroy()
  ctrl.view = null
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
  // Siblings' views are bound to the old canvas, so a backend switch moves them too.
  const siblings = backendChanged
    ? [...(getCanvasInstances(ctrl.canvas) ?? [])].filter((c) => c !== ctrl)
    : []
  // Their handlers must come off the old canvas before it is swapped out.
  for (const sib of siblings) removeInteractionListeners(sib)
  const oldCanvas = ctrl.canvas as HTMLCanvasElement
  if (!isSharedCanvas(ctrl) || backendChanged) {
    replaceCanvasElement(ctrl, backendChanged)
  }
  // 6. Create new view with current settings
  let view: NVViewGL | NVViewGPU
  try {
    view =
      ctrl.opts.backend === 'webgl2'
        ? new NVViewGL(ctrl.canvas as HTMLCanvasElement, ctrl.model, ctrl.opts)
        : new NVViewGPU(ctrl.canvas as HTMLCanvasElement, ctrl.model, ctrl.opts)
    // 7. Initialize the new view, publishing it only once init() resolves
    await view.init()
  } catch (error) {
    if (siblings.length > 0) restoreSharedCanvas(ctrl, oldCanvas, siblings)
    throw error
  }
  ctrl.view = view
  // Hooks go on before the resize() below draws the first frame: a preloaded
  // chunked volume starts streaming on it (see NiiVue._wireViewHooks).
  ctrl._wireViewHooks()
  // 7b. Reload thumbnail if it was active before recreation
  if (ctrl.opts.thumbnail && ctrl.model.ui.isThumbnailVisible) {
    await ctrl.view.loadThumbnail(ctrl.opts.thumbnail as string)
  }
  // 8. Reinstall event handlers on new canvas
  if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
  if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
  setupResizeHandler(ctrl)
  // 9. Rebuild GPU resources
  await ctrl._rebuildViewResources()
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
    backend: (ctrl.opts.backend ?? 'webgl2') as 'webgpu' | 'webgl2',
  })
  // 13. Rebuild siblings on the new canvas with the new backend. The canvas is
  // already locked to it, so one failure must not strand the siblings after it;
  // a failed sibling keeps the new backend and can be retried on its own.
  let siblingError: unknown
  for (const sib of siblings) {
    sib.opts.backend = ctrl.opts.backend
    if (!sib.view) continue
    try {
      await recreateView(sib)
    } catch (error) {
      log.error('Failed to rebuild a sibling view on the shared canvas:', error)
      siblingError ??= error
    }
  }
  if (siblingError) throw siblingError
}

export async function reinitializeView(
  ctrl: NiiVue,
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
    }
    // The setter also updates controllers sharing this canvas.
    if (pixelRatioChanged) ctrl.devicePixelRatio = newPixelRatio
    return true
  } catch (err) {
    log.error('Failed to reinitialize view:', err)
    return false
  }
}
