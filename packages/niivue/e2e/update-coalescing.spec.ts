import { expect, test } from '@playwright/test'

// A GPU update that arrives while another holds the update lock is coalesced
// into one follow-up. Its caller must settle with that follow-up (#447), and a
// follow-up failure must reach its own callers, not the first one (#273).

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('a queued update settles with the follow-up that carries it', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
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
    const log: string[] = []
    let calls = 0
    view.updateBindGroups = async (o) => {
      const n = ++calls
      await rebuild(o)
      log.push(`rebuild ${n}`)
      if (n === 4) throw new Error('fourth rebuild failed')
    }
    const settled = (name: string, p: Promise<unknown>) =>
      p.then(
        () => log.push(`${name} ok`),
        (e: Error) => log.push(`${name} ${e.message}`),
      )
    // A setter that starts a rebuild without being awaited (#447 repro).
    nv.volumeIsBackgroundMasking = true
    await settled('queued', nv.updateGLVolume())
    // Now one update fails while queued behind another (#273).
    await Promise.all([
      settled('first', nv.updateGLVolume()),
      settled('second', nv.updateGLVolume()),
    ])
    return log
  })
  expect(r).toEqual([
    'rebuild 1',
    'rebuild 2',
    'queued ok',
    'rebuild 3',
    'rebuild 4',
    'second fourth rebuild failed',
    'first ok',
  ])
})

test('whenUpdatesSettle waits for a rebuild a setter started', async ({
  page,
}) => {
  const r = await page.evaluate(async () => {
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
    const log: string[] = []
    view.updateBindGroups = async (o) => {
      await rebuild(o)
      log.push('rebuild')
    }
    // The second setter queues a follow-up behind the first rebuild.
    nv.volumeIsBackgroundMasking = true
    nv.volumeIsBackgroundMasking = false
    await nv.whenUpdatesSettle()
    log.push('settled')
    return log
  })
  expect(r).toEqual(['rebuild', 'rebuild', 'settled'])
})

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
