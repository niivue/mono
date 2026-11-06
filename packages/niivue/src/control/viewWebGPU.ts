import NVViewGPU from '@/wgpu/NVViewGPU'
import { singleBackendLifecycle } from './viewSingle'

export const {
  attachTo,
  attachToCanvas,
  recreateView,
  reinitializeView,
  unregister,
} = singleBackendLifecycle('webgpu', NVViewGPU, () => !!navigator.gpu)
