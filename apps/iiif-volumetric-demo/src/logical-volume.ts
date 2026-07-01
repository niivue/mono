// Shared factory for "logical" niivue volumes used by the streaming demos.
//
// niivue's NVImage carries a lot of derived geometry (matRAS, frac2mm, extents,
// mm-corners, volScale, …). The streaming demos all build the same axis-aligned
// shape from a level's `shape` + `spacing`; this module centralises that literal
// so each page only supplies what differs: an in-memory `img` (a regular volume)
// or a `chunkSource` (a streamed volume), plus display options.
//
// Side-effect free — safe to import from any entry module.

import type { NVImage, VolumeChunkSource } from '@niivue/niivue'

export type Shape3 = [number, number, number]

export interface NiftiDtype {
  code: number
  bits: number
  displayMin: number
  displayMax: number
}

export function niftiDatatype(dtype: string): NiftiDtype {
  switch (dtype) {
    case 'uint8':
      return { code: 2, bits: 8, displayMin: 0, displayMax: 255 }
    case 'int8':
      return { code: 256, bits: 8, displayMin: -128, displayMax: 127 }
    case 'uint16':
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
    case 'int16':
      return { code: 4, bits: 16, displayMin: -32768, displayMax: 32767 }
    case 'float32':
      return { code: 16, bits: 32, displayMin: 0, displayMax: 1 }
    default:
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
  }
}

export interface LogicalVolumeOpts {
  id: string
  url: string
  shape: Shape3
  spacing: Shape3
  datatypeCode: number
  numBitsPerVoxel: number
  calMin: number
  calMax: number
  colormap: string
  opacity?: number
  isTransparentBelowCalMin?: boolean
  // Exactly one of these: an in-memory volume (`img`) or a streamed one
  // (`chunkSource`, with `img` null and niivue tiling it).
  img?: ArrayBufferView | null
  chunkSource?: VolumeChunkSource
  // Set on an overlay volume to make niivue stream it as an independent hi-res
  // chunked layer over the chunked base whose cache-key (url/name) this names,
  // instead of reslicing it onto the base grid.
  chunkOverlayOf?: string
  chunkOverlayOpacity?: number
}

// Build a depth-correct, axis-aligned NVImage from a level's shape + spacing.
// The affine is diag(spacing) with the voxel grid placed at the origin, so two
// volumes built this way that cover the same mm box (shape*spacing) register.
export function buildLogicalVolume(o: LogicalVolumeOpts): NVImage {
  const { shape, spacing } = o
  const dims = [3, shape[0], shape[1], shape[2], 1, 1, 1, 1]
  const pixDims = [1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1]
  const affine = [
    [spacing[0], 0, 0, 0],
    [0, spacing[1], 0, 0],
    [0, 0, spacing[2], 0],
    [0, 0, 0, 1],
  ]
  const dimsMM: Shape3 = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ]
  const longest = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
  const matRAS = new Float32Array([
    spacing[0],
    0,
    0,
    0,
    0,
    spacing[1],
    0,
    0,
    0,
    0,
    spacing[2],
    0,
    0,
    0,
    0,
    1,
  ])
  const frac2mm = new Float32Array([
    dimsMM[0],
    0,
    0,
    0,
    0,
    dimsMM[1],
    0,
    0,
    0,
    0,
    dimsMM[2],
    0,
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
    1,
  ])
  const identity = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ])
  const minMM: Shape3 = [
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
  ]
  const maxMM: Shape3 = [
    (shape[0] - 0.5) * spacing[0],
    (shape[1] - 0.5) * spacing[1],
    (shape[2] - 0.5) * spacing[2],
  ]
  return {
    name: o.id,
    id: o.id,
    url: o.url,
    img: o.img ?? null,
    hdr: {
      littleEndian: true,
      dim_info: 0,
      dims,
      pixDims,
      intent_p1: 0,
      intent_p2: 0,
      intent_p3: 0,
      intent_code: 0,
      datatypeCode: o.datatypeCode,
      numBitsPerVoxel: o.numBitsPerVoxel,
      slice_start: 0,
      vox_offset: 352,
      scl_slope: 1,
      scl_inter: 0,
      slice_end: 0,
      slice_code: 0,
      xyzt_units: 10,
      cal_max: o.calMax,
      cal_min: o.calMin,
      slice_duration: 0,
      toffset: 0,
      description: 'logical streamed volume',
      aux_file: '',
      qform_code: 0,
      sform_code: 1,
      quatern_b: 0,
      quatern_c: 0,
      quatern_d: 0,
      qoffset_x: 0,
      qoffset_y: 0,
      qoffset_z: 0,
      affine,
      intent_name: '',
      magic: 'n+1',
    },
    originalAffine: affine.map((row) => [...row]),
    dims: dims.slice(0, 4),
    nVox3D: shape[0] * shape[1] * shape[2],
    extentsMin: minMM,
    extentsMax: maxMM,
    calMin: o.calMin,
    calMax: o.calMax,
    robustMin: o.calMin,
    robustMax: o.calMax,
    globalMin: o.calMin,
    globalMax: o.calMax,
    pixDimsRAS: pixDims.slice(0, 4),
    dimsRAS: dims.slice(0, 4),
    permRAS: [1, 2, 3],
    matRAS,
    obliqueRAS: identity,
    frac2mm,
    frac2mmOrtho: frac2mm,
    extentsMinOrtho: minMM,
    extentsMaxOrtho: maxMM,
    mm2ortho: identity,
    img2RASstep: [1, shape[0], shape[0] * shape[1]],
    img2RASstart: [0, 0, 0],
    toRAS: identity,
    toRASvox: identity,
    mm000: minMM,
    mm100: [maxMM[0], minMM[1], minMM[2]],
    mm010: [minMM[0], maxMM[1], minMM[2]],
    mm001: [minMM[0], minMM[1], maxMM[2]],
    oblique_angle: 0,
    maxShearDeg: 0,
    volScale: [dimsMM[0] / longest, dimsMM[1] / longest, dimsMM[2] / longest],
    frame4D: 0,
    nFrame4D: 1,
    nTotalFrame4D: 1,
    colormap: o.colormap,
    isTransparentBelowCalMin: o.isTransparentBelowCalMin ?? true,
    opacity: o.opacity ?? 1,
    modulateAlpha: 0,
    isColorbarVisible: false,
    isLegendVisible: false,
    colormapLabel: null,
    chunkSource: o.chunkSource,
    chunkOverlayOf: o.chunkOverlayOf,
    chunkOverlayOpacity: o.chunkOverlayOpacity,
  } as unknown as NVImage
}
