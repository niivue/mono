import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// whenChunkStreamSettles (and setVolumeChunkGrid, which awaits it) must resolve
// once the stream is idle, not only once every brick is resident, and not
// before the frame on screen is final.
//
// A 2D slice view needs only the bricks its plane crosses, so the stream goes
// idle with fewer bricks resident than the plan holds, and no busy frame (the
// kind `chunkStreamIdle` follows) need ever be drawn. A wait keyed to that
// event alone sits out its 30 s timeout. A wait keyed to the raw counts
// instead resolves while a brick is still cross-fading in over the coarse
// floor, so a screenshot taken then differs from the settled view. The wait
// resolves on the first frame the view itself calls settled.
//
// The volume is a synthetic 64^3 NIfTI built in the page, so the spec needs no
// Git LFS data and no network. The 3D case is the one the wait exists for: a
// screenshot after setVolumeChunkGrid must show every brick.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// A third of the 30 s timeout; a SwiftShader WebGPU 3D fill takes 2-4 s.
const SETTLE_BUDGET_MS = 10_000
// Long enough that a resolve mid-fade is plain, and longer than the frames a
// SwiftShader WebGPU view needs before it settles.
const FADE_MS = 3000

/** The one pixel at (x, y) of the page, decoded from a 1x1 PNG. */
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

const mount = (backend: string, sliceType: string, opts = ''): string => `
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { skip: 'no navigator.gpu' }
    let adapter = null
    try { adapter = await navigator.gpu.requestAdapter() }
    catch (e) { return { skip: 'requestAdapter threw: ' + e } }
    if (!adapter) return { skip: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const N = 64, VOX_OFFSET = 352
  const raw = new Uint8Array(VOX_OFFSET + N * N * N)
  const dv = new DataView(raw.buffer)
  dv.setInt32(0, 348, true)
  ;[3, N, N, N, 1, 1, 1, 1].forEach((d, i) => dv.setInt16(40 + i * 2, d, true))
  dv.setInt16(70, 2, true)   // DT_UINT8
  dv.setInt16(72, 8, true)   // bitpix
  ;[1, 1, 1, 1, 1, 1, 1, 1].forEach((p, i) => dv.setFloat32(76 + i * 4, p, true))
  dv.setFloat32(108, VOX_OFFSET, true)
  dv.setFloat32(112, 1, true)
  raw.set(new TextEncoder().encode('n+1\\0'), 344)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x - N / 2, y - N / 2, z - N / 2)
    raw[VOX_OFFSET + x + y * N + z * N * N] = r < N * 0.45 ? 50 + ((x + y + z) % 200) : 0
  }
  const file = new File([raw], 'synth.nii')
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 256
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:256px;height:256px'
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: '${backend}', sliceType: SLICE_TYPE.${sliceType}, ${opts} })
  await nv.attachToCanvas(canvas)
  if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
    return { skip: 'WebGPU init fell back to ' + nv.backend }
  }
  await nv.loadVolumes([{ url: file, name: 'synth.nii' }])
  const timed = async (fn) => {
    const t0 = performance.now()
    await fn()
    return Math.round(performance.now() - t0)
  }
  const counts = () => {
    const s = nv.chunkStreamStats()
    return { resident: s.resident, pending: s.pending, inFlight: s.inFlight, total: s.total }
  }
`

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`settles promptly when a 2D view needs only some bricks (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const result = await page.evaluate(`(async () => {
      try {
        ${mount(backend, 'AXIAL')}
        // The axial plane through the centre crosses half of a 2x2x4 grid.
        const gridMs = await timed(() => nv.setVolumeChunkGrid(0, [2, 2, 4]))
        const afterGrid = counts()
        const settleMs = await timed(() => nv.whenChunkStreamSettles())
        return { gridMs, afterGrid, settleMs, afterSettle: counts() }
      } catch (e) {
        const m = String(e && e.message ? e.message : e)
        if (/no longer exists|device (is )?lost|adapter/i.test(m)) {
          return { skip: 'GPU unavailable: ' + m }
        }
        throw e
      }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }
    // Guard: the scenario really is idle with bricks left over.
    expect(r.afterSettle.pending + r.afterSettle.inFlight).toBe(0)
    expect(r.afterSettle.resident).toBeLessThan(r.afterSettle.total)
    expect(r.gridMs).toBeLessThan(SETTLE_BUDGET_MS)
    expect(r.settleMs).toBeLessThan(SETTLE_BUDGET_MS)
  })

  test(`setVolumeChunkGrid resolves when the first brick is all a 2D view needs (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const result = await page.evaluate(`(async () => {
      try {
        ${mount(backend, 'AXIAL')}
        // An axial plane low in a 1x1x4 grid lies in brick 0 alone, the brick
        // the renderer admits when the plan is set: no frame is ever busy.
        nv.crosshairPos = [0.5, 0.5, 0.1]
        const gridMs = await timed(() => nv.setVolumeChunkGrid(0, [1, 1, 4]))
        return { gridMs, afterGrid: counts() }
      } catch (e) {
        const m = String(e && e.message ? e.message : e)
        if (/no longer exists|device (is )?lost|adapter/i.test(m)) {
          return { skip: 'GPU unavailable: ' + m }
        }
        throw e
      }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }
    expect(r.afterGrid.pending + r.afterGrid.inFlight).toBe(0)
    expect(r.afterGrid.resident).toBeLessThan(r.afterGrid.total)
    expect(r.gridMs).toBeLessThan(SETTLE_BUDGET_MS)
  })

  test(`setVolumeChunkGrid resolves with every 3D brick resident (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const result = await page.evaluate(`(async () => {
      try {
        ${mount(backend, 'RENDER')}
        const gridMs = await timed(() => nv.setVolumeChunkGrid(0, [2, 2, 2]))
        return { gridMs, afterGrid: counts() }
      } catch (e) {
        const m = String(e && e.message ? e.message : e)
        if (/no longer exists|device (is )?lost|adapter/i.test(m)) {
          return { skip: 'GPU unavailable: ' + m }
        }
        throw e
      }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }
    expect(r.afterGrid).toEqual({
      resident: 8,
      pending: 0,
      inFlight: 0,
      total: 8,
    })
    expect(r.gridMs).toBeLessThan(SETTLE_BUDGET_MS)
    // One probe inside each quadrant of the ball: every one is drawn.
    const px = await Promise.all(
      [
        [108, 108],
        [148, 108],
        [108, 148],
        [148, 148],
      ].map(([x, y]) => probe(page, x, y)),
    )
    for (const [red] of px) expect(red).toBeGreaterThan(40)
  })

  test(`setVolumeChunkGrid waits for the first brick to fade in over the coarse floor (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const result = await page.evaluate(`(async () => {
      try {
        ${mount(backend, 'AXIAL', `chunkFadeMs: ${FADE_MS}`)}
        // A flat floor, so the brick fading in over it changes the pixel. A
        // clone of the loaded volume with its own voxels, as an app supplies a
        // pyramid level (not one of nv.volumes).
        const v = nv.volumes[0]
        const floor = Object.assign(Object.create(Object.getPrototypeOf(v)), v, {
          img: v.img.map((x) => (x > 0 ? 250 : 0)),
        })
        await nv.setBaseCoarseFloor(floor)
        // Brick 0 alone holds this plane: no frame is ever busy, so only the
        // drawn frame's verdict can say the fade is still running.
        nv.crosshairPos = [0.5, 0.5, 0.1]
        const gridMs = await timed(() => nv.setVolumeChunkGrid(0, [1, 1, 4]))
        return { gridMs, afterGrid: counts() }
      } catch (e) {
        const m = String(e && e.message ? e.message : e)
        if (/no longer exists|device (is )?lost|adapter/i.test(m)) {
          return { skip: 'GPU unavailable: ' + m }
        }
        throw e
      }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }
    const atResolve = await probe(page, 128, 128)
    // Guard: the scenario is the no-new-work one, with bricks left over.
    expect(r.afterGrid.pending + r.afterGrid.inFlight).toBe(0)
    expect(r.afterGrid.resident).toBeLessThan(r.afterGrid.total)
    // What the call resolved on is what stays on screen once the fade is over.
    await page.waitForTimeout(FADE_MS + 500)
    expect(atResolve).toEqual(await probe(page, 128, 128))
    // The fade starts when the brick is admitted, inside the call.
    expect(r.gridMs).toBeGreaterThan(FADE_MS * 0.9)
    expect(r.gridMs).toBeLessThan(FADE_MS + SETTLE_BUDGET_MS)
  })
}
