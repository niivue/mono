import * as viewLifecycle from '@/control/viewWebGPU'
import NiiVueGPUBase, { type NiiVueOptions } from '@/NVControlBase'

export default class NiiVueGPU extends NiiVueGPUBase {
  constructor(options: NiiVueOptions = {}) {
    super(options, viewLifecycle, 'webgpu')
    this.enforceBackendAvailability()
  }
}
