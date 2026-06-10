// IIIF Image API 3.0 helpers.

import type {
  Axis,
  SliceImage,
  VolumeHandle,
} from '../adapters/volumeHandle.ts'
import { rgbaToPng } from '../util/png.ts'

export const IMAGE_API_CONTEXT = 'http://iiif.io/api/image/3/context.json'
export const IMAGE_API_PROFILE = 'level1'
export const IMAGE_API_PROTOCOL = 'http://iiif.io/api/image'

export interface InfoJsonOpts {
  baseUrl: string
  volId: string
  axis: Axis
  sliceIndex: number
  width: number
  height: number
  level?: number
}

export interface ImageApiParams {
  region?: string
  size?: string
  rotation?: string
  quality?: string
  format?: string
}

export interface InfoJson {
  '@context': string
  id: string
  type: 'ImageService3'
  protocol: string
  profile: string
  width: number
  height: number
  sizes: Array<{ width: number; height: number }>
  tiles: Array<{ width: number; height: number; scaleFactors: number[] }>
  extraFormats: string[]
  extraQualities: string[]
  extraFeatures: string[]
}

export function infoJson(opts: InfoJsonOpts): InfoJson {
  const { baseUrl, volId, axis, sliceIndex, width, height, level = 0 } = opts
  const w = Math.round(width)
  const h = Math.round(height)
  const encodedId = encodeURIComponent(volId)
  const serviceId =
    level > 0
      ? `${baseUrl}/iiif/image/${encodedId}/level/${level}/${axis}/${sliceIndex}`
      : `${baseUrl}/iiif/image/${encodedId}/${axis}/${sliceIndex}`
  return {
    '@context': IMAGE_API_CONTEXT,
    id: serviceId,
    type: 'ImageService3',
    protocol: IMAGE_API_PROTOCOL,
    profile: IMAGE_API_PROFILE,
    width: w,
    height: h,
    sizes: pyramidSizes(w, h),
    tiles: [{ width: 512, height: 512, scaleFactors: scaleFactors(w, h, 512) }],
    extraFormats: ['png'],
    extraQualities: ['default', 'gray'],
    extraFeatures: [
      'regionByPx',
      'sizeByW',
      'sizeByH',
      'sizeByConfinedWh',
      'sizeByPct',
    ],
  }
}

function pyramidSizes(
  w: number,
  h: number,
): Array<{ width: number; height: number }> {
  const sizes: Array<{ width: number; height: number }> = []
  let curW = w
  let curH = h
  while (curW > 1 || curH > 1) {
    sizes.push({ width: curW, height: curH })
    if (curW <= 256 && curH <= 256) break
    curW = Math.max(1, Math.ceil(curW / 2))
    curH = Math.max(1, Math.ceil(curH / 2))
  }
  return sizes
}

function scaleFactors(w: number, h: number, tile: number): number[] {
  const factors = [1]
  let f = 2
  while (Math.ceil(w / f) > tile || Math.ceil(h / f) > tile) {
    factors.push(f)
    f *= 2
    if (f > 64) break
  }
  return factors
}

class BadRequest extends Error {
  status = 400
}

function badRequest(msg: string): BadRequest {
  return new BadRequest(msg)
}

export interface ImageResponse {
  buffer: Buffer
  contentType: string
}

export async function renderImageRequest(
  volume: VolumeHandle,
  axis: Axis,
  sliceIndex: number,
  params: ImageApiParams,
): Promise<ImageResponse> {
  const [physW, physH] = volume.physicalSliceDims(axis)
  const slice = volume.getSlice(axis, sliceIndex)

  const region = parseRegion(params.region, physW, physH)

  const voxRegion = {
    x: (region.x / physW) * slice.width,
    y: (region.y / physH) * slice.height,
    w: (region.w / physW) * slice.width,
    h: (region.h / physH) * slice.height,
  }

  const cropped = cropRgba(slice, voxRegion)

  const targetW = Math.round(region.w)
  const targetH = Math.round(region.h)

  const sized = applySize(cropped, params.size, targetW, targetH)
  const rotated = applyRotation(sized, params.rotation)
  const qualified = applyQuality(rotated, params.quality)
  return encode(qualified, params.format)
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

function parseRegion(region: string | undefined, w: number, h: number): Rect {
  if (!region || region === 'full') {
    return { x: 0, y: 0, w, h }
  }
  if (region === 'square') {
    const s = Math.min(w, h)
    return { x: (w - s) / 2, y: (h - s) / 2, w: s, h: s }
  }
  if (region.startsWith('pct:')) {
    const [px, py, pw, ph] = region
      .substring(4)
      .split(',')
      .map((n) => Number(n))
    return {
      x: ((px ?? 0) / 100) * w,
      y: ((py ?? 0) / 100) * h,
      w: ((pw ?? 0) / 100) * w,
      h: ((ph ?? 0) / 100) * h,
    }
  }
  const parts = region.split(',').map((n) => Number(n))
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    throw badRequest(`Invalid region: ${region}`)
  }
  const [x, y, rw, rh] = parts as [number, number, number, number]
  return { x, y, w: rw, h: rh }
}

function cropRgba(slice: SliceImage, voxRegion: Rect): SliceImage {
  const { x, y, w, h } = voxRegion

  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(slice.width, Math.ceil(x + w))
  const y1 = Math.min(slice.height, Math.ceil(y + h))

  const cw = x1 - x0
  const ch = y1 - y0

  if (cw <= 0 || ch <= 0) {
    throw badRequest('Region outside slice bounds')
  }

  const out = new Uint8Array(cw * ch * 4)
  for (let row = 0; row < ch; row++) {
    const srcOff = ((y0 + row) * slice.width + x0) * 4
    const dstOff = row * cw * 4
    out.set(slice.data.subarray(srcOff, srcOff + cw * 4), dstOff)
  }
  return { width: cw, height: ch, data: out }
}

function applySize(
  slice: SliceImage,
  size: string | undefined,
  naturalW: number,
  naturalH: number,
): SliceImage {
  if (!size || size === 'max' || size === 'full') {
    return resizeNearest(slice, naturalW, naturalH)
  }
  let targetW: number
  let targetH: number
  if (size.startsWith('pct:')) {
    const pct = Number(size.substring(4))
    targetW = Math.max(1, Math.round((naturalW * pct) / 100))
    targetH = Math.max(1, Math.round((naturalH * pct) / 100))
  } else if (size.startsWith('^')) {
    return applySize(slice, size.substring(1), naturalW, naturalH)
  } else if (size.includes(',')) {
    const [wStr, hStr] = size.split(',')
    if (wStr === '' && hStr) {
      targetH = Number(hStr)
      targetW = Math.round((naturalW * targetH) / naturalH)
    } else if (hStr === '' && wStr) {
      targetW = Number(wStr)
      targetH = Math.round((naturalH * targetW) / naturalW)
    } else {
      targetW = Number(wStr)
      targetH = Number(hStr)
    }
  } else {
    return resizeNearest(slice, naturalW, naturalH)
  }
  return resizeNearest(slice, targetW, targetH)
}

function resizeNearest(
  slice: SliceImage,
  targetW: number,
  targetH: number,
): SliceImage {
  if (targetW === slice.width && targetH === slice.height) return slice
  const out = new Uint8Array(targetW * targetH * 4)
  const sx = slice.width / targetW
  const sy = slice.height / targetH
  for (let y = 0; y < targetH; y++) {
    const ys = Math.min(slice.height - 1, Math.floor(y * sy))
    for (let x = 0; x < targetW; x++) {
      const xs = Math.min(slice.width - 1, Math.floor(x * sx))
      const srcOff = (ys * slice.width + xs) * 4
      const dstOff = (y * targetW + x) * 4
      out[dstOff] = slice.data[srcOff] as number
      out[dstOff + 1] = slice.data[srcOff + 1] as number
      out[dstOff + 2] = slice.data[srcOff + 2] as number
      out[dstOff + 3] = slice.data[srcOff + 3] as number
    }
  }
  return { width: targetW, height: targetH, data: out }
}

function applyRotation(
  slice: SliceImage,
  rotation: string | undefined,
): SliceImage {
  if (!rotation || rotation === '0') return slice
  const r = Number(rotation.replace(/^!/, ''))
  if (![0, 90, 180, 270].includes(r)) {
    throw badRequest(`Unsupported rotation: ${rotation}`)
  }
  if (r === 0) return slice
  const { width: w, height: h, data } = slice
  const isQuarter = r === 90 || r === 270
  const newW = isQuarter ? h : w
  const newH = isQuarter ? w : h
  const out = new Uint8Array(newW * newH * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number
      let ny: number
      if (r === 90) {
        nx = h - 1 - y
        ny = x
      } else if (r === 180) {
        nx = w - 1 - x
        ny = h - 1 - y
      } else {
        nx = y
        ny = w - 1 - x
      }
      const src = (y * w + x) * 4
      const dst = (ny * newW + nx) * 4
      out[dst] = data[src] as number
      out[dst + 1] = data[src + 1] as number
      out[dst + 2] = data[src + 2] as number
      out[dst + 3] = data[src + 3] as number
    }
  }
  return { width: newW, height: newH, data: out }
}

function applyQuality(
  slice: SliceImage,
  quality: string | undefined,
): SliceImage {
  if (!quality || quality === 'default' || quality === 'gray') {
    return slice
  }
  if (quality === 'color') return slice
  if (quality === 'bitonal') {
    const out = new Uint8Array(slice.data.length)
    for (let i = 0; i < slice.data.length; i += 4) {
      const v = (slice.data[i] as number) >= 128 ? 255 : 0
      out[i] = v
      out[i + 1] = v
      out[i + 2] = v
      out[i + 3] = 255
    }
    return { width: slice.width, height: slice.height, data: out }
  }
  return slice
}

function encode(slice: SliceImage, format: string | undefined): ImageResponse {
  if (format === 'png' || !format) {
    return {
      buffer: rgbaToPng(slice.width, slice.height, slice.data),
      contentType: 'image/png',
    }
  }
  throw badRequest(`Unsupported format: ${format}`)
}
