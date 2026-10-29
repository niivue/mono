import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// volumeIsOverlayOpacityCorrected (issue #366): the overlay ray-march takes the
// background's step-size correction, so a translucent overlay's 3D density does
// not change with volumeSampleRate. Without it, more samples per voxel
// accumulate more alpha and the overlay darkens/saturates as the rate rises.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const SIZE = 256

/** One pixel of the page; see render-mode.spec.ts for why this decode works. */
async function probe(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  let colorType = 6
  const idat: Buffer[] = []
  for (let p = 8; p + 8 <= png.length; ) {
    const len = png.readUInt32BE(p)
    const type = png.toString('ascii', p + 4, p + 8)
    const body = png.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') colorType = body[9]
    if (type === 'IDAT') idat.push(body)
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  return Array.from(raw.subarray(1, 1 + (colorType === 6 ? 4 : 3)))
}

// The base is drawn at opacity 0 (skipped by the march), so the canvas shows
// only the overlay: the same head, thresholded and translucent, in red.
const mount = (backend: string): string => `(async () => {
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { ok: false, why: 'no navigator.gpu' }
    if (!(await navigator.gpu.requestAdapter())) return { ok: false, why: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const nextFrame = () => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)))
  const c = document.createElement('canvas')
  c.width = ${SIZE}; c.height = ${SIZE}
  c.style.cssText = 'position:fixed;top:0;left:0;width:${SIZE}px;height:${SIZE}px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: '${backend}',
    sliceType: SLICE_TYPE.RENDER,
    backgroundColor: [0, 0, 0, 1],
    azimuth: 120,
    elevation: 15,
  })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([
    { url: '/volumes/mni152.nii.gz', opacity: 0 },
    { url: '/volumes/mni152.nii.gz', colormap: 'red', calMin: 30, calMax: 80, opacity: 0.02 },
  ])
  await nextFrame()
  window.__nv = nv
  window.__set = async (rate, corrected) => {
    nv.volumeSampleRate = rate
    nv.volumeIsOverlayOpacityCorrected = corrected
    await nextFrame()
    await nextFrame()
  }
  return { ok: true, backend: nv.backend }
})()`

/** Red channel at a grid of points over the head. */
const GRID: [number, number][] = [
  [0.5, 0.5],
  [0.4, 0.35],
  [0.6, 0.35],
  [0.5, 0.7],
  [0.3, 0.5],
  [0.7, 0.5],
]
async function redAt(page: Page, rate: number, corrected: boolean) {
  await page.evaluate(`window.__set(${rate}, ${corrected})`)
  const out: number[] = []
  for (const [u, v] of GRID)
    out.push((await probe(page, u * SIZE, v * SIZE))[0])
  return out
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`overlay density is independent of sample rate (${backend})`, async ({
    page,
  }) => {
    const ready = await page.evaluate(mount(backend))
    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
    expect(ready.backend).toBe(backend)

    const on: Record<number, number[]> = {}
    const off: Record<number, number[]> = {}
    for (const rate of [1, 2, 4]) {
      on[rate] = await redAt(page, rate, true)
      off[rate] = await redAt(page, rate, false)
    }
    const maxDiff = (a: number[], b: number[]) =>
      Math.max(...a.map((v, i) => Math.abs(v - b[i])))
    // Something is drawn, so agreement below is not two black canvases.
    expect(Math.min(...on[1])).toBeGreaterThan(60)
    // Corrected: rates agree to within trilinear jitter (measured <= 2).
    expect(maxDiff(on[2], on[1])).toBeLessThanOrEqual(6)
    expect(maxDiff(on[4], on[1])).toBeLessThanOrEqual(6)
    // At one sample per voxel the exponent is 1, so the flag is a no-op.
    expect(maxDiff(off[1], on[1])).toBeLessThanOrEqual(2)
    // Uncorrected: density follows the rate (measured up to 40 levels at 4).
    expect(maxDiff(off[4], off[1])).toBeGreaterThan(15)
  })
}
