import { expect, type Page } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'
import { test } from './sharedPage'

// A finite meshThicknessOn2D slab follows the displayed voxel plane (#451):
// on an oblique volume, a click inside a slice keeps the slice and must keep
// the mesh. The slab is drawn over the slice, so hiding the slice reveals no
// more of it, and meshes inside it still x-ray each other.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

const SIZE = 500

// A fresh axial NiiVue with a 3 mm slab; `load` runs with `nv` in scope.
const mount = (
  backend: string,
  options: string,
  load: string,
): string => `(async () => {
  if ('${backend}' === 'webgpu' && !(await navigator.gpu?.requestAdapter())) {
    return { ok: false }
  }
  window.__nv?.destroy?.()
  document.body.innerHTML = ''
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const c = document.createElement('canvas')
  c.width = ${SIZE}; c.height = ${SIZE}
  c.style.cssText = 'position:fixed;top:0;left:0;width:${SIZE}px;height:${SIZE}px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: '${backend}',
    sliceType: SLICE_TYPE.AXIAL,
    forceDevicePixelRatio: 1,
    meshThicknessOn2D: 3,
    crosshairWidth: 0,
    ${options}
  })
  await nv.attachToCanvas(c)
  ${load}
  window.__nv = nv
  return { ok: true, backend: nv.backend }
})()`

// RGBA of a screen region after two frames, decoded in the page so the spec
// needs no PNG library. With `yellow`, the page returns only the indices of
// yellow mesh pixels (the grayscale T1 is never yellow): sending all 1M RGBA
// values of a full canvas back to Node took seconds per call on CI.
const pixels = async (
  page: Page,
  x: number,
  y: number,
  w: number,
  h: number,
  yellow = false,
): Promise<number[]> => {
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const png = await page.screenshot({ clip: { x, y, width: w, height: h } })
  return page.evaluate(
    async ([b64, mask]) => {
      const img = new Image()
      img.src = `data:image/png;base64,${b64}`
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.width
      c.height = img.height
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      if (!mask) return Array.from(d)
      const hits: number[] = []
      for (let i = 0; i < d.length / 4; i++) {
        if (d[4 * i] > 150 && d[4 * i + 1] > 150 && d[4 * i + 2] < 90)
          hits.push(i)
      }
      return hits
    },
    [png.toString('base64'), yellow] as const,
  )
}

const meshMask = (page: Page) => pixels(page, 0, 0, SIZE, SIZE, true)
const changed = (a: number[], b: number[]) => {
  const sa = new Set(a)
  const sb = new Set(b)
  return a.filter((i) => !sb.has(i)).length + b.filter((i) => !sa.has(i)).length
}

const oblique = (backend: string, opacity: number) =>
  mount(
    backend,
    'isColorbarVisible: false, isOrientationTextVisible: false,',
    `await nv.loadVolumes([{ url: '/volumes/fs/T1_oblique.nii.gz', opacity: ${opacity} }])
  await nv.loadMeshes([{ url: '/meshes/fs/T1_oblique.lh.mid.mz3', rgba255: [255, 255, 0, 255] }])`,
  )

// A red square above a blue one, no volume, axial view through z = 0.
const squares = (backend: string, xRay: number) =>
  mount(
    backend,
    `meshXRay: ${xRay},`,
    `const square = (z, name) => new File(
    ['v -20 -20 ' + z + '\\nv 20 -20 ' + z + '\\nv 20 20 ' + z + '\\nv -20 20 ' + z + '\\nf 1 2 3\\nf 1 3 4\\n'],
    name,
  )
  await nv.loadMeshes([
    { url: square(1, 'red.obj'), rgba255: [255, 0, 0, 255] },
    { url: square(-1, 'blue.obj'), rgba255: [0, 0, 255, 255] },
  ])`,
  )

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`mesh slab follows the oblique voxel plane (${backend})`, async ({
    page,
  }) => {
    const ready = await page.evaluate(oblique(backend, 1))
    test.skip(!ready.ok, 'no WebGPU adapter')
    expect(ready.backend).toBe(backend)

    const masks: number[][] = []
    const depths: number[] = []
    for (const x of [150, 250, 350]) {
      await page.mouse.click(x, SIZE / 2)
      depths.push(
        await page.evaluate(
          '__nv.model.scene2mm(__nv.model.scene.crosshairPos)[2]',
        ),
      )
      masks.push(await meshMask(page))
    }
    // The clicks really cross world depth: the slice is oblique.
    expect(Math.abs(depths[2] - depths[0])).toBeGreaterThan(3)
    expect(masks[1].length).toBeGreaterThan(200)
    expect(changed(masks[0], masks[1])).toBe(0)
    expect(changed(masks[1], masks[2])).toBe(0)

    // The whole slab draws over the slice.
    await page.evaluate(oblique(backend, 0))
    await page.mouse.click(250, SIZE / 2)
    expect(changed(await meshMask(page), masks[1])).toBe(0)
  })

  test(`meshes inside a slab x-ray each other (${backend})`, async ({
    page,
  }) => {
    const centre = async (xRay: number) => {
      const ready = await page.evaluate(squares(backend, xRay))
      test.skip(!ready.ok, 'no WebGPU adapter')
      expect(ready.backend).toBe(backend)
      return pixels(page, SIZE / 2, SIZE / 2, 1, 1)
    }
    const solid = await centre(0)
    expect(solid[0]).toBeGreaterThan(80)
    expect(solid[2]).toBeLessThan(10)
    expect((await centre(0.5))[2]).toBeGreaterThan(30)
  })
}
