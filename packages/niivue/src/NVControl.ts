import * as viewLifecycle from '@/control/viewBoth'
import NiiVueBase, { type NiiVueOptions } from '@/NVControlBase'

export default class NiiVue extends NiiVueBase {
  constructor(options: NiiVueOptions = {}) {
    super(options, viewLifecycle, 'both')
    this.enforceBackendAvailability()
  }
}
