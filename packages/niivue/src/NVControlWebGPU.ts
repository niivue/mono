import * as viewLifecycle from '@/control/viewWebGPU'
import NiiVueBase, { type NiiVueOptions } from '@/NVControlBase'

export default class NiiVue extends NiiVueBase {
  constructor(options: NiiVueOptions = {}) {
    super(options, viewLifecycle, 'webgpu')
    this.enforceBackendAvailability()
  }
}
