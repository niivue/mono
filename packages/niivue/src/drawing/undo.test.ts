import { describe, expect, test } from 'bun:test'
import { drawUndo } from './undo'
import { encodeRLE } from './rle'

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
    expect(result!.drawBitmap).toEqual(original)
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
    expect(result!.drawBitmap).toEqual(new Uint8Array([40, 50, 60]))
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
    expect(result!.currentDrawUndoBitmap).toBe(0)
  })
})
