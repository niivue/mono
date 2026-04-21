/**
 * FreeSurfer-style conform transform — pure computation.
 *
 * Reslices any image to a 256×256×256 isotropic volume with 1 mm voxels,
 * centered on the original volume. Optionally rescales intensities.
 *
 * Based on FastSurfer conform.py (Apache License) and nibabel mghformat.py (MIT License).
 */

import { mat4, vec3, vec4 } from 'gl-matrix'

// ============================================================================
// Types (self-contained to avoid niivue imports in worker context)
// ============================================================================

export interface ConformInput {
  /** Flat voxel data */
  img: ArrayLike<number>
  /** NIfTI datatype code */
  datatypeCode: number
  /** Volume dimensions [ndim, x, y, z, ...] */
  dims: number[]
  /** Pixel dimensions [qfac, dx, dy, dz, ...] */
  pixDims: number[]
  /** 4×4 affine as flat 16-element array (row-major) */
  affine: number[]
  sclSlope: number
  sclInter: number
  /** Options */
  toRAS?: boolean
  isLinear?: boolean
  asFloat32?: boolean
  isRobustMinMax?: boolean
}

export interface ConformOutput {
  img: ArrayBufferView
  dims: number[]
  pixDims: number[]
  affine: number[]
  datatypeCode: number
  bitsPerVoxel: number
  sclSlope: number
  sclInter: number
  calMin: number
  calMax: number
}

// ============================================================================
// gl-matrix helpers (formerly in volume/utils.ts)
// ============================================================================

function conformVox2Vox(
  inDims: number[],
  inAffine: number[],
  outDim = 256,
  outMM = 1,
  toRAS = false,
): [mat4, mat4, mat4] {
  const a = inAffine
  const affine = mat4.fromValues(
    a[0],
    a[1],
    a[2],
    a[3],
    a[4],
    a[5],
    a[6],
    a[7],
    a[8],
    a[9],
    a[10],
    a[11],
    a[12],
    a[13],
    a[14],
    a[15],
  )
  const half = vec4.fromValues(inDims[1] / 2, inDims[2] / 2, inDims[3] / 2, 1)
  const Pxyz_c4 = vec4.create()
  const affineT = mat4.create()
  mat4.transpose(affineT, affine)
  vec4.transformMat4(Pxyz_c4, half, affineT)
  const Pxyz_c = vec3.fromValues(Pxyz_c4[0], Pxyz_c4[1], Pxyz_c4[2])
  const delta = vec3.fromValues(outMM, outMM, outMM)
  let Mdc = mat4.fromValues(-1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1)
  if (toRAS) {
    Mdc = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)
  }
  mat4.transpose(Mdc, Mdc)
  const dims = vec4.fromValues(outDim, outDim, outDim, 1)
  const MdcD = mat4.create()
  mat4.scale(MdcD, Mdc, delta)
  const vol_center = vec4.fromValues(dims[0], dims[1], dims[2], 1)
  vec4.transformMat4(vol_center, vol_center, MdcD)
  vec4.scale(vol_center, vol_center, 0.5)
  const translate = vec3.create()
  vec3.subtract(
    translate,
    Pxyz_c,
    vec3.fromValues(vol_center[0], vol_center[1], vol_center[2]),
  )
  const out_affine = mat4.create()
  mat4.transpose(out_affine, MdcD)
  out_affine[3] = translate[0]
  out_affine[7] = translate[1]
  out_affine[11] = translate[2]
  const inv_out_affine = mat4.create()
  mat4.invert(inv_out_affine, out_affine)
  const vox2vox = mat4.create()
  mat4.mul(vox2vox, affine, inv_out_affine)
  const inv_vox2vox = mat4.create()
  mat4.invert(inv_vox2vox, vox2vox)
  return [out_affine, vox2vox, inv_vox2vox]
}

// ============================================================================
// Intensity scaling helpers
// ============================================================================

function toTypedView(
  img: ArrayLike<number> | ArrayBuffer,
  dt: number,
): ArrayLike<number> {
  if (!(img instanceof ArrayBuffer)) return img
  switch (dt) {
    case 2:
      return new Uint8Array(img)
    case 4:
      return new Int16Array(img)
    case 8:
      return new Int32Array(img)
    case 16:
      return new Float32Array(img)
    case 64:
      return new Float64Array(img)
    case 256:
      return new Int8Array(img)
    case 512:
      return new Uint16Array(img)
    case 768:
      return new Uint32Array(img)
    default:
      return new Float32Array(img)
  }
}

function scalecropUint8(
  img32: Float32Array,
  dst_min: number,
  dst_max: number,
  src_min: number,
  scale: number,
): Uint8Array {
  const n = img32.length
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    let v = dst_min + scale * (img32[i] - src_min)
    v = Math.max(v, dst_min)
    v = Math.min(v, dst_max)
    out[i] = v
  }
  return out
}

function scalecropFloat32(
  img32: Float32Array,
  dst_min: number,
  dst_max: number,
  src_min: number,
  scale: number,
): Float32Array {
  const n = img32.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = dst_min + scale * (img32[i] - src_min)
    v = Math.max(v, dst_min)
    v = Math.min(v, dst_max)
    out[i] = v
  }
  return out
}

function getScale(
  datatypeCode: number,
  img: ArrayLike<number>,
  sclSlope: number,
  sclInter: number,
  calMin: number,
  calMax: number,
  globalMin: number,
  globalMax: number,
  dstMin: number,
  dstMax: number,
  fLow: number,
  fHigh = 0.999,
): [number, number] {
  let srcMin = globalMin
  let srcMax = globalMax

  // DT_UINT8
  if (datatypeCode === 2) return [srcMin, 1.0]

  if (!Number.isFinite(fLow) || !Number.isFinite(fHigh)) {
    if (Number.isFinite(calMin) && Number.isFinite(calMax) && calMax > calMin) {
      srcMin = calMin
      srcMax = calMax
      return [srcMin, (dstMax - dstMin) / (srcMax - srcMin)]
    }
  }

  const voxnum = img.length
  const scaledImg = new Float32Array(voxnum)
  for (let i = 0; i < voxnum; i++) {
    scaledImg[i] = img[i] * sclSlope + sclInter
  }

  if (fLow === 0.0 && fHigh === 1.0) return [srcMin, 1.0]

  let nz = 0
  for (let i = 0; i < voxnum; i++) {
    if (Math.abs(scaledImg[i]) >= 1e-15) nz++
  }

  const histosize = 1000
  const binSize = (srcMax - srcMin) / histosize
  const hist = new Array(histosize).fill(0)
  for (let i = 0; i < voxnum; i++) {
    let bin = Math.floor((scaledImg[i] - srcMin) / binSize)
    bin = Math.min(bin, histosize - 1)
    hist[bin]++
  }

  const cs = new Array(histosize).fill(0)
  cs[0] = hist[0]
  for (let i = 1; i < histosize; i++) cs[i] = cs[i - 1] + hist[i]

  let nth = Math.floor(fLow * voxnum)
  let idx = 0
  while (idx < histosize) {
    if (cs[idx] >= nth) break
    idx++
  }
  const globalMinOrig = srcMin
  srcMin = idx * binSize + globalMinOrig

  nth = voxnum - Math.floor((1.0 - fHigh) * nz)
  idx = 0
  while (idx < histosize - 1) {
    if (cs[idx + 1] >= nth) break
    idx++
  }
  srcMax = idx * binSize + globalMinOrig

  let scale = 1
  if (srcMin !== srcMax) scale = (dstMax - dstMin) / (srcMax - srcMin)
  return [srcMin, scale]
}

// ============================================================================
// Main conform computation
// ============================================================================

export function computeConform(input: ConformInput): ConformOutput {
  const {
    datatypeCode,
    dims,
    pixDims: _pixDims,
    affine,
    sclSlope,
    sclInter,
    toRAS = false,
    isLinear = true,
    asFloat32 = false,
    isRobustMinMax = false,
  } = input

  const inImg = toTypedView(input.img, datatypeCode)
  const outDim = 256
  const outMM = 1

  const [outAffine, , invVox2Vox] = conformVox2Vox(
    dims,
    affine,
    outDim,
    outMM,
    toRAS,
  )

  const outNvox = outDim * outDim * outDim
  const outImg = new Float32Array(outNvox)

  const inNvox = dims[1] * dims[2] * dims[3]
  const inFloat = new Float32Array(inNvox)
  for (let i = 0; i < inNvox; i++) {
    inFloat[i] = (inImg[i] as number) * sclSlope + sclInter
  }

  let globalMin = Infinity
  let globalMax = -Infinity
  for (let i = 0; i < inNvox; i++) {
    const v = inFloat[i]
    if (v < globalMin) globalMin = v
    if (v > globalMax) globalMax = v
  }

  const dimX = dims[1]
  const dimY = dims[2]
  const dimZ = dims[3]
  const dimXY = dimX * dimY

  function voxidx(vx: number, vy: number, vz: number): number {
    return vx + vy * dimX + vz * dimXY
  }

  const m = invVox2Vox
  let i = -1

  if (isLinear) {
    for (let z = 0; z < outDim; z++) {
      for (let y = 0; y < outDim; y++) {
        const ixYZ = y * m[1] + z * m[2] + m[3]
        const iyYZ = y * m[5] + z * m[6] + m[7]
        const izYZ = y * m[9] + z * m[10] + m[11]
        for (let x = 0; x < outDim; x++) {
          const ix = x * m[0] + ixYZ
          const iy = x * m[4] + iyYZ
          const iz = x * m[8] + izYZ
          const fx = Math.floor(ix)
          const fy = Math.floor(iy)
          const fz = Math.floor(iz)
          i++
          if (fx < 0 || fy < 0 || fz < 0) continue
          const cx = Math.ceil(ix)
          const cy = Math.ceil(iy)
          const cz = Math.ceil(iz)
          if (cx >= dimX || cy >= dimY || cz >= dimZ) continue
          const rcx = ix - fx
          const rcy = iy - fy
          const rcz = iz - fz
          const rfx = 1 - rcx
          const rfy = 1 - rcy
          const rfz = 1 - rcz
          const fff = voxidx(fx, fy, fz)
          let vx = 0
          vx += inFloat[fff] * rfx * rfy * rfz
          vx += inFloat[fff + dimXY] * rfx * rfy * rcz
          vx += inFloat[fff + dimX] * rfx * rcy * rfz
          vx += inFloat[fff + dimX + dimXY] * rfx * rcy * rcz
          vx += inFloat[fff + 1] * rcx * rfy * rfz
          vx += inFloat[fff + 1 + dimXY] * rcx * rfy * rcz
          vx += inFloat[fff + 1 + dimX] * rcx * rcy * rfz
          vx += inFloat[fff + 1 + dimX + dimXY] * rcx * rcy * rcz
          outImg[i] = vx
        }
      }
    }
  } else {
    for (let z = 0; z < outDim; z++) {
      for (let y = 0; y < outDim; y++) {
        const ixYZ = y * m[1] + z * m[2] + m[3]
        const iyYZ = y * m[5] + z * m[6] + m[7]
        const izYZ = y * m[9] + z * m[10] + m[11]
        for (let x = 0; x < outDim; x++) {
          const ix = Math.round(x * m[0] + ixYZ)
          const iy = Math.round(x * m[4] + iyYZ)
          const iz = Math.round(x * m[8] + izYZ)
          i++
          if (ix < 0 || iy < 0 || iz < 0) continue
          if (ix >= dimX || iy >= dimY || iz >= dimZ) continue
          outImg[i] = inFloat[voxidx(ix, iy, iz)]
        }
      }
    }
  }

  // Intensity rescaling
  const fLow = isRobustMinMax ? NaN : 0
  let finalImg: ArrayBufferView
  let outDatatypeCode: number
  let bitsPerVoxel: number

  if (asFloat32) {
    const [srcMin, scale] = getScale(
      datatypeCode,
      inImg,
      sclSlope,
      sclInter,
      0,
      0,
      globalMin,
      globalMax,
      0,
      1,
      fLow,
    )
    finalImg = scalecropFloat32(outImg, 0, 1, srcMin, scale)
    outDatatypeCode = 16 // DT_FLOAT32
    bitsPerVoxel = 32
  } else {
    const [srcMin, scale] = getScale(
      datatypeCode,
      inImg,
      sclSlope,
      sclInter,
      0,
      0,
      globalMin,
      globalMax,
      0,
      255,
      fLow,
    )
    finalImg = scalecropUint8(outImg, 0, 255, srcMin, scale)
    outDatatypeCode = 2 // DT_UINT8
    bitsPerVoxel = 8
  }

  // Flatten output affine to array
  const outAffineFlat = Array.from(outAffine as Float32Array)

  return {
    img: finalImg,
    dims: [3, outDim, outDim, outDim, 1, 1, 1, 1],
    pixDims: [1, outMM, outMM, outMM, 1, 0, 0, 0],
    affine: outAffineFlat,
    datatypeCode: outDatatypeCode,
    bitsPerVoxel,
    sclSlope: 1,
    sclInter: 0,
    calMin: 0,
    calMax: 0,
  }
}
