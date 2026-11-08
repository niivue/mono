import { expect } from '@playwright/test'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// animateTo stops a transition on a press on the canvas, through listeners it
// adds to the canvas and removes when the transition ends. The planning,
// easing and timing are unit-tested in src/control/animate.test.ts against a
// fake clock, and the setters it drives in src/control/animateTo.test.ts.

// A visible canvas: a hidden page stops animation frames, which would turn
// every transition into a 'stalled' jump and test nothing in between.
const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const synth = ${syntheticVolume}
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 256
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(canvas)
  await nv.loadVolumes([
    { url: synth() },
    { url: synth({ name: 'overlay.nii' }), colormap: 'warm', opacity: 0 },
  ])
  const frame = () => new Promise((r) => requestAnimationFrame(r))
`

test('pressing on the canvas stops a transition where it is', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.scaleMultiplier = 1
    const running = nv.animateTo({ scaleMultiplier: 3 }, { duration: 2000, easing: 'linear' })
    // Press once the transition has moved, so it stops part way.
    while (nv.scaleMultiplier === 1) await frame()
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    const result = await running
    const stoppedAt = nv.scaleMultiplier
    // A stopped transition draws no more steps: the frames it would have
    // drawn them in leave the value alone.
    await frame()
    await frame()
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
