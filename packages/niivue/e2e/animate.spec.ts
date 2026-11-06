import { expect } from '@playwright/test'
import { test } from './sharedPage'

// animateTo stops a transition on a press on the canvas, through listeners it
// adds to the canvas and removes when the transition ends. The planning,
// easing and timing are unit-tested in src/control/animate.test.ts against a
// fake clock, and the setters it drives in src/control/animateTo.test.ts.

// A visible canvas: a hidden page stops animation frames, which would turn
// every transition into a 'stalled' jump and test nothing in between.
const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 256
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([
    { url: '/volumes/mni152.nii.gz' },
    { url: '/volumes/mni152_gm.nii.gz', colormap: 'warm', opacity: 0 },
  ])
`

test('pressing on the canvas stops a transition where it is', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.scaleMultiplier = 1
    const running = nv.animateTo({ scaleMultiplier: 3 }, { duration: 2000, easing: 'linear' })
    await new Promise((res) => setTimeout(res, 300))
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const result = await running
    const stoppedAt = nv.scaleMultiplier
    await new Promise((res) => setTimeout(res, 200))
    // Listeners are gone once it ends: a later press does not touch the next one.
    const next = nv.animateTo({ scaleMultiplier: 1 }, { duration: 100, interruptOnInput: false })
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    return { result, stoppedAt, after: nv.scaleMultiplier, next: await next }
  })()`)
  expect(r.result).toMatchObject({ completed: false, reason: 'input' })
  expect(r.stoppedAt).toBeGreaterThan(1)
  expect(r.stoppedAt).toBeLessThan(3)
  expect(r.after).toBe(r.stoppedAt)
  expect(r.next).toMatchObject({ completed: true, reason: 'finished' })
})
