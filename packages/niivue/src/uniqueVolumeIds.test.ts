import { describe, expect, mock, test } from 'bun:test'
import type { NIFTIHeader, NVImage, NVSignal } from '@/NVTypes'
import { defaultSignalDisplay } from '@/signal/processing'
import { computeModulationWeights } from '@/volume/modulation'

// Volume ids within one scene: the same URL loaded twice (AFNI's QC viewer shows
// a stats dataset as the overlay and again, hidden, as its threshold) must get
// two ids, or every find-by-id lookup resolves both to the first volume.
//
// NVModel / NVDocument pull in the volume-load worker (a Vite `?worker` import
// Bun cannot load) through loadBridge. Replace the loader with an in-memory one:
// every URL yields a 2x2x2 volume with two frames, frame 0 = 0..7 and
// frame 1 = 7..0, named and id'd by URL the way nii2volume does.

function header(): NIFTIHeader {
  return {
    littleEndian: true,
    dim_info: 0,
    dims: [4, 2, 2, 2, 2, 1, 1, 1],
    pixDims: [1, 1, 1, 1, 1, 0, 0, 0],
    intent_p1: 0,
    intent_p2: 0,
    intent_p3: 0,
    intent_code: 0,
    datatypeCode: 16,
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
    affine: [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ],
    intent_name: '',
    magic: 'n+1',
  }
}

mock.module('@/volume/loadBridge', () => ({
  loadVolumePrepared: async (
    url: string | File,
    _paired: unknown,
    _limit: number,
    name?: string,
  ): Promise<NVImage> => {
    const label = name ?? (typeof url === 'string' ? url : url.name)
    return {
      name: label,
      id: label,
      hdr: header(),
      img: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0]),
      dims: [3, 2, 2, 2],
      nVox3D: 8,
      extentsMin: [0, 0, 0],
      extentsMax: [2, 2, 2],
      calMin: 0,
      calMax: 7,
      robustMin: 0,
      robustMax: 7,
      globalMin: 0,
      globalMax: 7,
      frame4D: 0,
      nFrame4D: 2,
      nTotalFrame4D: 2,
    } as NVImage
  },
}))

const { default: NVModel } = await import('@/NVModel')
const NVDocument = await import('@/NVDocument')

const ANAT = 'https://example.com/anat.nii'
const STATS = 'https://example.com/stats.nii'

/** What `setModulationImage(targetId, modulatorId)` does to the model. */
function setModulationImage(
  model: InstanceType<typeof NVModel>,
  targetId: string,
  modulatorId: string,
): NVImage {
  const target = model.volumes.find((v) => v.id === targetId)
  if (!target) throw new Error(`no volume ${targetId}`)
  target.modulationImage = modulatorId
  target.modulateAlpha = 0
  return target
}

/** The modulator `computeModulationWeights` resolved for `target`, as the frame
 * it sampled: weight[0] is 0 for frame 0 (value 0) and 1 for frame 1 (value 7). */
function modulatorFrame(
  model: InstanceType<typeof NVModel>,
  target: NVImage,
): number {
  computeModulationWeights(model.volumes)
  const w = target._modulationWeight
  if (!w) throw new Error('modulation did not resolve')
  return w[0]
}

/** anat + stats overlay (frame 0) + the same stats file as a hidden threshold
 * volume (frame 1): AFNI's QC overlay/threshold pair. */
async function afniScene(): Promise<InstanceType<typeof NVModel>> {
  const model = new NVModel()
  await model.addVolume({ url: ANAT })
  await model.addVolume({ url: STATS })
  await model.addVolume({ url: STATS, opacity: 0 })
  model.volumes[2].frame4D = 1
  return model
}

describe('volume ids are unique within a scene', () => {
  test('the same URL loaded twice gets distinct ids and the same name', async () => {
    const model = await afniScene()
    expect(model.volumes.map((v) => v.id)).toEqual([ANAT, STATS, `${STATS}-2`])
    expect(model.volumes[1].name).toBe(STATS)
    expect(model.volumes[2].name).toBe(STATS)
  })

  test('setModulationImage between the two copies targets the right volumes', async () => {
    const model = await afniScene()
    const vols = model.volumes
    const target = setModulationImage(model, vols[1].id ?? '', vols[2].id ?? '')
    expect(target).toBe(vols[1])
    // The modulator is the threshold copy (frame 1), not the overlay itself.
    expect(modulatorFrame(model, target)).toBe(1)
    expect(vols[2]._modulationWeight).toBeNull()
  })

  test('an NVImage passed in with a taken id is suffixed too', async () => {
    const model = await afniScene()
    const copy = { ...model.volumes[1], id: STATS }
    await model.addVolume(copy)
    expect(model.volumes[3].id).toBe(`${STATS}-3`)
    // The caller's object is not renamed; the scene holds its own copy.
    expect(copy.id).toBe(STATS)
  })

  test('removing and re-adding reuses the freed id without disturbing others', async () => {
    const model = await afniScene()
    model.removeVolume(2)
    await model.addVolume({ url: STATS })
    expect(model.volumes.map((v) => v.id)).toEqual([ANAT, STATS, `${STATS}-2`])

    // Remove the first copy: the survivor keeps "-2", the re-added copy takes
    // the now-free plain id, and a link to "-2" still reaches the survivor.
    const survivor = model.volumes[2]
    survivor.frame4D = 1
    const target = setModulationImage(model, ANAT, `${STATS}-2`)
    model.removeVolume(1)
    await model.addVolume({ url: STATS })
    expect(model.volumes.map((v) => v.id)).toEqual([ANAT, `${STATS}-2`, STATS])
    expect(model.volumes[1]).toBe(survivor)
    expect(modulatorFrame(model, target)).toBe(1)
  })

  test('removeAllVolumes frees every id', async () => {
    const model = await afniScene()
    await model.removeAllVolumes()
    await model.addVolume({ url: STATS })
    expect(model.volumes[0].id).toBe(STATS)
  })
})

describe('NVD round-trip keeps id references', () => {
  async function roundTrip(
    model: InstanceType<typeof NVModel>,
    strip?: (doc: ReturnType<typeof NVDocument.deserialize>) => void,
  ): Promise<InstanceType<typeof NVModel>> {
    const bytes = NVDocument.serialize(model, undefined, { linkData: true })
    const doc = NVDocument.deserialize(bytes)
    strip?.(doc)
    const restored = new NVModel()
    NVDocument.applyDocumentToModel(restored, doc)
    for (const v of doc.volumes ?? []) {
      await NVDocument.reconstructVolume(restored, v)
    }
    return restored
  }

  test('the AFNI overlay/threshold pair restores with its modulation link', async () => {
    const model = await afniScene()
    setModulationImage(model, `${STATS}`, `${STATS}-2`)
    const restored = await roundTrip(model)
    expect(restored.volumes.map((v) => v.id)).toEqual([
      ANAT,
      STATS,
      `${STATS}-2`,
    ])
    expect(restored.volumes[1].modulationImage).toBe(`${STATS}-2`)
    expect(modulatorFrame(restored, restored.volumes[1])).toBe(1)
  })

  test('ids that differ from load order are restored exactly, with signal links', async () => {
    // Build [stats-2, stats]: re-deriving ids from load order would swap them
    // and point the modulation and signal links at the wrong copy.
    const model = new NVModel()
    await model.addVolume({ url: STATS })
    await model.addVolume({ url: STATS })
    model.removeVolume(0)
    await model.addVolume({ url: STATS })
    model.volumes[0].frame4D = 1
    expect(model.volumes.map((v) => v.id)).toEqual([`${STATS}-2`, STATS])
    setModulationImage(model, STATS, `${STATS}-2`)
    const signal: NVSignal = {
      id: 'physio',
      name: 'physio',
      kind: 'physio',
      raw: {
        kind: 'physio',
        columns: [new Float32Array([0, 1])],
        columnLabels: ['cardiac'],
        samplingFrequency: 1,
        startTime: 0,
      },
      display: defaultSignalDisplay(),
      attachedToId: `${STATS}-2`,
    }
    model.addSignal(signal)

    const restored = await roundTrip(model)
    expect(restored.volumes.map((v) => v.id)).toEqual([`${STATS}-2`, STATS])
    expect(restored.volumes[1].modulationImage).toBe(`${STATS}-2`)
    expect(modulatorFrame(restored, restored.volumes[1])).toBe(1)
    const attached = restored.volumes.find(
      (v) => v.id === restored.signals[0].attachedToId,
    )
    expect(attached).toBe(restored.volumes[0])
  })

  test('a document without ids re-derives unique ids in volume order', async () => {
    const model = await afniScene()
    const restored = await roundTrip(model, (doc) => {
      for (const v of doc.volumes ?? []) delete v.id
    })
    expect(restored.volumes.map((v) => v.id)).toEqual([
      ANAT,
      STATS,
      `${STATS}-2`,
    ])
  })
})
