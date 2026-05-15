// DICOM-series adapter (proof-of-concept stub).

import fs from 'node:fs/promises'
import path from 'node:path'
import type { AdapterContext, ProbeMeta, VolumeAdapter } from './nifti.ts'
import type { Dtype, VoxelArray } from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

interface DicomDataSet {
  uint16(tag: string): number | undefined
  elements: Record<string, { dataOffset: number; length: number } | undefined>
}
interface DicomParser {
  parseDicom(buf: Uint8Array): DicomDataSet
}

export const dicomAdapter: VolumeAdapter = {
  format: 'dicom',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (!isDirectory) return false
    return /(_dicom|\.dicom|dicom_series)$/i.test(p)
  },

  async probe(dirPath: string): Promise<ProbeMeta> {
    const files = await dicomFilesIn(dirPath)
    if (files.length === 0) {
      throw new Error(`No .dcm files found in ${dirPath}`)
    }
    const dims = await tryReadFirstSliceDims()
    return {
      shape: [dims.width, dims.height, files.length],
      dtype: dims.dtype,
      spacing: [1, 1, 1],
      affine: null,
    }
  },

  async load(dirPath: string): Promise<VolumeHandle> {
    const files = await dicomFilesIn(dirPath)
    if (files.length === 0) {
      throw new Error(`No .dcm files found in ${dirPath}`)
    }

    const parser = await tryLoadDicomParser()
    if (parser) {
      return loadWithDicomParser(files, parser)
    }

    const dims = await tryReadFirstSliceDims()
    const sx = dims.width
    const sy = dims.height
    const sz = files.length
    const data = new Uint8Array(sx * sy * sz)
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          data[x + y * sx + z * sx * sy] = (x ^ y ^ z) & 0xff
        }
      }
    }
    return new VolumeHandle({
      shape: [sx, sy, sz],
      spacing: [1, 1, 1],
      dtype: 'uint8',
      data,
      metadata: {
        note: 'DICOM placeholder volume. Install dicom-parser for real pixel data.',
      },
    })
  },
}

async function dicomFilesIn(dirPath: string): Promise<string[]> {
  const items = await fs.readdir(dirPath)
  return items
    .filter((f) => /\.dcm$/i.test(f))
    .sort()
    .map((f) => path.join(dirPath, f))
}

async function tryReadFirstSliceDims(): Promise<{
  width: number
  height: number
  dtype: Dtype
}> {
  return { width: 256, height: 256, dtype: 'uint8' }
}

async function tryLoadDicomParser(): Promise<DicomParser | null> {
  try {
    const mod = (await import('dicom-parser' as string)) as {
      default?: DicomParser
    } & DicomParser
    return mod.default || mod
  } catch {
    return null
  }
}

async function loadWithDicomParser(
  files: string[],
  dicomParser: DicomParser,
): Promise<VolumeHandle> {
  const firstPath = files[0]
  if (!firstPath) throw new Error('No DICOM files supplied')
  const firstBuf = await fs.readFile(firstPath)
  const firstDataSet = dicomParser.parseDicom(firstBuf)
  const cols = firstDataSet.uint16('x00280011') ?? 0
  const rows = firstDataSet.uint16('x00280010') ?? 0
  const bitsAllocated = firstDataSet.uint16('x00280100') || 16
  const pixelRepresentation = firstDataSet.uint16('x00280103') || 0
  const sx = cols
  const sy = rows
  const sz = files.length

  let TypedArrayCtor:
    | Uint8ArrayConstructor
    | Int16ArrayConstructor
    | Uint16ArrayConstructor
  let dtype: Dtype
  if (bitsAllocated <= 8) {
    TypedArrayCtor = Uint8Array
    dtype = 'uint8'
  } else if (pixelRepresentation === 1) {
    TypedArrayCtor = Int16Array
    dtype = 'int16'
  } else {
    TypedArrayCtor = Uint16Array
    dtype = 'uint16'
  }

  const sliceVoxels = sx * sy
  const data = new TypedArrayCtor(sliceVoxels * sz) as VoxelArray

  for (let z = 0; z < sz; z++) {
    const filePath = files[z] as string
    const buf = z === 0 ? firstBuf : await fs.readFile(filePath)
    const ds = z === 0 ? firstDataSet : dicomParser.parseDicom(buf)
    const pixelDataElement = ds.elements.x7fe00010
    if (!pixelDataElement) continue
    const start = pixelDataElement.dataOffset
    const length = pixelDataElement.length
    const pixelView = new TypedArrayCtor(
      buf.buffer,
      buf.byteOffset + start,
      length / TypedArrayCtor.BYTES_PER_ELEMENT,
    )
    ;(data as { set: (a: ArrayLike<number>, off: number) => void }).set(
      pixelView,
      z * sliceVoxels,
    )
  }

  return new VolumeHandle({
    shape: [sx, sy, sz],
    spacing: [1, 1, 1],
    dtype,
    data,
  })
}
