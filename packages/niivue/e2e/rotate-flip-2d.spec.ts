import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'
import { syntheticVolume } from './syntheticVolume'

// rotation2D / flips on real GPUs: a square axial tile of the (asymmetric)
// synthetic phantom must come out as the unturned capture rotated clockwise or
// mirrored on screen. Unit tests pin the matrices; only this pins the sign on
// each backend's clip space and framebuffer.

test.use(webgpuUse)

type Result = {
  skip?: string
  // Fraction of pixels off by more than the tolerance, per state.
  mismatch?: Record<string, number>
  // Fraction of pixels a quarter turn changes at all (the phantom is not symmetric).
  changed?: number
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`2D rotate and flip draw the turned or mirrored slice (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const result: Result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        let adapter = null
        try {
          adapter = await navigator.gpu.requestAdapter()
        } catch (e) {
          return { skip: 'requestAdapter threw: ' + e }
        }
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
      const synth = ${syntheticVolume}
      const W = 128
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = W
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        sliceType: SLICE_TYPE.AXIAL,
        crosshairWidth: 0,
        isOrientCubeVisible: false,
        isOrientationTextVisible: false,
        isColorbarVisible: false,
      })
      await nv.attachToCanvas(canvas)
      if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
        return { skip: 'WebGPU init fell back to ' + nv.backend }
      }
      await nv.loadVolumes([{ url: synth() }])
      const grab = (state) => {
        nv.rotation2D = state[0]
        nv.isFlipped2DHorizontal = state[1]
        nv.isFlipped2DVertical = state[2]
        const img = nv.getCanvasImage()
        return img.data
      }
      const base = grab([0, false, false])
      // Where each state's pixel (x, y) comes from in the base capture.
      const from = {
        rot90: (x, y) => [y, W - 1 - x],
        rot180: (x, y) => [W - 1 - x, W - 1 - y],
        rot270: (x, y) => [W - 1 - y, x],
        flipH: (x, y) => [W - 1 - x, y],
        flipV: (x, y) => [x, W - 1 - y],
        rot90flipH: (x, y) => [y, x],
        flipHV: (x, y) => [W - 1 - x, W - 1 - y],
      }
      const states = {
        rot90: [90, false, false],
        rot180: [180, false, false],
        rot270: [270, false, false],
        flipH: [0, true, false],
        flipV: [0, false, true],
        rot90flipH: [90, true, false],
        flipHV: [0, true, true],
      }
      const diff = (img, map, tol) => {
        let bad = 0
        for (let y = 0; y < W; y++)
          for (let x = 0; x < W; x++) {
            const [sx, sy] = map(x, y)
            const a = 4 * (y * W + x)
            const b = 4 * (sy * W + sx)
            for (let c = 0; c < 3; c++)
              if (Math.abs(img[a + c] - base[b + c]) > tol) {
                bad++
                break
              }
          }
        return bad / (W * W)
      }
      const mismatch = {}
      let changed = 0
      for (const [name, state] of Object.entries(states)) {
        const img = grab(state)
        mismatch[name] = diff(img, from[name], 8)
        if (name === 'rot90') changed = diff(img, (x, y) => [x, y], 0)
      }
      nv.destroy()
      canvas.remove()
      return { mismatch, changed }
    })()`)
    test.skip(!!result.skip, result.skip)
    expect(result.changed).toBeGreaterThan(0.05)
    for (const [state, bad] of Object.entries(result.mismatch ?? {}))
      expect(bad, state).toBeLessThan(0.01)
  })
}
