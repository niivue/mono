import { describe, expect, test } from 'bun:test'
import { decodeRLE, encodeRLE } from './rle'

describe('encodeRLE', () => {
  test('emptyInput_returnsEmptyArray', () => {
    const result = encodeRLE(new Uint8Array(0))
    expect(result.length).toBe(0)
  })

  test('singleByte_encodesCorrectly', () => {
    const input = new Uint8Array([42])
    const encoded = encodeRLE(input)
    const decoded = decodeRLE(encoded, 1)
    expect(decoded).toEqual(input)
  })

  test('allSameBytes_compressesAsRun', () => {
    const input = new Uint8Array(64).fill(7)
    const encoded = encodeRLE(input)
    // A run of 64 identical bytes should compress to 2 bytes: header + value
    expect(encoded.length).toBe(2)
    const decoded = decodeRLE(encoded, 64)
    expect(decoded).toEqual(input)
  })

  test('allDifferentBytes_encodesAsLiterals', () => {
    const input = new Uint8Array(10)
    for (let i = 0; i < 10; i++) input[i] = i * 25
    const encoded = encodeRLE(input)
    // Literals: 1 header byte + N data bytes
    expect(encoded.length).toBeGreaterThanOrEqual(input.length)
    const decoded = decodeRLE(encoded, input.length)
    expect(decoded).toEqual(input)
  })

  test('longRun_splitsAt129', () => {
    // PackBits max run length is 129. A run of 200 identical bytes
    // should be split into a run of 129 + a run of 71.
    const input = new Uint8Array(200).fill(99)
    const encoded = encodeRLE(input)
    // Two runs: 2 bytes each = 4 bytes total
    expect(encoded.length).toBe(4)
    const decoded = decodeRLE(encoded, 200)
    expect(decoded).toEqual(input)
  })
})

describe('decodeRLE roundtrip', () => {
  test('matchesOriginal', () => {
    const input = new Uint8Array([0, 0, 0, 1, 1, 2, 3, 3, 3, 3, 0, 0])
    const encoded = encodeRLE(input)
    const decoded = decodeRLE(encoded, input.length)
    expect(decoded).toEqual(input)
  })

  test('randomData_matchesOriginal', () => {
    const input = new Uint8Array(512)
    for (let i = 0; i < input.length; i++) {
      input[i] = (i * 37 + 13) & 0xff
    }
    const encoded = encodeRLE(input)
    const decoded = decodeRLE(encoded, input.length)
    expect(decoded).toEqual(input)
  })

  test('drawingBitmap_matchesOriginal', () => {
    // Simulate a sparse drawing bitmap: mostly zeros with scattered labels
    const input = new Uint8Array(256 * 256)
    input[100] = 1
    input[200] = 2
    input[50000] = 3
    input[65000] = 1
    const encoded = encodeRLE(input)
    // Should compress very well
    expect(encoded.length).toBeLessThan(input.length / 10)
    const decoded = decodeRLE(encoded, input.length)
    expect(decoded).toEqual(input)
  })
})
