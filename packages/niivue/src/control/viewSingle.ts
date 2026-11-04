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
import type { ReinitializeOptions, ViewLifecycle } from './viewLifecycle'

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
        await view.loadThumbnail(ctrl.model.ui.thumbnailUrl)
      }
      if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
      if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
      setupResizeHandler(ctrl)
      view.resize()
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

  async function recreateView(ctrl: NiiVue): Promise<void> {
    ctrl.view?.destroy()
    ctrl.view = null
    ctrl.model.clearAllGPUResources()
    removeInteractionListeners(ctrl)
    if (ctrl.resizeObserver) {
      ctrl.resizeObserver.disconnect()
    }
    // Same backend, so a canvas shared through bounds keeps its context (as in
    // viewBoth); an unshared one is cloned, since antialias is fixed at context
    // creation.
    if (!isSharedCanvas(ctrl)) replaceCanvas(ctrl)
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
      await ctrl.view.loadThumbnail(ctrl.opts.thumbnail as string)
    }
    if (ctrl.opts.isInteractionEnabled !== false) initInteraction(ctrl)
    if (ctrl.opts.isInteractionEnabled !== false) setupDragAndDrop(ctrl)
    setupResizeHandler(ctrl)
    await ctrl._rebuildViewResources()
    ctrl.restoreSlidePlaneView()
    ctrl.view.resize()
    ctrl.drawScene()
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

    ctrl.opts.backend = backend
    ctrl.opts.isAntiAlias = Boolean(newAntiAlias)
    ctrl.opts.forceDevicePixelRatio = newPixelRatio

    try {
      if (forceRestart || antiAliasChanged) {
        await recreateView(ctrl)
      } else {
        // The setter also updates controllers sharing this canvas.
        ctrl.devicePixelRatio = newPixelRatio
      }
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
