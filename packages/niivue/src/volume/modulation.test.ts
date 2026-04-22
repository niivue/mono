import { describe, expect, test } from 'bun:test'
import { NiiDataType } from '@/NVConstants'
import type { NVImage, NIFTIHeader } from '@/NVTypes'
import { computeModulationData } from './modulation'

function makeHeader(overrides: Partial<NIFTIHeader> = {}): NIFTIHeader {
  return {
    littleEndian: true,
    dim_info: 0,
    dims: [3, 2, 2, 2, 1, 1, 1, 1],
    pixDims: [1, 1, 1, 1, 1, 0, 0, 0],
    intent_p1: 0,
    intent_p2: 0,
    intent_p3: 0,
    intent_code: 0,
    datatypeCode: NiiDataType.DT_FLOAT32,
    numBitsPerVoxel: 32,
    slice_start: 0,
    vox_offset: 352,
    scl_slope: 1,
    scl_inter: 0,
    slice_end: 0,
    slice_code: 0,
    xyzt_units: 10,
    cal_max: 0,
    cal_min: 0,
    slice_duration: 0,
    toffset: 0,
    description: '',
    aux_file: '',
    qform_code: 0,
    sform_code: 1,
    quatern_b: 0,
    quatern_c: 0,
    quatern_d: 0,
    qoffset_x: 0,
    qoffset_y: 0,
    qoffset_z: 0,
    affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
    intent_name: '',
    magic: 'n+1',
    ...overrides,
  }
}

function makeVolume(overrides: Partial<NVImage> = {}): NVImage {
  return {
    name: 'test',
    id: 'vol1',
    hdr: makeHeader(),
    img: new Float32Array(8),
    dims: [3, 2, 2, 2],
    nVox3D: 8,
    extentsMin: [0, 0, 0],
    extentsMax: [2, 2, 2],
    calMin: 0,
    calMax: 1,
    robustMin: 0,
    robustMax: 1,
    globalMin: 0,
    globalMax: 1,
    dimsRAS: [3, 2, 2, 2],
    img2RASstep: [1, 2, 4],
    img2RASstart: [0, 0, 0],
    permRAS: [1, 2, 3],
    ...overrides,
  } as NVImage
}

describe('computeModulationData', () => {
  test('noModulationImage_setsNull', () => {
    const vol = makeVolume({ modulationImage: '' })
    computeModulationData([vol])
    expect(vol._modulationData).toBeNull()
  })

  test('undefinedModulationImage_setsNull', () => {
    const vol = makeVolume({ modulationImage: undefined })
    computeModulationData([vol])
    expect(vol._modulationData).toBeNull()
  })

  test('validModulation_producesNormalizedValues', () => {
    // Modulation source: values 0..7, calMin=0, calMax=7
    const modImg = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7])
    const modVol = makeVolume({
      id: 'mod1',
      img: modImg,
      calMin: 0,
      calMax: 7,
      frame4D: 0,
    })
    // Target vol references modVol
    const targetVol = makeVolume({
      id: 'target',
      modulationImage: 'mod1',
    })
    computeModulationData([targetVol, modVol])
    expect(targetVol._modulationData).not.toBeNull()
    const data = targetVol._modulationData!
    expect(data.length).toBe(8)
    // First voxel: (0 - 0) / 7 = 0
    expect(data[0]).toBeCloseTo(0, 5)
    // Last voxel: (7 - 0) / 7 = 1
    expect(data[7]).toBeCloseTo(1, 5)
    // Mid voxel: (3 - 0) / 7 ≈ 0.4286
    expect(data[3]).toBeCloseTo(3 / 7, 4)
  })

  test('modulationImageNotFound_setsNull', () => {
    const vol = makeVolume({ modulationImage: 'nonexistent' })
    computeModulationData([vol])
    expect(vol._modulationData).toBeNull()
  })
})
