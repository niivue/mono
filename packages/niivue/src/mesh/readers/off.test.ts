import { describe, expect, test } from 'bun:test'
import { read } from './off'

function makeOFF(content: string): ArrayBuffer {
  return new TextEncoder().encode(content).buffer
}

describe('OFF reader', () => {
  test('validOFF_parsesPositionsAndIndices', async () => {
    const off = `OFF
3 1 0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
3 0 1 2
`
    const result = await read(makeOFF(off))
    expect(result.positions).toBeDefined()
    expect(result.positions!.length).toBe(9) // 3 vertices * 3 coords
    expect(result.indices).toBeDefined()
    expect(result.indices!.length).toBe(3) // 1 triangle * 3 indices
    // Verify values
    expect(result.positions![0]).toBe(0)
    expect(result.positions![3]).toBe(1)
    expect(result.indices![0]).toBe(0)
    expect(result.indices![1]).toBe(1)
    expect(result.indices![2]).toBe(2)
  })

  test('missingHeader_stillParses', async () => {
    // OFF without the "OFF" header line — parser should still try
    const off = `3 1 0
0.0 0.0 0.0
1.0 0.0 0.0
0.0 1.0 0.0
3 0 1 2
`
    const result = await read(makeOFF(off))
    // Parser starts reading from line after header check
    expect(result.positions).toBeDefined()
    expect(result.positions!.length).toBe(9)
  })
})
