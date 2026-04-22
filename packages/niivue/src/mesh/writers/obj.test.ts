import { describe, expect, test } from 'bun:test'
import { write } from './obj'

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const indices = new Uint32Array([0, 1, 2])

describe('OBJ writer', () => {
  test('singleTriangle_producesValidOBJText', async () => {
    const buf = await write(positions, indices)
    const text = new TextDecoder().decode(buf)
    expect(text).toContain('v 0 0 0')
    expect(text).toContain('v 1 0 0')
    expect(text).toContain('v 0 1 0')
    expect(text).toContain('f ')
  })

  test('indicesAre1Based', async () => {
    const buf = await write(positions, indices)
    const text = new TextDecoder().decode(buf)
    // OBJ uses 1-based indexing: face should be "f 1 2 3"
    expect(text).toContain('f 1 2 3')
  })
})
