import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// A chunk-plan swap (multi-LOD refocus) must survive a texture refresh that
// lands while it is in flight.
//
// swapVolumeChunkPlan sets `vol.chunkPlan` to the new plan, then hands it to
// the renderer, whose swap awaits a new uploader before it records the plan on
// the cached entry. _ensureChunkedVolumeEntry reuses the cached entry only when
// `entry.plan === vol.chunkPlan`. An updateGLVolume (a colormap or window
// change, a modulation edit) that runs inside that await sees the new plan on
// the volume and the old one on the entry, evicts the entry with every brick it
// holds and rebuilds it with one brick; the swap then resumes and mutates the
// evicted entry: it builds an uploader and admits a brick nobody will free.
//
// The volume is a synthetic 64^3 NIfTI built in the page, so the spec needs no
// Git LFS data and no network. The replacement plan has the same content as the
// current one, so a correct swap keeps every resident brick and the cached
// entry, and the refresh (which changes nothing the bricks bake in) is a
// cache hit.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const GRID = 2

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
const BRICKS = GRID * GRID * GRID

/** Mounts `window.__nv` on a synthetic volume tiled into a forced GRID^3 plan
 * and waits for every brick to be resident. */
const mount = (backend: string): string => `
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { skip: 'no navigator.gpu' }
    let adapter = null
    try { adapter = await navigator.gpu.requestAdapter() }
    catch (e) { return { skip: 'requestAdapter threw: ' + e } }
    if (!adapter) return { skip: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE, chunkVolumeGrid } =
    await import('/src/index.ts')
  const nextFrame = () => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)))
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
  // A solid ball, so every view of it is plainly not blank.
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const r = Math.hypot(x - N / 2, y - N / 2, z - N / 2)
    raw[VOX_OFFSET + x + y * N + z * N * N] = r < N * 0.45 ? 50 + ((x + y + z) % 200) : 0
  }
  const file = new File([raw], 'synth.nii')
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 256
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:256px;height:256px'
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: '${backend}', sliceType: SLICE_TYPE.RENDER })
  await nv.attachToCanvas(canvas)
  if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
    return { skip: 'WebGPU init fell back to ' + nv.backend }
  }
  const errors = []
  const origError = console.error
  console.error = (...a) => { errors.push(a.map(String).join(' ')); origError(...a) }
  await nv.loadVolumes([{ url: file, name: 'synth.nii' }])
  const vol = nv.volumes[0]
  const d = vol.dimsRAS
  const makePlan = () => chunkVolumeGrid([d[1], d[2], d[3]], [${GRID}, ${GRID}, ${GRID}], 4096, [3, 3, 3])
  vol.chunkPlan = makePlan()
  await nv.updateGLVolume()
  const fill = async () => {
    for (let i = 0; i < 300; i++) {
      await nextFrame()
      const s = nv.chunkStreamStats()
      if (s && s.total === ${BRICKS} && s.resident === s.total) return s
    }
    return nv.chunkStreamStats()
  }
  // The renderer's cache of per-volume textures: read-only inspection.
  const cache = nv.view.volumeRenderer._texCache
  const key = vol.url || vol.name
`

// The refresh is issued either before the swap (it reaches the cache lookup
// while the swap awaits its uploader) or after it, and is either the public
// full rebuild or a colormap change, which also rebuilds the uploader in place
// and re-streams, so only the entry identity is asserted for it.
const REFRESHES = {
  updateGLVolume: 'nv.updateGLVolume()',
  colormap: "nv.setVolume(0, { colormap: 'hot' })",
} as const
const ORDERS = ['refresh-first', 'swap-first'] as const

for (const backend of ['webgl2', 'webgpu'] as const) {
  for (const [how, refreshCall] of Object.entries(REFRESHES)) {
    for (const order of ORDERS) {
      test(`a ${how} refresh during a plan swap keeps the swapped entry (${backend}, ${order})`, async ({
        page,
      }) => {
        test.setTimeout(180_000)
        const result = await page.evaluate(`(async () => {
          try {
            ${mount(backend)}
            const filled = await fill()

            // Control: the swap on its own keeps the entry and every brick.
            const before = cache.get(key)
            const quietPlan = makePlan()
            await nv.swapVolumeChunkPlan(vol.id, quietPlan)
            const quiet = {
              sameEntry: cache.get(key) === before,
              planIsNew: cache.get(key).plan === quietPlan,
              resident: nv.chunkStreamStats().resident,
            }
            await fill()

            // The race: a refresh and a swap in flight together.
            const old = cache.get(key)
            const racedPlan = makePlan()
            let refresh, swap
            if ('${order}' === 'refresh-first') {
              refresh = ${refreshCall}
              swap = nv.swapVolumeChunkPlan(vol.id, racedPlan)
            } else {
              swap = nv.swapVolumeChunkPlan(vol.id, racedPlan)
              refresh = ${refreshCall}
            }
            await Promise.all([swap, refresh])
            const live = cache.get(key)
            const raced = {
              sameEntry: live === old,
              planIsNew: live.plan === racedPlan,
              resident: nv.chunkStreamStats().resident,
              // Bricks still held by an entry that is no longer in the cache:
              // nothing will ever free them.
              orphanResident: live === old ? 0 : old.manager.residentCount,
            }
            const refilled = await fill()
            return { filled, quiet, raced, refilled, errors }
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
        expect(r.filled.resident).toBe(BRICKS)
        expect(r.quiet).toEqual({
          sameEntry: true,
          planIsNew: true,
          resident: BRICKS,
        })
        expect(r.raced.planIsNew).toBe(true)
        expect(r.raced.sameEntry).toBe(true)
        expect(r.raced.orphanResident).toBe(0)
        // updateGLVolume changes nothing the bricks bake in, so it keeps them;
        // a colormap change legitimately re-streams from one brick.
        if (how === 'updateGLVolume') expect(r.raced.resident).toBe(BRICKS)
        expect(r.refilled.resident).toBe(BRICKS)
        expect(r.errors).toEqual([])
        if (how === 'colormap') {
          // The ball is drawn grey before the change; every brick on screen
          // must now show the new colormap, not the one baked before it.
          const px = await Promise.all(
            [
              [128, 128],
              [100, 128],
              [156, 128],
              [128, 100],
              [128, 156],
            ].map(([x, y]) => probe(page, x, y)),
          )
          for (const [red, , blue] of px) expect(red - blue).toBeGreaterThan(40)
        }
      })
    }
  }
}
