import * as viewLifecycle from "@/control/viewBoth";
import NiiVueGPUBase, { type NiiVueOptions } from "@/NVControlBase";

export default class NiiVueGPU extends NiiVueGPUBase {
  constructor(options: NiiVueOptions = {}) {
    super(options, viewLifecycle, "both");
    this.enforceBackendAvailability();
  }
}
