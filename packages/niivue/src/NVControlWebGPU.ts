import * as viewLifecycle from '@/control/viewWebGPU'
import NiiVueBase, { type NiiVueOptions } from '@/NVControlBase'

export default class NiiVue extends NiiVueBase {
  constructor(options: NiiVueOptions = {}) {
    super(
      { ...options, backend: options.backend ?? 'webgpu' },
      viewLifecycle,
      'webgpu',
    )
    this.enforceBackendAvailability()
  }
}
