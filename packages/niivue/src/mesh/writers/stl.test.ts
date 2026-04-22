import { describe, expect, test } from 'bun:test'
import { write } from './stl'

// A single triangle: vertices at (0,0,0), (1,0,0), (0,1,0)
const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const indices = new Uint32Array([0, 1, 2])

describe('STL writer', () => {
  test('singleTriangle_producesCorrectBinarySize', async () => {
    const buf = await write(positions, indices)
    // 80-byte header + 4-byte count + 50 bytes per triangle = 134
    expect(buf.byteLength).toBe(134)
  })

  test('vertexPositions_areReadableFromOutput', async () => {
    const buf = await write(positions, indices)
    const view = new DataView(buf)
    // Triangle count at offset 80
    expect(view.getUint32(80, true)).toBe(1)
    // Skip header(80) + count(4) + normal(12) = offset 96 for first vertex
    expect(view.getFloat32(96, true)).toBe(0) // v0.x
    expect(view.getFloat32(100, true)).toBe(0) // v0.y
    expect(view.getFloat32(104, true)).toBe(0) // v0.z
    // Second vertex at 108
    expect(view.getFloat32(108, true)).toBe(1) // v1.x
    expect(view.getFloat32(112, true)).toBe(0) // v1.y
    // Third vertex at 120
    expect(view.getFloat32(120, true)).toBe(0) // v2.x
    expect(view.getFloat32(124, true)).toBe(1) // v2.y
  })
})
