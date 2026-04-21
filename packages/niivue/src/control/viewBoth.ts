import NVViewGL from "@/gl/NVViewGL"
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

/** Registry of controllers sharing each canvas, for coordinating canvas replacement */
const canvasInstances = new WeakMap<HTMLCanvasElement, Set<NiiVueGPU>>()
/** Tracks which backend a freshly-created canvas was made for, to prevent double-replacement
 *  within a batch while still allowing replacement on a future different-backend switch */
const freshCanvasBackend = new WeakMap<HTMLCanvasElement, BackendType>()

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
  ctrl.canvas = canvas
  // Register in canvas instance registry for shared canvas coordination
  let instances = canvasInstances.get(canvas)
  if (!instances) {
    instances = new Set()
    canvasInstances.set(canvas, instances)
  }
  instances.add(ctrl)
  if (ctrl.opts.backend === "webgl2") {
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
    initInteraction(ctrl)
    setupDragAndDrop(ctrl)
    setupResizeHandler(ctrl)
    ctrl.view.resize()
    ctrl.emit("viewAttached", {
      canvas,
      backend: (ctrl.opts.backend ?? "webgpu") as "webgpu" | "webgl2",
    })
    return ctrl
  } catch (error) {
    log.error("Failed to initialize view:", error)
    throw error
  }
}

/** Remove a controller from the canvas instance registry (called on destroy) */
export function unregister(ctrl: NiiVueGPU): void {
  if (!ctrl.canvas) return
  const instances = canvasInstances.get(ctrl.canvas)
  if (instances) {
    instances.delete(ctrl)
    if (instances.size === 0) {
      canvasInstances.delete(ctrl.canvas)
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
  const oldCanvas = ctrl.canvas!
  // If canvas was freshly created by a sibling for the same backend, skip (no context conflict)
  if (freshCanvasBackend.get(oldCanvas) === ctrl.opts.backend) return
  const parent = oldCanvas.parentNode
  if (!parent) return
  const newCanvas = document.createElement("canvas")
  newCanvas.id = oldCanvas.id
  newCanvas.className = oldCanvas.className
  newCanvas.style.cssText = oldCanvas.style.cssText
  parent.replaceChild(newCanvas, oldCanvas)
  freshCanvasBackend.set(newCanvas, ctrl.opts.backend ?? "webgpu")
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
}

export async function recreateView(
  ctrl: NiiVueGPU,
  backendChanged = false,
): Promise<void> {
  // 1. Destroy current view
  ctrl.emit("viewDestroyed")
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
  if (ctrl.opts.backend === "webgl2") {
    ctrl.view = new NVViewGL(ctrl.canvas!, ctrl.model, ctrl.opts)
  } else {
    ctrl.view = new NVViewGPU(ctrl.canvas!, ctrl.model, ctrl.opts)
  }
  // 7. Initialize the new view
  await ctrl.view.init()
  // 7b. Reload thumbnail if it was active before recreation
  if (ctrl.opts.thumbnail && ctrl.model.ui.isThumbnailVisible) {
    await ctrl.view.loadThumbnail(ctrl.opts.thumbnail as string)
  }
  // 8. Reinstall event handlers on new canvas
  initInteraction(ctrl)
  setupDragAndDrop(ctrl)
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
  ctrl.emit("viewAttached", {
    canvas: ctrl.canvas!,
    backend: (ctrl.opts.backend ?? "webgpu") as "webgpu" | "webgl2",
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
  if (newBackend !== "webgpu" && newBackend !== "webgl2") {
    log.warn(`Invalid backend: ${newBackend}. Expected 'webgpu' or 'webgl2'.`)
    return false
  }

  // Check WebGPU availability if switching to it
  if (
    newBackend === "webgpu" &&
    newBackend !== ctrl.opts.backend &&
    !navigator.gpu
  ) {
    log.warn("WebGPU is not supported in this browser.")
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
      ctrl.view!.forceDevicePixelRatio = newPixelRatio
      ctrl.view?.resize()
    }
    return true
  } catch (err) {
    log.error("Failed to reinitialize view:", err)
    return false
  }
}
