import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import { NiiDataType, NiiIntentCode } from '@/NVConstants'
import * as NVLoader from '@/NVLoader'
import type { NIFTI1, NIFTI2, NVImage, TypedVoxelArray } from '@/NVTypes'
import {
  calculateWorldExtents,
  calMinMax,
  ensureValidNonZero,
  toTypedView,
} from './utils'

// Re-export utilities for external use
export { calculateWorldExtents, calMinMax }

// Writer support
import * as volumeWriters from './writers'
import { writeVolume } from './writers'
export function volumeWriteExtensions(): string[] {
  return volumeWriters.writeExtensions()
}
export { writeVolume }

type VolumeReader = {
  extensions?: string[]
  read: (
    buffer: ArrayBuffer,
    name?: string,
    pairedImgData?: ArrayBuffer | null,
  ) => Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }>
}

const modules = import.meta.glob<VolumeReader>(
  ['./readers/*.ts', '!./readers/*.test.ts'],
  {
    eager: true,
  },
)
const readerByExt = NVLoader.buildExtensionMap(modules)

export function volumeExtensions(): string[] {
  return Array.from(readerByExt.keys()).sort()
}

export function registerExternalReader(
  fromExt: string,
  toExt: string,
  converter: (
    buffer: ArrayBuffer,
  ) => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>,
): void {
  const targetReader = readerByExt.get(toExt.toUpperCase())
  if (!targetReader) {
    throw new Error(`No built-in volume reader for target format "${toExt}"`)
  }
  const wrappedReader: VolumeReader = {
    extensions: [fromExt.toUpperCase()],
    read: async (buffer, name, pairedImgData) => {
      const converted = await converter(buffer)
      const ab =
        converted instanceof ArrayBuffer
          ? converted
          : (new Uint8Array(converted).buffer as ArrayBuffer)
      return targetReader.read(ab, name, pairedImgData)
    },
  }
  readerByExt.set(fromExt.toUpperCase(), wrappedReader)
}

export async function loadVolume(
  url: string | File,
  pairedImgData: string | File | null = null,
): Promise<{ hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }> {
  const result = await NVLoader.fetchFile(url)
  const pairedBuffer = pairedImgData
    ? await NVLoader.fetchFile(pairedImgData)
    : null
  const name = NVLoader.getName(url)
  const ext = NVLoader.getFileExt(url)
  let reader = readerByExt.get(ext)
  if (!reader || typeof reader.read !== 'function') {
    log.warn(`Unsupported volume format "${ext}", falling back to NIfTI reader`)
    reader = readerByExt.get('NII')
  }
  if (!reader) {
    throw new Error(`No volume reader available for extension ${ext}`)
  }
  return await reader.read(result, name, pairedBuffer)
}

/**
 * Convert a float32 RGB vector volume (intent_code 2003, dim4=3) to RGBA8.
 * Each voxel's 3 float32 components (across frames) become |x|→R, |y|→G, |z|→B.
 * Alpha is 255 (fully opaque) if any component is non-zero, 0 otherwise.
 */
export function convertFloat32RGBVector(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
): { hdr: NIFTI1 | NIFTI2; img: Uint8Array } {
  const nVox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  const slope = hdr.scl_slope
  const inter = hdr.scl_inter
  let f32: Float32Array
  if (img instanceof ArrayBuffer) {
    f32 = new Float32Array(img)
  } else if (img instanceof Float32Array) {
    f32 = img
  } else {
    f32 = new Float32Array(img.buffer, img.byteOffset, img.byteLength / 4)
  }
  // Apply slope/intercept and find max magnitude (skip NaN from tensor tools)
  const calibrated = new Float32Array(nVox3D * 3)
  let mx = 1.0
  for (let i = 0; i < nVox3D * 3; i++) {
    const v = f32[i] * slope + inter
    calibrated[i] = Number.isNaN(v) ? 0 : v
    mx = Math.max(mx, Math.abs(calibrated[i]))
  }
  const colorSlope = 255 / mx
  const rgba = new Uint8Array(nVox3D * 4)
  const nVox3D2 = nVox3D * 2
  // RGB = absolute magnitude scaled to 0-255
  // Alpha encodes sign polarity in 3 least-significant bits:
  //   bit 0 (1) = x positive, bit 1 (2) = y positive, bit 2 (4) = z positive
  //   alpha = 248 + xPos + yPos + zPos (or 0 if near-zero magnitude)
  for (let i = 0; i < nVox3D; i++) {
    const x = calibrated[i]
    const y = calibrated[i + nVox3D]
    const z = calibrated[i + nVox3D2]
    const j = i * 4
    rgba[j] = Math.abs(x * colorSlope)
    rgba[j + 1] = Math.abs(y * colorSlope)
    rgba[j + 2] = Math.abs(z * colorSlope)
    if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 0.1) {
      rgba[j + 3] = 0
    } else {
      const xPos = x > 0 ? 1 : 0
      const yPos = y > 0 ? 2 : 0
      const zPos = z > 0 ? 4 : 0
      rgba[j + 3] = 248 + xPos + yPos + zPos
    }
  }
  const newHdr = {
    ...hdr,
    dims: [...hdr.dims],
    affine: hdr.affine.map((row) => [...row]),
  }
  newHdr.datatypeCode = NiiDataType.DT_RGBA32
  newHdr.numBitsPerVoxel = 32
  newHdr.dims[0] = 3
  newHdr.dims[4] = 1
  newHdr.scl_slope = 1.0
  newHdr.scl_inter = 0.0
  log.info(
    `Converted RGB vector (intent 2003, dim4=3) to RGBA8 with sign-encoded alpha`,
  )
  return { hdr: newHdr, img: rgba }
}

export function nii2volume(
  hdr: NIFTI1 | NIFTI2,
  img: ArrayBuffer | TypedVoxelArray,
  name = '',
  limitFrames4D = Infinity,
): NVImage {
  // Convert float32 RGB vector volumes (intent_code 2003, dim4=3) to RGBA8
  if (
    hdr.intent_code === NiiIntentCode.NIFTI_INTENT_RGB_VECTOR &&
    hdr.dims[4] === 3 &&
    hdr.datatypeCode === NiiDataType.DT_FLOAT32
  ) {
    const converted = convertFloat32RGBVector(hdr, img)
    hdr = converted.hdr
    img = converted.img
  }
  const { extentsMin, extentsMax } = calculateWorldExtents(
    hdr.dims.slice(1, 4),
    new Float32Array(hdr.affine.flat()),
  )
  if (!Number.isFinite(hdr.scl_inter)) {
    hdr.scl_inter = 0.0
  }
  if (!Number.isFinite(hdr.scl_slope) || hdr.scl_slope === 0.0) {
    hdr.scl_slope = 1.0
  }
  for (let i = 1; i < 4; i++) {
    hdr.dims[i] = Math.max(hdr.dims[i], 1)
    hdr.pixDims[i] = ensureValidNonZero(hdr.pixDims[i])
  }
  // Compute total 4D frames from header (handles 5D/6D by multiplying dims 4-6)
  const nTotalFrame4D = [4, 5, 6].reduce(
    (acc, i) => acc * (hdr.dims[i] > 1 ? hdr.dims[i] : 1),
    1,
  )
  // Apply limitFrames4D: truncate img data if fewer frames requested
  const nFrame4D = Number.isFinite(limitFrames4D)
    ? Math.max(1, Math.min(limitFrames4D, nTotalFrame4D))
    : nTotalFrame4D
  const nVox3D = hdr.dims[1] * hdr.dims[2] * hdr.dims[3]
  let truncatedImg = img
  if (nFrame4D < nTotalFrame4D) {
    const bytesPerVoxel = hdr.numBitsPerVoxel / 8
    const keepBytes = nVox3D * nFrame4D * bytesPerVoxel
    if (img instanceof ArrayBuffer) {
      truncatedImg = img.slice(0, keepBytes)
    } else {
      const keepElements = nVox3D * nFrame4D
      truncatedImg = img.slice(0, keepElements)
    }
    log.info(
      `4D: loaded ${nFrame4D} of ${nTotalFrame4D} frames (limitFrames4D=${limitFrames4D})`,
    )
  }
  const [pct2, pct98, mnScale, mxScale] = calMinMax(hdr, truncatedImg)
  // Ensure img is always a typed array, never a raw ArrayBuffer
  const typedImg: TypedVoxelArray =
    truncatedImg instanceof ArrayBuffer
      ? (toTypedView(truncatedImg, hdr.datatypeCode) ??
        new Uint8Array(truncatedImg))
      : truncatedImg
  const volume: NVImage = {
    img: typedImg,
    hdr: hdr,
    dims: hdr.dims.slice(0, 4),
    nVox3D: nVox3D,
    extentsMin: extentsMin,
    extentsMax: extentsMax,
    name: name,
    id: name,
    calMin: pct2,
    calMax: pct98,
    robustMin: pct2,
    robustMax: pct98,
    globalMin: mnScale,
    globalMax: mxScale,
    frame4D: 0,
    nFrame4D: nFrame4D,
    nTotalFrame4D: nTotalFrame4D,
    isLegendVisible: false,
  }
  const v1 = (hdr as unknown as { v1?: Float32Array }).v1
  if (v1) {
    volume.v1 = v1
  }
  NVTransforms.calculateRAS(volume)
  if (!volume.pixDimsRAS || !volume.dimsRAS) {
    throw new Error('calculateRAS failed to set pixDimsRAS/dimsRAS')
  }
  const dimsMM = [
    volume.pixDimsRAS[1] * volume.dimsRAS[1],
    volume.pixDimsRAS[2] * volume.dimsRAS[2],
    volume.pixDimsRAS[3] * volume.dimsRAS[3],
  ]
  const longestAxis = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
  const volScale = [
    dimsMM[0] / longestAxis,
    dimsMM[1] / longestAxis,
    dimsMM[2] / longestAxis,
  ]
  volume.volScale = volScale
  return volume
}
