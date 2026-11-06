import { expect } from '@playwright/test'
import { test } from './sharedPage'

// A GPU update that arrives while another holds the update lock is coalesced
// into one follow-up. Its caller must settle with that follow-up (#447), and a
// follow-up failure must reach its own callers, not the first one (#273).
// Those rules are tested against a fake view in src/updateLock.test.ts; these
// keep the cases where a real view is recreated or destroyed under the lock.

for (const end of ['view recreation', 'destroy'] as const) {
  test(`a follow-up stuck on its view still settles its callers on ${end}`, async ({
    page,
  }) => {
    const r = await page.evaluate(async (end) => {
      const { default: NiiVue } = await import('/src/index.ts')
      const canvas = document.createElement('canvas')
      canvas.style.cssText = 'width:200px;height:200px'
      document.body.appendChild(canvas)
      const nv = new NiiVue({ backend: 'webgl2' })
      await nv.attachToCanvas(canvas)
      await nv.loadVolumes([{ url: '/volumes/sphere.nii.gz' }])
      const view = nv.view as unknown as {
        updateBindGroups: (o?: unknown) => Promise<void>
      }
      const rebuild = view.updateBindGroups.bind(view)
      let calls = 0
      // The follow-up's rebuild never settles, as on a lost device.
      view.updateBindGroups = (o) =>
        ++calls === 2 ? new Promise(() => {}) : rebuild(o)
      nv.volumeIsBackgroundMasking = true
      const queued = nv.updateGLVolume().then(
        () => 'ok',
        (e: Error) => e.message,
      )
      while (calls < 2) await new Promise((r) => setTimeout(r, 10))
      if (end === 'destroy') nv.destroy()
      else await nv.reinitializeView({ forceRestart: true })
      const late = () => new Promise((r) => setTimeout(() => r('stuck'), 3000))
      return {
        queued: await Promise.race([queued, late()]),
        settled: await Promise.race([
          nv.whenUpdatesSettle().then(() => 'ok'),
          late(),
        ]),
      }
    }, end)
    expect(r).toEqual({ queued: 'ok', settled: 'ok' })
  })
}

test('whenUpdatesSettle waits for the rebuild that took over its pass', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'width:200px;height:200px'
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    type View = { updateBindGroups: (o?: unknown) => Promise<void> }
    const internals = nv as unknown as {
      view: View
      _rebuildViewResources: () => Promise<void>
    }
    let releaseOld = () => {}
    let releaseNew = () => {}
    const oldGate = new Promise<void>((r) => {
      releaseOld = r
    })
    const newGate = new Promise<void>((r) => {
      releaseNew = r
    })
    internals.view.updateBindGroups = () => oldGate
    const old = nv.updateGLVolume()
    let settled = false
    const wait = nv.whenUpdatesSettle().then(() => {
      settled = true
    })
    // Gate the recreated view's resource rebuild, which takes over the lock.
    let newStarted = false
    let newFinished = false
    const takeover = internals._rebuildViewResources.bind(nv)
    internals._rebuildViewResources = async () => {
      const update = internals.view.updateBindGroups.bind(internals.view)
      internals.view.updateBindGroups = async (o) => {
        newStarted = true
        await newGate
        await update(o)
        newFinished = true
      }
      return takeover()
    }
    const replaced = nv.reinitializeView({ forceRestart: true })
    while (!newStarted) await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 10))
    const early = { settled, newFinished }
    releaseNew()
    await replaced
    await wait
    const after = { settled, newFinished }
    releaseOld()
    await old
    nv.destroy()
    return { early, after }
  })
  expect(r).toEqual({
    early: { settled: false, newFinished: false },
    after: { settled: true, newFinished: true },
  })
})

for (const oldResult of ['resolve', 'reject']) {
  for (const newResult of ['resolve', 'reject']) {
    test(`replacement owns its caller when old=${oldResult}, new=${newResult}`, async ({
      page,
    }) => {
      const r = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    const original = nv.view.updateBindGroups.bind(nv.view)
    let resolveOld, rejectOld, releaseNew, calls = 0, newStarted = false
    const oldGate = new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject })
    const newGate = new Promise(resolve => { releaseNew = resolve })
    nv.view.updateBindGroups = o => ++calls === 2 ? oldGate : original(o)
    const first = nv.updateGLVolume()
    let outcome = 'pending'
    const queued = nv.updateGLVolume().then(() => { outcome = 'ok' }, e => { outcome = e.message })
    while (calls < 2) await new Promise(r => setTimeout(r, 0))
    const takeover = nv._rebuildViewResources.bind(nv)
    nv._rebuildViewResources = async () => {
      const update = nv.view.updateBindGroups.bind(nv.view)
      nv.view.updateBindGroups = async o => {
        newStarted = true
        await newGate
        if ('${newResult}' === 'reject') throw new Error('replacement failed')
        return update(o)
      }
      return takeover()
    }
    const recreated = nv.reinitializeView({ forceRestart: true })
    while (!newStarted) await new Promise(r => setTimeout(r, 0))
    if ('${oldResult}' === 'reject') rejectOld(new Error('old device lost'))
    else resolveOld()
    await new Promise(r => setTimeout(r, 10))
    const beforeReplacement = outcome
    releaseNew()
    await recreated
    await queued
    await first
    const retained = nv._servingWaiters.size
    nv.destroy()
    return { beforeReplacement, outcome, retained }
  })()`)
      expect(r.beforeReplacement).toBe('pending')
      expect(r.outcome).toBe(
        newResult === 'resolve' ? 'ok' : 'replacement failed',
      )
      expect(r.retained).toBe(0)
    })
  }
}
