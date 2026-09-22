import { expect, test } from '@playwright/test'

// A caller-supplied `name` must reach `reader.read`, because several readers are
// filename-sensitive: MGH infers label volumes from it (readers/mgh.ts), and VMR
// tells `.v16` from `.vmr` by name alone (readers/vmr.ts).
//
// The worker used to pass its own `fileName` to `reader.read`. When it was
// changed to delegate to `loadVolume`, the name started being derived from the
// URL inside `loadVolume` instead, silently dropping the override on
// worker-capable browsers while the fallback did something else again.
// `loadVolume` now takes the override and both callers forward it.
//
// The fixture is one buffer that BOTH VMR branches parse, differing only in how
// the name routes it:
//   v16 reads dims at offsets 0/2/4 and 16-bit voxels
//   vmr reads a version at 0, dims at 2/4/6, and 8-bit voxels
// so `numBitsPerVoxel` alone says which branch ran.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const buf = new ArrayBuffer(4096)
  const dv = new DataView(buf)
  // 4 at each of 0/2/4/6: a version-4 VMR with 4x4x4 dims, and simultaneously a
  // 4x4x4 V16. Everything after stays zero, which both readers tolerate.
  dv.setUint16(0, 4, true); dv.setUint16(2, 4, true)
  dv.setUint16(4, 4, true); dv.setUint16(6, 4, true)

  const mk = async (name) => {
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    c.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    // The FILE is always named .vmr — only the override differs, so the
    // extension routing is identical and the name is the only variable.
    const file = new File([buf], 'blob.vmr')
    await nv.loadVolumes([{ url: file, name }])
    return nv.volumes[0].hdr.numBitsPerVoxel
  }
`

test('a caller-supplied name reaches the reader', async ({ page }) => {
  test.setTimeout(120_000)

  const bits = await page.evaluate(`(async () => {
    ${setup}
    return { asV16: await mk('sample.v16'), asVmr: await mk('sample.vmr') }
  })()`)

  // The override picks the branch. Without it both would report the same thing,
  // because the File's own name (.vmr) would decide twice.
  expect(bits.asV16).toBe(16)
  expect(bits.asVmr).toBe(8)
})

// An ordinary loader failure — a bad file — must NOT be retried on the main
// thread. The worker reports payload errors through the same rejection channel
// as infrastructure failure, and loadBridge used to retry all of them, so a
// malformed or missing input paid for its whole fetch + inflate + parse twice,
// the second time on the UI thread. The worker now tags them `VolumeLoadError`.
test('a bad input fails once, without a main-thread retry', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })

  const threw = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    c.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    // Valid extension so a reader is selected, but the bytes are nonsense.
    const bad = new File([new Uint8Array(64).fill(7)], 'broken.nii.gz')
    try { await nv.loadVolumes([{ url: bad }]); return false } catch { return true }
  })()`)

  expect(threw).toBe(true)
  // The tell: a retry logs this before repeating the work.
  expect(warnings.join('\n')).not.toContain('volumeLoad worker failed')
})

// A worker's base is its own script (a blob: URL for `?worker&inline`), so a
// document-relative URL resolves to nonsense there. That has always been broken;
// it was invisible only because every worker failure was silently retried on the
// main thread, where the base is correct. Now that ordinary loader errors are no
// longer retried, `loadVolumePrepared` must resolve the URL before the hop.
//
// Asserted without an LFS-backed volume: `./index.html` exists relative to the
// DOCUMENT and not relative to the worker, so a resolved URL fetches it and
// fails in the PARSER, while an unresolved one 404s.
test('a document-relative URL is resolved before the worker hop', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const message = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    c.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(c)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(c)
    try {
      await nv.loadVolumes([{ url: './index.html', name: 'relative.nii' }])
      return 'loaded'
    } catch (e) { return String(e && e.message ? e.message : e) }
  })()`)

  // The fetch must have SUCCEEDED against the document base. A 404 means the
  // worker resolved it against its own script instead.
  expect(message).not.toContain('404')
})
