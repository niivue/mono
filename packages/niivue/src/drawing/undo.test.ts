import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { encodeRLE } from './rle'
import { drawUndo, setDrawingBitmap } from './undo'

describe('drawUndo', () => {
  test('emptyBitmaps_returnsUndefined', () => {
    const result = drawUndo({
      drawUndoBitmaps: [],
      currentDrawUndoBitmap: 0,
      drawBitmap: new Uint8Array(10),
    })
    expect(result).toBeUndefined()
  })

  test('restoresPreviousState', () => {
    const original = new Uint8Array([1, 2, 3, 4])
    const encoded = encodeRLE(original)
    const result = drawUndo({
      drawUndoBitmaps: [encoded],
      currentDrawUndoBitmap: 0,
      drawBitmap: new Uint8Array(4),
    })
    expect(result).toBeDefined()
    expect(result?.drawBitmap).toEqual(original)
  })

  test('wrapsAroundWhenIndexNegative', () => {
    const state0 = encodeRLE(new Uint8Array([10, 20, 30]))
    const state1 = encodeRLE(new Uint8Array([40, 50, 60]))
    const result = drawUndo({
      drawUndoBitmaps: [state0, state1],
      currentDrawUndoBitmap: -1, // negative → wraps to last
      drawBitmap: new Uint8Array(3),
    })
    expect(result).toBeDefined()
    // -1 wraps to len-1 = 1
    expect(result?.drawBitmap).toEqual(new Uint8Array([40, 50, 60]))
  })

  test('shortBitmap_returnsUndefined', () => {
    // An entry with length < 2 is treated as corrupt
    const result = drawUndo({
      drawUndoBitmaps: [new Uint8Array([0])],
      currentDrawUndoBitmap: 0,
      drawBitmap: new Uint8Array(10),
    })
    expect(result).toBeUndefined()
  })

  test('decrementsBitmapIndex', () => {
    const state = encodeRLE(new Uint8Array([1, 2, 3]))
    const result = drawUndo({
      drawUndoBitmaps: [state, state],
      currentDrawUndoBitmap: 1,
      drawBitmap: new Uint8Array(3),
    })
    expect(result).toBeDefined()
    expect(result?.currentDrawUndoBitmap).toBe(0)
  })
})

// Undo and the fill-overwrite merge install a bitmap through this. It must
// write into the drawing's existing array: an extension that swapped that
// array for a SharedArrayBuffer view (MagicWandShared's zero-copy preview)
// would otherwise be left writing into an array nothing displays.
describe('setDrawingBitmap', () => {
  test('writes into the existing array when the sizes match, keeping its identity', () => {
    const img = new Uint8Array([1, 2, 3, 4])
    const vol = { img } as unknown as NVImage
    setDrawingBitmap(vol, new Uint8Array([9, 8, 7, 6]))
    expect(vol.img).toBe(img)
    expect(Array.from(img)).toEqual([9, 8, 7, 6])
  })

  test('replaces the array when the sizes differ', () => {
    const img = new Uint8Array([1, 2, 3, 4])
    const vol = { img } as unknown as NVImage
    const next = new Uint8Array([5, 5])
    setDrawingBitmap(vol, next)
    expect(vol.img).toBe(next)
  })

  test('installs the bitmap when the drawing has none yet', () => {
    const vol = {} as unknown as NVImage
    const next = new Uint8Array([1])
    setDrawingBitmap(vol, next)
    expect(vol.img).toBe(next)
  })
})
