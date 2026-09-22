import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// Issue #145, reported by @stebo85 as stale numbers out of `chunkStreamStats()`.
//
// `_destroyTexEntry` released an entry's GPU resources but left the entry in
// `_texCache`, and the one path that dropped the key by hand ran only for
// multi-instance callers. So a volume that stopped being chunked -- its plan
// cleared, or the same url reloaded as a plain volume -- left its chunked entry
// in the map for the life of the renderer: every brick texture still held, the
// upload pump still walking it, and `chunkStreamStats` still counting it.
//
// The assertion is that the brick count goes to zero once the volume is a single
// texture. It is a real regression test rather than a restatement of the fix:
// revert either backend's eviction and the second expect reports the full brick
// count for a volume that no longer has bricks.
//
// Both backends, because the leak and the fix are mirrored in gl/render.ts and
// wgpu/render.ts. WebGPU is skipped when the runner has no adapter (headless
// Chromium usually has SwiftShader for WebGL2 only).

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// A 2x2x2 forced plan: the volume fits in one texture, so the tiling is forced
// rather than required. Eight bricks is enough to tell "chunked" from "not"
// without paying for 27 uploads under SwiftShader.
const GRID = 2
const EXPECTED_CHUNKS = GRID * GRID * GRID

// The real mni152 from packages/dev-images, which is what the issue's manual
// repro uses -- one scenario for a reader to follow rather than two. It is Git
// LFS, so this workflow's checkout pulls that single object (see
// niivue-e2e.yml); an unpulled pointer parses as "not NIFTI" and fails loudly
// rather than silently testing nothing.
const VOLUME = '/volumes/mni152.nii.gz'

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`a volume that stops being chunked drops its bricks (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const result = await page.evaluate(`(async () => {
     try {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        let adapter = null
        try {
          adapter = await navigator.gpu.requestAdapter()
        } catch (e) {
          // Dawn on a headless runner throws "A valid external Instance
          // reference no longer exists" rather than resolving null. That is a
          // missing adapter, not a failed assertion.
          return { skip: 'requestAdapter threw: ' + e }
        }
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE, chunkVolumeGrid } =
        await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        sliceType: SLICE_TYPE.RENDER,
      })
      await nv.attachToCanvas(canvas)
      // The both-backends build silently falls back to WebGL2 when WebGPU init
      // throws, which would run this case twice on the same backend and report
      // it as WebGPU coverage. Skip instead of passing on a lie.
      if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
        return { skip: 'WebGPU init fell back to ' + nv.backend }
      }
      await nv.loadVolumes([{ url: '${VOLUME}' }])
      await nextFrame()

      const vol = nv.volumes[0]
      const d = vol.dimsRAS
      // The device limit only has to exceed the largest brick edge: the point
      // is to force a plan, not to model a real device cap.
      vol.chunkPlan = chunkVolumeGrid(
        [d[1], d[2], d[3]],
        [${GRID}, ${GRID}, ${GRID}],
        4096,
        [3, 3, 3],
      )
      await nv.updateGLVolume()
      await nextFrame()
      const chunked = nv.chunkStreamStats()

      // Back to one texture under the SAME cache key, which is the kind change
      // that used to strand the chunked entry.
      vol.chunkPlan = undefined
      await nv.updateGLVolume()
      await nextFrame()
      const single = nv.chunkStreamStats()

      return {
        chunkedTotal: chunked ? chunked.total : null,
        singleTotal: single ? single.total : null,
        singleResident: single ? single.resident : null,
      }
     } catch (e) {
      // A headless runner's GPU process can die under two concurrent WebGPU
      // contexts, after requestAdapter has already succeeded. That is the
      // environment going away, so skip. Anything else -- a validation error
      // from binding a destroyed texture, say, which is the failure mode this
      // spec exists to catch -- still fails the test.
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

    // Guard the guard: if the forced plan never took, the real assertion below
    // would pass for the wrong reason.
    expect(r.chunkedTotal).toBe(EXPECTED_CHUNKS)

    expect(r.singleTotal).toBe(0)
    expect(r.singleResident).toBe(0)
  })
}
