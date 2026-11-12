import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// Streamed volumes in a real browser, beyond the reference images of
// render-streamed.spec.ts:
// - a lazy-time switch (VOL-01) never draws one time point's floor or bricks
//   under the other's, nor a blank frame: every frame drawn while it runs is
//   captured;
// - the GL channel-stack blend matches its CPU reference.

test.use(webgpuUse)

/** Mount, then a two-frame streamed ball: frame 0 at x=8, frame 1 at x=24. */
const mount = (backend: string, body: string): string => `(async () => {
  if ('${backend}' === 'webgpu') {
    const adapter = navigator.gpu && (await navigator.gpu.requestAdapter())
    if (!adapter) return { skip: 'no WebGPU adapter' }
  }
  const { default: NiiVue } = await import('/src/index.ts')
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 128
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:128px;height:128px'
  document.body.appendChild(canvas)
  const nv = new NiiVue({ backend: '${backend}', sliceType: 0, maxTextureDimension3D: 24, isAntiAlias: false })
  await nv.attachToCanvas(canvas)
  if (nv.backend !== '${backend}') return { skip: 'fell back to ' + nv.backend }
  const ball = (cx, n, value) => {
    const v = new Uint8Array(n ** 3)
    const k = 32 / n
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      if (((x + 0.5) * k - cx) ** 2 + ((y + 0.5) * k - 16) ** 2 + ((z + 0.5) * k - 16) ** 2 < 36)
        v[x + n * (y + n * z)] = value
    return v
  }
  const source = (levels, frames, slow) => ({
    datatypeCode: 2,
    frames,
    levels: levels.map((n, i) => ({ level: i, shape: [n, n, n], spacing: [32 / n, 32 / n, 32 / n] })),
    fetchChunk: async ({ texOrigin: o, texDims: d, levelIndex, frame = 0 }) => {
      if (slow) await new Promise((r) => setTimeout(r, slow))
      const n = levels[levelIndex]
      const vox = ball(frame ? 24 : 8, n, 200)
      const out = new Uint8Array(d[0] * d[1] * d[2])
      for (let z = 0; z < d[2]; z++) for (let y = 0; y < d[1]; y++) for (let x = 0; x < d[0]; x++) {
        const sx = o[0] + x, sy = o[1] + y, sz = o[2] + z
        if (sx < n && sy < n && sz < n) out[x + d[0] * (y + d[1] * z)] = vox[sx + n * (sy + n * sz)]
      }
      return out
    },
  })
  ${body}
})()`

for (const backend of ['webgl2', 'webgpu'] as const) {
  for (const stack of [false, true])
    test(`a lazy-time switch never draws two time points at once (${stack ? 'two-channel stack' : 'one volume'}, ${backend})`, async ({
      page,
    }) => {
      test.slow()
      const result = (await page.evaluate(
        mount(
          backend,
          `
        const group = {}
        nv.volumeIsChannelStack = ${stack}
        nv.volumeOverlayColorBlend = 3
        const chunked = await nv.loadChunkedVolume(source([32, 16], 2, 15), { calMin: 0, calMax: 255, colormap: 'red', frameGroup: group })
        if (${stack})
          await nv.loadChunkedVolume(source([32, 16], 2, 15), { calMin: 0, calMax: 255, colormap: 'green', frameGroup: group })
        // Brightest channel where each frame's ball lands on the axial slice.
        const sides = () => {
          const img = nv.getCanvasImage()
          if (!img) return null
          const at = (x0, x1) => {
            let s = 0, n = 0
            for (let y = 40; y < 88; y++) for (let x = x0; x < x1; x++) {
              const k = 4 * (y * img.width + x)
              s += Math.max(img.data[k], img.data[k + 1], img.data[k + 2]); n++
            }
            return s / n
          }
          return [at(16, 48), at(80, 112)]
        }
        await nv.whenChunkStreamSettles()
        const before = sides()
        const frames = []
        let done = false
        const switching = chunked.setFrame(1).then(() => { done = true })
        while (!done) {
          const s = sides()
          if (s) frames.push(s)
          await new Promise((r) => requestAnimationFrame(r))
        }
        await switching
        // Stream-in of the new frame is where old fused chunks could linger.
        for (let k = 0; k < 30; k++) {
          const s = sides()
          if (s) frames.push(s)
          await new Promise((r) => requestAnimationFrame(r))
        }
        await nv.whenChunkStreamSettles()
        return { before, frames, settled: sides() }
      `,
        ),
      )) as {
        skip?: string
        before: number[]
        frames: number[][]
        settled: number[]
      }
      test.skip(!!result.skip, result.skip)
      const lit = (v: number) => v > 20
      const mixed = result.frames.filter(([l, r]) => lit(l) && lit(r))
      expect(result.frames.length).toBeGreaterThan(0)
      expect(mixed).toEqual([])
      // One volume keeps its floor through the switch; a stack's base draws
      // at opacity 0, so its new chunks may show blank before they fuse.
      if (!stack)
        expect(result.frames.filter(([l, r]) => !lit(l) && !lit(r))).toEqual([])
      // One side lit before, the other after.
      expect(result.before.map(lit)).toEqual(result.settled.map((v) => !lit(v)))
      expect(result.before.filter(lit).length).toBe(1)
    })
}

// The GL GPU fuse (blendOverlaysGL) against the CPU blendOverlayData it
// replaces, over every alpha x colour mode: the largest per-channel
// difference, which the WebGPU blend (check-blend-wgsl.mjs) holds to 1.
test('GL GPU blend matches blendOverlayData in every mode', async ({
  page,
}) => {
  const result = (await page.evaluate(`(async () => {
    const { blendOverlaysGL } = await import('/src/gl/blendOverlays.ts')
    const { blendOverlayData } = await import('/src/volume/overlayBlend.ts')
    const { readTexture3D } = await import('/src/gl/orientOverlay.ts')
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl.getExtension('EXT_color_buffer_float')) return { skip: 'no float targets' }
    const dims = [13, 11, 9]
    const n = dims[0] * dims[1] * dims[2] * 4
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256)
    const layers = [0, 1, 2].map(() => {
      const d = new Uint8Array(n)
      for (let i = 0; i < n; i++) d[i] = rnd()
      for (let i = 3; i < n; i += 4) if (rnd() < 64) d[i] = 0
      return d
    })
    const textures = layers.map((d) => {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_3D, t)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, dims[0], dims[1], dims[2], 0, gl.RGBA, gl.UNSIGNED_BYTE, d)
      return t
    })
    let max = 0
    const worst = []
    for (let a = 0; a < 3; a++) for (let c = 0; c < 4; c++) {
      const cpu = blendOverlayData(layers, dims, a, c)
      const gpu = readTexture3D(gl, blendOverlaysGL(gl, textures, dims, a, c), dims)
      let m = 0
      for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(cpu[i] - gpu[i]))
      worst.push(a + '/' + c + ':' + m)
      max = Math.max(max, m)
    }
    return { max, worst }
  })()`)) as { skip?: string; max: number; worst: string[] }
  test.skip(!!result.skip, result.skip)
  console.log(
    `GL GPU blend vs CPU: max ${result.max} (${result.worst.join(' ')})`,
  )
  expect(result.max).toBeLessThanOrEqual(1)
})
