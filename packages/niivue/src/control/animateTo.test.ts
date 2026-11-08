import { afterEach, expect, jest, test } from 'bun:test'
import NiiVue from '@/index'
import type { AnimationResult } from '@/NVTypes'
import { devImageUrl, niftiBytes } from '@/testing/headless'

// animateTo writes through the controller's public setters on animation
// frames. The planning, easing and timing are unit-tested in animate.test.ts
// against a fake clock; this holds the wiring through a real controller: the
// setters it calls and the handover between transitions. Stopping on canvas
// input needs a canvas and stays in e2e/animate.spec.ts.
//
// Frames are driven by hand: Bun's fake timers fake both the preload's
// requestAnimationFrame stand-in (a timer) and performance.now (the
// transition clock), so each step below is one 16 ms frame, the same on any
// machine.

const FRAME_MS = 16

afterEach(() => jest.useRealTimers())

/** Let promise work settle; setImmediate is not faked. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

/** Advance `n` frames, letting each frame's setter work land. */
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    jest.advanceTimersByTime(FRAME_MS)
    await settle()
  }
}

/** Advance frames until `p` settles (bounded, so a hang fails the test). */
async function untilDone<T>(p: Promise<T>): Promise<T> {
  let done = false
  void p.then(() => {
    done = true
  })
  for (let i = 0; i < 1000 && !done; i++) await frames(1)
  expect(done).toBe(true)
  return p
}

async function twoVolumes(): Promise<NiiVue> {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([
    { url: devImageUrl('volumes/hippo.nii.gz') },
    { url: devImageUrl('volumes/sphere.nii.gz'), colormap: 'warm', opacity: 0 },
  ])
  jest.useFakeTimers()
  return nv
}

test('a transition lands every targeted property on its target', async () => {
  const nv = await twoVolumes()
  nv.azimuth = 350
  const seen: number[] = []
  nv.addEventListener('azimuthElevationChange', (e) =>
    seen.push(e.detail.azimuth),
  )
  const result = await untilDone(
    nv.animateTo(
      {
        azimuth: 10,
        elevation: 30,
        crosshairMM: [10, -20, 30],
        clipPlanes: { 0: [0.1, 270, 0] },
        volumes: { 1: { opacity: 0.6, calMax: 0.9 } },
      },
      { duration: 300 },
    ),
  )

  expect(result.completed).toBe(true)
  expect(result.reason).toBe('finished')
  expect(nv.azimuth).toBe(10)
  expect(nv.elevation).toBe(30)
  const crosshair = nv.getCrosshairPos()
  for (const [i, v] of [10, -20, 30].entries())
    expect(crosshair[i]).toBeCloseTo(v, 0)
  const clip = nv.getClipPlaneDepthAziElev(0)
  expect(clip[0]).toBeCloseTo(0.1, 5)
  expect(clip[1]).toBeCloseTo(270, 3)
  expect(nv.volumes[1].opacity).toBe(0.6)
  expect(nv.volumes[1].calMax).toBe(0.9)
  expect(nv.isAnimating).toBe(false)
  // Frames in between (300 ms of 16 ms frames), turning the short way:
  // through 360, never near 180.
  const between = seen.slice(0, -1)
  expect(between.length).toBeGreaterThan(10)
  for (const a of between) expect(Math.abs(a - 180)).toBeGreaterThan(150)
})

test('a new transition supersedes the running one', async () => {
  const nv = await twoVolumes()
  nv.azimuth = 0
  const first = nv.animateTo({ azimuth: 90 }, { duration: 2000 })
  // Part way: 200 ms into a 2 s transition.
  await frames(200 / FRAME_MS)
  const midway = nv.azimuth
  const second = await untilDone(
    nv.animateTo({ elevation: 40 }, { duration: 100 }),
  )
  const firstResult: AnimationResult = await first

  expect(firstResult).toMatchObject({ completed: false, reason: 'superseded' })
  expect(second).toMatchObject({ completed: true, reason: 'finished' })
  // The first stopped part way, and the second did not touch azimuth.
  expect(midway).toBeGreaterThan(0)
  expect(midway).toBeLessThan(90)
  expect(nv.azimuth).toBe(midway)
  expect(nv.elevation).toBe(40)
})

test('a 4D frame moves forward through the frames on the way', async () => {
  // 8x8x8 voxels, 12 frames.
  const FRAMES = 12
  const file = new File(
    [
      niftiBytes({
        dims: [8, 8, 8, FRAMES],
        datatype: 'uint8',
        voxel: (i) => i % 251,
      }),
    ],
    'frames.nii',
  )
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: file }])
  jest.useFakeTimers()
  const vol = nv.volumes[0]
  const seen: number[] = []
  nv.addEventListener('frameChange', (e) => seen.push(e.detail.frame))
  const last = (vol.nFrame4D ?? 0) - 1
  expect(last).toBe(FRAMES - 1)
  const result = await untilDone(
    nv.animateTo(
      { volumes: { 0: { frame4D: last } } },
      { duration: 600, easing: 'linear' },
    ),
  )

  expect(result.completed).toBe(true)
  expect(vol.frame4D).toBe(last)
  // Frames only move forward and end on the last. One the GPU cannot keep up
  // with is skipped rather than queued, so steps may be larger than one.
  expect(seen.length).toBeGreaterThan(1)
  for (let i = 1; i < seen.length; i++)
    expect(seen[i]).toBeGreaterThan(seen[i - 1])
  expect(seen.at(-1)).toBe(last)
})
