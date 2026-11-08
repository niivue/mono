import { expect } from '@playwright/test'
import { test } from './sharedPage'

// `limitFrames4D` bounded RETENTION, not DECODING. Both load paths fetched and
// inflated every frame and then discarded them in nii2volume:
//
//   - volumeLoad.worker.ts reimplemented loadVolume (fetchFile + reader.read),
//     so it never reached loadVolume's bounded 4D fast path.
//   - loadBridge.ts's main-thread fallback called loadVolume(url, paired) with
//     no third argument, and the parameter defaults to Infinity, so the fast
//     path's `Number.isFinite(limitFrames4D)` gate was never true.
//
// Net effect: loadPartialNifti1 / loadPartialNiftiGz / NVGzStream.readWindow —
// all of it written for exactly this — was unreachable from loadVolumes. A
// 2.65 MB 4D .nii.gz drove a WebKit content process to 5.4 GiB while the caller
// had asked for one frame.
//
// Memory is the wrong thing to assert on here: a worker's heap is invisible to
// the main thread, which is precisely how this hid through review. So the test
// truncates the gzip stream after frame 0. A bounded read succeeds; a full
// decode cannot, because inflating to the end of the member hits the cut. The
// outcome is therefore a direct statement about how much was decoded.
// The main-thread fallback (loadBridge) is tested the same way under Bun in
// src/volume/partialDecode4D.test.ts; this spec holds the Worker path.

// Build a 4D NIfTI-1 in the page, gzip it with CompressionStream, and cut it.
const fixture = `
  const NX = 16, NY = 16, NZ = 8, FRAMES = 400, VOX_OFFSET = 352
  const frameBytes = NX * NY * NZ * 2
  const raw = new Uint8Array(VOX_OFFSET + frameBytes * FRAMES)
  const dv = new DataView(raw.buffer)
  dv.setInt32(0, 348, true)
  ;[4, NX, NY, NZ, FRAMES, 1, 1, 1].forEach((d, i) => dv.setInt16(40 + i * 2, d, true))
  dv.setInt16(70, 512, true)   // DT_UINT16
  dv.setInt16(72, 16, true)    // bitpix
  ;[1, 2, 2, 2, 1, 1, 1, 1].forEach((p, i) => dv.setFloat32(76 + i * 4, p, true))
  dv.setFloat32(108, VOX_OFFSET, true)
  dv.setFloat32(112, 1, true)  // scl_slope
  raw.set(new TextEncoder().encode('n+1\\0'), 344)
  // Frame 0 carries a marker so we can prove which frame survived.
  for (let i = 0; i < frameBytes; i += 2) dv.setUint16(VOX_OFFSET + i, 1234, true)

  const gz = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer())
  // Keep the header and frame 0, then cut mid-member.
  const truncated = gz.slice(0, Math.floor(gz.length * 0.6))
  const file = new File([truncated], 'trunc4d.nii.gz')
`

const mkNiivue = `
  const { default: NiiVue } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  c.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(c)
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.attachToCanvas(c)
`

test('the bounded path is used by the worker, not only the fallback', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })

  const voxels = await page.evaluate(`(async () => {
    ${fixture}
    ${mkNiivue}
    await nv.loadVolumes([{ url: file, name: 'trunc4d.nii.gz', limitFrames4D: 1 }])
    return nv.volumes[0].img.length
  })()`)

  expect(voxels).toBe(16 * 16 * 8)
  // If the worker had thrown and the main thread had rescued the load, the
  // bound would still hold but for the wrong reason. Pin the worker itself.
  expect(warnings.join('\n')).not.toContain('volumeLoad worker failed')
})
