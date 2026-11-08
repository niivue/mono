// Page-wide workers live exactly as long as some NiiVue does.

import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import type { NIFTI1 } from '@/NVTypes'
import { NVWorker } from './NVWorker'
import { PageWorker } from './pageWorker'

// A private copy of the module, so this file's hold counts start at zero
// whatever other test files in the process attached.
const isolated: string = './pageWorker?isolated'
const fresh = (await import(isolated)) as typeof import('./pageWorker')
const { retainPageWorkers, releasePageWorkers } = fresh

const workers = new Set<NVWorker>()
let terminated = 0
let spies: { mockRestore: () => void }[] = []
beforeEach(() => {
  workers.clear()
  terminated = 0
  spies = [
    spyOn(NVWorker, 'isSupported').mockReturnValue(true),
    spyOn(NVWorker.prototype, 'execute').mockImplementation(function (
      this: NVWorker,
    ) {
      workers.add(this)
      return new Promise((resolve) =>
        setTimeout(() => resolve({ volume: { hdr: {}, img: null } })),
      ) as never
    }),
    spyOn(NVWorker.prototype, 'terminate').mockImplementation(() => {
      terminated++
    }),
  ]
})
afterEach(() => {
  for (const s of spies) s.mockRestore()
})

const make = () => new fresh.PageWorker(() => ({}) as Worker)

test('created on first task, kept by a live instance, ended by the last release', async () => {
  const worker = make()
  retainPageWorkers()
  retainPageWorkers()
  await worker.execute({})
  expect(workers.size).toBe(1)
  releasePageWorkers()
  expect(terminated).toBe(0)
  await worker.execute({})
  expect(workers.size).toBe(1)
  releasePageWorkers()
  expect(terminated).toBe(1)
  retainPageWorkers()
  await worker.execute({})
  expect(workers.size).toBe(2)
  releasePageWorkers()
  expect(terminated).toBe(2)
})

test('a task in flight at the last release finishes on the worker', async () => {
  const worker = make()
  retainPageWorkers()
  const pending = worker.execute({})
  releasePageWorkers()
  expect(terminated).toBe(0)
  await pending
  expect(terminated).toBe(1)
})

test('one release ends every idle page worker', async () => {
  retainPageWorkers()
  await make().execute({})
  await make().execute({})
  releasePageWorkers()
  expect(terminated).toBe(2)
})

test('volume loads and built-in transforms run on page workers', async () => {
  const pageExecute = spyOn(PageWorker.prototype, 'execute')
  const { loadVolumePrepared } = await import('@/volume/loadBridge')
  await loadVolumePrepared('a.nii')
  expect(pageExecute).toHaveBeenCalledTimes(1)
  // The built-in registry is empty today; register a probe before a fresh
  // registry copy reads it.
  const { transformModules } = await import('@/volume/transforms/_registry')
  transformModules['probe.ts'] = {
    name: 'probe',
    description: '',
    apply: async (hdr, img) => ({ hdr, img: img as Uint8Array }),
  }
  try {
    const registry: string = '@/volume/transforms/index?probe'
    const { applyTransform } = (await import(
      registry
    )) as typeof import('@/volume/transforms')
    await applyTransform('probe', {} as NIFTI1, new Uint8Array(1))
    expect(pageExecute).toHaveBeenCalledTimes(2)
  } finally {
    delete transformModules['probe.ts']
    pageExecute.mockRestore()
  }
})

test('a NiiVue holds the workers from attach to destroy, once', async () => {
  const shared = await import('./pageWorker')
  const retain = spyOn(shared, 'retainPageWorkers')
  const release = spyOn(shared, 'releasePageWorkers')
  try {
    const { default: NiiVue } = await import('@/NVControlBase')
    // Never attached: holds nothing, so destroy releases nothing.
    new NiiVue({}, {} as never).destroy()
    expect(retain).toHaveBeenCalledTimes(0)
    expect(release).toHaveBeenCalledTimes(0)
    // A failed attach lets its hold go at once, so a viewer dropped without
    // destroy() (a backend fallback) cannot keep the workers alive.
    const nv = new NiiVue({}, {} as never)
    await nv.attachToCanvas({} as HTMLCanvasElement).catch(() => {})
    expect(retain).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    await nv.attachTo('missing-canvas-id').catch(() => {})
    expect(retain).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
    nv.destroy()
    nv.destroy()
    expect(release).toHaveBeenCalledTimes(2)
    // A viewer that stays attached holds once, however often it re-attaches,
    // until destroy.
    const held = new NiiVue({}, { attachToCanvas: async () => {} } as never)
    await held.attachToCanvas({} as HTMLCanvasElement)
    await held.attachToCanvas({} as HTMLCanvasElement)
    expect(retain).toHaveBeenCalledTimes(3)
    held.destroy()
    expect(release).toHaveBeenCalledTimes(3)
    // Overlapping attaches: the first rejects while the second is pending, so
    // the hold stays until the second settles (here: succeeds) and destroy.
    let rejectFirst = (_: Error): void => {}
    let resolveSecond = (): void => {}
    const pending = [
      new Promise<void>((_, rej) => {
        rejectFirst = rej
      }),
      new Promise<void>((res) => {
        resolveSecond = res
      }),
    ]
    const racing = new NiiVue({}, {
      attachToCanvas: () => pending.shift(),
    } as never)
    const first = racing.attachToCanvas({} as HTMLCanvasElement)
    const second = racing.attachToCanvas({} as HTMLCanvasElement)
    rejectFirst(new Error('no adapter'))
    await first.catch(() => {})
    expect(release).toHaveBeenCalledTimes(3)
    resolveSecond()
    await second
    expect(release).toHaveBeenCalledTimes(3)
    racing.destroy()
    expect(retain).toHaveBeenCalledTimes(4)
    expect(release).toHaveBeenCalledTimes(4)
    // An attach that fails after an earlier one succeeded keeps the hold.
    const reattach = new NiiVue({}, {
      attachToCanvas: (() => {
        let n = 0
        return async () => {
          if (n++ > 0) throw new Error('lost context')
        }
      })(),
    } as never)
    await reattach.attachToCanvas({} as HTMLCanvasElement)
    await reattach.attachToCanvas({} as HTMLCanvasElement).catch(() => {})
    expect(release).toHaveBeenCalledTimes(4)
    reattach.destroy()
    expect(retain).toHaveBeenCalledTimes(5)
    expect(release).toHaveBeenCalledTimes(5)
    // A backend constructor that refuses (WebGPU build without WebGPU) holds
    // nothing, so a fallback viewer's destroy can end the workers.
    const { default: GPU } = await import('@/NVControlWebGPU')
    expect(() => new GPU()).toThrow()
    expect(retain).toHaveBeenCalledTimes(5)
  } finally {
    retain.mockRestore()
    release.mockRestore()
  }
})
