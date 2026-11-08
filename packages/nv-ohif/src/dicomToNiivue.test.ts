import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { ConvertOptions, ConvertResult, Series } from '@niivue/dcm2niix'
import type { OhifDisplaySet } from './ohif-types'

// Stands in for dcm2niix's convert(): each test sets the result it resolves to.
let result: Promise<Partial<ConvertResult>>
let calls: ConvertOptions[]
mock.module('@niivue/dcm2niix', () => ({
  exitCodes: { ok: 0, noValidFiles: 2, someOkSomeBad: 8 },
  convert: async (_files: File[], options: ConvertOptions) => {
    calls.push(options)
    return { series: [], log: [], exitCode: 0, ...(await result) }
  },
}))
const { convertDisplaySetToNifti } = await import('./dicomToNiivue')

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

  it('is null without instances or reconstructed files', async () => {
    expect(await convertDisplaySetToNifti({} as OhifDisplaySet)).toBeNull()
    stubFetch('other-sop')
    expect(await convertDisplaySetToNifti(ds)).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
