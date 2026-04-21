import type { vec3 } from "gl-matrix"
import * as NVCmaps from "@/cmap/NVCmaps"
import * as Drawing from "@/drawing"
import * as NVTransforms from "@/math/NVTransforms"
import { isPaqd } from "@/NVConstants"
import type {
  LUT,
  NiiVueLocation,
  NiiVueLocationValue,
  NVImage,
  NVMesh as NVMeshType,
} from "@/NVTypes"
import { buildDrawingLut } from "@/view/NVDrawingTexture"
import { getVoxelRGBA, getVoxelValue } from "@/volume/utils"

export interface LocationContext {
  volumes: NVImage[]
  meshes: NVMeshType[]
  model: {
    sceneExtentsMinMax: () => [vec3, vec3, vec3]
    scene2mm: (pos: vec3) => vec3
    scene2vox: (pos: vec3) => vec3
    scene: { crosshairPos: vec3 }
    drawingVolume: NVImage | null
    draw: { colormap: string }
  }
  _drawLut: LUT | null
  lastPointerX: number
  lastPointerY: number
}

/**
 * Build a NiiVueLocation message from the current crosshair position.
 * Returns null if there are no volumes or meshes to report on.
 * May lazily build and mutate `ctx._drawLut` when a drawing is present.
 */
export function buildLocationMessage(
  ctx: LocationContext,
  axCorSag: number,
): NiiVueLocation | null {
  if (ctx.volumes.length === 0 && ctx.meshes.length === 0) return null
  // Dynamic decimal places based on field of view
  const [, , range] = ctx.model.sceneExtentsMinMax()
  const fov = Math.max(Math.max(range[0], range[1]), range[2])
  function dynamicDecimals(flt: number): number {
    return Math.max(0.0, -Math.ceil(Math.log10(Math.abs(flt))))
  }
  let deci = dynamicDecimals(fov * 0.001)
  const mm = ctx.model.scene2mm(ctx.model.scene.crosshairPos)
  function flt2str(flt: number, decimals = 0): string {
    return parseFloat(Number(flt).toFixed(decimals)).toString()
  }
  let str = `${flt2str(mm[0], deci)}\u00D7${flt2str(mm[1], deci)}\u00D7${flt2str(mm[2], deci)}`
  if (ctx.volumes.length > 0 && (ctx.volumes[0].nFrame4D ?? 1) > 1) {
    str += `\u00D7${flt2str(ctx.volumes[0].frame4D ?? 0)}`
  }
  // Voxel-based layer intensity
  if (ctx.volumes.length > 0) {
    let valStr = " = "
    for (let i = 0; i < ctx.volumes.length; i++) {
      const vol = ctx.volumes[i]
      const vox = NVTransforms.mm2vox(vol, mm)
      const frame = vol.frame4D ?? 0
      let flt = getVoxelValue(vol, vox[0], vox[1], vox[2], frame)
      deci = 3
      if (isPaqd(vol.hdr) && vol.colormapLabel) {
        const lut = vol.colormapLabel
        const raw = getVoxelRGBA(vol, vox[0], vox[1], vox[2])
        if (raw[2] > 2 && lut.labels) {
          const pct1 = Math.round((100 * raw[2]) / 255)
          valStr += `${lut.labels[raw[0]] ?? `label(${raw[0]})`} (${pct1}%)`
          if (raw[3] > 2) {
            const pct2 = Math.round((100 * raw[3]) / 255)
            valStr += ` ${lut.labels[raw[1]] ?? `label(${raw[1]})`} (${pct2}%)`
          }
        }
      } else if (vol.colormapLabel) {
        const lut = vol.colormapLabel
        const labelIdx = Math.round(flt)
        const labelMin = lut.min ?? 0
        const labelMax = lut.max ?? 0
        if (labelIdx >= labelMin && labelIdx <= labelMax && lut.labels) {
          const localIdx = labelIdx - labelMin
          valStr += lut.labels[localIdx] ?? `label(${labelIdx})`
        } else {
          valStr += flt2str(flt, deci)
        }
      } else {
        valStr += flt2str(flt, deci)
      }
      if (ctx.volumes[i].isImaginary) {
        flt = getVoxelValue(ctx.volumes[i], vox[0], vox[1], vox[2], frame)
        // TODO: read imaginary component when complex data support is added
        if (flt >= 0) {
          valStr += "+"
        }
        valStr += flt2str(flt, deci)
      }
      valStr += "   "
    }
    str += valStr
    // Drawing bitmap label
    if (ctx.volumes.length > 0) {
      const back = ctx.volumes[0]
      const dims = back.dimsRAS
      if (dims) {
        const nv = dims[1] * dims[2] * dims[3]
        if (ctx.model.drawingVolume) {
          const bitmap = Drawing.getDrawingBitmap(ctx.model.drawingVolume)
          if (bitmap.length === nv) {
            const vox = ctx.model.scene2vox(ctx.model.scene.crosshairPos)
            const vx = vox[0] + vox[1] * dims[1] + vox[2] * dims[1] * dims[2]
            const drawVal = bitmap[vx]
            if (drawVal > 0) {
              if (!ctx._drawLut) {
                const cm = NVCmaps.lookupColorMap(ctx.model.draw.colormap)
                if (cm) ctx._drawLut = buildDrawingLut(cm)
              }
              const lut = ctx._drawLut
              const localIdx = drawVal - (lut?.min ?? 0)
              const label = lut?.labels?.[localIdx]
              str += ` draw:${label ?? drawVal}`
            }
          }
        }
      }
    }
  }
  const frac = ctx.model.scene.crosshairPos
  const vox = ctx.model.scene2vox(frac)
  const msg: NiiVueLocation = {
    mm: [mm[0], mm[1], mm[2]],
    axCorSag,
    vox: [vox[0], vox[1], vox[2]],
    frac: [frac[0], frac[1], frac[2]],
    xy: [ctx.lastPointerX, ctx.lastPointerY],
    values: ctx.volumes.map((v) => {
      const vvox = NVTransforms.mm2vox(v, mm)
      const val = getVoxelValue(v, vvox[0], vvox[1], vvox[2], v.frame4D ?? 0)
      const entry: NiiVueLocationValue = {
        name: v.name,
        value: val,
        id: v.id ?? v.name,
        mm: [mm[0], mm[1], mm[2]],
        vox: [vvox[0], vvox[1], vvox[2]],
      }
      if (isPaqd(v.hdr) && v.colormapLabel) {
        const lut = v.colormapLabel
        const raw = getVoxelRGBA(v, vvox[0], vvox[1], vvox[2])
        if (raw[2] > 2 && lut.labels) {
          entry.label = lut.labels[raw[0]] ?? `label(${raw[0]})`
        }
      } else if (v.colormapLabel) {
        const lut = v.colormapLabel
        const labelIdx = Math.round(val)
        const labelMin = lut.min ?? 0
        const labelMax = lut.max ?? 0
        if (labelIdx >= labelMin && labelIdx <= labelMax && lut.labels) {
          entry.label = lut.labels[labelIdx - labelMin]
        }
      }
      return entry
    }),
    string: str,
  }
  return msg
}
