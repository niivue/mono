import * as viewLifecycle from '@/control/viewWebGL2'
import NiiVueBase, { type NiiVueOptions } from '@/NVControlBase'

export default class NiiVue extends NiiVueBase {
  constructor(options: NiiVueOptions = {}) {
    super(
      { ...options, backend: options.backend ?? 'webgl2' },
      viewLifecycle,
      'webgl2',
    )
    this.enforceBackendAvailability()
  }
}
