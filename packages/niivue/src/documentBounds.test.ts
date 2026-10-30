import { describe, expect, test } from 'bun:test'
import { decode, Encoder, encode } from 'cbor-x'
import {
  assertDocumentFitsInput,
  isEmbeddedImageComplete,
} from './documentBounds'
import { decodeDocumentJSON, encodeDocumentJSON } from './documentJson'

// The encoder `saveDocument` never uses, but a hostile file can: it writes
// tags 28/29, so a repeated or cyclic value is stored once.
const sharing = new Encoder({ structuredClone: true })

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

describe('isEmbeddedImageComplete', () => {
  test('accepts an image with a byte per voxel or more', () => {
    expect(isEmbeddedImageComplete([3, 4, 4, 4], 64)).toBe(true)
    expect(isEmbeddedImageComplete([4, 4, 4, 4, 2], 512)).toBe(true)
  })

  test('refuses a header that claims more voxels than the image holds', () => {
    expect(isEmbeddedImageComplete([3, 100_000, 100_000, 1], 3)).toBe(false)
    expect(isEmbeddedImageComplete([3, 4, 4, 4], 63)).toBe(false)
    expect(isEmbeddedImageComplete([3, 0, 4, 4], 64)).toBe(false)
    expect(isEmbeddedImageComplete([3, -4, -4, 4], 64)).toBe(false)
    expect(isEmbeddedImageComplete([3, 4.5, 4, 4], 64)).toBe(false)
  })
})
