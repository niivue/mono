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
