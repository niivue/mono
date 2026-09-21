import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'

// VOLUME_RENDER_MODE.SLICES draws the three crosshair planes inside the 3D tile
// instead of ray-marching. It is selected by the same `volumeRenderMode` field
// as MAXIMUM, which is why every test here also re-checks MAXIMUM: four places
// used to read that field as `> 0.5`, and under that test SLICES silently
// renders as a maximum-intensity projection (and, on a chunked volume, picks
// the MAX blend equation too).
//
// Pixels are probed with 1x1 clip screenshots rather than a GL readback: it is
// the one readback that works the same on both backends without asking for
// preserveDrawingBuffer.

test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
    ],
    // `use.launchOptions` replaces the config's object rather than merging into
    // it, so the config's escape hatch has to be repeated here.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
  },
})

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const SIZE = 256
const MODES = { COMPOSITE: 0, MAXIMUM: 1, SLICES: 2 } as const

/**
 * The one pixel at (x, y) of the page. A 1x1 PNG needs no real decoder: every
 * filter type degenerates to the identity when there is neither a left nor an
 * upper neighbour, so the scanline is a filter byte followed by the sample.
 */
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

const isBackground = (px: number[]): boolean =>
  px[0] < 12 && px[1] < 12 && px[2] < 12

/**
 * One instance on a fixed camera, `left` px from the page origin, exposed as
 * `window.__nv<id>` / `window.__setMode<id>`. Returns the backend that actually
 * came up, which is not always the one asked for.
 */
const mount = (
  backend: string,
  id: string,
  left: number,
  opts = '',
): string => `(async () => {
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { ok: false, why: 'no navigator.gpu' }
    if (!(await navigator.gpu.requestAdapter())) return { ok: false, why: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  window.__nextFrame = () => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)))
  const c = document.createElement('canvas')
  c.width = ${SIZE}; c.height = ${SIZE}
  c.style.cssText =
    'position:fixed;top:0;left:${left}px;width:${SIZE}px;height:${SIZE}px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: '${backend}',
    sliceType: SLICE_TYPE.RENDER,
    backgroundColor: [0, 0, 0, 1],
    // A fixed camera: every assertion here is about pixels, so nothing may
    // depend on canvas placement or a default animation.
    azimuth: 120,
    elevation: 15,
    ${opts}
  })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  await window.__nextFrame()
  window.__nv${id} = nv
  window.__setMode${id} = async (m) => {
    nv.volumeRenderMode = m
    await window.__nextFrame()
    await window.__nextFrame()
  }
  return { ok: true, backend: nv.backend }
})()`

/** Points spread over the tile, as page coordinates for a canvas at `left`. */
const GRID: [number, number][] = [
  [0.5, 0.5],
  [0.4, 0.35],
  [0.6, 0.35],
  [0.5, 0.7],
  [0.35, 0.55],
  [0.65, 0.55],
]
const gridProbes = (page: Page, left: number): Promise<number[]>[] =>
  GRID.map(([u, v]) => probe(page, left + u * SIZE, v * SIZE))

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`every render mode draws the volume (${backend})`, async ({ page }) => {
    test.setTimeout(180_000)
    const ready = await page.evaluate(mount(backend, '', 0))
    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
    expect(ready.backend).toBe(backend)

    const shots: Record<string, Buffer> = {}
    for (const [name, mode] of Object.entries(MODES)) {
      await page.evaluate(`window.__setMode(${mode})`)
      // The head fills the middle of the tile and nothing reaches the corner,
      // so this is "the volume is on screen" without a reference image.
      expect(isBackground(await probe(page, SIZE / 2, SIZE / 2)), name).toBe(
        false,
      )
      expect(isBackground(await probe(page, 2, 2)), name).toBe(true)
      shots[name] = await page.locator('canvas').screenshot()
    }
    // Each mode is a different picture. Without this, a mode that silently fell
    // through to COMPOSITE would pass everything above.
    expect(shots.SLICES.equals(shots.COMPOSITE)).toBe(false)
    expect(shots.MAXIMUM.equals(shots.COMPOSITE)).toBe(false)
    expect(shots.SLICES.equals(shots.MAXIMUM)).toBe(false)
  })

  test(`a SLICES pick lands on a crosshair plane (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const ready = await page.evaluate(mount(backend, '', 0))
    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
    expect(ready.backend).toBe(backend)

    const hit = await page.evaluate(`(async () => {
      await window.__setMode(${MODES.SLICES})
      const nv = window.__nv
      const mm = await nv.view.depthPick(${SIZE / 2}, ${SIZE / 2})
      const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
      const px = nv.volumes[0].pixDimsRAS ?? nv.volumes[0].hdr.pixDims
      return { mm, cross: [cross[0], cross[1], cross[2]],
               vox: [px[1], px[2], px[3]].map(Math.abs) }
    })()`)

    expect(hit.mm).not.toBeNull()
    // The render draws three planes through the crosshair, so a pick that is
    // visible at all lies on one of them: one coordinate matches the crosshair
    // to within a voxel.
    const onPlane = hit.mm.some(
      (v: number, i: number) =>
        Math.abs(v - hit.cross[i]) <= Math.abs(hit.vox[i]),
    )
    expect(onPlane, `pick ${hit.mm} vs crosshair ${hit.cross}`).toBe(true)
  })
}

test('both backends draw SLICES the same', async ({ page }) => {
  test.setTimeout(180_000)
  const gl = await page.evaluate(mount('webgl2', 'A', 0))
  const gpu = await page.evaluate(mount('webgpu', 'B', SIZE))
  test.skip(!gpu.ok, `backend unavailable: ${gpu.why}`)
  expect([gl.backend, gpu.backend]).toEqual(['webgl2', 'webgpu'])

  await page.evaluate(`Promise.all([
    window.__setModeA(${MODES.SLICES}),
    window.__setModeB(${MODES.SLICES}),
  ])`)

  const a = await Promise.all(gridProbes(page, 0))
  const b = await Promise.all(gridProbes(page, SIZE))
  // The plane branch is duplicated in WGSL and GLSL, so this is what catches
  // the two drifting. Not bit-exact: the two rasterizers land the ray on
  // fractionally different texels, which a trilinear tap turns into a few
  // levels. Anything structural (a layer blended in the wrong order, a plane
  // missing, air drawn opaque) is far larger than this.
  for (const [i, px] of a.entries()) {
    for (let c = 0; c < 3; c++) {
      expect(
        Math.abs(px[c] - b[i][c]),
        `probe ${i} channel ${c}: ${px} vs ${b[i]}`,
      ).toBeLessThanOrEqual(8)
    }
  }
  // And not by both being empty.
  expect(a.some((px) => !isBackground(px))).toBe(true)
})

// A chunked volume draws one cube per brick, so a plane crossing a brick
// boundary is at risk of being composited twice (a bright seam) or by neither
// cube (a gap). The half-open [0, len) hit test is what prevents both, and the
// cheapest way to see it fail is against the same volume drawn whole.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`a chunked volume has no plane seams (${backend})`, async ({ page }) => {
    test.setTimeout(180_000)
    const whole = await page.evaluate(mount(backend, 'A', 0))
    // maxTextureDimension3D forces an ordinary volume down the chunked path.
    const tiled = await page.evaluate(
      mount(backend, 'B', SIZE, 'maxTextureDimension3D: 128,'),
    )
    test.skip(!tiled.ok, `backend unavailable: ${tiled.why}`)
    expect([whole.backend, tiled.backend]).toEqual([backend, backend])
    expect(
      await page.evaluate('window.__nvB.view.volumeRenderer.hasChunkedVolume'),
    ).toBe(true)

    await page.evaluate(`Promise.all([
      window.__setModeA(${MODES.SLICES}),
      window.__setModeB(${MODES.SLICES}),
    ])`)
    // Streaming settles asynchronously; the bricks have to be resident before
    // the two pictures can be compared.
    await page.waitForTimeout(4000)
    await page.evaluate(`window.__setModeB(${MODES.SLICES})`)

    const a = await Promise.all(gridProbes(page, 0))
    const b = await Promise.all(gridProbes(page, SIZE))
    for (const [i, px] of a.entries()) {
      for (let c = 0; c < 3; c++) {
        expect(
          Math.abs(px[c] - b[i][c]),
          `probe ${i} channel ${c}: whole ${px} vs chunked ${b[i]}`,
        ).toBeLessThanOrEqual(8)
      }
    }
    expect(a.some((px) => !isBackground(px))).toBe(true)
  })
}
