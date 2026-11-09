import { describe, expect, test } from 'bun:test'
import { chunkVolume, chunkVolumeGrid, chunkVolumeMultiLOD } from './chunking'
import { chunkPlanMessage } from './chunkPlanMessage'

describe('chunkPlanMessage', () => {
  const base = {
    name: 'v',
    datatypeCode: 16,
    limitName: 'maxTextureDimension3D',
  }

  test('oversized: names the axes over the limit and the grid', () => {
    const plan = chunkVolume([300, 200, 100], 256, [3, 3, 3])
    const m = chunkPlanMessage({
      ...base,
      rasDims: [300, 200, 100],
      limit: 256,
      plan,
    })
    expect(m.level).toBe('warn')
    expect(m.text).toStartWith(
      'Volume "v" (300x200x100 float32) exceeds maxTextureDimension3D (256) on x: tiling it into a 2x1x1 grid = 2 bricks, ~',
    )
    const all = chunkPlanMessage({
      ...base,
      rasDims: [300, 300, 300],
      limit: 256,
      plan: chunkVolume([300, 300, 300], 256, [3, 3, 3]),
    })
    expect(all.text).toContain(
      'on x, y and z: tiling it into a 2x2x2 grid = 8 bricks',
    )
  })

  test('forced grid on a volume that fits: info, not a false "exceeds"', () => {
    const plan = chunkVolumeGrid([207, 256, 215], [3, 3, 3], 2048, [3, 3, 3])
    const m = chunkPlanMessage({
      ...base,
      datatypeCode: 2,
      rasDims: [207, 256, 215],
      limit: 2048,
      plan,
    })
    expect(m.level).toBe('info')
    expect(m.text).toStartWith(
      'Volume "v" (207x256x215 uint8) fits maxTextureDimension3D (2048), but was given a 3x3x3 grid = 27 bricks, ~',
    )
    expect(m.text).not.toContain('exceeds')
  })

  test('octree: bricks per level, coarsest first, not the placeholder 1x1x1 grid', () => {
    const plan = chunkVolume([512, 512, 512], 256, [3, 3, 3])
    plan.gridDims = [1, 1, 1] // as chunkVolumeMultiLOD stores it
    plan.levelDims = [
      [512, 512, 512],
      [256, 256, 256],
      [128, 128, 128],
    ]
    plan.chunks.forEach((c, i) => {
      c.sourceLevel = i < 5 ? 2 : i < 7 ? 1 : 0
    })
    const m = chunkPlanMessage({
      ...base,
      rasDims: [512, 512, 512],
      limit: 256,
      plan,
    })
    expect(m.level).toBe('warn')
    expect(m.text).toContain(
      'exceeds maxTextureDimension3D (256) on x, y and z: streaming it as a multi-resolution octree, 27 bricks in the plan (L2: 5, L1: 2, L0: 20), ~',
    )
    expect(m.text).toEndWith('; bricks may be re-chosen as the view moves.')
    expect(m.text).not.toContain('1x1x1')
  })

  test('real planner: a one-level octree is an octree, a pinned grid is a grid', () => {
    const focus = {
      center: [128, 128, 128] as [number, number, number],
      radius: 64,
    }
    const oneLevel = chunkVolumeMultiLOD([[256, 256, 256]], focus, 2048, {
      cellEdge: 128,
    })
    const m1 = chunkPlanMessage({
      ...base,
      rasDims: [256, 256, 256],
      limit: 2048,
      plan: oneLevel,
    })
    expect(m1.text).toContain(
      `but was given an adaptive octree, ${oneLevel.chunks.length} bricks in the plan, ~`,
    )
    expect(m1.text).not.toContain('1x1x1 grid')
    expect(m1.text).not.toContain('multi-resolution')
    expect(m1.text).not.toContain('L0')
    const pinned = chunkVolumeMultiLOD(
      [
        [256, 256, 256],
        [128, 128, 128],
      ],
      focus,
      2048,
      { gridDims: [2, 2, 2] },
    )
    const m2 = chunkPlanMessage({
      ...base,
      rasDims: [256, 256, 256],
      limit: 2048,
      plan: pinned,
    })
    expect(m2.text).toContain('but was given a 2x2x2 grid = 8 bricks')
    expect(m2.text).not.toContain('octree')
  })

  test('one brick is described neutrally: a budget-cut octree, a pinned grid at L1, a 1x1x1 grid', () => {
    const focus = {
      center: [128, 128, 128] as [number, number, number],
      radius: 64,
    }
    const cut = chunkVolumeMultiLOD(
      [
        [512, 512, 512],
        [256, 256, 256],
        [128, 128, 128],
      ],
      { center: [256, 256, 256], radius: 64 },
      256,
      { maxBricks: 1 },
    )
    expect(cut.chunks.length).toBe(1)
    const m = chunkPlanMessage({
      ...base,
      rasDims: [512, 512, 512],
      limit: 256,
      plan: cut,
    })
    expect(m.text).toContain(
      `on x, y and z: drawing it as 1 brick at L${cut.chunks[0]?.sourceLevel}, ~`,
    )
    const pinned = chunkVolumeMultiLOD(
      [
        [256, 256, 256],
        [128, 128, 128],
      ],
      focus,
      2048,
      { gridDims: [1, 1, 1], minLevel: 1 },
    )
    const p = chunkPlanMessage({
      ...base,
      rasDims: [256, 256, 256],
      limit: 2048,
      plan: pinned,
    })
    expect(p.text).toContain('but was given 1 brick at L1, ~')
    for (const text of [m.text, p.text]) {
      expect(text).not.toContain('octree')
      expect(text).not.toContain('grid')
    }
    const grid = chunkVolumeGrid([64, 64, 64], [1, 1, 1], 256, [3, 3, 3])
    const g = chunkPlanMessage({
      ...base,
      rasDims: [64, 64, 64],
      limit: 256,
      plan: grid,
    })
    expect(g.text).toContain('but was given 1 brick, ~')
  })

  test('an unknown datatype code is shown as a number', () => {
    const plan = chunkVolume([300, 10, 10], 256, [3, 3, 3])
    const m = chunkPlanMessage({
      ...base,
      datatypeCode: 9999,
      rasDims: [300, 10, 10],
      limit: 256,
      plan,
    })
    expect(m.text).toContain('(300x10x10 datatype 9999)')
  })
})
