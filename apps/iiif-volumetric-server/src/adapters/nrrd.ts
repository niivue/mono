// NRRD adapter. nrrd-js parses both detached header (.nhdr) and combined
// (.nrrd) forms and gives back a typed array.

import fs from 'node:fs/promises'
// @ts-expect-error nrrd-js ships no type declarations
import nrrd from 'nrrd-js'
import type { AdapterContext, ProbeMeta, VolumeAdapter } from './nifti.ts'
import type { Dtype, Shape3, Vec3, VoxelArray } from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

interface NrrdParsed {
  data: VoxelArray
  sizes?: number[]
  type?: Dtype
  spacings?: number[]
  spaceDirections?: number[][]
  encoding?: string
  endian?: string
  space?: string
}

export const nrrdAdapter: VolumeAdapter = {
  format: 'nrrd',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (isDirectory) return false
    return /\.(nrrd|nhdr)$/i.test(p)
  },

  async probe(filePath: string): Promise<ProbeMeta> {
    const parsed = await parse(filePath)
    return { ...summarize(parsed), affine: null }
  },

  async load(filePath: string): Promise<VolumeHandle> {
    const parsed = await parse(filePath)
    const summary = summarize(parsed)
    return new VolumeHandle({
      shape: summary.shape,
      spacing: summary.spacing,
      dtype: summary.dtype,
      data: parsed.data,
      metadata: {
        encoding: parsed.encoding,
        endian: parsed.endian,
        space: parsed.space,
      },
    })
  },
}

async function parse(filePath: string): Promise<NrrdParsed> {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer
  return (nrrd as { parse: (b: ArrayBuffer) => NrrdParsed }).parse(ab)
}

function summarize(parsed: NrrdParsed): {
  shape: Shape3
  dtype: Dtype
  spacing: Vec3
} {
  const sizes = parsed.sizes || [1, 1, 1]
  const shape: Shape3 = [sizes[0] || 1, sizes[1] || 1, sizes[2] || 1]
  let spacing: Vec3 = [1, 1, 1]
  if (parsed.spacings && parsed.spacings.length >= 3) {
    spacing = [
      parsed.spacings[0] || 1,
      parsed.spacings[1] || 1,
      parsed.spacings[2] || 1,
    ]
  } else if (
    parsed.spaceDirections &&
    parsed.spaceDirections.length >= 3 &&
    parsed.spaceDirections.every(Array.isArray)
  ) {
    const dirs = parsed.spaceDirections.slice(0, 3)
    spacing = [
      Math.hypot(...(dirs[0] ?? []).map(Number)) || 1,
      Math.hypot(...(dirs[1] ?? []).map(Number)) || 1,
      Math.hypot(...(dirs[2] ?? []).map(Number)) || 1,
    ]
  }
  return {
    shape,
    dtype: parsed.type || 'float32',
    spacing,
  }
}
