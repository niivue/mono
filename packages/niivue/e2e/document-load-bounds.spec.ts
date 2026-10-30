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
  await expect
    .poll(() =>
      warnings.some((w) => /drawing length .* does not match/.test(w)),
    )
    .toBe(true)
})

for (const [label, img] of [
  ['an image', { $ta: 'Uint8Array', b64: 'AAAA' }],
  // A plain object claiming a typed array's fields: only real ones are charged.
  [
    'a forged image view',
    {
      byteLength: 1e10,
      byteOffset: 0,
      buffer: { $ta: 'Uint8Array', b64: 'AAAA' },
    },
  ],
] as const) {
  test(`an embedded volume whose header claims more voxels than ${label} holds is refused`, async ({
    page,
  }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })
    const r = await page.evaluate(async (img) => {
      const { default: NiiVue } = await import('/src/index.ts')
      const nv = new NiiVue({ backend: 'webgl2' })
      await nv.loadVolumes([{ url: '/volumes/sphere.nii.gz' }])
      nv.createEmptyDrawing()
      const doc = JSON.parse(
        new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
      )
      // Three image bytes under a 100000 x 100000 header: the drawing would
      // allocate a byte per claimed voxel.
      const data = doc.volumes[0].data
      data.img = img
      data.hdr.dims = [3, 100_000, 100_000, 1, 1, 1, 1, 1]
      data.hdr.datatypeCode = 2
      data.hdr.numBitsPerVoxel = 8
      doc.drawingBitmapLength = 1
      const file = new File([JSON.stringify(doc)], 'big-header.nvd')
      const error = await nv.loadDocument(file).then(
        () => '',
        (e: Error) => e.message,
      )
      return { error, volumes: nv.volumes.length }
    }, img)
    expect(r.error).toBe('')
    expect(r.volumes).toBe(0)
    await expect
      .poll(() => warnings.some((w) => /claims more voxels/.test(w)))
      .toBe(true)
  })
}

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
  await expect
    .poll(() => warnings.some((w) => /slide drawing size .* not valid/.test(w)))
    .toBe(true)
})

for (const kind of ['mesh', 'signal'] as const) {
  test(`a forged ${kind} byte view is rejected before copying`, async ({
    page,
  }) => {
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })
    const error = await page.evaluate(async (kind) => {
      const { default: NiiVue } = await import('/src/index.ts')
      const nv = new NiiVue()
      const doc = JSON.parse(
        new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
      )
      // Impossible allocation sizes keep this regression safe on unfixed code.
      if (kind === 'mesh') {
        doc.meshes = [
          {
            name: 'forged',
            data: {
              positions: {
                buffer: String(Number.MAX_SAFE_INTEGER),
                byteOffset: 0,
                byteLength: 16,
              },
              indices: { $ta: 'Uint8Array', b64: 'AAAAAA==' },
              colors: { $ta: 'Uint8Array', b64: 'AAAAAA==' },
            },
          },
        ]
      } else {
        doc.signals = [
          {
            kind: 'spectroscopy',
            fid: { byteLength: Number.MAX_SAFE_INTEGER },
          },
        ]
      }
      return nv
        .loadDocument(new File([JSON.stringify(doc)], 'forged.nvd'))
        .then(
          () => '',
          (e: Error) => e.message,
        )
    }, kind)
    if (kind === 'mesh') {
      expect(error).toBe('')
      await expect
        .poll(() => warnings.some((w) => w.includes('expected a byte array')))
        .toBe(true)
    } else {
      expect(error).toContain('expected a byte array')
    }
  })
}
