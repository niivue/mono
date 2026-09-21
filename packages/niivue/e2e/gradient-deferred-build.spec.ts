import { expect, test } from '@playwright/test'

// The gradient texture is built at upload time, and NONE of its three consumers
// -- matcap illumination, gradientOpacity, silhouettePower -- is on by default.
// Building it for a scene that never reads it costs a full-volume pass plus an
// RGBA8 texture the size of the volume, so the upload path now skips it and
// `_ensureSingleGradients` fills it in on the first frame after a consumer turns
// on (the single-texture analogue of the chunked path's
// `_refreshUnlitChunksForLighting`).
//
// The risk that buys is a silently unlit render: a deferred build that never
// happens, or happens against the wrong texture, looks exactly like "lighting is
// off". So this pins the two halves that matter.
//
//   1. Turning illumination on after an unlit load CHANGES the image -- the
//      deferred build ran at all.
//   2. That image is IDENTICAL to loading with illumination already on -- the
//      deferred build produces the same texture the eager one did.
//
// (2) is the load-bearing assertion. (1) only guards against (2) passing because
// both instances are equally unlit. Run on both backends: the gate and the
// lazy fill are mirrored in gl/render.ts and wgpu/render.ts.

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

const ILLUM = 0.7

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`deferred gradient build matches the eager one (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const ready = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { ok: false, why: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) return { ok: false, why: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
      window.__nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      // Two instances of the same scene, differing ONLY in whether illumination
      // was on at load time -- i.e. whether the gradient pass ran eagerly.
      const mk = async (id, left, illumination) => {
        const c = document.createElement('canvas')
        c.id = id
        c.width = 256; c.height = 256
        c.style.cssText =
          'position:fixed;top:0;left:' + left + 'px;width:256px;height:256px'
        document.body.appendChild(c)
        const nv = new NiiVue({
          backend: '${backend}',
          sliceType: SLICE_TYPE.RENDER,
          volumeIllumination: illumination,
          // A fixed camera: the assertion is a byte compare, so nothing about
          // the view may depend on canvas placement or default animation.
          azimuth: 120,
          elevation: 15,
        })
        await nv.attachToCanvas(c)
        await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
        await window.__nextFrame()
        await window.__nextFrame()
        return nv
      }

      window.__unlit = await mk('cvDeferred', 0, 0)
      window.__eager = await mk('cvEager', 300, ${ILLUM})
      return { ok: true }
    })()`)

    test.skip(!ready.ok, `backend unavailable: ${ready.why}`)

    const deferredCanvas = page.locator('#cvDeferred')
    const eagerCanvas = page.locator('#cvEager')

    // The gate itself. Without this the parity assertion below still passes if
    // someone drops the deferral and goes back to building eagerly -- the
    // upload-time cost would quietly return with the suite green.
    const hasGradient = () =>
      page.evaluate(
        '!!window.__unlit.view.volumeRenderer.volumeGradientTexture',
      ) as Promise<boolean>
    expect(await hasGradient()).toBe(false)

    const unlit = await deferredCanvas.screenshot()
    const eager = await eagerCanvas.screenshot()

    // The gradient texture does not exist yet on __unlit. This is the flip that
    // has to build it.
    await page.evaluate(`(async () => {
      window.__unlit.volumeIllumination = ${ILLUM}
      await window.__nextFrame()
      await window.__nextFrame()
    })()`)

    const deferred = await deferredCanvas.screenshot()

    expect(await hasGradient()).toBe(true)

    // 1. The deferred build ran: illumination visibly changed the render.
    expect(deferred.equals(unlit)).toBe(false)
    // 2. And it produced what the eager build produced.
    expect(deferred.equals(eager)).toBe(true)
  })
}
