import { describe, expect, test } from 'bun:test'
import type { Vec3i } from '@/volume/chunking'
import {
  chunkRGBA,
  extractChunkBytes,
  extractChunkBytesReoriented,
  isRGBAChunkDatatype,
} from './orientChunked'

// Build a row-major source buffer where each voxel's value is a deterministic
// function of (x, y, z): byteValue = (z * 100 + y * 10 + x) & 0xff.
function makeSource(
  dims: Vec3i,
  bpv: number,
  fill: (x: number, y: number, z: number, byte: number) => number,
): Uint8Array {
  const [dx, dy, dz] = dims
  const buf = new Uint8Array(dx * dy * dz * bpv)
  for (let z = 0; z < dz; z++) {
    for (let y = 0; y < dy; y++) {
      for (let x = 0; x < dx; x++) {
        const base = ((z * dy + y) * dx + x) * bpv
        for (let b = 0; b < bpv; b++) {
          buf[base + b] = fill(x, y, z, b) & 0xff
        }
      }
    }
  }
  return buf
}

describe('extractChunkBytes', () => {
  test('full-volume extraction (texOrigin=0, texDims=volumeDims) is a pass-through', () => {
    const dims: Vec3i = [4, 3, 2]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    const out = extractChunkBytes(src, dims, 1, [0, 0, 0], dims)
    expect(out.length).toBe(src.length)
    expect(Array.from(out)).toEqual(Array.from(src))
  })

  test('single-voxel extraction picks the right CPU byte', () => {
    const dims: Vec3i = [5, 4, 3]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    // Voxel (2, 1, 2) — expected value = 2*100 + 1*10 + 2 = 212 → 212 & 0xff
    const out = extractChunkBytes(src, dims, 1, [2, 1, 2], [1, 1, 1])
    expect(out.length).toBe(1)
    expect(out[0]).toBe(212 & 0xff)
  })

  test('multi-voxel extraction preserves row-major ordering', () => {
    const dims: Vec3i = [4, 4, 4]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    // Extract a 2x2x2 chunk starting at (1,1,1)
    const out = extractChunkBytes(src, dims, 1, [1, 1, 1], [2, 2, 2])
    expect(out.length).toBe(8)
    // Expected voxels in row-major order: (1,1,1) (2,1,1) (1,2,1) (2,2,1)
    //                                     (1,1,2) (2,1,2) (1,2,2) (2,2,2)
    const expected = [
      1 * 100 + 1 * 10 + 1,
      1 * 100 + 1 * 10 + 2,
      1 * 100 + 2 * 10 + 1,
      1 * 100 + 2 * 10 + 2,
      2 * 100 + 1 * 10 + 1,
      2 * 100 + 1 * 10 + 2,
      2 * 100 + 2 * 10 + 1,
      2 * 100 + 2 * 10 + 2,
    ].map((v) => v & 0xff)
    expect(Array.from(out)).toEqual(expected)
  })

  test('edge chunk at the high corner (no halo overflow)', () => {
    const dims: Vec3i = [4, 4, 4]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    // texOrigin (2,2,2), texDims (2,2,2) — exactly reaches the volume boundary
    const out = extractChunkBytes(src, dims, 1, [2, 2, 2], [2, 2, 2])
    expect(out.length).toBe(8)
    expect(out[0]).toBe((2 * 100 + 2 * 10 + 2) & 0xff)
    expect(out[7]).toBe((3 * 100 + 3 * 10 + 3) & 0xff)
  })

  test('asymmetric texOrigin and texDims (different per axis)', () => {
    const dims: Vec3i = [8, 6, 4]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    const out = extractChunkBytes(src, dims, 1, [3, 2, 1], [4, 3, 2])
    expect(out.length).toBe(4 * 3 * 2)
    // Spot-check corner voxels
    expect(out[0]).toBe((1 * 100 + 2 * 10 + 3) & 0xff) // (3,2,1)
    expect(out[3]).toBe((1 * 100 + 2 * 10 + 6) & 0xff) // (6,2,1)
    expect(out[out.length - 1]).toBe((2 * 100 + 4 * 10 + 6) & 0xff) // (6,4,2)
  })

  test('bytesPerVoxel=2 copies both bytes per voxel correctly', () => {
    const dims: Vec3i = [3, 2, 2]
    // Pack a uint16 little-endian value = z*100 + y*10 + x at each voxel.
    const src = makeSource(dims, 2, (x, y, z, b) => {
      const v = z * 100 + y * 10 + x
      return b === 0 ? v & 0xff : (v >> 8) & 0xff
    })
    const out = extractChunkBytes(src, dims, 2, [1, 0, 0], [2, 2, 2])
    expect(out.length).toBe(2 * 2 * 2 * 2)
    // First voxel = (1,0,0) → uint16 LE = 1 = [0x01, 0x00]
    expect(out[0]).toBe(0x01)
    expect(out[1]).toBe(0x00)
    // Voxel (2,1,1) → uint16 LE = 112 = [0x70, 0x00]
    // Position in chunk: row-major index 7 → byte offset 14
    expect(out[14]).toBe(112 & 0xff)
    expect(out[15]).toBe((112 >> 8) & 0xff)
  })

  test('bytesPerVoxel=4 copies all four bytes per voxel correctly', () => {
    const dims: Vec3i = [2, 2, 2]
    const src = makeSource(dims, 4, (_x, _y, _z, b) => b + 1) // [1,2,3,4] per voxel
    const out = extractChunkBytes(src, dims, 4, [0, 0, 0], [2, 2, 2])
    for (let i = 0; i < 8; i++) {
      expect(out[i * 4]).toBe(1)
      expect(out[i * 4 + 1]).toBe(2)
      expect(out[i * 4 + 2]).toBe(3)
      expect(out[i * 4 + 3]).toBe(4)
    }
  })

  test('thin-slab chunk (texDims has a 1)', () => {
    const dims: Vec3i = [4, 4, 4]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    const out = extractChunkBytes(src, dims, 1, [0, 0, 2], [4, 4, 1])
    expect(out.length).toBe(16)
    // All voxels in this slab have z=2 → byte = 200 + y*10 + x
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(out[y * 4 + x]).toBe((200 + y * 10 + x) & 0xff)
      }
    }
  })
})

describe('extractChunkBytesReoriented', () => {
  // Decode the native (nx,ny,nz) of a linear native index, then reproduce the
  // makeSource fill: value = nz*100 + ny*10 + nx.
  function nativeValueAt(nativeIdx: number, nativeDims: Vec3i): number {
    const [ndx, ndy] = nativeDims
    const nx = nativeIdx % ndx
    const ny = Math.floor(nativeIdx / ndx) % ndy
    const nz = Math.floor(nativeIdx / (ndx * ndy))
    return (nz * 100 + ny * 10 + nx) & 0xff
  }

  function expectedRASValue(
    x: number,
    y: number,
    z: number,
    start: number[],
    step: number[],
    nativeDims: Vec3i,
  ): number {
    const nativeIdx =
      start[0] + start[1] + start[2] + x * step[0] + y * step[1] + z * step[2]
    return nativeValueAt(nativeIdx, nativeDims)
  }

  test('identity mapping matches extractChunkBytes', () => {
    const dims: Vec3i = [5, 4, 3]
    const src = makeSource(dims, 1, (x, y, z) => z * 100 + y * 10 + x)
    const start = [0, 0, 0]
    const step = [1, dims[0], dims[0] * dims[1]]
    const plain = extractChunkBytes(src, dims, 1, [1, 1, 0], [3, 2, 3])
    const reor = extractChunkBytesReoriented(
      src,
      1,
      [1, 1, 0],
      [3, 2, 3],
      start,
      step,
    )
    expect(Array.from(reor)).toEqual(Array.from(plain))
  })

  test('x-axis flip (negative step, nonzero start)', () => {
    const nativeDims: Vec3i = [4, 3, 2]
    const src = makeSource(nativeDims, 1, (x, y, z) => z * 100 + y * 10 + x)
    // RAS x = 0 maps to native x = 3; step[0] = -1, start[0] = 3.
    const start = [3, 0, 0]
    const step = [-1, nativeDims[0], nativeDims[0] * nativeDims[1]]
    const rasDims: Vec3i = [4, 3, 2]
    const out = extractChunkBytesReoriented(
      src,
      1,
      [0, 0, 0],
      rasDims,
      start,
      step,
    )
    expect(out.length).toBe(4 * 3 * 2)
    for (let z = 0; z < rasDims[2]; z++) {
      for (let y = 0; y < rasDims[1]; y++) {
        for (let x = 0; x < rasDims[0]; x++) {
          const idx = (z * rasDims[1] + y) * rasDims[0] + x
          expect(out[idx]).toBe(
            expectedRASValue(x, y, z, start, step, nativeDims),
          )
        }
      }
    }
  })

  test('x<->y axis swap with offset chunk', () => {
    const nativeDims: Vec3i = [4, 3, 2]
    const src = makeSource(nativeDims, 1, (x, y, z) => z * 100 + y * 10 + x)
    // RAS x indexes native y, RAS y indexes native x → RAS dims [3,4,2].
    const start = [0, 0, 0]
    const step = [nativeDims[0], 1, nativeDims[0] * nativeDims[1]]
    const texOrigin: Vec3i = [1, 1, 0]
    const texDims: Vec3i = [2, 3, 2]
    const out = extractChunkBytesReoriented(
      src,
      1,
      texOrigin,
      texDims,
      start,
      step,
    )
    expect(out.length).toBe(2 * 3 * 2)
    for (let z = 0; z < texDims[2]; z++) {
      for (let y = 0; y < texDims[1]; y++) {
        for (let x = 0; x < texDims[0]; x++) {
          const idx = (z * texDims[1] + y) * texDims[0] + x
          expect(out[idx]).toBe(
            expectedRASValue(
              texOrigin[0] + x,
              texOrigin[1] + y,
              texOrigin[2] + z,
              start,
              step,
              nativeDims,
            ),
          )
        }
      }
    }
  })

  test('bytesPerVoxel=2 reorients both bytes per voxel', () => {
    const nativeDims: Vec3i = [3, 2, 2]
    // uint16 LE value = z*100 + y*10 + x at each native voxel.
    const src = makeSource(nativeDims, 2, (x, y, z, b) => {
      const v = z * 100 + y * 10 + x
      return b === 0 ? v & 0xff : (v >> 8) & 0xff
    })
    // z-axis flip: RAS z=0 maps to native z=1. start[2] is the linear offset
    // of the last z-slice = (ndz-1) * ndx * ndy.
    const sliceStride = nativeDims[0] * nativeDims[1]
    const start = [0, 0, (nativeDims[2] - 1) * sliceStride]
    const step = [1, nativeDims[0], -sliceStride]
    const rasDims: Vec3i = [3, 2, 2]
    const out = extractChunkBytesReoriented(
      src,
      2,
      [0, 0, 0],
      rasDims,
      start,
      step,
    )
    expect(out.length).toBe(3 * 2 * 2 * 2)
    // RAS (0,0,0) → native (0,0,1) → value 100 = [0x64, 0x00]
    expect(out[0]).toBe(100 & 0xff)
    expect(out[1]).toBe((100 >> 8) & 0xff)
    // RAS (2,1,1) → native (2,1,0) → value 12 = [0x0c, 0x00]
    const idx = ((1 * rasDims[1] + 1) * rasDims[0] + 2) * 2
    expect(out[idx]).toBe(12 & 0xff)
    expect(out[idx + 1]).toBe((12 >> 8) & 0xff)
  })
})

describe('chunkRGBA (color chunk → RGBA8)', () => {
  test('isRGBAChunkDatatype flags 128 and 2304 only', () => {
    expect(isRGBAChunkDatatype(128)).toBe(true)
    expect(isRGBAChunkDatatype(2304)).toBe(true)
    expect(isRGBAChunkDatatype(2)).toBe(false)
    expect(isRGBAChunkDatatype(16)).toBe(false)
  })

  test('RGB24 expands 3→4 bytes with opaque alpha', () => {
    // two voxels: (10,20,30) and (40,50,60)
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60])
    const out = chunkRGBA(rgb, 128)
    expect(Array.from(out)).toEqual([10, 20, 30, 255, 40, 50, 60, 255])
  })

  test('RGB24 expansion preserves a full chunk extracted at bpv=3', () => {
    // 2x2x1 RGB source; extract the whole thing then expand
    const dims: Vec3i = [2, 2, 1]
    const src = makeSource(dims, 3, (x, y, _z, b) => x * 50 + y * 20 + b)
    const chunk = extractChunkBytes(src, dims, 3, [0, 0, 0], dims)
    const rgba = chunkRGBA(chunk, 128)
    expect(rgba.length).toBe(2 * 2 * 1 * 4)
    // voxel (1,1): src value x*50+y*20+b = 50+20+b
    const v11 = (1 * 2 + 1) * 4
    expect(rgba[v11]).toBe(70)
    expect(rgba[v11 + 1]).toBe(71)
    expect(rgba[v11 + 2]).toBe(72)
    expect(rgba[v11 + 3]).toBe(255)
  })

  test('RGBA32 passes through unchanged', () => {
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const out = chunkRGBA(rgba, 2304)
    expect(out).toBe(rgba) // same reference, already RGBA8
  })

  test('throws for a non-color datatype', () => {
    expect(() => chunkRGBA(new Uint8Array(4), 16)).toThrow()
  })
})
