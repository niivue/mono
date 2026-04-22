import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { projectMMToCanvas } from './sliceUtils'

describe('projectMMToCanvas', () => {
  test('identityMVP_projectsToCenter', () => {
    // Identity MVP: mm (0,0,0) → NDC (0,0,0) → center of tile
    const mvp = mat4.create() // identity
    const ltwh = [0, 0, 100, 100] // tile at origin, 100x100
    const [cx, cy] = projectMMToCanvas([0, 0, 0], mvp, ltwh)
    // NDC (0,0) → canvas (0 + (0+1)*0.5*100, 0 + (1-0)*0.5*100) = (50, 50)
    expect(cx).toBeCloseTo(50, 5)
    expect(cy).toBeCloseTo(50, 5)
  })

  test('offCenter_projectsCorrectly', () => {
    // Identity MVP: mm (1,1,0) → NDC (1,1,0)
    const mvp = mat4.create()
    const ltwh = [0, 0, 200, 200]
    const [cx, cy] = projectMMToCanvas([1, 1, 0], mvp, ltwh)
    // NDC x=1 → canvas: 0 + (1+1)*0.5*200 = 200
    // NDC y=1 → canvas: 0 + (1-1)*0.5*200 = 0
    expect(cx).toBeCloseTo(200, 5)
    expect(cy).toBeCloseTo(0, 5)
  })
})
