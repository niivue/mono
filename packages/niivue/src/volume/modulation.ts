import type { NVImage } from "@/NVTypes"
import { getTypedArrayConstructor } from "./utils"

/** Compute modulation data for all volumes that have modulationImage set. */
export function computeModulationData(volumes: NVImage[]): void {
  for (const vol of volumes) {
    if (!vol.modulationImage) {
      vol._modulationData = null
      continue
    }
    const mod = volumes.find((v) => v.id === vol.modulationImage)
    if (!mod?.img || !mod.dimsRAS || !mod.img2RASstep || !mod.img2RASstart) {
      vol._modulationData = null
      continue
    }
    const hdr = mod.hdr
    const Ctor = getTypedArrayConstructor(hdr.datatypeCode)
    if (!Ctor) {
      vol._modulationData = null
      continue
    }
    const imgData = mod.img
    const dims = mod.dimsRAS
    const nVoxRAS = dims[1] * dims[2] * dims[3]
    const result = new Float32Array(nVoxRAS)
    const slope = hdr.scl_slope
    const inter = hdr.scl_inter
    const range = mod.calMax - mod.calMin
    if (range <= 0) {
      result.fill(1)
      vol._modulationData = result
      continue
    }
    const start = mod.img2RASstart
    const step = mod.img2RASstep
    const frameOffset = (mod.frame4D ?? 0) * mod.nVox3D
    let rasIdx = 0
    for (let rz = 0; rz < dims[3]; rz++) {
      for (let ry = 0; ry < dims[2]; ry++) {
        for (let rx = 0; rx < dims[1]; rx++) {
          const nativeIndex =
            start[0] +
            rx * step[0] +
            start[1] +
            ry * step[1] +
            start[2] +
            rz * step[2]
          const raw =
            (imgData as unknown as ArrayLike<number>)[
              nativeIndex + frameOffset
            ] ?? 0
          const scaled = raw * slope + inter
          result[rasIdx] = Math.max(
            0,
            Math.min(1, (scaled - mod.calMin) / range),
          )
          rasIdx++
        }
      }
    }
    vol._modulationData = result
  }
}
