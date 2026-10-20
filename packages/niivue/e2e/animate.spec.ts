import { expect, test } from '@playwright/test'

// animateTo writes through the controller's public setters on real animation
// frames, so whether a transition lands on its target, and stops where it is
// told to, is only observable in a live instance. The planning, easing and
// timing are unit-tested in src/control/animate.test.ts against a fake clock;
// this holds the wiring: the setters it calls, the canvas listeners it adds
// and removes, and the handover between transitions.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

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

test('a transition lands every targeted property on its target', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.azimuth = 350
    const seen = []
    nv.addEventListener('azimuthElevationChange', (e) => seen.push(e.detail.azimuth))
    const result = await nv.animateTo({
      azimuth: 10,
      elevation: 30,
      crosshairMM: [10, -20, 30],
      clipPlanes: { 0: [0.1, 270, 0] },
      volumes: { 1: { opacity: 0.6, calMax: 0.9 } },
    }, { duration: 300 })
    return {
      result,
      azimuth: nv.azimuth,
      elevation: nv.elevation,
      crosshair: nv.getCrosshairPos(),
      clip: nv.getClipPlaneDepthAziElev(0),
      opacity: nv.volumes[1].opacity,
      calMax: nv.volumes[1].calMax,
      seen,
      animating: nv.isAnimating,
    }
  })()`)
  expect(r.result.completed).toBe(true)
  expect(r.result.reason).toBe('finished')
  expect(r.azimuth).toBe(10)
  expect(r.elevation).toBe(30)
  for (const [i, v] of r.crosshair.entries())
    expect(v).toBeCloseTo([10, -20, 30][i], 0)
  expect(r.clip[0]).toBeCloseTo(0.1, 5)
  expect(r.clip[1]).toBeCloseTo(270, 3)
  expect(r.opacity).toBe(0.6)
  expect(r.calMax).toBe(0.9)
  expect(r.animating).toBe(false)
  // Frames in between, turning the short way: through 360, never near 180.
  const between = r.seen.slice(0, -1)
  expect(between.length).toBeGreaterThan(2)
  for (const a of between) expect(Math.abs(a - 180)).toBeGreaterThan(150)
})

test('a new transition supersedes the running one', async ({ page }) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    ${setup}
    nv.azimuth = 0
    const first = nv.animateTo({ azimuth: 90 }, { duration: 2000 })
    await new Promise((res) => setTimeout(res, 200))
    const second = await nv.animateTo({ elevation: 40 }, { duration: 100 })
    return { first: await first, second, azimuth: nv.azimuth, elevation: nv.elevation }
  })()`)
  expect(r.first).toMatchObject({ completed: false, reason: 'superseded' })
  expect(r.second).toMatchObject({ completed: true, reason: 'finished' })
  // The first stopped part way, and the second did not touch azimuth.
  expect(r.azimuth).toBeGreaterThan(0)
  expect(r.azimuth).toBeLessThan(90)
  expect(r.elevation).toBe(40)
})

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

test('a 4D frame moves forward through the frames on the way', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const r = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 128; canvas.height = 128
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    await nv.loadVolumes([{ url: '/volumes/mpld_asl.nii.gz' }])
    const vol = nv.volumes[0]
    const frames = []
    nv.addEventListener('frameChange', (e) => frames.push(e.detail.frame))
    const last = vol.nFrame4D - 1
    const result = await nv.animateTo({ volumes: { 0: { frame4D: last } } }, { duration: 600, easing: 'linear' })
    return { result, frames, last, frame: vol.frame4D }
  })()`)
  expect(r.result.completed).toBe(true)
  expect(r.frame).toBe(r.last)
  // Frames only move forward and end on the last. One the GPU cannot keep up
  // with is skipped rather than queued, so steps may be larger than one.
  expect(r.frames.length).toBeGreaterThan(1)
  for (let i = 1; i < r.frames.length; i++)
    expect(r.frames[i]).toBeGreaterThan(r.frames[i - 1])
  expect(r.frames.at(-1)).toBe(r.last)
})
