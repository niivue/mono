import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ConvertOptions, ConvertResult, Series } from '@niivue/dcm2niix'
import type NiiVue from '@niivue/niivue'
import {
  getNiivueEntry,
  registerNiivue,
  unregisterNiivue,
} from './niivueRegistry'
import type { OhifDisplaySet } from './ohif-types'

// Stands in for dcm2niix's convert(): each test sets the result it resolves to.
let result: Promise<Partial<ConvertResult>>
let calls: ConvertOptions[]
let inputs: File[]
mock.module('@niivue/dcm2niix', () => ({
  exitCodes: { ok: 0, noValidFiles: 2, someOkSomeBad: 8 },
  convert: async (files: File[], options: ConvertOptions) => {
    inputs = files
    calls.push(options)
    return { series: [], log: [], exitCode: 0, ...(await result) }
  },
}))
const { convertDisplaySetToNifti, frameGroupKey, loadConversion } =
  await import('./dicomToNiivue')
const { clearSharedTasks } = await import('./sharedTask')

// Header-only NIfTI-1 output; the voxel count breaks ties in the policy.
function output(stem: string, voxels: number): Series {
  const view = new DataView(new ArrayBuffer(352))
  view.setInt32(0, 348, true)
  view.setInt16(40, 1, true)
  view.setInt16(42, voxels, true)
  const name = `${stem}.nii`
  const image = Object.assign(new File([view.buffer], name), {
    relativePath: name,
  })
  return { stem, image }
}

const frames = 'https://h/dicomweb/studies/1/series/2/instances/3/frames/1'
const ds = { instances: [{ imageId: `wadors:${frames}` }] } as OhifDisplaySet
const realFetch = globalThis.fetch

function stubFetch(sop = '3') {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    return url.endsWith('/metadata')
      ? Response.json([{ '00080018': { vr: 'UI', Value: [sop] } }])
      : new Response(new Uint8Array(4))
  }) as unknown as typeof fetch
}

beforeEach(() => {
  // Every test converts the same display set; start each with a cold cache.
  clearSharedTasks()
  calls = []
  result = Promise.resolve({})
  stubFetch()
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('convertDisplaySetToNifti', () => {
  it('shows the policy pick and names the other outputs', async () => {
    result = Promise.resolve({
      series: [output('s_e2', 9), output('s', 4), output('s_ph', 9)],
    })
    const signal = new AbortController().signal
    const out = await convertDisplaySetToNifti(ds, { signal })
    expect(out?.image.name).toBe('s.nii') // no sidecars: echo 1 by stem wins
    expect(out?.note).toBe('Showing s; also converted: s_e2, s_ph.')
    expect(calls[0]?.args).toEqual(['-z', 'n'])
    // The shared conversion owns its signal; the caller's releases its hold.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  // R26 C38: a multi-frame output (a surview) beside a single-slice one was
  // left out of the stack, and an orientation-less page shown first hid both.
  it('stacks every mapped output and opens on one', async () => {
    // Axial outputs at z (LPS), dims 2 x 1 x nz; sform_code 0 without orientation.
    const axial = (stem: string, z: number, nz: number, code = 1) => {
      const v = new DataView(new ArrayBuffer(352))
      v.setInt32(0, 348, true)
      for (const [at, n] of [
        [40, 3],
        [42, 2],
        [44, 1],
        [46, nz],
        [254, code],
      ] as const)
        v.setInt16(at, n, true)
      for (let r = 0; r < 3; r++) v.setFloat32(280 + 20 * r, 1, true)
      v.setFloat32(324, z, true) // srow_z[3]
      const name = `${stem}.nii`
      return {
        stem,
        image: Object.assign(new File([v.buffer], name), {
          relativePath: name,
        }),
      }
    }
    result = Promise.resolve({
      series: [
        axial('page', 0, 9, 0),
        axial('one', 0, 1),
        axial('two', 5, 2),
        axial('resampled_Eq_1', 0.5, 2),
      ],
    })
    const instance = (sop: string, z: number) => ({
      imageId: `wadors:${frames}`,
      SOPInstanceUID: sop,
      ImagePositionPatient: [0, 0, z],
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    })
    const out = await convertDisplaySetToNifti({
      instances: [instance('3', 0), instance('4', 5), instance('5', 6)],
    } as unknown as OhifDisplaySet)
    expect(out?.image.name).toBe('two.nii')
    expect(out?.alternates?.map((a) => a.image.name)).toEqual(['one.nii'])
    // Two frames at one position (a 4D surview) map no slice: still shown
    // before the orientation-less page.
    clearSharedTasks()
    result = Promise.resolve({
      series: [axial('page', 0, 9, 0), axial('surview', 0, 1)],
    })
    const surview = await convertDisplaySetToNifti({
      instances: [instance('3', 0), instance('4', 0)],
    } as unknown as OhifDisplaySet)
    expect(surview?.image.name).toBe('surview.nii')
  })

  it('loads the outputs of a nonzero exit with a note', async () => {
    result = Promise.resolve({
      series: [output('a', 2)],
      exitCode: 8,
      log: ['Warning: slice 7 missing', 'Conversion required 0.1 seconds.'],
    })
    const out = await convertDisplaySetToNifti(ds)
    expect(out?.image.name).toBe('a.nii')
    expect(out?.note).toBe(
      'dcm2niix exit 8 (someOkSomeBad): Warning: slice 7 missing',
    )
  })

  it('rejects with the log tail when no image converted', async () => {
    result = Promise.resolve({ exitCode: 2, log: ['No valid DICOM images'] })
    await expect(convertDisplaySetToNifti(ds)).rejects.toThrow(
      'dcm2niix produced no image (exit 2 noValidFiles): No valid DICOM images',
    )
  })

  it('rejects with convert() rejection (abort, worker failure)', async () => {
    result = Promise.reject(new DOMException('cancelled', 'AbortError'))
    // Handled until convert() awaits it: as the first test, the fetches outlast
    // bun's unhandled-rejection check.
    result.catch(() => {})
    await expect(convertDisplaySetToNifti(ds)).rejects.toThrow('cancelled')
  })

  it('never converts when aborted while fetching', async () => {
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(
      convertDisplaySetToNifti(ds, { signal: abort.signal }),
    ).rejects.toThrow('cancelled')
    expect(calls).toHaveLength(0)
  })

  it('fetches a relative DICOMweb root from the page origin', async () => {
    const urls: string[] = []
    const stub = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(url)
      return stub(url, init)
    }) as unknown as typeof fetch
    result = Promise.resolve({ series: [output('rel', 3)] })
    Object.defineProperty(globalThis, 'location', {
      value: { href: 'https://h/viewer/niivue' },
      configurable: true,
    })
    try {
      await convertDisplaySetToNifti({
        instances: [
          {
            imageId: 'wadors:/dicomweb/studies/1/series/2/instances/3/frames/1',
          },
        ],
      } as OhifDisplaySet)
    } finally {
      Reflect.deleteProperty(globalThis, 'location')
    }
    expect(urls).toContain(frames)
  })

  it('fetches a just-saved instance (dicomfile: imageId) from its data source', async () => {
    const urls: string[] = []
    const stub = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(url)
      return stub(url, init)
    }) as unknown as typeof fetch
    result = Promise.resolve({ series: [output('saved', 3)] })
    const uids = {
      StudyInstanceUID: '1',
      SeriesInstanceUID: '2',
      SOPInstanceUID: '3',
    }
    await convertDisplaySetToNifti({
      wadoRoot: 'https://h/dicomweb',
      instances: [{ imageId: 'dicomfile:0', ...uids }],
    } as OhifDisplaySet)
    expect(urls).toContain(frames)
  })

  it('fetches frames 1..NumberOfFrames of a multi-frame instance into one file', async () => {
    const urls: string[] = []
    const stub = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      urls.push(url)
      return stub(url, init)
    }) as unknown as typeof fetch
    result = Promise.resolve({ series: [output('mf', 3)] })
    // OHIF's instance imageId is frame 1 even for a multi-frame instance.
    const mf = {
      instances: [
        { imageId: `wadors:${frames}`, NumberOfFrames: 3 },
        { imageId: `wadors:${frames}`, NumberOfFrames: 3 },
      ],
    } as OhifDisplaySet
    await convertDisplaySetToNifti(mf)
    expect(urls.filter((u) => u.includes('/frames/')).sort()).toEqual(
      [1, 2, 3].map((n) => frames.replace(/1$/, String(n))),
    )
    expect(inputs.map((f) => f.name)).toEqual(['3.dcm'])
  })

  // Review of #835: every output of a PET stack is in SUV, not just the first.
  it('scales stacked PET outputs to SUV', async () => {
    // One axial slice at the origin, identity sform: each output maps to SOP 3.
    const placed = (stem: string): Series => {
      const v = new DataView(new ArrayBuffer(352))
      v.setInt32(0, 348, true)
      // dim[0..3] = 3, 2, 1, 1; sform_code 1.
      for (const [at, n] of [
        [40, 3],
        [42, 2],
        [44, 1],
        [46, 1],
        [254, 1],
      ] as const)
        v.setInt16(at, n, true)
      v.setFloat32(112, 1, true) // scl_slope
      for (let r = 0; r < 3; r++) v.setFloat32(280 + 20 * r, 1, true) // srow
      const name = `${stem}.nii`
      const image = Object.assign(new File([v.buffer], name), {
        relativePath: name,
      })
      return { stem, image }
    }
    result = Promise.resolve({ series: [placed('a'), placed('b')] })
    const pet = {
      Modality: 'PT',
      instances: [
        {
          imageId: `wadors:${frames}`,
          SOPInstanceUID: '3',
          ImagePositionPatient: [0, 0, 0],
          ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
          Units: 'BQML',
          CorrectedImage: ['ATTN', 'DECY'],
          DecayCorrection: 'ADMIN',
          PatientWeight: 70,
          RadiopharmaceuticalInformationSequence: {
            RadionuclideTotalDose: 140000,
            RadionuclideHalfLife: 1000,
          },
        },
      ],
    } as unknown as OhifDisplaySet
    const out = await convertDisplaySetToNifti(pet)
    const slope = async (f?: Blob) =>
      f &&
      new DataView(await f.slice(0, 348).arrayBuffer()).getFloat32(112, true)
    expect(out?.alternates).toHaveLength(1)
    expect(await slope(out?.image)).toBe(0.5)
    expect(await slope(out?.alternates?.[0]?.image)).toBe(0.5)
    // The petSUV panel edits the weight in place: a reload of the cached
    // conversion takes the new factor.
    ;(pet.instances?.[0] as { PatientWeight: number }).PatientWeight = 140
    expect(await slope((await convertDisplaySetToNifti(pet))?.image)).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('shares a conversion only between identical inputs', async () => {
    let finish = () => {}
    result = new Promise((resolve) => {
      finish = () => resolve({ series: [output('v', 3)] })
    })
    const uid = { displaySetInstanceUID: 'ds1' }
    const one = { ...uid, instances: [{ imageId: `wadors:${frames}` }] }
    const three = {
      ...uid,
      instances: [{ imageId: `wadors:${frames}`, NumberOfFrames: 3 }],
    }
    const pending = [one, three, one].map((d) =>
      convertDisplaySetToNifti(d as OhifDisplaySet),
    )
    await Bun.sleep(0)
    finish()
    await Promise.all(pending)
    expect(calls).toHaveLength(2)
  })

  it('does not share a fetch across request headers', async () => {
    const auths: (string | null)[] = []
    const stub = globalThis.fetch
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      auths.push(new Headers(init?.headers).get('Authorization'))
      return stub(url, init)
    }) as unknown as typeof fetch
    let finish = () => {}
    result = new Promise((resolve) => {
      finish = () => resolve({ series: [output('h', 3)] })
    })
    const pending = ['Bearer old', 'Bearer new'].map((auth) =>
      convertDisplaySetToNifti(ds, { headers: { Authorization: auth } }),
    )
    await Bun.sleep(0)
    finish()
    await Promise.all(pending)
    expect(auths).toContain('Bearer new')
    expect(calls).toHaveLength(2)
  })

  it('is null without instances or reconstructed files', async () => {
    expect(await convertDisplaySetToNifti({} as OhifDisplaySet)).toBeNull()
    stubFetch('other-sop')
    expect(await convertDisplaySetToNifti(ds)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('loadConversion', () => {
  const map = { origin: [0, 0, 0], normal: [0, 0, 1], frames: [] } as never
  const converted = { image: new File([], 'a.nii'), sliceFrames: map }
  afterEach(() => unregisterNiivue('vp-lc'))

  it('publishes the slice map only after the volume loads', async () => {
    registerNiivue('vp-lc', {} as never)
    let release = () => {}
    const nv = {
      prepareVolume: async () => ({}),
      loadVolumes: () => new Promise<void>((r) => (release = r)),
    } as unknown as NiiVue
    const shown = loadConversion(nv, 'vp-lc', converted, undefined, () => false)
    await new Promise((r) => setTimeout(r)) // into loadVolumes
    expect(getNiivueEntry('vp-lc')?.sliceFrames).toBeUndefined()
    release()
    expect(await shown).toBe(true)
    expect(getNiivueEntry('vp-lc')?.sliceFrames).toBe(map)
  })

  it('leaves no slice map when the load fails or was cancelled', async () => {
    registerNiivue('vp-lc', {} as never)
    const failing = {
      prepareVolume: async () => ({}),
      loadVolumes: () => Promise.reject(new Error('bad')),
    } as unknown as NiiVue
    await expect(
      loadConversion(failing, 'vp-lc', converted, undefined, () => false),
    ).rejects.toThrow('bad')
    expect(getNiivueEntry('vp-lc')?.sliceFrames).toBeUndefined()
    const ok = {
      prepareVolume: async () => ({}),
      loadVolumes: () => Promise.resolve(),
    } as unknown as NiiVue
    expect(
      await loadConversion(ok, 'vp-lc', converted, undefined, () => true),
    ).toBe(false)
    expect(getNiivueEntry('vp-lc')?.sliceFrames).toBeUndefined()
  })

  it('does not install a volume prepared after the slot was swapped', async () => {
    registerNiivue('vp-lc', {} as never)
    let installs = 0
    const nv = {
      prepareVolume: async () => ({}),
      loadVolumes: async () => {
        installs++
      },
    } as unknown as NiiVue
    expect(
      await loadConversion(nv, 'vp-lc', converted, undefined, () => true),
    ).toBe(false)
    expect(installs).toBe(0)
  })
})

describe('frameGroupKey', () => {
  it('a re-made display set with other instances keys another 4D group', () => {
    const uid = { displaySetInstanceUID: 'ds1' }
    const other = {
      ...uid,
      instances: [{ imageId: `wadors:${frames.replace('/3/', '/4/')}` }],
    } as OhifDisplaySet
    const key = frameGroupKey({ ...ds, ...uid })
    expect(key).toBe(frameGroupKey({ ...ds, ...uid }))
    expect(key).not.toBe(frameGroupKey(other))
    expect(frameGroupKey(ds)).toBeUndefined()
  })
})
