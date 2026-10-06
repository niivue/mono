import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// An overlay's modulation (setModulationImage) must survive the chunked path.
// The non-chunked overlay orient pass has always received the modulator; the
// per-chunk pass did not, so a modulated overlay silently lost its gating the
// moment the background went over the 3D texture limit (niivue/mono#256).
//
// The scene: MNI152 anatomy under a full-opacity red brain mask that is
// alpha-modulated by the CSF fraction map. Modulated, the red is confined to
// ventricles and sulci and the grey anatomy shows through; unmodulated, the
// whole brain is red. Whole and chunked renders of that scene must agree, and
// removing the modulation on the chunked one must visibly change it (so the
// agreement is not two unmodulated pictures). The mask is a distinct file
// because volume ids are URLs: a second copy of mni152 would share the base's
// id and setModulationImage would modulate the background instead.
//
// A chunked background reaches an overlay by three routes, and the first fix
// covered only the first: an in-memory overlay is resliced whole and cut into
// bricks; an overlay with a `chunkSource` co-registered at the base grid is
// streamed brick by brick through the generic chunk uploader (the "streamed
// combined" path); an overlay with `chunkOverlayOf` streams independently
// through that same uploader. The second case below gives the mask a
// chunkSource that serves its own in-memory bytes, so the picture must still
// match the whole render.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const SIZE = 256
// VOLUME_RENDER_MODE.SLICES: three crosshair planes, the one render that is
// the same picture whole and in bricks up to rasterization noise.
const SLICES = 2

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

/**
 * One instance on a fixed camera, `left` px from the page origin, exposed as
 * `window.__nv<id>`. The overlay is modulated before the first frame so both
 * instances build their overlay textures through the same code path once.
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
  const nextFrame = () => new Promise((r) =>
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
    azimuth: 120,
    elevation: 15,
    ${opts}
  })
  await nv.attachToCanvas(c)
  await nv.loadVolumes([
    { url: '/volumes/mni152.nii.gz', colormap: 'gray' },
    { url: '/volumes/mni152_mask.nii.gz', colormap: 'red', calMin: 0, calMax: 1, opacity: 1 },
    // The modulator: hidden, it only supplies the alpha weight.
    { url: '/volumes/mni152_csf.nii.gz', calMin: 0, calMax: 1, opacity: 0 },
  ])
  nv.volumeRenderMode = ${SLICES}
  await nv.setModulationImage(nv.volumes[1].id, nv.volumes[2].id, 1)
  await nextFrame()
  window.__nv${id} = nv
  window.__settle${id} = async () => {
    // Re-commit the render mode after the bricks stream in; same recipe as
    // render-mode.spec.ts for a chunked instance.
    nv.volumeRenderMode = ${SLICES}
    await nextFrame(); await nextFrame()
  }
  window.__unmodulate${id} = async () => {
    await nv.setModulationImage(nv.volumes[1].id, '', 0)
    await nextFrame(); await nextFrame()
  }
  // Turn the in-memory mask into a streamed overlay: the chunkSource hands the
  // uploader each brick's bytes in RAS order, cut from the image it already
  // holds, so the only thing that changes is which code path builds the
  // bricks. Returns the chunk count before and after, so the test can assert
  // that the overlay really did become a second streamed volume.
  window.__stream${id} = async () => {
    const { extractChunkBytes, extractChunkBytesReoriented, isIdentityPermutation } =
      await import('/src/volume/orientChunked.ts')
    const vol = nv.volumes[1]
    const img = vol.img
    const dims = [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
    const before = nv.chunkStreamStats().total
    vol.chunkSource = (req) => {
      const bpv = req.bytesPerVoxel
      const src = new Uint8Array(img.buffer, img.byteOffset, vol.nVox3D * bpv)
      return isIdentityPermutation(vol)
        ? extractChunkBytes(src, dims, bpv, req.desc.texOrigin, req.desc.texDims)
        : extractChunkBytesReoriented(src, bpv, req.desc.texOrigin,
            req.desc.texDims, vol.img2RASstart, vol.img2RASstep)
    }
    await nv.updateGLVolume()
    await nextFrame()
    return { before, after: nv.chunkStreamStats().total }
  }
  return { ok: true, backend: nv.backend }
})()`

const GRID: [number, number][] = [
  [0.5, 0.5],
  [0.4, 0.35],
  [0.6, 0.35],
  [0.5, 0.7],
  [0.35, 0.55],
  [0.65, 0.55],
]
const gridProbes = (page: Page, left: number): Promise<number[][]> =>
  Promise.all(GRID.map(([u, v]) => probe(page, left + u * SIZE, v * SIZE)))

async function mountOrSkip(
  page: Page,
  backend: string,
  id: string,
  left: number,
  opts = '',
): Promise<void> {
  const ready = await page.evaluate(mount(backend, id, left, opts))
  test.skip(!ready.ok, `backend unavailable: ${ready.why}`)
  expect(ready.backend).toBe(backend)
}

const isBackground = (px: number[]): boolean =>
  px[0] < 12 && px[1] < 12 && px[2] < 12

/** Same tolerance and rationale as render-mode.spec.ts's whole-vs-chunked. */
function expectProbesClose(a: number[][], b: number[][], label: string): void {
  for (const [i, px] of a.entries()) {
    for (let c = 0; c < 3; c++) {
      expect(
        Math.abs(px[c] - b[i][c]),
        `${label} probe ${i} channel ${c}: ${px} vs ${b[i]}`,
      ).toBeLessThanOrEqual(8)
    }
  }
  expect(a.some((px) => !isBackground(px))).toBe(true)
}

/** The largest per-channel difference over all probes. */
const maxDelta = (a: number[][], b: number[][]): number =>
  Math.max(
    ...a.flatMap((px, i) => [0, 1, 2].map((c) => Math.abs(px[c] - b[i][c]))),
  )

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`a chunked overlay keeps its modulation (${backend})`, async ({
    page,
  }) => {
    await mountOrSkip(page, backend, 'A', 0)
    // maxTextureDimension3D forces an ordinary volume down the chunked path.
    await mountOrSkip(page, backend, 'B', SIZE, 'maxTextureDimension3D: 128,')
    expect(
      await page.evaluate('window.__nvB.view.volumeRenderer.hasChunkedVolume'),
    ).toBe(true)
    // Streaming settles asynchronously; the bricks have to be resident before
    // the two pictures can be compared.
    await page.waitForTimeout(4000)
    await page.evaluate('window.__settleB()')

    const whole = await gridProbes(page, 0)
    const chunked = await gridProbes(page, SIZE)
    expectProbesClose(whole, chunked, 'whole vs chunked, modulated')

    // Guard: the agreement above must be of two MODULATED renders. Dropping the
    // modulation on the chunked instance has to change it by far more than
    // the rasterization tolerance, or the test would pass with modulation
    // ignored on both sides.
    await page.evaluate('window.__unmodulateB()')
    const unmodulated = await gridProbes(page, SIZE)
    expect(
      maxDelta(chunked, unmodulated),
      `chunked modulated ${JSON.stringify(chunked)} vs unmodulated ${JSON.stringify(unmodulated)}`,
    ).toBeGreaterThan(40)
  })

  test(`a streamed (chunkSource) overlay keeps its modulation (${backend})`, async ({
    page,
  }) => {
    await mountOrSkip(page, backend, 'A', 0)
    await mountOrSkip(page, backend, 'C', SIZE, 'maxTextureDimension3D: 128,')
    const counts = await page.evaluate('window.__streamC()')
    // The base alone is `before` bricks; the streamed overlay is co-registered
    // at the base grid, so it adds the same number again. A streamed overlay
    // that fell back to whole reslicing would add none.
    expect(counts.before).toBeGreaterThan(1)
    expect(counts.after).toBe(2 * counts.before)
    await page.waitForTimeout(4000)
    await page.evaluate('window.__settleC()')

    const whole = await gridProbes(page, 0)
    const streamed = await gridProbes(page, SIZE)
    expectProbesClose(whole, streamed, 'whole vs streamed, modulated')

    await page.evaluate('window.__unmodulateC()')
    const unmodulated = await gridProbes(page, SIZE)
    expect(
      maxDelta(streamed, unmodulated),
      `streamed modulated ${JSON.stringify(streamed)} vs unmodulated ${JSON.stringify(unmodulated)}`,
    ).toBeGreaterThan(40)
  })
}
