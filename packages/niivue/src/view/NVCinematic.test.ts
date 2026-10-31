import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { addColormap } from '@/cmap/NVCmaps'
import { VOLUME_DEFAULTS } from '@/NVConstants'
import type { ColorMap, NVImage } from '@/NVTypes'
import {
  bakeTransferFunction,
  CinematicCpuCache,
  calibrationMap,
  cinematicGeometry,
  clipParams,
  dilateLabels,
  findLabelVolume,
  HIDDEN_LABEL,
  labelMaterials,
  lightVector,
  packMarchParams,
  TF_H,
  TF_W,
} from './NVCinematic'

const ramp: ColorMap = {
  R: [0, 255],
  G: [0, 255],
  B: [0, 255],
  A: [0, 100],
  I: [0, 255],
}

describe('bakeTransferFunction', () => {
  test('plainColormapIgnoresGradient', () => {
    const tf = bakeTransferFunction(ramp, -1000, 1000)
    const alphaAt = (x: number, y: number) => tf.color[(y * TF_W + x) * 4 + 3]
    expect(alphaAt(255, 0)).toBe(100)
    expect(alphaAt(255, TF_H - 1)).toBe(100)
    expect(tf.maxAlpha[255]).toBe(100)
    expect([tf.huMin, tf.huMax, tf.gMax, tf.shininess]).toEqual([
      -1000, 1000, 1000, 40,
    ])
  })

  test('edgeAlphaAppliesAtHighGradient', () => {
    const tf = bakeTransferFunction(
      { ...ramp, E: [0, 250], S: [0, 200], labelBlend: 0.5 },
      0,
      1,
    )
    const o = ((TF_H - 1) * TF_W + 255) * 4
    expect(tf.color[o + 3]).toBe(250)
    // Surfaceness 1 and full specular on the top row, none on the first.
    expect(tf.material[((TF_H - 1) * TF_W + 255) * 2 + 1]).toBe(255)
    expect(tf.material[255 * 2]).toBe(0)
    expect(tf.maxAlpha[255]).toBe(250)
    expect(tf.labelBlend).toBe(0.5)
  })
})

describe('labelMaterials', () => {
  const table: ColorMap = {
    R: [0, 255, 10],
    G: [0, 0, 20],
    B: [0, 0, 30],
    A: [0, 255, 128],
    I: [0, 3, 7],
    S: [0, 255, 0],
    lo: [0, 30, 0],
    hi: [0, 70, 0],
    surface: [0, 255, 0],
  }

  test('indexesByLabelValue', () => {
    const { materials, isVisible } = labelMaterials(table)
    expect(Array.from(materials.subarray(3 * 8, 3 * 8 + 8))).toEqual([
      1, 0, 0, 1, 30, 70, 1, 1,
    ])
    expect(isVisible[3]).toBe(1)
    expect(isVisible[7]).toBe(1)
    expect(isVisible[0]).toBe(0)
  })

  test('hiddenLabelsGetZeroOpacity', () => {
    const { materials, isVisible } = labelMaterials(table, [7])
    expect(materials[7 * 8 + 3]).toBe(0)
    expect(isVisible[7]).toBe(0)
  })

  test('plainLabelTableIsLabelShaped', () => {
    const { materials } = labelMaterials({
      ...table,
      lo: undefined,
      hi: undefined,
    })
    expect(materials[3 * 8 + 4]).toBeLessThan(materials[3 * 8 + 5])
    expect(materials[3 * 8 + 5]).toBeLessThan(-1000)
  })
})

describe('dilateLabels', () => {
  test('visibleLabelSpreadsOneVoxelAndHiddenBecomes255', () => {
    // 5 x 1 x 1: [0, 2, 1, 0, 0] with label 1 visible, 2 hidden.
    const isVisible = new Uint8Array(256)
    isVisible[1] = 1
    const out = dilateLabels(
      Uint8Array.from([0, 2, 1, 0, 0]),
      [5, 1, 1],
      isVisible,
    )
    expect(Array.from(out)).toEqual([0, 1, 1, 1, 0])
    const alone = dilateLabels(Uint8Array.from([2, 0]), [2, 1, 1], isVisible)
    expect(Array.from(alone)).toEqual([HIDDEN_LABEL, 0])
  })
})

describe('calibrationMap', () => {
  test('mapsLabelMediansPiecewiseLinearly', () => {
    const img = new Float32Array(70)
    const ids = new Uint8Array(70)
    for (let i = 0; i < 70; i++) {
      ids[i] = (i % 2) + 1
      img[i] = ids[i] === 1 ? 300 : 500
    }
    const map = calibrationMap(img, ids, [
      [[1], 100],
      [[2], 200],
    ])
    expect(map?.(300)).toBe(100)
    expect(map?.(500)).toBe(200)
    expect(map?.(700)).toBe(300)
  })

  test('needsTwoLabelledTissues', () => {
    const ids = new Uint8Array(14).fill(1)
    expect(calibrationMap(new Float32Array(14), ids, [[[1], 0]])).toBeNull()
  })
})

describe('clipParams', () => {
  test('rescalesPlanesToMillimetres', () => {
    // 100 mm cube: frac p maps to 100 * p mm.
    const frac2mm = mat4.fromScaling(mat4.create(), [100, 100, 100])
    const { mm2frac } = cinematicGeometry(frac2mm, [10, 10, 10])
    const off = [0, 0, 0, 2]
    const out = clipParams([1, 0, 0, 0.1, ...off], true, mm2frac)
    expect(Array.from(out.subarray(48, 50))).toEqual([1, 1])
    // Plane at x_frac 0.6 (60 mm): dot(n', p) - d' is mm from it, p in frac.
    const [nx, , , d] = out
    expect(nx * 0.6 - d).toBeCloseTo(0, 4)
    expect(nx * 0.7 - d).toBeCloseTo(10, 4)
  })

  test('skipsInactivePlanes', () => {
    const out = clipParams([0, 0, 1, 2], false, mat4.create())
    expect(out[48]).toBe(0)
  })
})

describe('geometry, light and uniforms', () => {
  test('gradientConversionAndVoxelSize', () => {
    const frac2mm = mat4.fromScaling(mat4.create(), [20, 30, 40])
    const geo = cinematicGeometry(frac2mm, [10, 10, 10])
    expect(geo.voxelMM).toBe(2)
    // dI/dvoxel -> dI/dmm: divide by the voxel size along that axis.
    expect(geo.gradToMM[0]).toBeCloseTo(0.5)
    expect(geo.gradToMM[5]).toBeCloseTo(1 / 3)
  })

  test('lightFollowsTheCamera', () => {
    const [x, y, z] = lightVector(mat4.create(), 0, 0)
    expect([x, y, z]).toEqual([0, 0, 1])
    expect(lightVector(mat4.create(), 90, 0)[1]).toBeCloseTo(1)
  })

  test('packsTheParamsLayout', () => {
    const geo = cinematicGeometry(mat4.create(), [4, 4, 4])
    const out = packMarchParams({
      geometry: geo,
      invMVP: mat4.create(),
      model: mat4.create(),
      width: 64,
      height: 32,
      frame: 5,
      options: VOLUME_DEFAULTS.cinematic,
      tf: bakeTransferFunction(ramp, -1, 1),
      clip: new Float32Array(52),
      labelInfo: [1, 0, 0.5, 0],
    })
    expect(out.length).toBe(128)
    expect(Array.from(out.subarray(48, 50))).toEqual([64, 32])
    expect(out[61]).toBe(5)
    expect(Array.from(out.subarray(124))).toEqual([1, 0, 0.5, 0])
  })
})

/** A RAS-ordered float volume on an n^3 unit grid. */
function volume(img: Float32Array, n: number, extra: Partial<NVImage> = {}) {
  return {
    img,
    dimsRAS: [3, n, n, n],
    img2RASstep: [1, n, n * n],
    img2RASstart: [0, 0, 0],
    frac2mm: mat4.fromScaling(mat4.create(), [n, n, n]),
    hdr: { scl_slope: 1, scl_inter: 0 },
    calMin: 0,
    calMax: 100,
    colormap: 'gray',
    opacity: 1,
    ...extra,
  } as unknown as NVImage
}

describe('findLabelVolume', () => {
  test('picksADrawnLabelVolumeOnTheSameGrid', () => {
    const base = volume(new Float32Array(8), 2)
    const lut = { lut: new Uint8ClampedArray(4) }
    const hidden = volume(new Float32Array(8), 2, {
      colormapLabel: lut,
      opacity: 0,
    })
    const other = volume(new Float32Array(27), 3, { colormapLabel: lut })
    const labels = volume(new Float32Array(8), 2, { colormapLabel: lut })
    expect(findLabelVolume([base, hidden, other, labels])).toBe(labels)
    expect(findLabelVolume([base, other])).toBeNull()
  })
})

describe('CinematicCpuCache', () => {
  const n = 4
  addColormap('cinematicTestLabels', {
    R: [0, 255],
    G: [0, 0],
    B: [0, 0],
    labels: ['', 'one'],
  })
  const base = volume(new Float32Array(n ** 3).fill(50), n)
  const ids = new Float32Array(n ** 3)
  ids[0] = 1
  const labels = volume(ids, n, {
    colormap: 'cinematicTestLabels',
    colormapLabel: { lut: new Uint8ClampedArray(8) },
  })

  test('rebuildsOnlyWhatChanged', () => {
    const cache = new CinematicCpuCache()
    const opts = { ...VOLUME_DEFAULTS.cinematic }
    const first = cache.update(base, labels, opts)
    expect(first?.intensity?.values.length).toBe(n ** 3)
    expect(first?.tf?.huMax).toBe(100)
    expect(first?.labels?.info[0]).toBe(1)
    expect(first?.labels?.ids?.[1]).toBe(1) // dilated
    const same = cache.update(base, labels, opts)
    expect(same?.intensity).toBeNull()
    expect(same?.tf).toBeNull()
    expect(same?.labels).toBeNull()
    expect(same?.version).toBe(first?.version)

    labels.hiddenLabels = [1]
    const hidden = cache.update(base, labels, opts)
    expect(hidden?.intensity).toBeNull()
    expect(hidden?.labels?.ids?.[0]).toBe(HIDDEN_LABEL)
    expect(hidden?.version).toBeGreaterThan(first?.version ?? 0)

    base.calMax = 200
    expect(cache.update(base, labels, opts)?.tf?.huMax).toBe(200)

    const none = cache.update(base, labels, { ...opts, labelMode: 'none' })
    expect(none?.labels?.ids).toBeNull()
    expect(none?.labels?.info[0]).toBe(0)
  })

  test('rejectsLabelValuesAbove254', () => {
    const big = new Float32Array(n ** 3)
    big[0] = 300
    const bad = volume(big, n, {
      colormap: 'cinematicTestLabels',
      colormapLabel: { lut: new Uint8ClampedArray(8) },
    })
    const cache = new CinematicCpuCache()
    const out = cache.update(base, bad, { ...VOLUME_DEFAULTS.cinematic })
    expect(out?.labels?.ids).toBeNull()
    expect(cache.labelProblem).not.toBe('')
  })
})
