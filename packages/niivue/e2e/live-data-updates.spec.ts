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

// The ordinary update path after an in-place edit: the caller rewrites `img`
// (same buffer) and sets `isDirty`, then calls setVolume / updateGLVolume /
// setFrame4D. The orient caches key on the buffer identity, so before
// `isDirty` was honoured these redraws kept the old voxels. Also covers
// re-registering a colormap name, which the same caches keyed by name.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`isDirty in-place edits redraw through the ordinary update path (${backend})`, async ({
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

      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      // Pixels that are lit, and pixels where one channel clearly leads.
      const count = async () => {
        await nextFrame()
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let lit = 0
        let red = 0
        let green = 0
        let gray = 0
        for (let i = 0; i < px.length; i += 4) {
          const isLit = px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30
          const isRed = px[i] - px[i + 1] > 40 && px[i] - px[i + 2] > 40
          const isGreen = px[i + 1] - px[i] > 40 && px[i + 1] - px[i + 2] > 40
          if (isLit) lit++
          if (isRed) red++
          if (isGreen) green++
          if (isLit && !isRed && !isGreen) gray++
        }
        return { lit, red, green, gray }
      }
      const renderer = () => nv.view.volumeRenderer

      await nv.loadVolumes([
        { url: '${VOLUME}' },
        { url: '${OVERLAY}', colormap: 'red', calMin: 0, calMax: 1 },
      ])
      const bg = nv.volumes[0]
      const ov = nv.volumes[1]
      const start = await count()

      // ---- overlay edited in place, then setVolume ----
      const bgCache = renderer().volumeOrientCache
      const bgCacheVersion = bgCache ? bgCache.dataVersion : null
      const bgVersion = bg._dataVersion ?? 0
      const ovCache = renderer().overlayOrientCache
      const ovSource = ovCache
        ? ovCache.inputTexture ?? ovCache.sourceTexture
        : null
      const ovOriginal = ov.img.slice()
      ov.img.fill(0)
      ov.isDirty = true
      await nv.setVolume(1, { opacity: 1 })
      const ovZeroed = await count()
      const ovFlagCleared = ov.isDirty === false
      const ovCacheAfter = renderer().overlayOrientCache
      // The overlay re-uploaded into its existing texture...
      const ovTexturesKept =
        !!ovCache &&
        ovCacheAfter === ovCache &&
        (ovCacheAfter.inputTexture ?? ovCacheAfter.sourceTexture) === ovSource
      // ...and the clean background was not re-uploaded.
      const bgCacheAfter = renderer().volumeOrientCache
      const bgUntouched =
        !!bgCache &&
        bgCacheAfter === bgCache &&
        bgCacheAfter.dataVersion === bgCacheVersion &&
        (bg._dataVersion ?? 0) === bgVersion

      // ---- background edited in place, then updateGLVolume ----
      const bgOriginal = bg.img.slice()
      bg.img.fill(0)
      bg.isDirty = true
      await nv.updateGLVolume()
      const bgZeroed = await count()

      // ---- a dirty overlay joins a scoped updateVolumeData(background) ----
      ov.img.set(ovOriginal)
      ov.isDirty = true
      await nv.updateVolumeData(0, bgOriginal)
      const bothRestored = await count()

      // ---- affine-only update: its overlay fast path stands aside ----
      const view = nv.view
      const origBind = view.updateBindGroups.bind(view)
      let fullBinds = 0
      view.updateBindGroups = (...args) => {
        fullBinds++
        return origBind(...args)
      }
      const still = { translation: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
      // Nothing dirty: the overlay-only fast path handles it.
      await nv.applyVolumeTransform(1, still)
      const fastPathBinds = fullBinds
      bg.img.fill(0)
      bg.isDirty = true
      await nv.applyVolumeTransform(1, still)
      const affineDirtyBinds = fullBinds - fastPathBinds
      const affineZeroed = await count()
      view.updateBindGroups = origBind

      // ---- 4D: an in-place edit of the displayed frame ----
      await nv.loadVolumes([{ url: '${VOLUME_4D}' }])
      const v4 = nv.volumes[0]
      await nv.setFrame4D(v4.id, 1)
      const f4Before = await count()
      v4.img.fill(0, v4.nVox3D, 2 * v4.nVox3D)
      v4.isDirty = true
      await nv.updateGLVolume()
      const f4Zeroed = await count()

      // ---- re-registering a colormap name ----
      nv.addColormap('liveSwap', { R: [0, 255], G: [0, 0], B: [0, 0] })
      await nv.loadVolumes([{ url: '${VOLUME}', colormap: 'liveSwap' }])
      const cmapRed = await count()
      nv.addColormap('liveSwap', { R: [0, 0], G: [0, 255], B: [0, 0] })
      await nv.updateGLVolume()
      const cmapGreen = await count()

      return {
        start,
        ovZeroed,
        ovFlagCleared,
        ovTexturesKept,
        bgUntouched,
        bgZeroed,
        bothRestored,
        fastPathBinds,
        affineDirtyBinds,
        affineZeroed,
        f4Before,
        f4Zeroed,
        cmapRed,
        cmapGreen,
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

    // Overlay: setVolume after an in-place zeroing removes the red, reusing
    // the overlay's textures and leaving the clean background's alone.
    expect(r.start.lit).toBeGreaterThan(1000)
    expect(r.start.red).toBeGreaterThan(1000)
    expect(r.ovZeroed.red).toBeLessThan(r.start.red * 0.05)
    expect(r.ovFlagCleared).toBe(true)
    expect(r.ovTexturesKept).toBe(true)
    expect(r.bgUntouched).toBe(true)

    // Background: updateGLVolume after an in-place zeroing blanks the slice.
    expect(r.bgZeroed.lit).toBeLessThan(r.start.lit * 0.05)

    // A scoped update of the background also uploads the dirty overlay.
    expect(r.bothRestored.lit).toBeGreaterThan(r.start.lit * 0.9)
    expect(r.bothRestored.red).toBeGreaterThan(r.start.red * 0.9)

    // Affine-only update: without dirty volumes it takes the overlay-only fast
    // path; with a dirty background it rebuilds, so the edit shows.
    expect(r.fastPathBinds).toBe(0)
    expect(r.affineDirtyBinds).toBeGreaterThan(0)
    // The overlay is back by now, so count the gray background only.
    expect(r.affineZeroed.gray).toBeLessThan(r.start.gray * 0.05)

    // 4D: the displayed frame's in-place edit shows.
    expect(r.f4Before.lit).toBeGreaterThan(100)
    expect(r.f4Zeroed.lit).toBeLessThan(r.f4Before.lit * 0.05)

    // Colormap: the re-registered colors replace the cached ones.
    expect(r.cmapRed.red).toBeGreaterThan(1000)
    expect(r.cmapGreen.green).toBeGreaterThan(1000)
    expect(r.cmapGreen.red).toBeLessThan(r.cmapRed.red * 0.05)
  })
}

// RGB/RGBA volumes skip the orient pass, so they had no cache to reuse:
// every update allocated a new 3D texture (and, on WebGPU, copied the voxels
// first). They now keep one texture per slot and write new voxels into it.
// The background slot skips the upload while its voxels are unchanged; the
// overlay slot re-uploads on each overlay pass, and background masking must
// not free the texture it keeps.
const RGB_VOLUME = '/volumes/visiblehuman.nii.gz'

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`updateVolumeData reuses RGB volume textures (${backend})`, async ({
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
      const errors = []
      if (nv.view && nv.view.device) {
        nv.view.device.addEventListener('uncapturederror', (e) => {
          errors.push(String(e.error && e.error.message))
        })
      }

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
      const renderer = () => nv.view.volumeRenderer
      const gpuAllocs = () => {
        // Count 3D texture allocations, so a reused texture can be told apart
        // from a fresh one that happens to be cached in the same slot.
        let n = 0
        if ('${backend}' === 'webgl2') {
          const gl = nv.view.gl
          const storage = gl.texStorage3D.bind(gl)
          const image = gl.texImage3D.bind(gl)
          gl.texStorage3D = (...a) => {
            n++
            return storage(...a)
          }
          gl.texImage3D = (...a) => {
            n++
            return image(...a)
          }
          return {
            count: () => n,
            restore: () => {
              gl.texStorage3D = storage
              gl.texImage3D = image
            },
          }
        }
        const device = nv.view.device
        const orig = device.createTexture.bind(device)
        device.createTexture = (desc) => {
          if (desc.dimension === '3d') n++
          return orig(desc)
        }
        return { count: () => n, restore: () => { device.createTexture = orig } }
      }
      const uploadsTo = (tex) => {
        // Count voxel uploads into one texture: proves an unchanged volume's
        // upload was skipped, not merely written into the same texture.
        let n = 0
        if ('${backend}' === 'webgl2') {
          const gl = nv.view.gl
          const orig = gl.texSubImage3D.bind(gl)
          gl.texSubImage3D = (...a) => {
            if (gl.getParameter(gl.TEXTURE_BINDING_3D) === tex) n++
            return orig(...a)
          }
          return { count: () => n, restore: () => { gl.texSubImage3D = orig } }
        }
        const queue = nv.view.device.queue
        const orig = queue.writeTexture.bind(queue)
        queue.writeTexture = (dst, ...a) => {
          if (dst.texture === tex) n++
          return orig(dst, ...a)
        }
        return { count: () => n, restore: () => { queue.writeTexture = orig } }
      }
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

      // ---- background ----
      await nv.loadVolumes([{ url: '${RGB_VOLUME}' }])
      const vol = nv.volumes[0]
      const original = vol.img.slice()
      const zeros = new Array(original.length).fill(0)
      const bgBefore = await litPixels()
      const bgTex = renderer().volumeTexture
      const bgCacheTex = renderer().volumeRgbaCache
        ? renderer().volumeRgbaCache.texture
        : null

      let allocs = gpuAllocs()
      let uploads = uploadsTo(bgCacheTex)
      await nv.updateVolumeData(0, zeros)
      const bgZeroed = await litPixels()
      await nv.updateVolumeData(0, original)
      const bgRestored = await litPixels()
      const bgEditUploads = uploads.count()
      uploads.restore()
      // A full update with unchanged voxels uploads nothing at all.
      uploads = uploadsTo(bgCacheTex)
      await nv.setVolume(0, { opacity: 1 })
      const bgIdleUploads = uploads.count()
      uploads.restore()
      const bgAllocs = allocs.count()
      allocs.restore()
      const bgKept =
        !!bgTex && bgTex === bgCacheTex && renderer().volumeTexture === bgTex

      // ---- overlay (same grid) ----
      await nv.loadVolumes([{ url: '${RGB_VOLUME}' }, { url: '${RGB_VOLUME}' }])
      // A dim background (alpha 10): not lit, but not masked either, so the
      // lit pixels are the overlay's.
      await nv.updateVolumeData(0, new Array(original.length).fill(10))
      const ovBefore = await litPixels()
      const ovTex = renderer().overlayRgbaCache
        ? renderer().overlayRgbaCache.texture
        : null
      allocs = gpuAllocs()
      await nv.updateVolumeData(1, zeros)
      const ovZeroed = await litPixels()
      await nv.updateVolumeData(1, original)
      const ovRestored = await litPixels()
      uploads = uploadsTo(ovTex)
      await nv.setVolume(1, { opacity: 1 })
      const ovIdleUploads = uploads.count()
      uploads.restore()
      const ovAllocs = allocs.count()
      allocs.restore()
      const ovKept =
        !!ovTex &&
        !!renderer().overlayRgbaCache &&
        renderer().overlayRgbaCache.texture === ovTex

      // ---- background masking: it must not free the kept overlay texture ----
      nv.volumeIsBackgroundMasking = true
      await nv.updateVolumeData(1, zeros)
      const maskZeroed = await litPixels()
      await nv.updateVolumeData(1, original)
      const maskRestored = await litPixels()
      const maskKept =
        !!renderer().overlayRgbaCache &&
        renderer().overlayRgbaCache.texture === ovTex
      // A zeroed background masks the whole overlay out.
      await nv.updateVolumeData(0, zeros)
      const ovMasked = await litPixels()
      // Masking off again: the overlay's own voxels come back, so a texture
      // masking edited in place (WebGL2) is not mistaken for current.
      nv.volumeIsBackgroundMasking = false
      await nv.setVolume(1, { opacity: 1 })
      const ovUnmasked = await litPixels()

      // ---- scalar overlay under masking ----
      // The WebGPU mask pass also freed the scalar orient cache's output.
      nv.volumeIsBackgroundMasking = true
      await nv.loadVolumes([
        { url: '${VOLUME}' },
        { url: '${OVERLAY}', colormap: 'red', calMin: 0, calMax: 1 },
      ])
      const scalarOriginal = nv.volumes[1].img.slice()
      const scalarBefore = await redPixels()
      await nv.updateVolumeData(1, new Array(scalarOriginal.length).fill(0))
      const scalarZeroed = await redPixels()
      await nv.updateVolumeData(1, scalarOriginal)
      const scalarRestored = await redPixels()
      nv.volumeIsBackgroundMasking = false

      // ---- a modulator edited in place keeps its target's orient cache ----
      const bg = nv.volumes[0]
      const bgOriginal = bg.img.slice()
      await nv.setModulationImage(nv.volumes[1].id, bg.id)
      const modBefore = await redPixels()
      const modCache = renderer().overlayOrientCache
      await nv.updateVolumeData(0, new Array(bgOriginal.length).fill(0))
      const modZeroed = await redPixels()
      await nv.updateVolumeData(0, bgOriginal)
      const modRestored = await redPixels()
      const modCacheKept =
        !!modCache && renderer().overlayOrientCache === modCache

      return {
        bgBefore,
        bgZeroed,
        bgRestored,
        bgKept,
        bgAllocs,
        bgEditUploads,
        bgIdleUploads,
        ovBefore,
        ovZeroed,
        ovRestored,
        ovKept,
        ovAllocs,
        ovIdleUploads,
        maskZeroed,
        maskRestored,
        maskKept,
        ovMasked,
        ovUnmasked,
        scalarBefore,
        scalarZeroed,
        scalarRestored,
        modBefore,
        modZeroed,
        modRestored,
        modCacheKept,
        errors,
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

    // Background: the edits show, through the texture the volume loaded with.
    expect(r.bgBefore).toBeGreaterThan(1000)
    expect(r.bgZeroed).toBeLessThan(r.bgBefore * 0.05)
    expect(r.bgRestored).toBe(r.bgBefore)
    expect(r.bgKept).toBe(true)
    expect(r.bgAllocs).toBe(0)
    expect(r.bgEditUploads).toBe(2)
    expect(r.bgIdleUploads).toBe(0)

    // Overlay: the edits show, written into the overlay's kept texture.
    expect(r.ovBefore).toBeGreaterThan(1000)
    expect(r.ovZeroed).toBeLessThan(r.ovBefore * 0.05)
    expect(r.ovRestored).toBe(r.ovBefore)
    expect(r.ovKept).toBe(true)
    expect(r.ovAllocs).toBe(0)
    expect(r.ovIdleUploads).toBe(0)

    // Masking: further edits still show, the kept texture survives it (the
    // WebGPU mask pass used to destroy its input), and a black background
    // masks the overlay out.
    expect(r.maskZeroed).toBeLessThan(r.ovBefore * 0.05)
    expect(r.maskRestored).toBe(r.ovBefore)
    expect(r.maskKept).toBe(true)
    expect(r.ovMasked).toBeLessThan(r.ovBefore * 0.05)
    // (Not exactly ovBefore: the background is black now, not dim.)
    expect(r.ovUnmasked).toBeGreaterThan(r.ovBefore * 0.9)

    // A scalar overlay keeps working under masking too.
    expect(r.scalarBefore).toBeGreaterThan(1000)
    expect(r.scalarZeroed).toBeLessThan(r.scalarBefore * 0.05)
    expect(r.scalarRestored).toBe(r.scalarBefore)

    // Editing the modulator rewrites only the target's weights.
    expect(r.modBefore).toBeGreaterThan(1000)
    expect(r.modZeroed).toBeLessThan(r.modBefore * 0.05)
    expect(r.modRestored).toBe(r.modBefore)
    expect(r.modCacheKept).toBe(true)
    expect(r.errors).toEqual([])
  })
}

// Multi-instance mode (`instances`) caches each volume's baked RGBA texture
// by url/name. The entry used to be checked only against the voxel and
// modulator data versions, so a colormap change, a re-registered colormap
// name or a new window kept drawing the old texture.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`multi-instance volume textures follow display changes (${backend})`, async ({
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
      const { default: NiiVue } = await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        backgroundColor: [0, 0, 0, 1],
        instances: [{ id: 'only', bounds: [[0, 0], [1, 1]] }],
        isOrientCubeVisible: false,
        isOrientationTextVisible: false,
        isColorbarVisible: false,
      })
      await nv.attachToCanvas(canvas)
      if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
        return { skip: 'WebGPU init fell back to ' + nv.backend }
      }

      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      const count = async () => {
        await nextFrame()
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let lit = 0
        let red = 0
        let green = 0
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30) lit++
          if (px[i] - px[i + 1] > 40 && px[i] - px[i + 2] > 40) red++
          if (px[i + 1] - px[i] > 40 && px[i + 1] - px[i + 2] > 40) green++
        }
        return { lit, red, green }
      }

      // Transparent at the low end, so the 3D render is not an opaque box.
      nv.addColormap('instSwap', {
        R: [0, 255],
        G: [0, 0],
        B: [0, 0],
        A: [0, 255],
      })
      await nv.loadVolumes([{ url: '${VOLUME}', colormap: 'red' }])
      // Tiles are built from instances on resize / setInstances.
      nv.setInstances([{ id: 'only', bounds: [[0, 0], [1, 1]] }])
      const vol = nv.volumes[0]
      const red = await count()
      // A plain display change.
      await nv.setVolume(0, { colormap: 'green' })
      const green = await count()
      // A window that leaves every voxel below calMin.
      const { calMin, calMax } = vol
      await nv.setVolume(0, { calMin: 1e9, calMax: 2e9 })
      const windowedOut = await count()
      // A re-registered colormap name, through an ordinary update.
      await nv.setVolume(0, { colormap: 'instSwap', calMin, calMax })
      const swapRed = await count()
      nv.addColormap('instSwap', {
        R: [0, 0],
        G: [0, 255],
        B: [0, 0],
        A: [0, 255],
      })
      await nv.updateGLVolume()
      const swapGreen = await count()
      // An in-place voxel edit.
      await nv.updateVolumeData(0, new Array(vol.img.length).fill(0))
      const zeroed = await count()
      return { red, green, windowedOut, swapRed, swapGreen, zeroed }
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

    expect(r.red.red).toBeGreaterThan(1000)
    expect(r.green.green).toBeGreaterThan(1000)
    expect(r.green.red).toBeLessThan(r.red.red * 0.05)
    expect(r.windowedOut.lit).toBeLessThan(r.red.lit * 0.05)
    expect(r.swapRed.red).toBeGreaterThan(1000)
    expect(r.swapGreen.green).toBeGreaterThan(1000)
    expect(r.swapGreen.red).toBeLessThan(r.swapRed.red * 0.05)
    expect(r.zeroed.lit).toBeLessThan(r.red.lit * 0.05)
  })
}

// A volume drawn as chunks bakes its colormapped bricks, and chunkedDisplayKey
// decides when to re-stream them. Without the data version in that key, an
// in-place edit flagged isDirty kept drawing the old bricks.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`isDirty edits of a chunked volume re-stream its bricks (${backend})`, async ({
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

      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      // Chunks stream in over several frames; render until the count settles.
      const litPixels = async () => {
        let last = -1
        for (let i = 0; i < 30; i++) {
          await nextFrame()
          if (nv.view) nv.view.render()
          ctx.clearRect(0, 0, readback.width, readback.height)
          ctx.drawImage(canvas, 0, 0)
          const px = ctx.getImageData(0, 0, readback.width, readback.height).data
          let lit = 0
          for (let j = 0; j < px.length; j += 4) {
            if (px[j] > 30 || px[j + 1] > 30 || px[j + 2] > 30) lit++
          }
          if (lit === last) return lit
          last = lit
        }
        return last
      }

      await nv.loadVolumes([{ url: '${VOLUME}' }])
      const vol = nv.volumes[0]
      const d = vol.dimsRAS
      vol.chunkPlan = chunkVolumeGrid([d[1], d[2], d[3]], [2, 2, 2], 4096, [
        3, 3, 3,
      ])
      await nv.updateGLVolume()
      const chunked = !!nv.chunkStreamStats()
      const before = await litPixels()
      const original = vol.img.slice()
      vol.img.fill(0)
      vol.isDirty = true
      await nv.updateGLVolume()
      const zeroed = await litPixels()
      vol.img.set(original)
      vol.isDirty = true
      await nv.updateGLVolume()
      const restored = await litPixels()
      return { chunked, before, zeroed, restored }
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
    expect(r.chunked).toBe(true)
    expect(r.before).toBeGreaterThan(1000)
    expect(r.zeroed).toBeLessThan(r.before * 0.05)
    expect(r.restored).toBe(r.before)
  })
}

// Shared page-side setup for the tests below: a NiiVue on an off-screen
// canvas (or a skip reason) plus pixel counters that read whichever canvas the
// controller currently owns (a view recreation swaps in a fresh one).
const setupPage = (backend: 'webgl2' | 'webgpu') => `
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
      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      const count = async () => {
        await nextFrame()
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(nv.canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let lit = 0
        let red = 0
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30) lit++
          if (px[i] - px[i + 1] > 40 && px[i] - px[i + 2] > 40) red++
        }
        return { lit, red }
      }
`

const runInPage = async (
  page: import('@playwright/test').Page,
  body: string,
): Promise<Record<string, unknown> | null> => {
  const result = await page.evaluate(`(async () => {
     try {
      ${body}
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
    return null
  }
  return r
}

// View recreation rebuilds every texture from the model. A modulator edited in
// place and flagged isDirty gets its data-version bump there, so the weights
// it feeds must be recomputed too, or the new view bakes the old ones.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`view recreation recomputes modulation from an isDirty modulator (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const r = await runInPage(
      page,
      `${setupPage(backend)}
      await nv.loadVolumes([
        { url: '${VOLUME}' },
        { url: '${OVERLAY}', colormap: 'red', calMin: 0, calMax: 1 },
      ])
      const bg = nv.volumes[0]
      const ov = nv.volumes[1]
      // The red overlay is scaled by the background's windowed intensity.
      await nv.setModulationImage(ov.id, bg.id, 0)
      const modulated = await count()
      bg.img.fill(0)
      bg.isDirty = true
      await nv.reinitializeView({})
      const recreated = await count()
      return { modulated, recreated, flagCleared: bg.isDirty === false }
      `,
    )
    if (!r) return
    // biome-ignore lint/suspicious/noExplicitAny: page result
    const res = r as any
    expect(res.modulated.red).toBeGreaterThan(1000)
    expect(res.flagCleared).toBe(true)
    // A zero modulator weighs the overlay down to nothing.
    expect(res.recreated.red).toBeLessThan(res.modulated.red * 0.05)
  })
}

// prepareRGBAData used to read a color volume from the start of img, and the
// RGBA caches did not key on frame4D, so a 4D RGB/RGBA volume always showed
// frame 0: setFrame4D did nothing and the one-frame form of updateVolumeData
// wrote a frame that never appeared.
for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`4D RGB volumes show the selected frame (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const r = await runInPage(
      page,
      `${setupPage(backend)}
      await nv.loadVolumes([{ url: '${RGB_VOLUME}' }])
      const vol = nv.volumes[0]
      const frame = vol.img.slice()
      // Two frames: the original, then a blank one.
      const img = new Uint8Array(frame.length * 2)
      img.set(frame)
      vol.img = img
      vol.nFrame4D = 2
      vol.isDirty = true
      await nv.updateGLVolume()
      const frame0 = await count()
      await nv.setFrame4D(vol.id, 1)
      const frame1 = await count()
      // One-frame form: written into the displayed frame 1.
      await nv.updateVolumeData(0, frame)
      const frame1Written = await count()
      await nv.updateVolumeData(0, new Uint8Array(frame.length))
      const frame1Cleared = await count()
      let frame0Intact = true
      for (let i = 0; i < frame.length; i++) {
        if (vol.img[i] !== frame[i]) {
          frame0Intact = false
          break
        }
      }
      await nv.setFrame4D(vol.id, 0)
      const frame0Again = await count()
      return { frame0, frame1, frame1Written, frame1Cleared, frame0Intact, frame0Again }
      `,
    )
    if (!r) return
    // biome-ignore lint/suspicious/noExplicitAny: page result
    const res = r as any
    expect(res.frame0.lit).toBeGreaterThan(1000)
    expect(res.frame1.lit).toBeLessThan(res.frame0.lit * 0.05)
    expect(res.frame1Written.lit).toBe(res.frame0.lit)
    expect(res.frame1Cleared.lit).toBeLessThan(res.frame0.lit * 0.05)
    expect(res.frame0Intact).toBe(true)
    expect(res.frame0Again.lit).toBe(res.frame0.lit)
  })
}
