import NVViewGL from '@/gl/NVViewGL'
import { singleBackendLifecycle } from './viewSingle'

export const {
  attachTo,
  attachToCanvas,
  recreateView,
  reinitializeView,
  unregister,
} = singleBackendLifecycle('webgl2', NVViewGL)
