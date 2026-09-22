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
