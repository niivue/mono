import { expect, test } from '@playwright/test'

// `crosshairColorPerAxis` tints each crosshair segment by the world axis it
// extends along, and the mapping is only observable in the rendered pixels: the
// colour is chosen per cylinder inside gl/crosshair.ts and wgpu/crosshair.ts,
// downstream of anything the Bun runner can import. getAxisColor()'s unit tests
// pin the resolver; they cannot tell you that cylinder index 2 is the Y axis, or
// that the WebGPU path reads the same array as WebGL2.
//
// So this asserts the mapping through the public API, on both backends, by
// counting saturated pixels per channel on a single-slice view:
//
//   AXIAL     shows X and Y  -> red + green, never blue
//   CORONAL   shows X and Z  -> red + blue,  never green
//   SAGITTAL  shows Y and Z  -> green + blue, never red
//
// A swapped pair fails on the channel that is asserted absent, which a
// "some colour changed" assertion would miss. The default (`[]`) is checked
// first, and must show red only -- that is the backward-compatibility claim.

// WebGPU is off by default in headless Chromium. These flags bring up Dawn on
// SwiftShader; scoped to this file so the rest of the suite keeps the config's
// plain WebGL2-on-SwiftShader setup. `launchOptions` REPLACES the config's
// object rather than merging into it, so the config's PLAYWRIGHT_CHROMIUM_PATH
// escape hatch has to be repeated here or this file alone fails to launch on a
// machine without Playwright's pinned revision.
test.use({
  launchOptions: {
    args: [
      '--enable-unsafe-swiftshader',
      '--enable-unsafe-webgpu',
      '--use-angle=swiftshader',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
    ],
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {}),
  },
})

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// The real mni152 from packages/dev-images, so this spec loads the same single
// LFS object niivue-e2e.yml already pulls for texcache-kind-change. An unpulled
// pointer parses as "not NIFTI" and fails loudly rather than testing nothing.
const VOLUME = '/volumes/mni152.nii.gz'

// Pure primaries, so each segment is classified by which channel dominates.
// The crosshair is lit 3D geometry, not a flat 2D line: a pure-green cylinder
// lands around rgb(0,139,0) and the red one ranges from rgb(92,0,0) to
// rgb(240,45,45) depending on the angle it is seen at. Only the ordering of
// the channels is stable, so the classifier must not test brightness.
const PER_AXIS = '[[1,0,0,1],[0,1,0,1],[0,0,1,1]]'

// A crosshair is a few pixels wide across one canvas edge; anything above a
// handful of pixels is a drawn line rather than an anti-aliased stray.
const MIN_LINE_PIXELS = 20

type Counts = { red: number; green: number; blue: number }
type Phase = { name: string; counts: Counts }
type Result = { skip?: string; backend?: string; phases?: Phase[] }

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`crosshair segments take their axis colour (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const result: Result = await page.evaluate(`(async () => {
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
      const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      const canvas = document.createElement('canvas')
      canvas.width = 512
      canvas.height = 512
      document.body.appendChild(canvas)

      const nv = new NiiVue({
        backend: '${backend}',
        backgroundColor: [0, 0, 0, 1],
        sliceType: SLICE_TYPE.AXIAL,
        crosshairWidth: 2,
        // The orientation cube is drawn in red/green/blue, and the labels in
        // the font colour. Both would be counted as crosshair pixels.
        isOrientCubeVisible: false,
        isOrientationTextVisible: false,
        isColorbarVisible: false,
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

      // Same capture path as saveBitmap(): render, then copy in the same task,
      // so the drawing buffer is still valid without preserveDrawingBuffer.
      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }

      const count = () => {
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let red = 0
        let green = 0
        let blue = 0
        // The slice itself is grayscale (r == g == b) and the background is
        // black, so a channel leading the other two by this margin is a
        // crosshair pixel whatever the lighting did to its brightness.
        const LEAD = 40
        const FLOOR = 50
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i]
          const g = px[i + 1]
          const b = px[i + 2]
          if (r > FLOOR && r - g > LEAD && r - b > LEAD) red++
          else if (g > FLOOR && g - r > LEAD && g - b > LEAD) green++
          else if (b > FLOOR && b - r > LEAD && b - g > LEAD) blue++
        }
        return { red, green, blue }
      }

      const phases = []
      const measure = async (name, sliceType) => {
        nv.sliceType = sliceType
        await nextFrame()
        await nextFrame()
        phases.push({ name, counts: count() })
      }

      // Default: crosshairColorPerAxis is [], so every segment is crosshairColor.
      await measure('default-axial', SLICE_TYPE.AXIAL)

      nv.crosshairColorPerAxis = ${PER_AXIS}
      await measure('perAxis-axial', SLICE_TYPE.AXIAL)
      await measure('perAxis-coronal', SLICE_TYPE.CORONAL)
      await measure('perAxis-sagittal', SLICE_TYPE.SAGITTAL)

      return { backend: nv.backend, phases }
     } catch (e) {
      return { skip: 'threw: ' + (e && e.message ? e.message : e) }
     }
    })()`)

    test.skip(!!result.skip, result.skip ?? '')
    expect(result.backend).toBe(backend)

    const phases = result.phases ?? []
    const at = (name: string): Counts => {
      const phase = phases.find((p) => p.name === name)
      if (!phase) throw new Error(`missing phase ${name}`)
      return phase.counts
    }

    // Unchanged for existing users: the whole crosshair is crosshairColor (red).
    const fallback = at('default-axial')
    expect(fallback.red).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(fallback.green).toBe(0)
    expect(fallback.blue).toBe(0)

    const axial = at('perAxis-axial')
    expect(axial.red).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(axial.green).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(axial.blue).toBe(0)

    const coronal = at('perAxis-coronal')
    expect(coronal.red).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(coronal.blue).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(coronal.green).toBe(0)

    const sagittal = at('perAxis-sagittal')
    expect(sagittal.green).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(sagittal.blue).toBeGreaterThan(MIN_LINE_PIXELS)
    expect(sagittal.red).toBe(0)
  })
}
