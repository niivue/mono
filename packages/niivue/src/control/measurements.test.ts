import { describe, expect, mock, test } from 'bun:test'
import { mat4, vec3 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type NiiVue from '@/NVControlBase'
import type { CompletedMeasurement } from '@/NVTypes'
import type { SliceTile } from '@/view/NVSliceLayout'
import {
  addMeasurement,
  buildMeasurement,
  pickMeasurement,
  removeMeasurement,
} from './measurements'

// An axial tile with an identity MVP over a 100x100 px viewport: mm (x, y, 0)
// projects to canvas ((x + 1) * 50, (1 - y) * 50). planeNormal +z through the
// origin, so only measurements with z ~ 0 land on it (computeTolerance falls
// back to 0.5 mm with no volumes loaded).
function axialTile(): SliceTile {
  return {
    axCorSag: SLICE_TYPE.AXIAL,
    leftTopWidthHeight: [0, 0, 100, 100],
    mvpMatrix: mat4.create(),
    planeNormal: vec3.fromValues(0, 0, 1),
    planePoint: vec3.fromValues(0, 0, 0),
  }
}

function fakeCtrl(tiles: SliceTile[] = [axialTile()]) {
  const emit = mock((_type: string, _detail?: unknown) => {})
  const drawScene = mock(() => {})
  const completedMeasurements: CompletedMeasurement[] = []
  const ctrl = {
    model: {
      completedMeasurements,
      getVolumes: () => [],
      // Fake scene-fraction mapping: mm / 100 (extents -50..50 shifted).
      mm2scene: (mm: ArrayLike<number>) =>
        vec3.fromValues(mm[0] / 100, mm[1] / 100, mm[2] / 100),
    },
    view: { screenSlices: tiles },
    emit,
    drawScene,
  } as unknown as NiiVue
  return { ctrl, emit, drawScene, completedMeasurements }
}

describe('addMeasurement', () => {
  test('clamps a caller-supplied slicePosition and coerces non-finite to 0', () => {
    const { ctrl, completedMeasurements } = fakeCtrl()
    const hi = addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0], {
      slicePosition: 5,
    })
    expect(completedMeasurements[hi]?.slicePosition).toBe(1)
    const lo = addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0], {
      slicePosition: -3,
    })
    expect(completedMeasurements[lo]?.slicePosition).toBe(0)
    const nan = addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0], {
      slicePosition: Number.NaN,
    })
    expect(completedMeasurements[nan]?.slicePosition).toBe(0)
  })

  test('clamps a derived slicePosition to [0, 1] for out-of-volume endpoints', () => {
    const { ctrl, completedMeasurements } = fakeCtrl()
    const idx = addMeasurement(ctrl, [9999, 0, 0], [9999, 2, 0])
    const added = completedMeasurements[idx]
    if (!added) throw new Error('measurement missing')
    expect(added.slicePosition).toBeGreaterThanOrEqual(0)
    expect(added.slicePosition).toBeLessThanOrEqual(1)
  })

  test('appends, emits measurementCompleted after the mutation, redraws, and returns the index', () => {
    const { ctrl, emit, drawScene, completedMeasurements } = fakeCtrl()
    let lengthAtEmit = -1
    emit.mockImplementation((type: string) => {
      if (type === 'measurementCompleted')
        lengthAtEmit = completedMeasurements.length
    })

    const idx = addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0])

    expect(idx).toBe(0)
    expect(completedMeasurements).toHaveLength(1)
    expect(lengthAtEmit).toBe(1) // add events fire after the mutation
    expect(emit).toHaveBeenCalledWith(
      'measurementCompleted',
      completedMeasurements[0],
    )
    expect(drawScene).toHaveBeenCalledTimes(1)
    expect(addMeasurement(ctrl, [0, -1, 0], [0, 1, 0])).toBe(1)
  })

  test('computes the mm distance and copies the endpoints', () => {
    const { ctrl } = fakeCtrl()
    const start: [number, number, number] = [0, 3, 0]
    const end: [number, number, number] = [4, 0, 0]
    addMeasurement(ctrl, start, end)
    const m = ctrl.model.completedMeasurements[0]
    expect(m.distance).toBeCloseTo(5)
    expect(m.startMM).toEqual(start)
    expect(m.startMM).not.toBe(start) // defensive copy
  })
})

describe('buildMeasurement slice metadata', () => {
  test('derives sliceType from the constant axis and slicePosition from the midpoint scene fraction', () => {
    const { ctrl } = fakeCtrl()
    // z constant -> axial; midpoint z = 10 mm -> scene fraction 0.1.
    const axial = buildMeasurement(ctrl, [-5, 2, 10], [5, -2, 10])
    expect(axial.sliceType).toBe(SLICE_TYPE.AXIAL)
    expect(axial.slicePosition).toBeCloseTo(0.1)
    expect(axial.sliceIndex).toBe(0)

    // y constant -> coronal; x constant -> sagittal.
    expect(buildMeasurement(ctrl, [-5, 3, 1], [5, 3, 9]).sliceType).toBe(
      SLICE_TYPE.CORONAL,
    )
    expect(buildMeasurement(ctrl, [7, -5, 1], [7, 5, 9]).sliceType).toBe(
      SLICE_TYPE.SAGITTAL,
    )
  })

  test('opts override the derived slice metadata', () => {
    const { ctrl } = fakeCtrl()
    const m = buildMeasurement(ctrl, [-5, 0, 10], [5, 0, 10], {
      sliceIndex: 2,
      sliceType: SLICE_TYPE.CORONAL,
      slicePosition: 0.25,
    })
    expect(m.sliceIndex).toBe(2)
    expect(m.sliceType).toBe(SLICE_TYPE.CORONAL)
    expect(m.slicePosition).toBe(0.25)
  })

  test('honours each explicit 2D orientation and its slicePosition axis', () => {
    const { ctrl } = fakeCtrl()
    // Segment geometry derives AXIAL (z constant), so an explicit CORONAL /
    // SAGITTAL is only respected if opts.sliceType actually takes effect. The
    // midpoint is (0, 0, 10) -> scene fraction 0.1 on whichever axis is used.
    const start: [number, number, number] = [-5, 0, 10]
    const end: [number, number, number] = [5, 0, 10]
    for (const sliceType of [
      SLICE_TYPE.AXIAL,
      SLICE_TYPE.CORONAL,
      SLICE_TYPE.SAGITTAL,
    ]) {
      const m = buildMeasurement(ctrl, start, end, { sliceType })
      expect(m.sliceType).toBe(sliceType)
    }
    // AXIAL -> z axis (mid z 10 -> 0.1); CORONAL/SAGITTAL midpoint is 0 -> 0.
    expect(
      buildMeasurement(ctrl, start, end, { sliceType: SLICE_TYPE.AXIAL })
        .slicePosition,
    ).toBeCloseTo(0.1)
    expect(
      buildMeasurement(ctrl, start, end, { sliceType: SLICE_TYPE.SAGITTAL })
        .slicePosition,
    ).toBeCloseTo(0)
  })

  test('ignores a non-2D sliceType and falls back to the derived orientation', () => {
    const { ctrl } = fakeCtrl()
    // z constant with x and y varying -> derived AXIAL; midpoint z = 10 mm ->
    // scene fraction 0.1 on the axial axis (a silently-kept non-2D value would
    // corrupt this: sliceTypeDim falls back to the axial dim for all of them).
    for (const bad of [
      SLICE_TYPE.MULTIPLANAR,
      SLICE_TYPE.RENDER,
      SLICE_TYPE.NONE,
    ]) {
      const m = buildMeasurement(ctrl, [-5, 2, 10], [5, -2, 10], {
        sliceType: bad,
      })
      expect(m.sliceType).toBe(SLICE_TYPE.AXIAL)
      expect(m.slicePosition).toBeCloseTo(0.1)
    }
  })

  test('auto-derives the orientation when sliceType is omitted', () => {
    const { ctrl } = fakeCtrl()
    expect(buildMeasurement(ctrl, [-5, 2, 10], [5, -2, 10]).sliceType).toBe(
      SLICE_TYPE.AXIAL,
    )
    expect(buildMeasurement(ctrl, [-5, 3, 1], [5, 3, 9]).sliceType).toBe(
      SLICE_TYPE.CORONAL,
    )
  })
})

describe('removeMeasurement', () => {
  test('emits measurementRemoved before the mutation, then splices and redraws', () => {
    const { ctrl, emit, drawScene, completedMeasurements } = fakeCtrl()
    addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0])
    addMeasurement(ctrl, [0, -1, 0], [0, 1, 0])
    const removed = completedMeasurements[0]
    emit.mockClear()
    drawScene.mockClear()

    let lengthAtEmit = -1
    emit.mockImplementation((type: string) => {
      if (type === 'measurementRemoved')
        lengthAtEmit = completedMeasurements.length
    })
    removeMeasurement(ctrl, 0)

    expect(lengthAtEmit).toBe(2) // removal events fire before the mutation
    expect(emit).toHaveBeenCalledWith('measurementRemoved', {
      measurement: removed,
      index: 0,
    })
    expect(completedMeasurements).toHaveLength(1)
    expect(completedMeasurements[0]).not.toBe(removed)
    expect(drawScene).toHaveBeenCalledTimes(1)
  })

  test('warns and no-ops on an out-of-bounds index (matching removeVolume)', () => {
    const { ctrl, emit, drawScene, completedMeasurements } = fakeCtrl()
    addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0])
    emit.mockClear()
    drawScene.mockClear()

    expect(() => removeMeasurement(ctrl, -1)).not.toThrow()
    expect(() => removeMeasurement(ctrl, 1)).not.toThrow()
    expect(completedMeasurements).toHaveLength(1)
    expect(emit).not.toHaveBeenCalled()
    expect(drawScene).not.toHaveBeenCalled()
  })
})

describe('pickMeasurement', () => {
  test('hits a measurement near its projected segment and misses far away', () => {
    const { ctrl } = fakeCtrl()
    // mm (-1,0,0)-(1,0,0) projects to canvas (0,50)-(100,50) on the axial tile.
    addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0])

    expect(pickMeasurement(ctrl, 50, 55)).toBe(0) // 5 px < default 8 px radius
    expect(pickMeasurement(ctrl, 50, 70)).toBeNull() // 20 px away
    expect(pickMeasurement(ctrl, 120, 50)).toBeNull() // past the endpoint cap
  })

  test('a larger radius widens the hit zone', () => {
    const { ctrl } = fakeCtrl()
    addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0])
    expect(pickMeasurement(ctrl, 50, 70)).toBeNull()
    expect(pickMeasurement(ctrl, 50, 70, 25)).toBe(0)
  })

  test('returns the closest of several candidates', () => {
    const { ctrl } = fakeCtrl()
    addMeasurement(ctrl, [-1, 0.2, 0], [1, 0.2, 0]) // canvas y = 40
    addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0]) // canvas y = 50
    expect(pickMeasurement(ctrl, 50, 48, 20)).toBe(1)
    expect(pickMeasurement(ctrl, 50, 42, 20)).toBe(0)
  })

  test('ignores measurements whose endpoints are off every tile slice plane', () => {
    const { ctrl } = fakeCtrl()
    // z = 10 mm is far off the tile's z = 0 plane (tolerance 0.5 mm).
    addMeasurement(ctrl, [-1, 0, 10], [1, 0, 10])
    expect(pickMeasurement(ctrl, 50, 50)).toBeNull()
  })

  test('returns null with no rendered tiles or no measurements', () => {
    const { ctrl } = fakeCtrl([])
    expect(pickMeasurement(ctrl, 50, 50)).toBeNull()
    addMeasurement(ctrl, [-1, 0, 0], [1, 0, 0])
    expect(pickMeasurement(ctrl, 50, 50)).toBeNull()
    // A tile that has not cached picking matrices yet is skipped too.
    const bare = { axCorSag: SLICE_TYPE.AXIAL } as SliceTile
    ;(ctrl.view as { screenSlices: SliceTile[] }).screenSlices = [bare]
    expect(pickMeasurement(ctrl, 50, 50)).toBeNull()
  })
})
