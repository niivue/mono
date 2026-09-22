import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

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

test.use({ launchOptions: webgpuLaunchOptions })

// Every test here loads a volume and compiles shaders on SwiftShader.
test.describe.configure({ timeout: 180_000 })

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

/** Mount an instance, skipping the test when its backend is unavailable. */
async function mountOrSkip(
  page: Page,
  backend: string,
  id = '',
  left = 0,
  opts = '',
): Promise<void> {
  const ready = await page.evaluate(mount(backend, id, left, opts))
  test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
  // WebGPU falls back to WebGL2 rather than failing, which would quietly turn
  // the cross-backend comparison below into WebGL2 against itself.
  expect(ready.backend).toBe(backend)
}

/**
 * Two probe grids of the same scene agree. Not bit-exact: two rasterizers (or a
 * whole volume and the same volume in bricks) land the ray on fractionally
 * different texels, which a trilinear tap turns into a few levels. Anything
 * structural -- a layer blended in the wrong order, a plane missing, air drawn
 * opaque, a seam composited twice -- is far larger than this.
 */
function expectProbesClose(a: number[][], b: number[][], label: string): void {
  for (const [i, px] of a.entries()) {
    for (let c = 0; c < 3; c++) {
      expect(
        Math.abs(px[c] - b[i][c]),
        `${label} probe ${i} channel ${c}: ${px} vs ${b[i]}`,
      ).toBeLessThanOrEqual(8)
    }
  }
  // And not by both being empty.
  expect(a.some((px) => !isBackground(px))).toBe(true)
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`every render mode draws the volume (${backend})`, async ({ page }) => {
    await mountOrSkip(page, backend)

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
    await mountOrSkip(page, backend)

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
  await mountOrSkip(page, 'webgl2', 'A', 0)
  await mountOrSkip(page, 'webgpu', 'B', SIZE)

  await page.evaluate(`Promise.all([
    window.__setModeA(${MODES.SLICES}),
    window.__setModeB(${MODES.SLICES}),
  ])`)

  // The plane branch is duplicated in WGSL and GLSL, so this is what catches
  // the two drifting.
  expectProbesClose(
    await Promise.all(gridProbes(page, 0)),
    await Promise.all(gridProbes(page, SIZE)),
    'webgl2 vs webgpu',
  )
})

// Every pick in SLICES must land ON a crosshair plane, or on nothing at all.
// The chunked CPU-pick path has a near-surface fallback for the marched modes,
// and letting a plane miss fall into it returns a scalp voxel that is nowhere
// near the planes and was never on screen -- which is what an earlier revision
// did. Sweeping the tile is what catches it: the fallback only fires for a ray
// that crosses the volume's box but no visible plane.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`every SLICES pick lands on a plane or nothing (${backend})`, async ({
    page,
  }) => {
    // Chunked, so the pick takes the CPU fallback where the fallback lives;
    // Clip Dark, so air really is empty rather than a solid slab.
    await mountOrSkip(
      page,
      backend,
      '',
      0,
      'volumeIsAlphaClipDark: true, maxTextureDimension3D: 128,',
    )
    expect(
      await page.evaluate('window.__nv.view.volumeRenderer.hasChunkedVolume'),
    ).toBe(true)
    // Let the bricks settle, or the planes are empty for a different reason.
    await page.waitForTimeout(4000)

    const swept = await page.evaluate(`(async () => {
      await window.__setMode(${MODES.SLICES})
      const nv = window.__nv
      const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
      const px = nv.volumes[0].pixDimsRAS ?? nv.volumes[0].hdr.pixDims
      const vox = [px[1], px[2], px[3]].map(Math.abs)
      const off = []
      let hits = 0
      let misses = 0
      for (let y = 16; y < ${SIZE}; y += 16) {
        for (let x = 16; x < ${SIZE}; x += 16) {
          const mm = await nv.view.depthPick(x, y)
          if (!mm) { misses++; continue }
          hits++
          const onPlane = mm.some((v, i) => Math.abs(v - cross[i]) <= vox[i])
          if (!onPlane) off.push({ x, y, mm })
        }
      }
      return { off: off.slice(0, 5), offCount: off.length, hits, misses }
    })()`)

    // A sweep that never hit a plane, or never missed one, proves nothing.
    expect(swept.hits).toBeGreaterThan(0)
    expect(swept.misses).toBeGreaterThan(0)
    expect(
      swept.offCount,
      `picks off every plane: ${JSON.stringify(swept.off)}`,
    ).toBe(0)
  })
}

// A chunked volume draws one cube per brick, so a plane crossing a brick
// boundary is at risk of being composited twice (a bright seam) or by neither
// cube (a gap). The half-open [0, len) hit test is what prevents both, and the
// cheapest way to see it fail is against the same volume drawn whole.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`a chunked volume has no plane seams (${backend})`, async ({ page }) => {
    await mountOrSkip(page, backend, 'A', 0)
    // maxTextureDimension3D forces an ordinary volume down the chunked path.
    await mountOrSkip(page, backend, 'B', SIZE, 'maxTextureDimension3D: 128,')
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

    expectProbesClose(
      await Promise.all(gridProbes(page, 0)),
      await Promise.all(gridProbes(page, SIZE)),
      'whole vs chunked',
    )
  })
}

/**
 * A streamed volume for the chunked case: only a chunked SOURCE carries a base
 * pick sampler (built from its coarse floor), so only it can show a plane
 * crossing being rejected as transparent and then accepted for the drawing.
 * An ordinary volume forced down the chunked path has no sampler and every
 * in-box crossing already counts as visible. One 64^3 level, a bright ball in
 * the middle, air around it.
 */
const BALL_SOURCE = `(() => {
  const N = 64, R = 18
  const vox = new Uint8Array(N * N * N)
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - N / 2 + 0.5, dy = y - N / 2 + 0.5, dz = z - N / 2 + 0.5
    if (dx * dx + dy * dy + dz * dz < R * R) vox[x + y * N + z * N * N] = 200
  }
  return {
    datatypeCode: 2,
    levels: [{ level: 0, shape: [N, N, N], spacing: [2, 2, 2] }],
    fetchChunk: async ({ texOrigin: o, texDims: d }) => {
      const out = new Uint8Array(d[0] * d[1] * d[2])
      for (let z = 0; z < d[2]; z++) for (let y = 0; y < d[1]; y++) for (let x = 0; x < d[0]; x++) {
        const sx = o[0] + x, sy = o[1] + y, sz = o[2] + z
        if (sx < N && sy < N && sz < N) {
          out[x + y * d[0] + z * d[0] * d[1]] = vox[sx + sy * N + sz * N * N]
        }
      }
      return out
    },
  }
})()`

// SLICES composites the drawing (and any PAQD label) onto a plane even where
// the base volume is transparent, so a painted voxel on an otherwise empty
// plane is on screen. A pick has to agree: every pick path used to test only
// the base and overlay alpha, so a click on a painted-but-transparent spot of a
// plane was discarded and the crosshair did not move. The whole volume takes
// the GPU depth pass, the chunked one takes the CPU ray walk; both have to see
// the drawing.
for (const backend of ['webgl2', 'webgpu'] as const) {
  for (const kind of ['whole', 'chunked'] as const) {
    test(`a drawing on a transparent plane is pickable (${backend}, ${kind})`, async ({
      page,
    }) => {
      // Clip Dark, so the air around the head (or the ball) is transparent and
      // a painted voxel there is the only thing on the plane.
      await mountOrSkip(page, backend, '', 0, 'volumeIsAlphaClipDark: true,')
      if (kind === 'chunked') {
        await page.evaluate(`(async () => {
          const nv = window.__nv
          await nv.removeAllVolumes()
          await nv.loadChunkedVolume(${BALL_SOURCE},
            { calMin: 50, calMax: 255, colormap: 'gray' })
          await window.__nextFrame()
        })()`)
        // Let the floor and the bricks settle.
        await page.waitForTimeout(4000)
      }
      expect(
        await page.evaluate('window.__nv.view.volumeRenderer.hasChunkedVolume'),
      ).toBe(kind === 'chunked')

      const swept = await page.evaluate(`(async () => {
        await window.__setMode(${MODES.SLICES})
        const nv = window.__nv
        const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
        const px = nv.volumes[0].pixDimsRAS ?? nv.volumes[0].hdr.pixDims
        const vox = [px[1], px[2], px[3]].map(Math.abs)
        const sweep = async () => {
          const hits = new Map()
          for (let y = 16; y < ${SIZE}; y += 16) {
            for (let x = 16; x < ${SIZE}; x += 16) {
              const mm = await nv.view.depthPick(x, y)
              if (mm) hits.set(x + ',' + y, [mm[0], mm[1], mm[2]])
            }
          }
          return hits
        }
        const before = await sweep()

        // Paint the whole axial crosshair slice (and its two neighbours, so a
        // plane sitting on a voxel boundary still lands on paint). Where the
        // tissue is, the base already showed; where the air is, only the
        // drawing does.
        nv.createEmptyDrawing()
        const dv = nv.drawingVolume
        const [nx, ny, nz] = [dv.dimsRAS[1], dv.dimsRAS[2], dv.dimsRAS[3]]
        const zc = Math.min(nz - 1, Math.max(0,
          Math.floor(nv.model.scene.crosshairPos[2] * nz)))
        for (let z = Math.max(0, zc - 1); z <= Math.min(nz - 1, zc + 1); z++) {
          dv.img.fill(1, z * nx * ny, (z + 1) * nx * ny)
        }
        nv.refreshDrawing()
        await window.__nextFrame()
        await window.__nextFrame()
        const after = await sweep()

        const added = []
        const offPlane = []
        for (const [k, mm] of after) {
          if (!mm.some((v, i) => Math.abs(v - cross[i]) <= vox[i])) {
            offPlane.push({ k, mm })
          }
          if (!before.has(k)) added.push({ k, mm })
        }
        const lost = [...before.keys()].filter((k) => !after.has(k))
        const addedOffAxial = added.filter(
          ({ mm }) => Math.abs(mm[2] - cross[2]) > vox[2])
        return {
          before: before.size, after: after.size, added: added.length,
          lost: lost.length,
          addedOffAxial: addedOffAxial.slice(0, 5),
          addedOffAxialCount: addedOffAxial.length,
          offPlane: offPlane.slice(0, 5), offPlaneCount: offPlane.length,
        }
      })()`)

      // The paint reached spots that were nothing before.
      expect(swept.before).toBeGreaterThan(0)
      expect(swept.added, JSON.stringify(swept)).toBeGreaterThan(0)
      // And nothing that was pickable stopped being pickable.
      expect(swept.lost).toBe(0)
      // Every new pick sits on the painted axial plane, not on a scalp voxel
      // the near-surface fallback found for a ray that crossed no plane.
      expect(
        swept.addedOffAxialCount,
        `new picks off the painted plane: ${JSON.stringify(swept.addedOffAxial)}`,
      ).toBe(0)
      expect(
        swept.offPlaneCount,
        `picks off every plane: ${JSON.stringify(swept.offPlane)}`,
      ).toBe(0)
    })
  }
}
