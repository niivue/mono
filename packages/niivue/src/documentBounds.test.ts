import { describe, expect, test } from 'bun:test'
import { decode, Encoder, encode } from 'cbor-x'
import {
  assertCborFitsInput,
  assertDocumentFitsInput,
  copyDocumentBytes,
  isEmbeddedImageComplete,
} from './documentBounds'
import { decodeDocumentJSON, encodeDocumentJSON } from './documentJson'

// The encoder `saveDocument` never uses, but a hostile file can: it writes
// tags 28/29, so a repeated or cyclic value is stored once.
// Shared references (tags 28/29) without cbor-x records, which serialize never emits.
const sharing = new Encoder({ structuredClone: true, useRecords: false })

const honestDoc = () => ({
  version: 9,
  volumes: [
    {
      name: 'a',
      data: { hdr: { dims: [3, 4, 4, 4] }, img: new Uint8Array(4096) },
      clipPlane: [0, 0, 0, 0],
    },
  ],
  meshes: [{ data: { positions: new Uint8Array(1200) } }],
  scene: { azimuth: 110, elevation: 10 },
})

describe('copyDocumentBytes', () => {
  test('copies only the view bytes into independent storage', () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const copy = new Uint8Array(copyDocumentBytes(bytes.subarray(1, 3)))
    bytes[1] = 9
    expect([...copy]).toEqual([2, 3])
  })

  test('rejects forged byte views before trusting their size', () => {
    for (const forged of [
      { byteLength: Number.MAX_SAFE_INTEGER },
      {
        buffer: String(Number.MAX_SAFE_INTEGER),
        byteOffset: 0,
        byteLength: 16,
      },
    ]) {
      expect(() => copyDocumentBytes(forged as unknown as Uint8Array)).toThrow(
        'expected a byte array',
      )
    }
  })
})

describe('assertDocumentFitsInput', () => {
  test('accepts an honest CBOR document', () => {
    const bytes = encode(honestDoc())
    expect(() =>
      assertDocumentFitsInput(decode(bytes), bytes.length),
    ).not.toThrow()
  })

  test('accepts an honest JSON document', () => {
    const bytes = new TextEncoder().encode(encodeDocumentJSON(honestDoc()))
    const doc = decodeDocumentJSON(new TextDecoder().decode(bytes))
    expect(() => assertDocumentFitsInput(doc, bytes.length)).not.toThrow()
  })

  test('refuses one embedded array shared by many volumes', () => {
    const img = new Uint8Array(100_000)
    const volumes = Array.from({ length: 50 }, () => ({ data: { img } }))
    const bytes = sharing.encode({ version: 9, volumes })
    const doc = decode(bytes) as { volumes: { data: { img: Uint8Array } }[] }
    // cbor-x rebuilds the shared reference: 50 volumes over one array.
    expect(doc.volumes[49].data.img).toBe(doc.volumes[0].data.img)
    expect(() => assertDocumentFitsInput(doc, bytes.length)).toThrow(
      /expand beyond/,
    )
  })

  test('refuses a cycle', () => {
    const scene: Record<string, unknown> = {}
    scene.self = scene
    const bytes = sharing.encode({ version: 9, scene })
    expect(() => assertDocumentFitsInput(decode(bytes), bytes.length)).toThrow(
      /expand beyond/,
    )
  })

  test('refuses a chain of shared objects that doubles at each level', () => {
    let node: unknown = 0
    for (let i = 0; i < 40; i++) node = [node, node]
    const bytes = sharing.encode({ version: 9, scene: node })
    expect(() => assertDocumentFitsInput(decode(bytes), bytes.length)).toThrow(
      /expand beyond/,
    )
  })

  test('refuses shared arrays inside a Set or a Map', () => {
    const fid = new Uint8Array(100_000)
    const signals = new Set(
      Array.from({ length: 50 }, (_, i) => ({ id: i, fid })),
    )
    const map = new Map(Array.from({ length: 50 }, (_, i) => [i, fid]))
    for (const doc of [
      { version: 9, signals },
      { version: 9, map },
    ]) {
      const bytes = sharing.encode(doc)
      expect(() =>
        assertDocumentFitsInput(decode(bytes), bytes.length),
      ).toThrow(/expand beyond/)
    }
  })
})

describe('assertCborFitsInput', () => {
  test('accepts an honest document, including plain arrays and maps', () => {
    const doc = {
      ...honestDoc(),
      colormaps: { c: { R: [0, 255], G: [0, 128], B: [0, 64], A: [0, 1] } },
      annotations: [{ polygons: [{ outer: [{ x: 1, y: 2 }], holes: [] }] }],
    }
    expect(() => assertCborFitsInput(encode(doc))).not.toThrow()
    expect(() => assertCborFitsInput(sharing.encode(doc))).not.toThrow()
  })

  test('refuses nested array headers that claim more items than the file', () => {
    // 20 nested headers each claiming 100M items: cbor-x would allocate each
    // array before finding the data missing.
    const bytes = new Uint8Array(100)
    for (let i = 0; i < 20; i++) bytes.set([0x9a, 0x06, 0, 0, 0], i * 5)
    expect(() => assertCborFitsInput(bytes)).toThrow(/declare more items/)
  })

  test('refuses many map headers that together claim more than the file', () => {
    // Each map (128 entries, 256 items) alone fits the file; their sum does not.
    const bytes = new Uint8Array(300)
    for (let i = 0; i < 300; i += 2) bytes.set([0xb8, 0x80], i)
    expect(() => assertCborFitsInput(bytes)).toThrow(/declare more items/)
  })

  test('refuses cbor-x tags that hide array heads from the scan', () => {
    // 0xdfff makes cbor-x read the next 8 bytes as CBOR, which the scan skips
    // as an argument: here three hidden 100M-item array heads.
    const head = [0xd9, 0xdf, 0xff, 0x1b, 0x9a, 0x06, 0, 0, 0]
    const bytes = new Uint8Array([
      ...head,
      ...head,
      ...head,
      ...new Array(16).fill(0),
    ])
    expect(() => assertCborFitsInput(bytes)).toThrow(/unsupported tag/)
  })

  test('refuses packed-value prefixes, which copy arrays inside decode', () => {
    const bytes = new Uint8Array([
      0xd8, 0x33, 0x84, 0x81, 0, 0x82, 0, 0x80, 0x80, 0x80,
    ])
    expect(() => assertCborFitsInput(bytes)).toThrow(/unsupported tag/)
  })
})

describe('isEmbeddedImageComplete', () => {
  test('accepts an image with a byte per voxel or more', () => {
    expect(isEmbeddedImageComplete([3, 4, 4, 4], new Uint8Array(64))).toBe(true)
    expect(isEmbeddedImageComplete([4, 4, 4, 4, 2], new Uint8Array(512))).toBe(
      true,
    )
  })

  test('refuses a header that claims more voxels than the image holds', () => {
    expect(
      isEmbeddedImageComplete([3, 100_000, 100_000, 1], new Uint8Array(3)),
    ).toBe(false)
    expect(isEmbeddedImageComplete([3, 4, 4, 4], new Uint8Array(63))).toBe(
      false,
    )
    expect(isEmbeddedImageComplete([3, 0, 4, 4], new Uint8Array(64))).toBe(
      false,
    )
    expect(isEmbeddedImageComplete([3, -4, -4, 4], new Uint8Array(64))).toBe(
      false,
    )
    expect(isEmbeddedImageComplete([3, 4.5, 4, 4], new Uint8Array(64))).toBe(
      false,
    )
  })

  test('refuses a JSON image stored as a plain array, however long', () => {
    // Far more numbers than the 4x4x4 header implies, but not a typed array,
    // so it is never copied into one.
    const text = `{"version":9,"volumes":[{"data":{"hdr":{"dims":[3,4,4,4]},"img":[${new Array(100_000).fill(0).join(',')}]}}]}`
    const doc = decodeDocumentJSON(text) as {
      volumes: { data: { hdr: { dims: number[] }; img: unknown } }[]
    }
    const { hdr, img } = doc.volumes[0].data
    expect(Array.isArray(img)).toBe(true)
    expect(isEmbeddedImageComplete(hdr.dims, img)).toBe(false)
  })

  test('refuses an image that only claims a byteLength', () => {
    // JSON can rebuild a plain object, and only typed arrays are charged.
    const forged = {
      byteLength: 1e10,
      byteOffset: 0,
      buffer: new Uint8Array(3),
    }
    expect(isEmbeddedImageComplete([3, 100_000, 100_000, 1], forged)).toBe(
      false,
    )
  })
})
