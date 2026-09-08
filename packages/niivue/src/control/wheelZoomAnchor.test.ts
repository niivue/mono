import { describe, expect, mock, test } from 'bun:test'
import { mat4, vec3 } from 'gl-matrix'
import type NiiVue from '@/NVControl'
import type { ViewHitTest, WheelZoomAnchor } from '@/NVTypes'
import { resolveWheelZoomAnchorMM } from './wheelZoomAnchor'

const CROSSHAIR_MM: [number, number, number] = [11, 22, 33]

// One axial-style tile covering canvas [0,0,100,100] with a cached MVP
// (identity) and slice plane z = 7. With the identity MVP, screenSlicePick
// unprojects canvas (25, 75) to NDC (-0.5, -0.5) and the ray hits the plane
// at mm (-0.5, -0.5, 7).
function fakeTile() {
  return {
    leftTopWidthHeight: [0, 0, 100, 100],
    mvpMatrix: mat4.create(),
    planeNormal: vec3.fromValues(0, 0, 1),
    planePoint: vec3.fromValues(0, 0, 7),
  }
}

function fakeCtrl(opts: {
  anchor: WheelZoomAnchor
  tiles?: unknown[]
  volumes?: unknown[]
}) {
  const scene2mm = mock((_frac: ArrayLike<number>) => CROSSHAIR_MM)
  const ctrl = {
    model: {
      interaction: { wheelZoomAnchor: opts.anchor },
      scene: { crosshairPos: [0.5, 0.5, 0.5] },
      scene2mm,
      volumes: opts.volumes ?? [{}],
      tex2mm: mat4.create(),
    },
    view: { screenSlices: opts.tiles ?? [fakeTile()] },
  } as unknown as NiiVue
  return { ctrl, scene2mm }
}

const hit: ViewHitTest = {
  isRender: false,
  sliceType: 0,
  normalizedX: 0.25,
  normalizedY: 0.75,
  tileIndex: 0,
}

describe('resolveWheelZoomAnchorMM', () => {
  test('crosshair anchor (default) uses scene2mm(crosshairPos), not the pointer', () => {
    const { ctrl, scene2mm } = fakeCtrl({ anchor: 'crosshair' })
    const mm = resolveWheelZoomAnchorMM(ctrl, 25, 75, hit)
    expect(mm).toEqual(CROSSHAIR_MM)
    expect(scene2mm).toHaveBeenCalledWith(ctrl.model.scene.crosshairPos)
  })

  test('pointer anchor uses the mm picked under the pointer', () => {
    const { ctrl, scene2mm } = fakeCtrl({ anchor: 'pointer' })
    const mm = resolveWheelZoomAnchorMM(ctrl, 25, 75, hit)
    expect(mm[0]).toBeCloseTo(-0.5, 5)
    expect(mm[1]).toBeCloseTo(-0.5, 5)
    expect(mm[2]).toBeCloseTo(7, 5)
    expect(scene2mm).not.toHaveBeenCalled()
  })

  test('pointer anchor tracks the pointer position, not the tile centre', () => {
    const { ctrl } = fakeCtrl({ anchor: 'pointer' })
    const mm = resolveWheelZoomAnchorMM(ctrl, 75, 25, hit)
    expect(mm[0]).toBeCloseTo(0.5, 5)
    expect(mm[1]).toBeCloseTo(0.5, 5)
    expect(mm[2]).toBeCloseTo(7, 5)
  })

  test('pointer anchor falls back to the crosshair when no tile is picked', () => {
    const { ctrl, scene2mm } = fakeCtrl({ anchor: 'pointer', tiles: [] })
    const mm = resolveWheelZoomAnchorMM(ctrl, 25, 75, hit)
    expect(mm).toEqual(CROSSHAIR_MM)
    expect(scene2mm).toHaveBeenCalledWith(ctrl.model.scene.crosshairPos)
  })

  test('pointer anchor falls back to the crosshair in a mesh-only scene', () => {
    // screenSlicePick declines when no volumes are loaded
    const { ctrl } = fakeCtrl({ anchor: 'pointer', volumes: [] })
    const mm = resolveWheelZoomAnchorMM(ctrl, 25, 75, hit)
    expect(mm).toEqual(CROSSHAIR_MM)
  })
})
