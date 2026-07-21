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
  initInteraction,
  removeInteractionListeners,
  setupDragAndDrop,
  setupResizeHandler,
} from './interactions'
import { registerCanvasInstance } from './viewBoth'

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
  if (ctrl.opts.backend === 'webgl2') {
    throw new Error(
      "This niivue distribution includes only WebGPU. Requested backend 'webgl2' is unavailable.",
    )
  }
  ctrl.canvas = canvas
  clearCanvasMessage(canvas)
  registerCanvasInstance(ctrl, canvas)
  ctrl.view = new NVViewGPU(canvas, ctrl.model, ctrl.opts)
  try {
    await ctrl.view.init()
    if (ctrl.opts.thumbnail) {
      ctrl.model.ui.isThumbnailVisible = true
      ctrl.model.ui.thumbnailUrl = ctrl.opts.thumbnail as string
      await ctrl.view.loadThumbnail(ctrl.model.ui.thumbnailUrl)
    }
    initInteraction(ctrl)
    setupDragAndDrop(ctrl)
    setupResizeHandler(ctrl)
    ctrl.view.resize()
    return ctrl
  } catch (error) {
    log.error('Failed to initialize view:', error)
    // Tear down the partially-initialized view so a retry starts clean (no leaked
    // GPU/context resources, no stale ctrl.view).
    try {
      ctrl.view?.destroy()
    } catch {
      // a view that failed mid-init may not destroy cleanly; ignore
    }
    ctrl.view = null
    // WebGPU-only distribution: no WebGL2 fallback, so surface guidance on-canvas.
    showCanvasMessage(canvas, GRAPHICS_UNAVAILABLE_MESSAGE)
    throw error
  }
}

export async function recreateView(ctrl: NiiVue): Promise<void> {
  ctrl.view?.destroy()
  ctrl.model.clearAllGPUResources()
  removeInteractionListeners(ctrl)
  if (ctrl.resizeObserver) {
    ctrl.resizeObserver.disconnect()
  }
  const oldCanvas = ctrl.canvas as HTMLCanvasElement
  const parent = oldCanvas.parentNode
  // cloneNode(false) preserves all attributes (width/height/data-*/aria/tabindex),
  // unlike copying only id/class/style; it carries no rendering context, so the
  // clone can getContext a fresh backend. (External listeners are not preserved.)
  const newCanvas = oldCanvas.cloneNode(false) as HTMLCanvasElement
  parent?.replaceChild(newCanvas, oldCanvas)
  ctrl.canvas = newCanvas
  ctrl.view = new NVViewGPU(ctrl.canvas, ctrl.model, ctrl.opts)
  await ctrl.view.init()
  if (ctrl.opts.thumbnail && ctrl.model.ui.isThumbnailVisible) {
    await ctrl.view.loadThumbnail(ctrl.opts.thumbnail as string)
  }
  initInteraction(ctrl)
  setupDragAndDrop(ctrl)
  setupResizeHandler(ctrl)
  await ctrl.view.updateBindGroups()
  ctrl.restoreSlidePlaneView()
  ctrl.view.resize()
  ctrl.drawScene()
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
  const newAntiAlias = options.isAntiAlias ?? ctrl.opts.isAntiAlias
  const newBackend = options.backend ?? ctrl.opts.backend
  const newPixelRatio =
    options.forceDevicePixelRatio ?? ctrl.opts.forceDevicePixelRatio ?? -1
  const forceRestart = options.forceRestart ?? true

  if (newBackend !== 'webgpu') {
    log.warn(
      "This niivue distribution includes only WebGPU. Expected backend 'webgpu'.",
    )
    return false
  }
  if (!navigator.gpu) {
    log.warn('WebGPU is not supported in this browser.')
    return false
  }

  const antiAliasChanged = Boolean(newAntiAlias) !== ctrl.isAntiAlias
  const pixelRatioChanged = newPixelRatio !== ctrl.opts.forceDevicePixelRatio

  if (!forceRestart && !antiAliasChanged && !pixelRatioChanged) {
    return true
  }

  ctrl.opts.backend = 'webgpu'
  ctrl.opts.isAntiAlias = Boolean(newAntiAlias)
  ctrl.opts.forceDevicePixelRatio = newPixelRatio

  try {
    if (forceRestart || antiAliasChanged) {
      await recreateView(ctrl)
    } else {
      if (ctrl.view) ctrl.view.forceDevicePixelRatio = newPixelRatio
      ctrl.view?.resize()
    }
    return true
  } catch (err) {
    log.error('Failed to reinitialize view:', err)
    return false
  }
}
