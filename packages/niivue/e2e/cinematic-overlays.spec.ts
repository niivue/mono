import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`cinematic uses standard statistical overlay controls (${backend})`, async ({
    page,
  }) => {
    await page.goto('/examples/index.html')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const result = await page.evaluate(async (backend) => {
      const {
        default: NiiVue,
        SLICE_TYPE,
        VOLUME_RENDER_MODE,
      } = await import('/src/index.ts')
      const { createNiftiArray } = await import('/src/volume/utils.ts')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 128
      canvas.style.cssText =
        'position:fixed;top:0;left:0;width:128px;height:128px'
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend,
        sliceType: SLICE_TYPE.RENDER,
        volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
        volumeCinematic: { maxFrames: 2 },
        isOrientCubeVisible: false,
        is3DCrosshairVisible: false,
        isColorbarVisible: false,
        isOrientationTextVisible: false,
        backgroundColor: [0, 0, 0, 1],
        azimuth: 180,
        elevation: 0,
      })
      await nv.attachToCanvas(canvas)
      // Transparent anatomy proves that the statistics are volumes, not a tint
      // dependent on a visible anatomical surface or its empty-space skip.
      nv.addColormap('cinematic_empty', {
        R: [0, 0],
        G: [0, 0],
        B: [0, 0],
        A: [0, 0],
      })
      const affine = (step: number) => [
        step,
        0,
        0,
        -8,
        0,
        step,
        0,
        -8,
        0,
        0,
        step,
        -8,
        0,
        0,
        0,
        1,
      ]
      const base = createNiftiArray(
        [16, 16, 16],
        [1, 1, 1],
        affine(1),
        2,
        new Uint8Array(16 ** 3).fill(100),
      )
      const values = new Float32Array(8 ** 3).fill(2)
      for (let z = 2; z < 6; z++)
        for (let y = 2; y < 6; y++)
          for (let x = 2; x < 6; x++) {
            values[x + 8 * (y + 8 * z)] = x < 4 ? 4 : -4
          }
      // A different grid exercises the existing resampling/registration path.
      const stats = createNiftiArray(
        [8, 8, 8],
        [2, 2, 2],
        affine(2),
        16,
        values,
      )
      await nv.loadVolumes([
        {
          url: new File([base], 'base.nii'),
          colormap: 'cinematic_empty',
          calMin: 0,
          calMax: 255,
        },
        {
          url: new File([stats], 'stats.nii'),
          colormap: 'redyell',
          colormapNegative: 'winter',
          calMin: 3,
          calMax: 6,
          calMinNeg: -3,
          calMaxNeg: -6,
        },
      ])
      const capture = async () => {
        let converged = false
        for (let i = 0; i < 100; i++) {
          await new Promise((r) =>
            requestAnimationFrame(() => setTimeout(r, 10)),
          )
          const tiles = [...nv.view.cinematicRenderer.tiles.values()]
          if (tiles.length && tiles.every((t) => t.frame === 2)) {
            converged = true
            break
          }
        }
        if (!converged) throw new Error('Cinematic did not converge')
        return new Promise<{ red: number; blue: number; hash: number }>(
          (resolve) =>
            requestAnimationFrame(() => {
              nv.view.render()
              const copy = document.createElement('canvas')
              copy.width = canvas.width
              copy.height = canvas.height
              const ctx = copy.getContext('2d')
              if (!ctx) throw new Error('No 2D context')
              ctx.drawImage(canvas, 0, 0)
              const data = ctx.getImageData(0, 0, copy.width, copy.height).data
              let red = 0
              let blue = 0
              let hash = 0
              for (let i = 0; i < data.length; i += 4) {
                if (data[i] > data[i + 2] + 30) red++
                if (data[i + 2] > data[i] + 30) blue++
                hash =
                  (Math.imul(hash, 31) +
                    data[i] +
                    257 * data[i + 1] +
                    65537 * data[i + 2]) >>>
                  0
              }
              resolve({ red, blue, hash })
            }),
        )
      }
      const shown = await capture()
      await nv.setVolume(1, { calMin: 5, calMax: 6 })
      const negativeOnly = await capture()
      await nv.setVolume(1, { calMinNeg: -5, calMaxNeg: -6 })
      const thresholded = await capture()
      await nv.setVolume(1, { calMin: 3, calMinNeg: -3 })
      const restored = await capture()
      await nv.setVolume(1, { opacity: 0.1 })
      const translucent = await capture()
      await nv.setVolume(1, { opacity: 1, visible: false })
      const hidden = await capture()
      await nv.setVolume(1, {
        visible: true,
        colormap: 'winter',
        colormapNegative: 'redyell',
      })
      const recoloured = await capture()
      await nv.setVolumeAffine(1, [
        [2, 0, 0, 40],
        [0, 2, 0, -8],
        [0, 0, 2, -8],
        [0, 0, 0, 1],
      ])
      const moved = await capture()
      await nv.resetVolumeAffine(1)
      const realigned = await capture()
      await nv.updateVolumeData(1, new Float32Array(values.length))
      const clearedData = await capture()
      await nv.updateVolumeData(1, values)
      nv.setClipPlanes([[-0.9, 0, 0]])
      const outsideClip = await capture()
      nv.clipPlaneOverlay = true
      const clipped = await capture()
      nv.destroy()
      return {
        backend: nv.backend,
        shown,
        negativeOnly,
        thresholded,
        restored,
        translucent,
        hidden,
        recoloured,
        moved,
        realigned,
        clearedData,
        outsideClip,
        clipped,
      }
    }, backend)
    expect(errors).toEqual([])
    expect(result.backend).toBe(backend)
    expect(result.shown.red).toBeGreaterThan(10)
    expect(result.shown.blue).toBeGreaterThan(10)
    expect(result.negativeOnly.red).toBeLessThan(result.shown.red / 3)
    expect(result.negativeOnly.blue).toBeGreaterThan(10)
    expect(result.thresholded.red + result.thresholded.blue).toBe(0)
    expect(result.restored).toEqual(result.shown)
    expect(result.translucent.hash).not.toBe(result.shown.hash)
    expect(result.hidden.red + result.hidden.blue).toBe(0)
    expect(result.recoloured.hash).not.toBe(result.shown.hash)
    expect(result.moved.red + result.moved.blue).toBe(0)
    expect(result.realigned).toEqual(result.recoloured)
    expect(result.clearedData.red + result.clearedData.blue).toBe(0)
    expect(result.outsideClip).toEqual(result.recoloured)
    expect(result.clipped.red + result.clipped.blue).toBe(0)
  })
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`cinematic draws overlays over a hidden background (${backend})`, async ({
    page,
  }) => {
    await page.goto('/examples/index.html')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const result = await page.evaluate(async (backend) => {
      const {
        default: NiiVue,
        SLICE_TYPE,
        VOLUME_RENDER_MODE,
      } = await import('/src/index.ts')
      const { createNiftiArray } = await import('/src/volume/utils.ts')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 128
      canvas.style.cssText =
        'position:fixed;top:0;left:0;width:128px;height:128px'
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend,
        sliceType: SLICE_TYPE.RENDER,
        volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
        volumeCinematic: { maxFrames: 2 },
        isOrientCubeVisible: false,
        is3DCrosshairVisible: false,
        isColorbarVisible: false,
        isOrientationTextVisible: false,
        backgroundColor: [0, 0, 0, 1],
        azimuth: 180,
        elevation: 0,
      })
      await nv.attachToCanvas(canvas)
      const affine = [1, 0, 0, -8, 0, 1, 0, -8, 0, 0, 1, -8, 0, 0, 0, 1]
      const base = createNiftiArray(
        [16, 16, 16],
        [1, 1, 1],
        affine,
        2,
        new Uint8Array(16 ** 3).fill(100),
      )
      const values = new Float32Array(16 ** 3)
      for (let z = 4; z < 12; z++)
        for (let y = 4; y < 12; y++)
          for (let x = 4; x < 12; x++) values[x + 16 * (y + 16 * z)] = 4
      const stats = createNiftiArray(
        [16, 16, 16],
        [1, 1, 1],
        affine,
        16,
        values,
      )
      await nv.loadVolumes([
        { url: new File([base], 'base.nii'), calMin: 0, calMax: 255 },
        {
          url: new File([stats], 'stats.nii'),
          colormap: 'redyell',
          calMin: 3,
          calMax: 6,
        },
      ])
      const red = async () => {
        let converged = false
        for (let i = 0; i < 100; i++) {
          await new Promise((r) =>
            requestAnimationFrame(() => setTimeout(r, 10)),
          )
          const tiles = [...nv.view.cinematicRenderer.tiles.values()]
          if (tiles.length && tiles.every((t) => t.frame === 2)) {
            converged = true
            break
          }
        }
        if (!converged) throw new Error('Cinematic did not converge')
        return new Promise<number>((resolve) =>
          requestAnimationFrame(() => {
            nv.view.render()
            const copy = document.createElement('canvas')
            copy.width = canvas.width
            copy.height = canvas.height
            const ctx = copy.getContext('2d')
            if (!ctx) throw new Error('No 2D context')
            ctx.drawImage(canvas, 0, 0)
            const data = ctx.getImageData(0, 0, copy.width, copy.height).data
            let n = 0
            for (let i = 0; i < data.length; i += 4)
              if (data[i] > data[i + 2] + 30) n++
            resolve(n)
          }),
        )
      }
      await nv.setVolume(0, { opacity: 0 })
      const zeroOpacity = await red()
      await nv.setVolume(0, { opacity: 1, visible: false })
      const invisible = await red()
      nv.destroy()
      return { backend: nv.backend, zeroOpacity, invisible }
    }, backend)
    expect(errors).toEqual([])
    expect(result.backend).toBe(backend)
    // The 8^3 overlay cube fills roughly 1/4 of the 128^2 canvas.
    expect(result.zeroOpacity).toBeGreaterThan(1000)
    expect(result.invisible).toBeGreaterThan(1000)
  })

  test(`cinematic overlay alpha matches classic on anisotropic voxels (${backend})`, async ({
    page,
  }) => {
    await page.goto('/examples/index.html')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const result = await page.evaluate(async (backend) => {
      const {
        default: NiiVue,
        SLICE_TYPE,
        VOLUME_RENDER_MODE,
      } = await import('/src/index.ts')
      const { createNiftiArray } = await import('/src/volume/utils.ts')
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 192
      canvas.style.cssText =
        'position:fixed;top:0;left:0;width:192px;height:192px'
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend,
        isOverlayOpacityCorrected: true,
        sliceType: SLICE_TYPE.RENDER,
        volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
        volumeCinematic: { maxFrames: 32 },
        isOrientCubeVisible: false,
        is3DCrosshairVisible: false,
        isColorbarVisible: false,
        isOrientationTextVisible: false,
        backgroundColor: [0, 0, 0, 0],
        azimuth: 0,
        elevation: 90,
      })
      await nv.attachToCanvas(canvas)
      nv.addColormap('cinematic_empty', {
        R: [0, 0],
        G: [0, 0],
        B: [0, 0],
        A: [0, 0],
      })
      // 4 mm slices viewed from above: the ray crosses one overlay voxel.
      const affine = [1, 0, 0, -8, 0, 1, 0, -8, 0, 0, 4, -32, 0, 0, 0, 1]
      const base = createNiftiArray(
        [16, 16, 16],
        [1, 1, 4],
        affine,
        2,
        new Uint8Array(16 ** 3).fill(100),
      )
      const values = new Float32Array(16 ** 3)
      for (let i = 0; i < 256; i++) values[i + 256 * 8] = 4
      const stats = createNiftiArray(
        [16, 16, 16],
        [1, 1, 4],
        affine,
        16,
        values,
      )
      await nv.loadVolumes([
        {
          url: new File([base], 'base.nii'),
          colormap: 'cinematic_empty',
          calMin: 0,
          calMax: 255,
        },
        {
          url: new File([stats], 'stats.nii'),
          colormap: 'redyell',
          calMin: 3,
          calMax: 6,
          opacity: 0.1,
        },
      ])
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 10)))
        const tiles = [...nv.view.cinematicRenderer.tiles.values()]
        if (tiles.length && tiles.every((t) => t.frame === 32)) break
      }
      const centreAlpha = () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => {
            nv.view.render()
            const copy = document.createElement('canvas')
            copy.width = canvas.width
            copy.height = canvas.height
            const ctx = copy.getContext('2d')
            if (!ctx) throw new Error('No 2D context')
            ctx.drawImage(canvas, 0, 0)
            resolve(ctx.getImageData(96, 96, 1, 1).data[3])
          }),
        )
      const cinematic = await centreAlpha()
      nv.volumeRenderMode = VOLUME_RENDER_MODE.COMPOSITE
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)))
      const classic = await centreAlpha()
      nv.destroy()
      return { backend: nv.backend, cinematic, classic }
    }, backend)
    expect(errors).toEqual([])
    expect(result.backend).toBe(backend)
    expect(result.classic).toBeGreaterThan(10)
    // Per-mm correction would cross the 4 mm slice as ~4 samples (alpha ~4x).
    expect(Math.abs(result.cinematic - result.classic)).toBeLessThanOrEqual(6)
  })
}
