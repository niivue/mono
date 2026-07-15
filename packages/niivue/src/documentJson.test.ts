import { describe, expect, test } from 'bun:test'
import {
  decodeDocumentJSON,
  encodeDocumentJSON,
  looksLikeJSON,
} from './documentJson'

describe('encodeDocumentJSON / decodeDocumentJSON', () => {
  test('round-trips plain values', () => {
    const doc = {
      version: 9,
      scene: { azimuth: 200, crosshairPos: [0.1, 0.2, 0.3] },
      layout: {},
      nested: { a: [1, 2, { b: true, c: 'x' }] },
    }
    expect(decodeDocumentJSON(encodeDocumentJSON(doc))).toEqual(doc)
  })

  test('round-trips a Uint8Array as itself (embedded volume bytes)', () => {
    const doc = { data: { img: new Uint8Array([0, 1, 2, 253, 254, 255]) } }
    const out = decodeDocumentJSON(encodeDocumentJSON(doc)) as typeof doc
    expect(out.data.img).toBeInstanceOf(Uint8Array)
    expect(Array.from(out.data.img)).toEqual([0, 1, 2, 253, 254, 255])
  })

  test('preserves other typed-array kinds by constructor', () => {
    const doc = {
      f32: new Float32Array([1.5, -2.25, 3.75]),
      i16: new Int16Array([-1, 1000, 32000]),
      u32: new Uint32Array([0, 4294967295]),
    }
    const out = decodeDocumentJSON(encodeDocumentJSON(doc)) as typeof doc
    expect(out.f32).toBeInstanceOf(Float32Array)
    expect(Array.from(out.f32)).toEqual([1.5, -2.25, 3.75])
    expect(out.i16).toBeInstanceOf(Int16Array)
    expect(Array.from(out.i16)).toEqual([-1, 1000, 32000])
    expect(out.u32).toBeInstanceOf(Uint32Array)
    expect(Array.from(out.u32)).toEqual([0, 4294967295])
  })

  test('handles a typed-array view with a non-zero byteOffset', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9])
    const view = backing.subarray(2, 5) // [1,2,3], byteOffset 2
    const out = decodeDocumentJSON(encodeDocumentJSON({ view })) as {
      view: Uint8Array
    }
    expect(Array.from(out.view)).toEqual([1, 2, 3])
  })

  test('the JSON is valid, human-readable text (no binary)', () => {
    const json = encodeDocumentJSON({ img: new Uint8Array([1, 2, 3]) })
    expect(() => JSON.parse(json)).not.toThrow()
    expect(json).toContain('"$ta":"Uint8Array"')
    expect(json).toContain('"b64":')
  })
})

describe('looksLikeJSON', () => {
  test('true for JSON bytes (with leading whitespace)', () => {
    expect(looksLikeJSON(new TextEncoder().encode('{"a":1}'))).toBe(true)
    expect(looksLikeJSON(new TextEncoder().encode('  \n\t{"a":1}'))).toBe(true)
  })

  test('false for CBOR bytes (map marker >= 0xa0) and empty', () => {
    expect(looksLikeJSON(new Uint8Array([0xa2, 0x01, 0x02]))).toBe(false)
    expect(looksLikeJSON(new Uint8Array([0xbf]))).toBe(false)
    expect(looksLikeJSON(new Uint8Array([]))).toBe(false)
  })
})
