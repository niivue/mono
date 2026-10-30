import { deflateSync } from 'node:zlib'
import { expect, test } from '@playwright/test'

// #385: a document's thumbnail and matcap are images NiiVue decodes to RGBA.
// A small PNG can declare a size that decodes to gigabytes, so one larger than
// MAX_IMAGE_SIDE is refused before it is decoded and the document still loads.
// 20000 on a side (1.6 GB of RGBA): Chrome itself rejects images past 2 GB.
// Headless Chromium has no WebGPU adapter; WebGPU shares the same loader.

/** A 1-bit grayscale PNG of `side` x `side` black pixels, as a data URL. */
function hugePng(side: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer): number => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // grayscale
  // Each row: a filter byte, then side bits. All zero compresses ~1000:1.
  const raw = Buffer.alloc(side * (1 + Math.ceil(side / 8)))
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

for (const field of ['thumbnail', 'matcap'] as const) {
  test(`a document whose ${field} declares 20000x20000 still loads`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const warnings: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text())
    })
    const url = hugePng(20_000)
    const r = await page.evaluate(
      async ([field, url]) => {
        const { default: NiiVue } = await import('/src/index.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        document.body.prepend(canvas)
        const nv = new NiiVue({ backend: 'webgl2' })
        await nv.attachToCanvas(canvas)
        nv.sliceType = 4 // render: the view that uploads the matcap
        await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
        const doc = JSON.parse(
          new TextDecoder().decode(nv.serializeDocument({ format: 'json' })),
        )
        if (field === 'thumbnail') doc.ui = { ...doc.ui, thumbnailUrl: url }
        else doc.volume = { ...doc.volume, matcap: url }
        const file = new File([JSON.stringify(doc)], `${field}.nvd`)
        const error = await nv.loadDocument(file).then(
          () => '',
          (e: Error) => e.message,
        )
        // The matcap is uploaded with the volume after the document resolves.
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return {
          error,
          volumes: nv.volumes.length,
          thumbnailVisible: nv.model.ui.isThumbnailVisible,
        }
      },
      [field, url] as const,
    )
    expect(r.error).toBe('')
    expect(r.volumes).toBe(1)
    if (field === 'thumbnail') expect(r.thumbnailVisible).toBe(false)
    await expect
      .poll(() => warnings.some((w) => /20000x20000, larger than 8192/.test(w)))
      .toBe(true)
  })
}
