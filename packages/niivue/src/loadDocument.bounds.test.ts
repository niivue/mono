import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import { Encoder } from 'cbor-x'
import { decodeDocumentJSON } from '@/documentJson'
import NiiVue from '@/index'
import {
  captureWarnings,
  devImageUrl,
  documentFile,
  parseJsonDocument,
  rejectionMessage,
} from '@/testing/headless'

// A hostile .nvd must not make loadDocument allocate far more than the file
// holds: shared CBOR references (#383), drawing sizes decoded before they are
// checked (#384), and image volumes declaring a size that decodes to gigabytes
// (#511). The thumbnail and matcap forms of #511 decode through a DOM image
// and stay in e2e/document-image-bounds.spec.ts.

const SPHERE = devImageUrl('volumes/sphere.nii.gz')

let warnings: ReturnType<typeof captureWarnings>
beforeEach(() => {
  warnings = captureWarnings()
})
afterEach(() => warnings.restore())
const warned = (re: RegExp) => warnings.messages.some((w) => re.test(w))

/** Load a sphere volume, optionally with a drawing, and return its JSON document. */
async function sphereDocument(
  nv: NiiVue,
  withDrawing: boolean,
): Promise<Record<string, unknown>> {
  await nv.loadVolumes([{ url: SPHERE }])
  if (withDrawing) nv.createEmptyDrawing()
  return parseJsonDocument(nv.serializeDocument({ format: 'json' }))
}

test('a document that repeats one embedded volume through shared references is refused', async () => {
  const src = new NiiVue({ backend: 'webgl2' })
  await src.loadVolumes([{ url: SPHERE }])
  const doc = decodeDocumentJSON(
    new TextDecoder().decode(src.serializeDocument({ format: 'json' })),
  ) as { volumes: unknown[] }
  // One embedded volume, listed 20 times; tags 28/29 store it once.
  doc.volumes = Array.from({ length: 20 }, () => doc.volumes[0])
  const bytes = new Encoder({
    structuredClone: true,
    useRecords: false,
  }).encode(doc)

  const nv = new NiiVue({ backend: 'webgl2' })
  const error = await rejectionMessage(
    nv.loadDocument(documentFile(new Uint8Array(bytes), 'shared.nvd')),
  )
  expect(error).toMatch(/expand beyond/)
  expect(nv.volumes).toHaveLength(0)
})

test('an oversized drawing length is skipped before it is decoded', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const doc = await sphereDocument(nv, true)
  // Larger than any allocation succeeds: main throws a RangeError here.
  doc.drawingBitmapLength = Number.MAX_SAFE_INTEGER
  const error = await rejectionMessage(
    nv.loadDocument(documentFile(JSON.stringify(doc), 'big-drawing.nvd')),
  )
  expect(error).toBe('')
  expect(nv.volumes).toHaveLength(1)
  expect(warned(/drawing length .* does not match/)).toBe(true)
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
  test(`an embedded volume whose header claims more voxels than ${label} holds is refused`, async () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    const doc = (await sphereDocument(nv, true)) as {
      volumes: {
        data: {
          img: unknown
          hdr: { dims: number[]; datatypeCode: number; numBitsPerVoxel: number }
        }
      }[]
      drawingBitmapLength: number
    }
    // Three image bytes under a 100000 x 100000 header: the drawing would
    // allocate a byte per claimed voxel.
    const data = doc.volumes[0].data
    data.img = img
    data.hdr.dims = [3, 100_000, 100_000, 1, 1, 1, 1, 1]
    data.hdr.datatypeCode = 2
    data.hdr.numBitsPerVoxel = 8
    doc.drawingBitmapLength = 1
    const error = await rejectionMessage(
      nv.loadDocument(documentFile(JSON.stringify(doc), 'big-header.nvd')),
    )
    expect(error).toBe('')
    expect(nv.volumes).toHaveLength(0)
    expect(warned(/claims more voxels/)).toBe(true)
  })
}

test('an oversized slide drawing is skipped before it is allocated', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const doc = parseJsonDocument(nv.serializeDocument({ format: 'json' }))
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
  // The manifest names no tile bytes, so the slide logs a failed tile fetch.
  const tileErrors = spyOn(console, 'error').mockImplementation(() => {})
  const error = await rejectionMessage(
    nv.loadDocument(documentFile(JSON.stringify(doc), 'big-slide.nvd')),
  ).finally(() => tileErrors.mockRestore())
  expect(error).toBe('')
  expect(warned(/slide drawing size .* not valid/)).toBe(true)
})

for (const kind of ['mesh', 'signal'] as const) {
  test(`a forged ${kind} byte view is rejected before copying`, async () => {
    const nv = new NiiVue()
    const doc = parseJsonDocument(nv.serializeDocument({ format: 'json' }))
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
        { kind: 'spectroscopy', fid: { byteLength: Number.MAX_SAFE_INTEGER } },
      ]
    }
    const error = await rejectionMessage(
      nv.loadDocument(documentFile(JSON.stringify(doc), 'forged.nvd')),
    )
    if (kind === 'mesh') {
      expect(error).toBe('')
      expect(warned(/expected a byte array/)).toBe(true)
    } else {
      expect(error).toContain('expected a byte array')
    }
  })
}

/** A 1-bit grayscale PNG of `side` x `side` black pixels. */
function hugePng(side: number): Buffer {
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
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// The size is read from the PNG header before anything is decoded, so this
// needs no image decoder: the refusal must come first.
test('a document whose image volume declares 20000x20000 loads the rest', async () => {
  // 20000 on a side is 1.6 GB of RGBA.
  const dir = mkdtempSync(join(tmpdir(), 'nv-huge-png-'))
  const file = join(dir, 'huge.png')
  writeFileSync(file, hugePng(20_000))
  try {
    const nv = new NiiVue({ backend: 'webgl2' })
    const doc = (await sphereDocument(nv, false)) as {
      volumes: Record<string, unknown>[]
    }
    doc.volumes.push({ url: pathToFileURL(file).href, name: 'huge.png' })
    const error = await rejectionMessage(
      nv.loadDocument(documentFile(JSON.stringify(doc), 'volume.nvd')),
    )
    expect(error).toBe('')
    expect(nv.volumes).toHaveLength(1)
    expect(warned(/20000x20000, larger than 8192/)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
