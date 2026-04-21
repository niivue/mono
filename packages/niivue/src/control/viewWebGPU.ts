import { log } from "@/logger"
import type NiiVueGPU from "@/NVControlBase"
import type { BackendType } from "@/NVTypes"
import NVViewGPU from "@/wgpu/NVViewGPU"
import {
  initInteraction,
  removeInteractionListeners,
  setupDragAndDrop,
  setupResizeHandler,
} from "./interactions"

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
  log.debug("attached to element with id: ", id)
  return ctrl
}

export async function attachToCanvas(
  ctrl: NiiVueGPU,
  canvas: HTMLCanvasElement,
  isAntiAlias: boolean | null = null,
): Promise<NiiVueGPU> {
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
    throw new Error("NiiVue requires a valid HTMLCanvasElement")
  }
  if (typeof isAntiAlias === "boolean") {
    ctrl.opts.isAntiAlias = isAntiAlias
  }
  if (ctrl.opts.backend === "webgl2") {
    throw new Error(
      "This niivuegpu distribution includes only WebGPU. Requested backend 'webgl2' is unavailable.",
    )
  }
  ctrl.canvas = canvas
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
    log.error("Failed to initialize view:", error)
    throw error
  }
}

export async function recreateView(ctrl: NiiVueGPU): Promise<void> {
  ctrl.view?.destroy()
  ctrl.model.clearAllGPUResources()
  removeInteractionListeners(ctrl)
  if (ctrl.resizeObserver) {
    ctrl.resizeObserver.disconnect()
  }
  const oldCanvas = ctrl.canvas!
  const parent = oldCanvas.parentNode
  const newCanvas = document.createElement("canvas")
  newCanvas.id = oldCanvas.id
  newCanvas.className = oldCanvas.className
  newCanvas.style.cssText = oldCanvas.style.cssText
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
  ctrl.view.resize()
  ctrl.drawScene()
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
  const newAntiAlias = options.isAntiAlias ?? ctrl.opts.isAntiAlias
  const newBackend = options.backend ?? ctrl.opts.backend
  const newPixelRatio =
    options.forceDevicePixelRatio ?? ctrl.opts.forceDevicePixelRatio ?? -1
  const forceRestart = options.forceRestart ?? true

  if (newBackend !== "webgpu") {
    log.warn(
      "This niivuegpu distribution includes only WebGPU. Expected backend 'webgpu'.",
    )
    return false
  }
  if (!navigator.gpu) {
    log.warn("WebGPU is not supported in this browser.")
    return false
  }

  const antiAliasChanged = Boolean(newAntiAlias) !== ctrl.isAntiAlias
  const pixelRatioChanged = newPixelRatio !== ctrl.opts.forceDevicePixelRatio

  if (!forceRestart && !antiAliasChanged && !pixelRatioChanged) {
    return true
  }

  ctrl.opts.backend = "webgpu"
  ctrl.opts.isAntiAlias = Boolean(newAntiAlias)
  ctrl.opts.forceDevicePixelRatio = newPixelRatio

  try {
    if (forceRestart || antiAliasChanged) {
      await recreateView(ctrl)
    } else {
      ctrl.view!.forceDevicePixelRatio = newPixelRatio
      ctrl.view?.resize()
    }
    return true
  } catch (err) {
    log.error("Failed to reinitialize view:", err)
    return false
  }
}
