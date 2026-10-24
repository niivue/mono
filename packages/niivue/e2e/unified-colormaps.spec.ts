import { inflateSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// One colormap per volume (issue #69): a label colormap (one with a `labels`
// array) set through `setVolume({ colormap })` colours each integer ID; a
// NIFTI_INTENT_LABEL volume defaults to the generated Random palette; label
// LUTs wrap into rows of 256 so wide ID ranges upload on any GPU; documents
// name colormaps and embed runtime ones. Pixels are read with 1x1 clip
// screenshots, the one readback that works the same on both backends.

test.use({ launchOptions: webgpuLaunchOptions })
test.describe.configure({ timeout: 180_000 })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

async function probe(page: Page, x: number, y: number): Promise<number[]> {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  let colorType = 6
  const idat: Buffer[] = []
  for (let p = 8; p + 8 <= png.length; ) {
    const len = png.readUInt32BE(p)
    const type = png.toString('ascii', p + 4, p + 8)
    const body = png.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') colorType = body[9]
    if (type === 'IDAT') idat.push(body)
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  return Array.from(raw.subarray(1, 1 + (colorType === 6 ? 4 : 3)))
}

const SIZE = 256

// A 32x32x4 int16 NIfTI with intent NIFTI_INTENT_LABEL: the left half holds ID
// 3, the right half ID 20000. A one-row LUT that wide exceeds SwiftShader's
// 8192-texel limit; wrapped, ID 20000 sits in row 78. Exposed as
// window.__labelFile.
const MOUNT = (backend: string) => `(async () => {
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { ok: false, why: 'no navigator.gpu' }
    if (!(await navigator.gpu.requestAdapter())) return { ok: false, why: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const [nx, ny, nz] = [32, 32, 4]
  const buf = new ArrayBuffer(352 + nx * ny * nz * 2)
  const dv = new DataView(buf)
  dv.setInt32(0, 348, true)
  ;[3, nx, ny, nz, 1, 1, 1, 1].forEach((d, i) => dv.setInt16(40 + 2 * i, d, true))
  dv.setInt16(68, 1002, true) // intent_code
  dv.setInt16(70, 4, true) // int16
  dv.setInt16(72, 16, true)
  ;[1, 1, 1, 1].forEach((p, i) => dv.setFloat32(76 + 4 * i, p, true))
  dv.setFloat32(108, 352, true)
  dv.setFloat32(112, 1, true) // scl_slope
  dv.setInt16(254, 1, true) // sform_code
  dv.setFloat32(280, 1, true); dv.setFloat32(300, 1, true); dv.setFloat32(320, 1, true)
  new Uint8Array(buf, 344, 4).set([0x6e, 0x2b, 0x31, 0])
  const img = new Int16Array(buf, 352)
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++)
        img[x + nx * (y + ny * z)] = x < nx / 2 ? 3 : 20000
  window.__labelFile = () => new File([buf], 'labels.nii')
  window.__nextFrame = () => new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(r)))
  const c = document.createElement('canvas')
  c.width = ${SIZE}; c.height = ${SIZE}
  c.style.cssText = 'position:fixed;top:0;left:0;width:${SIZE}px;height:${SIZE}px'
  document.body.appendChild(c)
  const nv = new NiiVue({
    backend: '${backend}',
    sliceType: SLICE_TYPE.AXIAL,
    backgroundColor: [0, 0, 0, 1],
    isOrientationTextVisible: false,
    isColorbarVisible: false,
    // A named label table draws a legend over the right of the canvas.
    isLegendVisible: false,
    crosshairWidth: 0,
  })
  await nv.attachToCanvas(c)
  window.__nv = nv
  window.__NiiVue = NiiVue
  return { ok: true, backend: nv.backend }
})()`

// Screen points over the left (ID 3) and right (ID 20000) halves.
const LEFT = { x: 70, y: 128 }
const RIGHT = { x: 186, y: 128 }

const lutColor = (page: Page, id: number) =>
  page.evaluate((id) => {
    const lut = window.__nv.volumes[0].colormapLabel
    if (!lut) return null
    const k = 4 * (id - (lut.min ?? 0))
    return Array.from(lut.lut.slice(k, k + 3))
  }, id)

const close = (a: number[] | null, b: number[]) =>
  !!a && a.every((v, i) => Math.abs(v - b[i]) <= 3)

for (const backend of ['webgl2', 'webgpu']) {
  test(`${backend}: a label-intent volume shows labels without setup, across LUT rows`, async ({
    page,
  }) => {
    const up = await page.evaluate(MOUNT(backend))
    test.skip(
      !up.ok || up.backend !== backend,
      `no ${backend}: ${up.why ?? up.backend}`,
    )
    await page.evaluate(async () => {
      await window.__nv.loadVolumes([{ url: window.__labelFile() }])
      await window.__nextFrame()
    })
    const state = await page.evaluate(() => {
      const v = window.__nv.volumes[0]
      return {
        colormap: v.colormap,
        min: v.colormapLabel?.min,
        max: v.colormapLabel?.max,
      }
    })
    expect(state).toEqual({ colormap: 'Random', min: 0, max: 20000 })
    // ID 20000 lives in row 78 of the wrapped LUT; a wrong row or column shows
    // another label's colour (or the clamped edge entry) here.
    expect(
      close(
        await lutColor(page, 20000),
        (await probe(page, RIGHT.x, RIGHT.y)).slice(0, 3),
      ),
    ).toBe(true)
    expect(
      close(
        await lutColor(page, 3),
        (await probe(page, LEFT.x, LEFT.y)).slice(0, 3),
      ),
    ).toBe(true)
  })

  test(`${backend}: setVolume switches between continuous and label colormaps`, async ({
    page,
  }) => {
    const up = await page.evaluate(MOUNT(backend))
    test.skip(
      !up.ok || up.backend !== backend,
      `no ${backend}: ${up.why ?? up.backend}`,
    )
    const r = await page.evaluate(async () => {
      const nv = window.__nv
      await nv.loadVolumes([{ url: window.__labelFile() }])
      await nv.setVolume(0, { colormap: 'gray' })
      const afterGray = nv.volumes[0].colormapLabel
      const name = nv.addColormap('halves', {
        R: [0, 0, 255],
        G: [0, 255, 0],
        B: [0, 0, 0],
        I: [0, 3, 20000],
        labels: ['air', 'left', 'right'],
      })
      await nv.setVolume(0, { colormap: name })
      await window.__nextFrame()
      const lut = nv.volumes[0].colormapLabel
      return {
        name,
        afterGray,
        labels: lut ? [lut.labels?.[3], lut.labels?.[20000]] : null,
        listed: nv.colormapNames('label').includes(name),
        notContinuous: !nv.colormapNames('continuous').includes(name),
      }
    })
    expect(r.afterGray).toBeNull()
    expect(r.labels).toEqual(['left', 'right'])
    expect(r.listed && r.notContinuous).toBe(true)
    expect(
      close((await probe(page, LEFT.x, LEFT.y)).slice(0, 3), [0, 255, 0]),
    ).toBe(true)
    expect(
      close((await probe(page, RIGHT.x, RIGHT.y)).slice(0, 3), [255, 0, 0]),
    ).toBe(true)

    // Re-registering the name recolours the volume using it.
    await page.evaluate(async () => {
      window.__nv.addColormap('halves', {
        R: [0, 0, 0],
        G: [0, 0, 0],
        B: [0, 255, 255],
        I: [0, 3, 20000],
        labels: ['air', 'left', 'right'],
      })
      window.__nv.updateGLVolume()
      await window.__nextFrame()
    })
    expect(
      close((await probe(page, RIGHT.x, RIGHT.y)).slice(0, 3), [0, 0, 255]),
    ).toBe(true)
  })
}

test('drawColormap takes label colormaps with IDs up to 255 only', async ({
  page,
}) => {
  const up = await page.evaluate(MOUNT('webgl2'))
  expect(up.ok).toBe(true)
  const r = await page.evaluate(() => {
    const nv = window.__nv
    const attempt = (name: string) => {
      try {
        nv.drawColormap = name
        return 'ok'
      } catch {
        return 'threw'
      }
    }
    nv.addColormap('wide', {
      R: [0, 9],
      G: [0, 9],
      B: [0, 9],
      I: [0, 20000],
      labels: [],
    })
    return {
      itksnap: attempt('itksnap'),
      gray: attempt('gray'),
      wide: attempt('wide'),
      kept: nv.drawColormap,
      offered: nv.drawingColormaps,
    }
  })
  expect(r).toMatchObject({
    itksnap: 'ok',
    gray: 'threw',
    wide: 'threw',
    kept: 'itksnap',
  })
  expect(r.offered).toEqual(
    expect.arrayContaining(['Draw', 'Itksnap', 'Slicer3d', 'Random']),
  )
  expect(r.offered).not.toContain('Wide')
})

test('a document embeds a runtime label colormap and restores it by name', async ({
  page,
}) => {
  const up = await page.evaluate(MOUNT('webgl2'))
  expect(up.ok).toBe(true)
  const r = await page.evaluate(async () => {
    const nv = window.__nv
    await nv.loadVolumes([{ url: window.__labelFile() }])
    const name = nv.addColormap('docAtlas', {
      R: [0, 10, 20],
      G: [0, 30, 40],
      B: [0, 50, 60],
      I: [0, 3, 20000],
      labels: ['air', 'left', 'right'],
    })
    await nv.setVolume(0, { colormap: name })
    const bytes = nv.serializeDocument({ format: 'json' })
    const doc = JSON.parse(new TextDecoder().decode(bytes))
    // The registry is page-wide, so overwrite 'DocAtlas' with a ramp: the
    // restored volume is a label map only if loadDocument registers the
    // document's own definition.
    nv.addColormap('docAtlas', { R: [0, 255], G: [0, 255], B: [0, 255] })
    const c = document.createElement('canvas')
    document.body.appendChild(c)
    const nv2 = new window.__NiiVue({ backend: 'webgl2' })
    await nv2.attachToCanvas(c)
    await nv2.loadDocument(new File([bytes], 'scene.json'))
    const v = nv2.volumes[0]
    return {
      version: doc.version,
      embedded: Object.keys(doc.colormaps ?? {}),
      savedLut: 'colormapLabel' in doc.volumes[0],
      colormap: v.colormap,
      right: v.colormapLabel?.labels?.[20000],
    }
  })
  expect(r).toEqual({
    version: 10,
    embedded: expect.arrayContaining(['DocAtlas']),
    savedLut: false,
    colormap: 'DocAtlas',
    right: 'right',
  })
})

test('a v9 document with a compiled label LUT loads through the converter', async ({
  page,
}) => {
  const up = await page.evaluate(MOUNT('webgl2'))
  expect(up.ok).toBe(true)
  const r = await page.evaluate(async () => {
    const lut = new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255])
    let b64 = ''
    for (const v of lut) b64 += String.fromCharCode(v)
    const doc = {
      version: 9,
      draw: { colormap: '_itksnap' },
      volumes: [
        {
          url: '/volumes/aal.nii.gz',
          name: 'aal.nii.gz',
          colormap: 'gray',
          colormapLabel: {
            lut: { $ta: 'Uint8Array', b64: btoa(b64) },
            min: 0,
            max: 2,
            labels: ['air', 'one', 'two'],
          },
        },
      ],
    }
    const nv = window.__nv
    const load = () =>
      nv.loadDocument(new File([JSON.stringify(doc)], 'old.json'))
    await load()
    const v = nv.volumes[0]
    const first = {
      colormap: v.colormap,
      labels: v.colormapLabel?.labels,
      draw: nv.drawColormap,
    }
    // The same table loaded again reuses its name rather than adding another.
    await load()
    return { ...first, reloaded: nv.volumes[0].colormap }
  })
  expect(r).toEqual({
    colormap: 'Aal labels',
    labels: ['air', 'one', 'two'],
    draw: 'Itksnap',
    reloaded: 'Aal labels',
  })
})
