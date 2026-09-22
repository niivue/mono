import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// The gradient texture (RGB = encoded unit normal, A = log-encoded magnitude)
// feeds three features -- matcap illumination, gradientOpacity and
// silhouettePower -- and BOTH backends must build it identically, or switching
// backend changes the picture.
//
// They did not. wgpu/sobel.wgsl ran an 8-corner Sobel over the colormapped
// texture's RED channel followed by a 27-tap blur; gl/gradient.ts ran three
// linear-sampled central differences over ALPHA. Red is the fatal one: on the
// `hot` LUT red saturates at 37% of the intensity range and is flat above it,
// so WebGPU returned NO gradient at all across the top 63% of the data. Alpha
// is monotonic in intensity for every LUT, so it is the channel both now read.
// Both now run the old package's two-pass estimator (8-corner box blur of
// alpha, then 8-corner Sobel of the blur), reachable on WebGL2 as two FBO
// passes; the shared constants live in view/NVGradient.ts.
//
// This runs both gradient passes over ONE deterministic input volume and diffs
// the readbacks texel by texel. Both write rgba8unorm through the same
// hardware trilinear filter, so the bar is bit-exactness, not a tolerance.
// Point sobel.wgsl back at `.r` and the magnitude channel diverges on ~30% of
// texels (verified by doing exactly that).

// WebGPU is off by default in headless Chromium. These flags bring up Dawn on
// SwiftShader, which is enough to run a compute pass; scoped to this file so the
// rest of the suite keeps the config's plain WebGL2-on-SwiftShader setup.
test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const harness = `
  const { volume2TextureGradientRGBA: glGrad } = await import('/src/gl/gradient.ts')
  const { volume2TextureGradientRGBA: gpuGrad } = await import('/src/wgpu/wgpu.ts')

  const D = 32
  const N = D * D * D

  // A soft sphere plus a hard slab step, with RGB deliberately UNLIKE alpha:
  // red saturates part-way up, as it does on a real colour LUT. A backend
  // reading the wrong channel therefore cannot pass by coincidence.
  const src = new Uint8Array(N * 4)
  for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) for (let x = 0; x < D; x++) {
    const i = x + y * D + z * D * D
    const dx = x - 15.5, dy = y - 15.5, dz = z - 15.5
    let a = Math.max(0, 1 - Math.sqrt(dx*dx + dy*dy + dz*dz) / 12)
    if (x > 20) a = Math.min(1, a + 0.5)
    const v = Math.round(a * 255)
    src[i*4+0] = Math.min(255, v * 3)
    src[i*4+1] = 255 - v
    src[i*4+2] = 128
    src[i*4+3] = v
  }

  const runGL = () => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const inTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_3D, inTex)
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, D, D, D)
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0,0,0, D,D,D, gl.RGBA, gl.UNSIGNED_BYTE, src)
    const outTex = glGrad(gl, inTex, [D, D, D])
    const out = new Uint8Array(N * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer())
    const slice = new Uint8Array(D * D * 4)
    for (let z = 0; z < D; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, outTex, 0, z)
      gl.readPixels(0, 0, D, D, gl.RGBA, gl.UNSIGNED_BYTE, slice)
      out.set(slice, z * D * D * 4)
    }
    return out
  }

  const runGPU = async () => {
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) return null
    const device = await adapter.requestDevice()
    const inGpu = device.createTexture({
      size: [D, D, D], dimension: '3d', format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture: inGpu }, src,
      { bytesPerRow: D * 4, rowsPerImage: D }, [D, D, D])
    const outGpu = await gpuGrad(device, inGpu)
    // D*4 = 128 bytes per row, padded to copyTextureToBuffer's 256 alignment.
    const bpr = 256
    const buf = device.createBuffer({
      size: bpr * D * D,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const enc = device.createCommandEncoder()
    enc.copyTextureToBuffer({ texture: outGpu },
      { buffer: buf, bytesPerRow: bpr, rowsPerImage: D }, [D, D, D])
    device.queue.submit([enc.finish()])
    await buf.mapAsync(GPUMapMode.READ)
    const padded = new Uint8Array(buf.getMappedRange())
    const out = new Uint8Array(N * 4)
    for (let z = 0; z < D; z++) for (let y = 0; y < D; y++) {
      out.set(padded.subarray((z*D + y)*bpr, (z*D + y)*bpr + D*4), (z*D*D + y*D) * 4)
    }
    return out
  }
`

test('both backends build a bit-identical gradient texture', async ({
  page,
}) => {
  test.setTimeout(120_000)

  const r = await page.evaluate(`(async () => {
    ${harness}
    const gpuOut = await runGPU()
    if (!gpuOut) return { noWebGPU: true }
    const glOut = runGL()

    const N4 = gpuOut.length
    const perChannel = [0, 0, 0, 0]
    let nonzeroMagGL = 0, nonzeroMagGPU = 0
    for (let i = 0; i < N4; i += 4) {
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(glOut[i+c] - gpuOut[i+c])
        if (d > perChannel[c]) perChannel[c] = d
      }
      if (glOut[i+3] > 0) nonzeroMagGL++
      if (gpuOut[i+3] > 0) nonzeroMagGPU++
    }
    return { perChannel, nonzeroMagGL, nonzeroMagGPU, texels: N4 / 4 }
  })()`)

  // Software WebGPU is not guaranteed in every headless shell; the WebGL2 half
  // alone would prove nothing, so skip rather than pass vacuously.
  test.skip(!!r.noWebGPU, 'no WebGPU adapter in this browser')

  // Bit-exact on all four channels: normal x/y/z and the log magnitude.
  expect(r.perChannel).toEqual([0, 0, 0, 0])

  // The count of texels carrying ANY gradient is what the red-channel bug
  // destroyed (it zeroed the field wherever red had saturated), so assert it
  // separately -- the equality above would also hold if both were empty.
  expect(r.nonzeroMagGL).toBe(r.nonzeroMagGPU)
  expect(r.nonzeroMagGL).toBeGreaterThan(r.texels / 8)
})
