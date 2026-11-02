import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// CINEMATIC behaviour that lives in the view tile loops, on both backends: an
// affine change moves the volume, an RGB background falls back to COMPOSITE, a
// drawing warns, and a label volume survives a hidden background.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`cinematic scene edges (${backend})`, async ({ page }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })
    await page.goto('/examples/index.html', { waitUntil: 'load' })
    const r = await page.evaluate(async (backend) => {
      if (backend === 'webgpu' && !(await navigator.gpu?.requestAdapter()))
        return null
      const {
        default: NiiVue,
        SLICE_TYPE,
        VOLUME_RENDER_MODE,
      } = await import('/src/index.ts')
      const next = () =>
        new Promise((res) => requestAnimationFrame(() => setTimeout(res, 50)))
      const make = async (urls: { url: string; colormap?: string }[]) => {
        const c = document.createElement('canvas')
        c.width = c.height = 128
        document.body.appendChild(c)
        const nv = new NiiVue({
          backend,
          sliceType: SLICE_TYPE.RENDER,
          volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
          volumeCinematic: { maxFrames: 2 },
          isLegendVisible: false,
        })
        await nv.attachToCanvas(c)
        // A label table, so the second volume is the cinematic label volume.
        nv.addColormap('edgeLabels', {
          R: [0, 255],
          G: [0, 255],
          B: [0, 0],
          labels: ['', 'one'],
        })
        await nv.loadVolumes(urls)
        return nv
      }
      const settled = async (nv: InstanceType<typeof NiiVue>) => {
        const cine = nv.view.cinematicRenderer
        const frames = () => [...cine.tiles.values()].map((t) => t.frame)
        for (let i = 0; i < 100 && frames()[0] !== 2; i++) await next()
        return frames()
      }

      const moved = await make([{ url: '/volumes/mni152.nii.gz' }])
      await settled(moved)
      const before = Array.from(moved.view.cinematicRenderer.geometry.mm2frac)
      const affine = moved.getVolumeAffine(0)
      affine[0][3] += 30
      await moved.setVolumeAffine(0, affine)
      await next()
      await settled(moved)
      const after = Array.from(moved.view.cinematicRenderer.geometry.mm2frac)
      // frac = mm2frac * mm: 30 mm over the x extent of the volume.
      const frac2mm = moved.volumes[0].frac2mm as Float32Array
      const shift = (before[12] - after[12]) * frac2mm[0]

      const rgb = await make([{ url: '/volumes/V1.nii.gz' }])
      for (let i = 0; i < 5; i++) await next()
      const rgbTiles = rgb.view.cinematicRenderer.tiles.size

      const drawn = await make([{ url: '/volumes/mni152.nii.gz' }])
      await settled(drawn)
      await drawn.loadDrawing('/volumes/drawing.nii.gz')
      for (let i = 0; i < 5; i++) await next()

      const labelled = await make([
        { url: '/volumes/torso.nii.gz' },
        { url: '/volumes/torsoLabel.nii.gz', colormap: 'edgeLabels' },
      ])
      labelled.setVolume(0, { visible: false })
      await next()
      const hiddenFrames = await settled(labelled)
      labelled.setVolume(1, { visible: false })
      const cine = labelled.view.cinematicRenderer
      for (let i = 0; i < 100 && cine.tiles.size > 0; i++) await next()

      return {
        shift,
        rgbTiles,
        hiddenFrames,
        // Nothing left to draw, so the tile is released.
        tilesWithNothingVisible: labelled.view.cinematicRenderer.tiles.size,
      }
    }, backend)
    test.skip(!r, 'no WebGPU adapter')
    expect(r?.shift).toBeCloseTo(30, 3)
    expect(r?.rgbTiles).toBe(0)
    expect(r?.hiddenFrames).toEqual([2])
    expect(r?.tilesWithNothingVisible).toBe(0)
    expect(warnings.some((w) => w.includes('RGB/RGBA'))).toBe(true)
    expect(warnings.some((w) => w.includes('drawing layer'))).toBe(true)
  })
}

// Mean green minus red over a screenshot of the canvas, decoded in the page.
async function greenness(page: Page): Promise<number> {
  const png = await page.screenshot({
    clip: { x: 0, y: 0, width: 128, height: 128 },
  })
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const ctx = document
      .createElement('canvas')
      .getContext('2d') as CanvasRenderingContext2D
    ctx.canvas.width = img.width
    ctx.canvas.height = img.height
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i + 1] - d[i]
    return sum / (d.length / 4)
  }, png.toString('base64'))
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`a negative clip alpha tints the cinematic cut face (${backend})`, async ({
    page,
  }) => {
    await page.goto('/examples/index.html', { waitUntil: 'load' })
    const ready = await page.evaluate(async (backend) => {
      if (backend === 'webgpu' && !(await navigator.gpu?.requestAdapter()))
        return false
      const {
        default: NiiVue,
        SLICE_TYPE,
        VOLUME_RENDER_MODE,
      } = await import('/src/index.ts')
      const next = () =>
        new Promise((res) => requestAnimationFrame(() => setTimeout(res, 50)))
      document.body.innerHTML = ''
      const c = document.createElement('canvas')
      c.width = c.height = 128
      c.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px'
      document.body.appendChild(c)
      const nv = new NiiVue({
        backend,
        sliceType: SLICE_TYPE.RENDER,
        volumeRenderMode: VOLUME_RENDER_MODE.CINEMATIC,
        volumeCinematic: { maxFrames: 2 },
        isLegendVisible: false,
        isOrientCubeVisible: false,
        crosshairWidth: 0,
        forceDevicePixelRatio: 1,
      })
      await nv.attachToCanvas(c)
      await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
      // Cut through the middle, facing the camera.
      nv.azimuth = 180
      nv.elevation = 0
      nv.setClipPlanes([[0, 180, 0]])
      window.__tint = async (alpha: number) => {
        nv.clipPlaneColor = [0, 1, 0, alpha]
        const cine = nv.view.cinematicRenderer
        for (let i = 0; i < 100; i++) {
          await next()
          const frames = [...cine.tiles.values()].map((t) => t.frame)
          if (frames.length && frames.every((f) => f === 2)) break
        }
        await next()
      }
      return true
    }, backend)
    test.skip(!ready, 'no WebGPU adapter')
    await page.evaluate('window.__tint(0)')
    const plain = await greenness(page)
    await page.evaluate('window.__tint(-1)')
    const tinted = await greenness(page)
    expect(tinted).toBeGreaterThan(plain + 10)
  })
}
