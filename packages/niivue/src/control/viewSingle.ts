// The ViewLifecycle of a single-backend controller (NVControlWebGL2,
// NVControlWebGPU). The two differ only in the view class, the backend name and
// the WebGPU support check, so each entry builds its lifecycle here (#308).
// The view classes are imported as types only: the caller passes its own, so a
// single-backend entry never pulls in the other renderer.

import type NVViewGL from '@/gl/NVViewGL'
import { log } from '@/logger'
import type NiiVue from '@/NVControlBase'
import type { BackendType } from '@/NVTypes'
import type NVViewGPU from '@/wgpu/NVViewGPU'
import {
  clearCanvasMessage,
  GRAPHICS_UNAVAILABLE_MESSAGE,
  showCanvasMessage,
} from './canvasMessage'
import {
  isSharedCanvas,
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
import {
  loadThumbnailSafely,
  type ReinitializeOptions,
  type ViewLifecycle,
} from './viewLifecycle'

type SingleBackend = 'webgl2' | 'webgpu'
type ViewClass = typeof NVViewGL | typeof NVViewGPU

const LABEL: Record<SingleBackend, string> = {
  webgl2: 'WebGL2',
  webgpu: 'WebGPU',
}

/**
 * Build the lifecycle for a distribution that ships one backend. `isSupported`
 * is checked before a reinitialize (WebGPU: `navigator.gpu`).
 */
export function singleBackendLifecycle(
  backend: SingleBackend,
  View: ViewClass,
  isSupported: () => boolean = () => true,
): Required<ViewLifecycle> {
  const only = `This niivue distribution includes only ${LABEL[backend]}.`

  async function attachTo(
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

  async function attachToCanvas(
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
    const requested = ctrl.opts.backend
    if (requested && requested !== backend) {
      throw new Error(
        `${only} Requested backend '${requested}' is unavailable.`,
      )
    }
    ctrl.canvas = canvas
    clearCanvasMessage(canvas)
    registerCanvasInstance(ctrl, canvas)
    // Publish ctrl.view only once init() resolves; a view exposed mid-init is
    // indistinguishable from a ready one to `if (!this.view) return` callers (#61).
    const view = new View(canvas, ctrl.model, ctrl.opts)
    ctrl.view = null
    try {
      await view.init()
      ctrl.view = view
      // Hooks go on before the resize() below draws the first frame: a preloaded
      // chunked volume starts streaming on it (see NiiVue._wireViewHooks).
      ctrl._wireViewHooks()
      if (ctrl.opts.thumbnail) {
        ctrl.model.ui.isThumbnailVisible = true
        ctrl.model.ui.thumbnailUrl = ctrl.opts.thumbnail as string
        await loadThumbnailSafely(view, ctrl.model.ui.thumbnailUrl)
      }
      if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
      if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
      setupResizeHandler(ctrl)
      view.resize()
      ctrl.emit('viewAttached', { canvas, backend })
      return ctrl
    } catch (error) {
      log.error('Failed to initialize view:', error)
      // Tear down the partially-initialized view so a retry starts clean (no leaked
      // GPU/context resources, no stale ctrl.view).
      try {
        view.destroy()
      } catch {
        // a view that failed mid-init may not destroy cleanly; ignore
      }
      ctrl.view = null
      // No other backend to fall back to, so surface guidance on-canvas.
      showCanvasMessage(canvas, GRAPHICS_UNAVAILABLE_MESSAGE)
      throw error
    }
  }

  async function recreateView(
    ctrl: NiiVue,
    cloneDetached = false,
  ): Promise<void> {
    ctrl.emit('viewDestroyed')
    ctrl.view?.destroy()
    ctrl.view = null
    ctrl.model.clearAllGPUResources()
    removeInteractionListeners(ctrl)
    if (ctrl.resizeObserver) {
      ctrl.resizeObserver.disconnect()
    }
    // Same backend, so a canvas shared through bounds keeps its context (as in
    // viewBoth); an unshared one is cloned for a fresh context. A detached canvas
    // stays put unless WebGL2 antialias changes (WebGPU sets MSAA per view): the
    // caller holds it, so the clone reaches them only through viewAttached.
    const canvas = ctrl.canvas as HTMLCanvasElement
    if (!isSharedCanvas(ctrl) && (canvas.parentNode || cloneDetached)) {
      replaceCanvas(ctrl)
    }
    const view = new View(
      ctrl.canvas as HTMLCanvasElement,
      ctrl.model,
      ctrl.opts,
    )
    await view.init()
    ctrl.view = view
    // Hooks go on before the resize() below draws the first frame: a preloaded
    // chunked volume starts streaming on it (see NiiVue._wireViewHooks).
    ctrl._wireViewHooks()
    if (ctrl.opts.thumbnail && ctrl.model.ui.isThumbnailVisible) {
      await loadThumbnailSafely(ctrl.view, ctrl.opts.thumbnail as string)
    }
    if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
    if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
    setupResizeHandler(ctrl)
    await ctrl._rebuildViewResources()
    if (ctrl.model.drawingVolume) ctrl.refreshDrawing()
    ctrl.restoreSlidePlaneView()
    ctrl.view.resize()
    ctrl.drawScene()
    ctrl.emit('viewAttached', {
      canvas: ctrl.canvas as HTMLCanvasElement,
      backend,
    })
  }

  async function reinitializeView(
    ctrl: NiiVue,
    options: ReinitializeOptions = {},
  ): Promise<boolean> {
    const newAntiAlias = options.isAntiAlias ?? ctrl.opts.isAntiAlias
    const newBackend: BackendType | undefined =
      options.backend ?? ctrl.opts.backend
    const newPixelRatio =
      options.forceDevicePixelRatio ?? ctrl.opts.forceDevicePixelRatio ?? -1
    const forceRestart = options.forceRestart ?? true

    if (newBackend !== backend) {
      log.warn(`${only} Expected backend '${backend}'.`)
      return false
    }
    if (!isSupported()) {
      log.warn(`${LABEL[backend]} is not supported in this browser.`)
      return false
    }

    const antiAliasChanged = Boolean(newAntiAlias) !== ctrl.isAntiAlias
    const pixelRatioChanged = newPixelRatio !== ctrl.opts.forceDevicePixelRatio

    if (!forceRestart && !antiAliasChanged && !pixelRatioChanged) {
      return true
    }
    // A WebGL2 context fixes antialias at creation, and siblings share this one.
    // WebGPU sets MSAA per view, so it needs no new context.
    if (antiAliasChanged && backend === 'webgl2' && isSharedCanvas(ctrl)) {
      log.warn('Cannot change antialiasing on a canvas shared by other views.')
      return false
    }

    ctrl.opts.backend = backend
    ctrl.opts.isAntiAlias = Boolean(newAntiAlias)
    ctrl.opts.forceDevicePixelRatio = newPixelRatio

    try {
      if (forceRestart || antiAliasChanged) {
        await recreateView(ctrl, antiAliasChanged && backend === 'webgl2')
      }
      // The setter also updates controllers sharing this canvas.
      if (pixelRatioChanged) ctrl.devicePixelRatio = newPixelRatio
      return true
    } catch (err) {
      log.error('Failed to reinitialize view:', err)
      return false
    }
  }

  return {
    attachTo,
    attachToCanvas,
    recreateView,
    reinitializeView,
    unregister,
  }
}
