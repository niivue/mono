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
// On VOLUME's grid, so it can be loaded as an overlay.
const OVERLAY = '/volumes/mni152_mask.nii.gz'
// Small 4D (2-frame) int16 volume, for the one-frame form of updateVolumeData.
const VOLUME_4D = '/volumes/i16.nii.gz'
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
      await nv.setMesh(0, { opacity: 0 })
      const volBefore = await litPixels()
      const meshGpuBefore = nv.view._getMeshGpu(nv.meshes[0])

      const vol = nv.volumes[0]
      // Raw (unscaled) maximum: img holds raw values, calMax is scaled.
      let rawMax = 0
      for (let i = 0; i < vol.img.length; i++) rawMax = Math.max(rawMax, vol.img[i])
      // Zero the whole (3D) volume through the API: copies into the SAME
      // buffer, which the orient cache must notice via _dataVersion.
      const bgCacheBefore = nv.view.volumeRenderer.volumeOrientCache
      const bgSourceBefore = bgCacheBefore
        ? bgCacheBefore.inputTexture ?? bgCacheBefore.sourceTexture
        : null
      await nv.updateVolumeData(0, new Array(vol.img.length).fill(0))
      const volZeroed = await litPixels()
      const meshGpuAfterVolume = nv.view._getMeshGpu(nv.meshes[0])
      const bgCacheAfter = nv.view.volumeRenderer.volumeOrientCache
      const bgTexturesKept =
        !!bgCacheBefore &&
        bgCacheAfter === bgCacheBefore &&
        (bgCacheAfter.inputTexture ?? bgCacheAfter.sourceTexture) ===
          bgSourceBefore

      // In-place edit by the caller, then a data-less call.
      vol.img.fill(rawMax)
      await nv.updateVolumeData(0)
      const volFilled = await litPixels()

      // ---- overlay: only the overlay pass re-runs ----
      await nv.loadVolumes([
        { url: '${VOLUME}' },
        { url: '${OVERLAY}', colormap: 'red', calMin: 0, calMax: 1 },
      ])
      await nextFrame()
      // Pixels where red clearly leads: the overlay, not the gray background.
      const redPixels = async () => {
        await nextFrame()
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let red = 0
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] - px[i + 1] > 40 && px[i] - px[i + 2] > 40) red++
        }
        return red
      }
      const ovBefore = await redPixels()
      const ovCacheBefore = nv.view.volumeRenderer.overlayOrientCache
      let backgroundPasses = 0
      const renderer = nv.view.volumeRenderer
      const origUpdateVolume = renderer.updateVolume.bind(renderer)
      renderer.updateVolume = (...args) => {
        backgroundPasses++
        return origUpdateVolume(...args)
      }
      await nv.updateVolumeData(1, new Array(nv.volumes[1].img.length).fill(0))
      const ovZeroed = await redPixels()
      renderer.updateVolume = origUpdateVolume
      const ovCacheKept =
        !!ovCacheBefore &&
        nv.view.volumeRenderer.overlayOrientCache === ovCacheBefore

      // ---- 4D: the one-frame form writes only the current frame ----
      await nv.loadVolumes([{ url: '${VOLUME_4D}' }])
      const v4 = nv.volumes[0]
      await nv.setFrame4D(v4.id, 1)
      const f4Before = await litPixels()
      const sumFrame = (f) => {
        let sum = 0
        for (let i = f * v4.nVox3D; i < (f + 1) * v4.nVox3D; i++) {
          sum += Math.abs(v4.img[i])
        }
        return sum
      }
      const frame0Before = sumFrame(0)
      await nv.updateVolumeData(0, new Array(v4.nVox3D).fill(0))
      const f4Zeroed = await litPixels()
      const frame0After = sumFrame(0)
      const frame1After = sumFrame(1)

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
        bgTexturesKept,
        ovBefore,
        ovZeroed,
        backgroundPasses,
        ovCacheKept,
        f4Before,
        f4Zeroed,
        frame0Before,
        frame0After,
        frame1After,
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
    // A volume-data update leaves mesh GPU resources alone, and re-uploads
    // into the existing orient cache rather than reallocating it.
    expect(r.meshKeptOnVolumeUpdate).toBe(true)
    expect(r.bgTexturesKept).toBe(true)

    // Overlay: zeroing it removes the red, without re-running the background
    // pass, through the existing overlay cache.
    expect(r.ovBefore).toBeGreaterThan(1000)
    expect(r.ovZeroed).toBeLessThan(r.ovBefore * 0.05)
    expect(r.backgroundPasses).toBe(0)
    expect(r.ovCacheKept).toBe(true)

    // 4D: one frame's worth of values replaces only the displayed frame.
    expect(r.f4Before).toBeGreaterThan(100)
    expect(r.f4Zeroed).toBeLessThan(r.f4Before * 0.05)
    expect(r.frame0After).toBe(r.frame0Before)
    expect(r.frame0Before).toBeGreaterThan(0)
    expect(r.frame1After).toBe(0)

    // Mesh: shrinking shows up, through the in-place buffer write.
    expect(r.meshBefore).toBeGreaterThan(1000)
    expect(r.meshShrunk).toBeLessThan(r.meshBefore * 0.5)
    expect(r.meshKeptOnMeshUpdate).toBe(true)
    expect(r.fullRebuilds).toBe(0)
    expect(r.positionsCopied).toBe(true)
  })
}
