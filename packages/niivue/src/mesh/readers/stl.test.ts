import { describe, expect, test } from 'bun:test'
import { read } from './stl'
import { write } from '../writers/stl'

describe('STL reader', () => {
  test('binarySTL_parsesTriangles', async () => {
    // Create a valid binary STL via the writer, then read it back
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const indices = new Uint32Array([0, 1, 2])
    const buf = await write(positions, indices)
    const result = await read(buf)
    expect(result.positions).toBeDefined()
    // Binary STL produces 9 position values (3 vertices * 3 coords)
    expect(result.positions!.length).toBe(9)
    expect(result.indices).toBeDefined()
    expect(result.indices!.length).toBe(3)
    // Verify roundtrip positions
    expect(result.positions![0]).toBeCloseTo(0, 5)
    expect(result.positions![3]).toBeCloseTo(1, 5)
    expect(result.positions![7]).toBeCloseTo(1, 5) // v2.y
  })

  test('asciiSTL_parsesVertices', async () => {
    const ascii = `solid test
  facet normal 0 0 0
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid test`
    const buf = new TextEncoder().encode(ascii).buffer
    const result = await read(buf)
    expect(result.positions).toBeDefined()
    expect(result.positions!.length).toBe(9)
    expect(result.positions![3]).toBe(1) // second vertex x
  })

  test('tooSmallBuffer_throws', async () => {
    const tiny = new ArrayBuffer(10)
    expect(read(tiny)).rejects.toThrow()
  })
})
