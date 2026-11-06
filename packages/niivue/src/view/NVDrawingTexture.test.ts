import { describe, expect, test } from 'bun:test'
import { chunkVolume } from '@/volume/chunking'
import { drawingChunkUploads } from './NVDrawingTexture'

// 4x2x2 RGBA drawing split into two 2x2x2 chunks along x.
const dims = [4, 2, 2]
const plan = chunkVolume([4, 2, 2], 2, [0, 0, 0])
const rgba = Uint8Array.from({ length: 4 * 2 * 2 * 4 }, (_, i) => i)

function uploads(reuse: boolean, dirty?: number[]) {
  return Array.from(
    drawingChunkUploads(rgba, dims, plan, reuse, dirty),
    ([i, bytes, texDims]) => ({ i, first: bytes[0], texDims }),
  )
}

describe('drawingChunkUploads', () => {
  test('uploads every chunk when textures are new', () => {
    expect(uploads(false, [1])).toEqual([
      { i: 0, first: 0, texDims: [2, 2, 2] },
      { i: 1, first: 8, texDims: [2, 2, 2] },
    ])
  })

  test('re-uploads only dirty chunks when reusing textures', () => {
    expect(uploads(true, [1]).map((u) => u.i)).toEqual([1])
    expect(uploads(true).map((u) => u.i)).toEqual([0, 1])
  })
})
