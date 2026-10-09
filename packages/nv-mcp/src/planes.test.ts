import { describe, expect, it } from 'bun:test'

import {
  cameraForPlane,
  clipNormal,
  depthThrough,
  namePlane,
  PLANE_ANGLES,
  PLANE_NONE,
  planeDepthCuts,
  resolvePlane,
  samePlane,
  viewDirection,
} from './planes'

const close = (v: readonly number[], expected: readonly number[]) => {
  for (let i = 0; i < 3; i++) expect(v[i]).toBeCloseTo(expected[i], 6)
}

describe('clipNormal', () => {
  it('gives each named plane the normal NiiVue gives it', () => {
    const expected: Record<string, [number, number, number]> = {
      posterior: [0, 1, 0],
      anterior: [0, -1, 0],
      left: [1, 0, 0],
      right: [-1, 0, 0],
      superior: [0, 0, -1],
      inferior: [0, 0, 1],
    }
    for (const { name, azimuth, elevation } of PLANE_ANGLES) {
      close(clipNormal(azimuth, elevation), expected[name])
    }
  })
})

describe('viewDirection', () => {
  it('has the default camera on the left, in front and above, looking in', () => {
    const [x, y, z] = viewDirection(110, 10)
    expect(x).toBeGreaterThan(0.9)
    expect(y).toBeLessThan(0)
    expect(z).toBeLessThan(0)
  })

  it('looks along each axis from the expected side', () => {
    close(viewDirection(90, 0), [1, 0, 0])
    close(viewDirection(270, 0), [-1, 0, 0])
    close(viewDirection(0, 0), [0, 1, 0])
    close(viewDirection(180, 0), [0, -1, 0])
    close(viewDirection(0, 90), [0, 0, -1])
    close(viewDirection(0, -90), [0, 0, 1])
  })
})

describe('cameraForPlane', () => {
  it('faces each named side from the side it takes off', () => {
    const expected: Record<string, [number, number]> = {
      left: [90, 0],
      right: [270, 0],
      posterior: [0, 0],
      anterior: [180, 0],
      inferior: [0, -90],
      superior: [0, 90],
    }
    for (const { name, azimuth, elevation } of PLANE_ANGLES) {
      expect(cameraForPlane(azimuth, elevation), name).toEqual({
        azimuth: expected[name][0],
        elevation: expected[name][1],
      })
    }
  })

  it("looks straight along the plane's normal at any angles", () => {
    for (let azimuth = 0; azimuth < 360; azimuth += 15) {
      for (let elevation = -90; elevation <= 90; elevation += 15) {
        const camera = cameraForPlane(azimuth, elevation)
        close(
          viewDirection(camera.azimuth, camera.elevation),
          clipNormal(azimuth, elevation),
        )
      }
    }
  })

  it('keeps the azimuth within a turn', () => {
    expect(cameraForPlane(0, 0).azimuth).toBe(0)
    expect(cameraForPlane(450, 0).azimuth).toBe(270)
    expect(cameraForPlane(-90, 0).azimuth).toBe(90)
  })
})

describe('depthThrough', () => {
  it("is zero for a point on the middle plane and matches the sweep's coronal rule", () => {
    expect(depthThrough([0, 1, 0], [0.5, 0.5, 0.5])).toBe(0)
    // sweep.ts: a coronal plane through the crosshair has depth 0.5 - crosshair[1].
    expect(depthThrough([0, 1, 0], [0.2, 0.7, 0.9])).toBeCloseTo(0.5 - 0.7, 9)
  })

  it('puts the plane through the point for any normal', () => {
    const n = clipNormal(37, 12)
    const p = [0.31, 0.62, 0.48]
    const depth = depthThrough(n, p)
    const onPlane =
      n[0] * (p[0] - 0.5) + n[1] * (p[1] - 0.5) + n[2] * (p[2] - 0.5) + depth
    expect(onPlane).toBeCloseTo(0, 9)
  })
})

describe('resolvePlane', () => {
  it('knows the six sides and their anatomical aliases', () => {
    expect(resolvePlane('Left', null)?.azimuth).toBe(270)
    expect(resolvePlane('coronal', null)?.name).toBe('posterior')
    expect(resolvePlane('axial', null)?.name).toBe('superior')
    expect(resolvePlane('sagittal', null)?.name).toBe('left')
    expect(resolvePlane('diagonal', null)).toBeNull()
  })

  it('keeps the current plane when one is cut and falls back to coronal when none is', () => {
    expect(resolvePlane(undefined, [0.2, 90, 0])?.name).toBe('right')
    expect(resolvePlane('current', [0.1, 45, 10])).toEqual({
      name: 'current',
      azimuth: 45,
      elevation: 10,
    })
    expect(resolvePlane('current', [2, 0, 0])?.name).toBe('posterior')
    // NiiVue's default plane reads back as depth -2: off, so coronal too.
    expect(resolvePlane('current', [-2, 0, 0])?.name).toBe('posterior')
    expect(resolvePlane(undefined, null)?.name).toBe('posterior')
  })
})

describe('namePlane', () => {
  it('names each of the six sides from the angles NiiVue reports, either way round', () => {
    for (const plane of PLANE_ANGLES) {
      expect(namePlane(0.1, plane.azimuth, plane.elevation)).toBe(plane.name)
      expect(namePlane(0.1, plane.azimuth - 360, plane.elevation)).toBe(
        plane.name,
      )
    }
    // NiiVue hands a plane set at 270 back as -90.
    expect(namePlane(0, -90, 0)).toBe('left')
  })

  it('says off past the depth the shader ignores, and custom for any other angles', () => {
    expect(namePlane(PLANE_NONE, 0, 0)).toBe('off')
    expect(namePlane(1.8, 90, 0)).toBe('off')
    // A fresh NiiVue reads its default plane back as -2, not +2.
    expect(namePlane(-PLANE_NONE, 0, 0)).toBe('off')
    expect(namePlane(-1.8, 0, 0)).toBe('off')
    expect(namePlane(-1.5, 0, 0)).toBe('posterior')
    expect(namePlane(0.2, 45, 10)).toBe('custom')
  })

  it('treats either side of the off depth as no plane', () => {
    expect(planeDepthCuts(0)).toBe(true)
    expect(planeDepthCuts(1.5)).toBe(true)
    expect(planeDepthCuts(-1.5)).toBe(true)
    expect(planeDepthCuts(1.8)).toBe(false)
    expect(planeDepthCuts(-2)).toBe(false)
  })
})

describe('samePlane', () => {
  it('compares normals, so a full turn or a wrapped angle is the same plane', () => {
    expect(samePlane([270, 0], [-90, 0])).toBe(true)
    expect(samePlane([0, 90], [180, 90])).toBe(true)
    expect(samePlane([0, 0], [180, 0])).toBe(false)
  })
})
