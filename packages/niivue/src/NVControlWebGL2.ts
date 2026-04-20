import * as viewLifecycle from "@/control/viewWebGL2";
import NiiVueGPUBase, { type NiiVueOptions } from "@/NVControlBase";

export default class NiiVueGPU extends NiiVueGPUBase {
  constructor(options: NiiVueOptions = {}) {
    super(
      { ...options, backend: options.backend ?? "webgl2" },
      viewLifecycle,
      "webgl2",
    );
    this.enforceBackendAvailability();
  }
}
