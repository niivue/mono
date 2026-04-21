import type NiiVueGPU from '@/NVControlBase'
import type { BackendType } from '@/NVTypes'

export type ReinitializeOptions = {
  backend?: BackendType
  isAntiAlias?: boolean
  forceDevicePixelRatio?: number
  forceRestart?: boolean
}

export type ViewLifecycle = {
  attachTo: (
    ctrl: NiiVueGPU,
    id: string,
    isAntiAlias?: boolean | null,
  ) => Promise<NiiVueGPU>
  attachToCanvas: (
    ctrl: NiiVueGPU,
    canvas: HTMLCanvasElement,
    isAntiAlias?: boolean | null,
  ) => Promise<NiiVueGPU>
  recreateView: (ctrl: NiiVueGPU) => Promise<void>
  reinitializeView: (
    ctrl: NiiVueGPU,
    options?: ReinitializeOptions,
  ) => Promise<boolean>
  unregister?: (ctrl: NiiVueGPU) => void
}
