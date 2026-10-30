import { expect, test } from '@playwright/test'
import { Encoder } from 'cbor-x'
import { decodeDocumentJSON } from '../src/documentJson'

// A hostile .nvd must not make loadDocument allocate far more than the file
// holds: shared CBOR references (#383) and drawing sizes decoded before they
// are checked (#384).

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

test('a document that repeats one embedded volume through shared references is refused', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const json = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.loadVolumes([{ url: '/volumes/sphere.nii.gz' }])
    return new TextDecoder().decode(nv.serializeDocument({ format: 'json' }))
  })
  const doc = decodeDocumentJSON(json) as { volumes: unknown[] }
  // One embedded volume, listed 20 times; tags 28/29 store it once.
  doc.volumes = Array.from({ length: 20 }, () => doc.volumes[0])
  const bytes = Array.from(new Encoder({ structuredClone: true }).encode(doc))

  const r = await page.evaluate(async (bytes) => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    const file = new File([new Uint8Array(bytes)], 'shared.nvd')
    const error = await nv.loadDocument(file).then(
      () => '',
      (e: Error) => e.message,
    )
    return { error, volumes: nv.volumes.length }
  }, bytes)
  expect(r.error).toMatch(/expand beyond/)
  expect(r.volumes).toBe(0)
})

test('an oversized drawing length is skipped before it is decoded', async ({
  page,
}) => {
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.loadVolumes([{ url: '/volumes/sphere.nii.gz' }])
    nv.createEmptyDrawing()
    const doc = JSON.parse(
      new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
    )
    // Larger than any allocation succeeds: main throws a RangeError here.
    doc.drawingBitmapLength = Number.MAX_SAFE_INTEGER
    const file = new File([JSON.stringify(doc)], 'big-drawing.nvd')
    const error = await nv.loadDocument(file).then(
      () => '',
      (e: Error) => e.message,
    )
    return { error, volumes: nv.volumes.length }
  })
  expect(r.error).toBe('')
  expect(r.volumes).toBe(1)
  expect(warnings.some((w) => /drawing length .* does not match/.test(w))).toBe(
    true,
  )
})

test('an oversized slide drawing is skipped before it is allocated', async ({
  page,
}) => {
  const warnings: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text())
  })
  const r = await page.evaluate(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const nv = new NiiVue({ backend: 'webgl2' })
    const doc = JSON.parse(
      new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
    )
    const tile = 256
    doc.slidePlane = {
      manifest: {
        id: 's',
        name: 's',
        width: tile,
        height: tile,
        tileSize: tile,
        dtype: 'uint8',
        channels: 'encoded-rgb',
        levels: [
          {
            index: 0,
            width: tile,
            height: tile,
            downsample: 1,
            tileWidth: tile,
            tileHeight: tile,
            columns: 1,
            rows: 1,
            codec: 'image/jpeg',
            tiles: [{ x: 0, y: 0, width: tile, height: tile, frame: 1 }],
          },
        ],
      },
      pixelToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      drawingRLE: { $ta: 'Uint8Array', b64: 'AAA=' },
      drawingWidth: 200_000,
      drawingHeight: 200_000,
    }
    const file = new File([JSON.stringify(doc)], 'big-slide.nvd')
    const error = await nv.loadDocument(file).then(
      () => '',
      (e: Error) => e.message,
    )
    return { error }
  })
  expect(r.error).toBe('')
  expect(warnings.some((w) => /slide drawing size .* not valid/.test(w))).toBe(
    true,
  )
})
