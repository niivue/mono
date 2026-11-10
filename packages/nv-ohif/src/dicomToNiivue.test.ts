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
const { convertDisplaySetToNifti, loadConversion } = await import(
  './dicomToNiivue'
)

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
    expect(calls[0]?.signal).toBe(signal)
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
