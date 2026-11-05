import { log } from '@/logger'
import type NiiVue from '@/NVControlBase'
import type { BackendType } from '@/NVTypes'

export type ReinitializeOptions = {
  backend?: BackendType
  isAntiAlias?: boolean
  forceDevicePixelRatio?: number
  forceRestart?: boolean
}

export type ViewLifecycle = {
  attachTo: (
    ctrl: NiiVue,
    id: string,
    isAntiAlias?: boolean | null,
  ) => Promise<NiiVue>
  attachToCanvas: (
    ctrl: NiiVue,
    canvas: HTMLCanvasElement,
    isAntiAlias?: boolean | null,
  ) => Promise<NiiVue>
  recreateView: (ctrl: NiiVue) => Promise<void>
  reinitializeView: (
    ctrl: NiiVue,
    options?: ReinitializeOptions,
  ) => Promise<boolean>
  unregister?: (ctrl: NiiVue) => void
}

/**
 * Load the optional thumbnail without letting a bad image abort attach or
 * rebuild: a rejection there would skip handlers and leave a dead view.
 */
export async function loadThumbnailSafely(
  view: { loadThumbnail: (url: string) => Promise<void> },
  url: string,
): Promise<void> {
  try {
    await view.loadThumbnail(url)
  } catch (error) {
    log.warn('Failed to load the thumbnail:', error)
  }
}
