import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type { OhifDisplaySet } from './ohif-types'

// A controllable stand-in for the dcm2niix worker wrapper.
let initGate: PromiseWithResolvers<true>
let runGate: PromiseWithResolvers<File[]>
let terminated: number
let runs: number
let initStarted: boolean
class FakeDcm2niix {
  worker: { terminate: () => void } | null = null
  init() {
    created++
    initStarted = true
    this.worker = { terminate: () => terminated++ }
    return initGate.promise
  }
  input(_files: File[]) {
    return {
      run: () => {
        runs++
        return runGate.promise
      },
    }
  }
}
let created = 0
// Holds the first dynamic import open, so a test can fail the fetch before the
// module lands. The import is cached afterwards, so that test must run first.
const importGate = Promise.withResolvers<void>()
mock.module('@niivue/dcm2niix', async () => {
  await importGate.promise
  return { Dcm2niix: FakeDcm2niix }
})
const { convertDisplaySetToNifti } = await import('./dicomToNiivue')

const frames = 'https://h/dicomweb/studies/1/series/2/instances/3/frames/1'
const ds = { instances: [{ imageId: `wadors:${frames}` }] } as OhifDisplaySet
const realFetch = globalThis.fetch
let fetchGate: PromiseWithResolvers<void>
const flush = () => new Promise((r) => setTimeout(r, 0))

function stubFetch(sop = '3') {
  globalThis.fetch = (async (url: string) => {
    await fetchGate.promise
    return url.endsWith('/metadata')
      ? Response.json([{ '00080018': { vr: 'UI', Value: [sop] } }])
      : new Response(new Uint8Array(4))
  }) as unknown as typeof fetch
}

beforeEach(() => {
  initGate = Promise.withResolvers()
  runGate = Promise.withResolvers()
  fetchGate = Promise.withResolvers()
  terminated = 0
  runs = 0
  initStarted = false
  stubFetch()
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('convertDisplaySetToNifti (#121)', () => {
  // Must stay first: later tests see the cached import.
  it('terminates a worker whose import lands after the fetch failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(convertDisplaySetToNifti(ds)).rejects.toThrow('offline')
    importGate.resolve()
    for (let i = 0; i < 5; i++) await flush()
    expect(created).toBe(1)
    expect(terminated).toBe(1)
  })

  it('boots dcm2niix while fetching, converts, then terminates', async () => {
    const out = convertDisplaySetToNifti(ds)
    await flush()
    expect(initStarted).toBe(true) // fetch still pending
    fetchGate.resolve()
    initGate.resolve(true)
    runGate.resolve([
      new File(['a'], 'a.nii'),
      new File(['bigger'], 'b.nii.gz'),
      new File(['{}'], 'b.json'),
    ])
    expect((await out)?.name).toBe('b.nii.gz')
    expect(terminated).toBe(1)
  })

  it('skips dcm2niix entirely when there are no instances', async () => {
    expect(await convertDisplaySetToNifti({} as OhifDisplaySet)).toBeNull()
    await flush()
    expect(initStarted).toBe(false)
  })

  it('terminates the speculative worker when no files reconstruct', async () => {
    stubFetch('other-sop')
    fetchGate.resolve()
    expect(await convertDisplaySetToNifti(ds)).toBeNull()
    initGate.resolve(true)
    await flush()
    expect(terminated).toBe(1)
  })

  it('rejects with the fetch error and terminates the worker', async () => {
    globalThis.fetch = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    await expect(convertDisplaySetToNifti(ds)).rejects.toThrow('offline')
    await flush()
    expect(terminated).toBe(1)
  })

  it('rejects with the init error once fetching settles', async () => {
    const out = convertDisplaySetToNifti(ds)
    initGate.reject(new Error('wasm failed'))
    await flush()
    fetchGate.resolve()
    await expect(out).rejects.toThrow('wasm failed')
    expect(terminated).toBe(1)
  })

  it('rejects with the abort reason during conversion and terminates', async () => {
    const abort = new AbortController()
    const out = convertDisplaySetToNifti(ds, { signal: abort.signal })
    fetchGate.resolve()
    initGate.resolve(true)
    await flush()
    abort.abort(new Error('cancelled'))
    await expect(out).rejects.toThrow('cancelled')
    expect(terminated).toBe(1)
  })
  it('never runs dcm2niix when the converting callback aborts', async () => {
    const abort = new AbortController()
    const out = convertDisplaySetToNifti(ds, {
      signal: abort.signal,
      onProgress: (stage) => {
        if (stage === 'converting') abort.abort(new Error('cancelled'))
      },
    })
    fetchGate.resolve()
    await expect(out).rejects.toThrow('cancelled')
    initGate.resolve(true)
    for (let i = 0; i < 5; i++) await flush()
    expect(runs).toBe(0)
    expect(terminated).toBe(1)
  })
})
