import { describe, expect, test } from 'bun:test'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'
import * as ecat from './ecat'
import * as fib from './fib'
import * as mha from './mha'
import * as mif from './mif'
import * as npy from './npy'
import * as nrrd from './nrrd'
import * as src from './src'
import * as vmr from './vmr'

// Characterization of the headers built by readers that share header setup
// (issue #313). Fixtures are synthesized: dev-images has none of these formats.
// Dims are 4x3x2 so a swapped axis shows up in dims, pixDims or the affine.

const enc = new TextEncoder()

function concat(...parts: Uint8Array[]): ArrayBuffer {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out.buffer
}

const bytesOf = (a: ArrayBufferView): Uint8Array =>
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength)

// MAT v4 tag: mtype (tens digit = type), rows, cols, imagf, namlen, name, data.
function matTag(
  name: string,
  mtype: number,
  data: ArrayBufferView,
): Uint8Array {
  const nameBytes = enc.encode(`${name}\0`)
  const head = new Uint32Array([
    mtype,
    data.byteLength / bytesPer(mtype),
    1,
    0,
    nameBytes.length,
  ])
  return new Uint8Array(concat(bytesOf(head), nameBytes, bytesOf(data)))
}

function bytesPer(mtype: number): number {
  return [8, 4, 4, 2, 2, 1][Math.floor(mtype / 10) % 10]
}

function ramp(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

function summary(out: {
  hdr: NIFTI1 | NIFTI2
  img: ArrayBuffer | TypedVoxelArray
}): Record<string, unknown> {
  const { hdr, img } = out
  return {
    dims: hdr.dims,
    pixDims: hdr.pixDims,
    affine: hdr.affine,
    datatypeCode: hdr.datatypeCode,
    numBitsPerVoxel: hdr.numBitsPerVoxel,
    littleEndian: hdr.littleEndian,
    sform_code: hdr.sform_code,
    description: hdr.description,
    vox_offset: hdr.vox_offset,
    imgBytes: img.byteLength,
  }
}

type ReadResult = { hdr: NIFTI1 | NIFTI2; img: ArrayBuffer | TypedVoxelArray }

const fixtures: Record<string, () => Promise<ReadResult>> = {
  fib: async () => {
    const buf = concat(
      matTag('dimension', 20, new Int32Array([4, 3, 2])),
      matTag('voxel_size', 10, new Float32Array([1, 2, 3])),
      matTag('dti_fa', 10, new Float32Array(ramp(24))),
      matTag('report', 50, enc.encode('fib report')),
    )
    return await fib.read(buf)
  },
  src: async () => {
    const buf = concat(
      matTag('dimension', 20, new Int32Array([4, 3, 2])),
      matTag('voxel_size', 10, new Float32Array([1, 2, 3])),
      matTag('image0', 40, new Uint16Array(ramp(24))),
      matTag('image1', 40, new Uint16Array(ramp(24))),
      matTag('report', 50, enc.encode('src report')),
    )
    return await src.read(buf)
  },
  v16: async () => {
    const buf = concat(bytesOf(new Uint16Array([4, 3, 2, ...ramp(24)])))
    return vmr.read(buf, 'a.v16')
  },
  vmr: async () => {
    const n = 24
    const buf = new ArrayBuffer(8 + n + 92 + 14)
    const dv = new DataView(buf)
    ;[4, 4, 3, 2].forEach((v, i) => {
      dv.setUint16(i * 2, v, true)
    })
    dv.setUint32(8 + n + 88, 0, true)
    ;[1.5, 2, 3].forEach((v, i) => {
      dv.setFloat32(8 + n + 92 + 2 + i * 4, v, true)
    })
    return vmr.read(buf, 'a.vmr')
  },
  ecat: async () => {
    const buf = new ArrayBuffer(1536 + 48)
    const dv = new DataView(buf)
    dv.setInt32(0, 1296127058)
    dv.setInt16(50, 7)
    dv.setInt32(512, 31)
    dv.setInt32(532, 3) // first volume at block 3, subheader in block 2
    dv.setUint16(1024, 6)
    ;[4, 3, 2].forEach((v, i) => {
      dv.setUint16(1024 + 4 + i * 2, v)
    })
    dv.setFloat32(1024 + 26, 2)
    ;[0.125, 0.25, 0.5].forEach((v, i) => {
      dv.setFloat32(1024 + 34 + i * 4, v)
    })
    dv.setUint32(1024 + 46, 5000)
    for (let i = 0; i < 24; i++) dv.setUint16(1536 + i * 2, i)
    return ecat.read(buf)
  },
  npy: async () => {
    const text =
      "{'descr': '<i2', 'fortran_order': False, 'shape': (2, 3, 4), }"
    const head = enc.encode(text.padEnd(118, ' ') + '\n')
    const pre = new Uint8Array([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, 0, 0])
    new DataView(pre.buffer).setUint16(8, head.length, true)
    return await npy.read(concat(pre, head, bytesOf(new Int16Array(ramp(24)))))
  },
  mif: async () => {
    const text = [
      'mrtrix image',
      'dim: 4,3,2',
      'vox: 1,2,3',
      'layout: +0,+1,+2',
      'datatype: Int16LE',
      'transform: 1,0,0,-10',
      'transform: 0,1,0,-20',
      'transform: 0,0,1,-30',
      'comments: mif comment',
      'file: . 256',
      'END',
      '',
    ].join('\n')
    const head = new Uint8Array(256)
    head.set(enc.encode(text))
    return await mif.read(concat(head, bytesOf(new Int16Array(ramp(24)))))
  },
  nrrd: async () => {
    const text = [
      'NRRD0004',
      'type: short',
      'dimension: 3',
      'sizes: 4 3 2',
      'space: left-posterior-superior',
      'space directions: (1,0,0) (0,2,0) (0,0,3)',
      'space origin: (10,20,30)',
      'endian: little',
      'encoding: raw',
      '',
      '',
    ].join('\n')
    return await nrrd.read(
      concat(enc.encode(text), bytesOf(new Int16Array(ramp(24)))),
    )
  },
  mha: () => readMha(true),
}

// TransformMatrix is optional in MetaImage; omitted means axis-aligned.
async function readMha(withMatrix: boolean): Promise<ReadResult> {
  const text = [
    'ObjectType = Image',
    'NDims = 3',
    'DimSize = 4 3 2',
    'ElementType = MET_SHORT',
    ...(withMatrix ? ['TransformMatrix = 1 0 0 0 1 0 0 0 1'] : []),
    'Offset = 10 20 30',
    'ElementSpacing = 1 2 3',
    'ElementDataFile = LOCAL',
    '',
  ].join('\n')
  return await mha.read(
    concat(enc.encode(text), bytesOf(new Int16Array(ramp(24)))),
  )
}

const expected: Record<string, Record<string, unknown>> = {
  fib: {
    dims: [3, 4, 3, 2, 1, 0, 0, 0],
    pixDims: [1, 1, 2, 3, 1, 0, 0, 0],
    affine: [
      [1, 0, 0, -1.5],
      [0, -2, 0, 2],
      [0, 0, 3, -1.5],
      [0, 0, 0, 1],
    ],
    datatypeCode: 16,
    numBitsPerVoxel: 32,
    littleEndian: true,
    sform_code: 1,
    description: 'fib report',
    vox_offset: 0,
    imgBytes: 96,
  },
  src: {
    dims: [4, 4, 3, 2, 2, 0, 0, 0],
    pixDims: [1, 1, 2, 3, 1, 0, 0, 0],
    affine: [
      [1, 0, 0, -1.5],
      [0, -2, 0, 2],
      [0, 0, 3, -1.5],
      [0, 0, 0, 1],
    ],
    datatypeCode: 512,
    numBitsPerVoxel: 16,
    littleEndian: true,
    sform_code: 1,
    description: 'src report',
    vox_offset: 0,
    imgBytes: 96,
  },
  v16: {
    dims: [3, 4, 3, 2, 0, 0, 0, 0],
    pixDims: [1, 1, 1, 1, 1, 0, 0, 0],
    affine: [
      [0, 0, -1, 1],
      [-1, 0, 0, 0.5],
      [0, -1, 0, 0],
      [0, 0, 0, 1],
    ],
    datatypeCode: 512,
    numBitsPerVoxel: 16,
    littleEndian: true,
    sform_code: 0,
    description: '',
    vox_offset: 0,
    imgBytes: 48,
  },
  vmr: {
    dims: [3, 4, 3, 2, 0, 0, 0, 0],
    pixDims: [1, 1.5, 2, 3, 1, 0, 0, 0],
    affine: [
      [0, 0, -1.5, 1.5],
      [-2, 0, 0, 1],
      [0, -3, 0, 0],
      [0, 0, 0, 1],
    ],
    datatypeCode: 2,
    numBitsPerVoxel: 8,
    littleEndian: false,
    sform_code: 0,
    description: '',
    vox_offset: 0,
    imgBytes: 24,
  },
  ecat: {
    dims: [3, 4, 3, 2, 1, 0, 0, 0],
    pixDims: [1, 1.25, 2.5, 5, 5, 0, 0, 0],
    affine: [
      [-1.25, 0, 0, 1.25],
      [0, -2.5, 0, 1.25],
      [0, 0, -5, 0],
      [0, 0, 0, 1],
    ],
    datatypeCode: 16,
    numBitsPerVoxel: 32,
    littleEndian: false,
    sform_code: 1,
    description: '',
    vox_offset: 0,
    imgBytes: 96,
  },
  npy: {
    dims: [3, 4, 3, 2, 1, 1, 1, 1],
    pixDims: [1, 1, 1, 1, 1, 0, 0, 0],
    affine: [
      [1, 0, 0, -1],
      [0, -1, 0, 0.5],
      [0, 0, -1, 0],
      [0, 0, 0, 1],
    ],
    datatypeCode: 4,
    numBitsPerVoxel: 16,
    littleEndian: true,
    sform_code: 0,
    description: '',
    vox_offset: 0,
    imgBytes: 48,
  },
  mif: {
    dims: [3, 4, 3, 2, 1, 1, 1, 1],
    pixDims: [1, 1, 2, 3, 1, 0, 0, 0],
    affine: [
      [1, 0, 0, -10],
      [0, 2, 0, -20],
      [0, 0, 3, -30],
      [0, 0, 0, 1],
    ],
    datatypeCode: 4,
    numBitsPerVoxel: 16,
    littleEndian: true,
    sform_code: 0,
    description: 'mif comment',
    vox_offset: 256,
    imgBytes: 48,
  },
  nrrd: {
    dims: [3, 4, 3, 2, 0, 0, 0, 0],
    pixDims: [1, 1, 2, 3, 1, 0, 0, 0],
    affine: [
      [-1, 0, 0, -10],
      [0, -2, 0, -20],
      [0, 0, 3, 30],
      [0, 0, 0, 1],
    ],
    datatypeCode: 4,
    numBitsPerVoxel: 16,
    littleEndian: true,
    sform_code: 2,
    description: '',
    vox_offset: 175,
    imgBytes: 48,
  },
  mha: {
    dims: [3, 4, 3, 2, 1, 1, 1, 1],
    pixDims: [1, 1, 2, 3, 1, 0, 0, 0],
    affine: [
      [-1, -0, -0, -10],
      [-0, -2, -0, -20],
      [0, 0, 3, 30],
      [0, 0, 0, 1],
    ],
    datatypeCode: 4,
    numBitsPerVoxel: 16,
    littleEndian: true,
    sform_code: 0,
    description: '',
    vox_offset: 170,
    imgBytes: 48,
  },
}

describe('volume reader headers', () => {
  for (const [name, load] of Object.entries(fixtures)) {
    test(name, async () => {
      expect(summary(await load())).toEqual(expected[name])
    })
  }
  test('mha without TransformMatrix is axis-aligned', async () => {
    const { hdr } = await readMha(false)
    expect(hdr.affine).toEqual((await readMha(true)).hdr.affine)
  })
})
