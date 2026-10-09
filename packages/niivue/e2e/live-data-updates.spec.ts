import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// updateVolumeData / updateMeshPositions: the in-place fast paths for
// animating loaded data.
//
// The volume case is the regression this guards: the orient-texture caches key
// on the `img` buffer identity, which an in-place edit keeps, so before the
// `_dataVersion` token an edited volume kept drawing its old voxels. Each case
// asserts both that the pixels change and that the fast path really is fast:
// the mesh's GPU resources survive (no full rebuild).
//
// WebGPU is skipped when the runner has no adapter.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const VOLUME = '/volumes/mni152.nii.gz'
const MESH = '/meshes/BrainMesh_ICBM152.lh.mz3'

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`updateVolumeData and updateMeshPositions redraw in place (${backend})`, async ({
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
          return { skip: 'requestAdapter threw: ' + e }
        }
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        backgroundColor: [0, 0, 0, 1],
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

      // Render, then copy in the same task (no preserveDrawingBuffer needed).
      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      const litPixels = async () => {
        await nextFrame()
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let lit = 0
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30) lit++
        }
        return lit
      }

      // ---- volume ----
      await nv.loadVolumes([{ url: '${VOLUME}' }])
      await nv.loadMeshes([{ url: '${MESH}' }])
      await nextFrame()
      nv.meshes[0].opacity = 0
      await nv.setMesh(0, { opacity: 0 })
      const volBefore = await litPixels()
      const meshGpuBefore = nv.view._getMeshGpu(nv.meshes[0])

      const vol = nv.volumes[0]
      // Raw (unscaled) maximum: img holds raw values, calMax is scaled.
      let rawMax = 0
      for (let i = 0; i < vol.img.length; i++) rawMax = Math.max(rawMax, vol.img[i])
      // Zero one frame through the API: copies into the SAME buffer.
      await nv.updateVolumeData(0, new Array(vol.nVox3D).fill(0))
      const volZeroed = await litPixels()
      const meshGpuAfterVolume = nv.view._getMeshGpu(nv.meshes[0])

      // In-place edit by the caller, then a data-less call.
      vol.img.fill(rawMax)
      await nv.updateVolumeData(0)
      const volFilled = await litPixels()

      // ---- mesh ----
      await nv.removeAllVolumes()
      nv.sliceType = SLICE_TYPE.RENDER
      await nv.setMesh(0, { opacity: 1 })
      const meshBefore = await litPixels()
      const gpuBefore = nv.view._getMeshGpu(nv.meshes[0])

      let fullRebuilds = 0
      const origUpdate = nv.updateGLVolume.bind(nv)
      nv.updateGLVolume = () => {
        fullRebuilds++
        return origUpdate()
      }
      // Shrink the mesh to a quarter of its size about its centroid.
      const pts = nv.meshes[0].positions
      const c = [0, 0, 0]
      const n = pts.length / 3
      for (let i = 0; i < pts.length; i++) c[i % 3] += pts[i] / n
      const shrunk = new Float32Array(pts.length)
      for (let i = 0; i < pts.length; i++) {
        shrunk[i] = c[i % 3] + (pts[i] - c[i % 3]) * 0.25
      }
      nv.updateMeshPositions(0, shrunk)
      const meshShrunk = await litPixels()
      const gpuAfter = nv.view._getMeshGpu(nv.meshes[0])

      return {
        volBefore,
        volZeroed,
        volFilled,
        meshKeptOnVolumeUpdate: meshGpuBefore === meshGpuAfterVolume,
        meshBefore,
        meshShrunk,
        meshKeptOnMeshUpdate: gpuBefore === gpuAfter,
        fullRebuilds,
        positionsCopied: nv.meshes[0].positions[0] === shrunk[0],
      }
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

    // Volume: the slice is visible, goes black when zeroed, and lights up
    // again (the whole slice) after a caller's in-place fill.
    expect(r.volBefore).toBeGreaterThan(1000)
    expect(r.volZeroed).toBeLessThan(r.volBefore * 0.05)
    expect(r.volFilled).toBeGreaterThan(r.volBefore)
    // A volume-data update leaves mesh GPU resources alone.
    expect(r.meshKeptOnVolumeUpdate).toBe(true)

    // Mesh: shrinking shows up, through the in-place buffer write.
    expect(r.meshBefore).toBeGreaterThan(1000)
    expect(r.meshShrunk).toBeLessThan(r.meshBefore * 0.5)
    expect(r.meshKeptOnMeshUpdate).toBe(true)
    expect(r.fullRebuilds).toBe(0)
    expect(r.positionsCopied).toBe(true)
  })
}
