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

  test('throws on a typed-array kind the decoder cannot rebuild', () => {
    expect(() =>
      encodeDocumentJSON({ big: new BigInt64Array([1n, 2n]) }),
    ).toThrow(/BigInt64Array/)
  })
})

describe('non-finite numbers', () => {
  test('round-trips NaN and +/-Infinity as the same values', () => {
    const doc = {
      calMinNeg: Number.NaN,
      thicknessOn2D: Number.POSITIVE_INFINITY,
      pinBottom: Number.NEGATIVE_INFINITY,
    }
    const out = decodeDocumentJSON(encodeDocumentJSON(doc)) as typeof doc
    expect(Number.isNaN(out.calMinNeg)).toBe(true)
    expect(out.thicknessOn2D).toBe(Number.POSITIVE_INFINITY)
    expect(out.pinBottom).toBe(Number.NEGATIVE_INFINITY)
  })

  test('round-trips non-finite numbers inside arrays', () => {
    const doc = { ys: [0.5, Number.NaN, Number.POSITIVE_INFINITY, -1] }
    const out = decodeDocumentJSON(encodeDocumentJSON(doc)) as typeof doc
    expect(out.ys[0]).toBe(0.5)
    expect(Number.isNaN(out.ys[1])).toBe(true)
    expect(out.ys[2]).toBe(Number.POSITIVE_INFINITY)
    expect(out.ys[3]).toBe(-1)
  })

  test('writes a $num tag, never a bare null', () => {
    const json = encodeDocumentJSON({
      a: Number.NaN,
      b: Number.POSITIVE_INFINITY,
      c: Number.NEGATIVE_INFINITY,
    })
    expect(json).toContain('"a":{"$num":"NaN"}')
    expect(json).toContain('"b":{"$num":"Infinity"}')
    expect(json).toContain('"c":{"$num":"-Infinity"}')
    expect(json).not.toContain('null')
  })

  test('never tags a finite number', () => {
    const doc = {
      zero: 0,
      neg: -0.25,
      max: Number.MAX_VALUE,
      min: -Number.MAX_VALUE,
    }
    const json = encodeDocumentJSON(doc)
    expect(json).not.toContain('$num')
    expect(decodeDocumentJSON(json)).toEqual(doc)
  })

  test('leaves an unknown $num tag as a plain object', () => {
    const out = decodeDocumentJSON('{"x":{"$num":"Banana"}}') as {
      x: unknown
    }
    expect(out.x).toEqual({ $num: 'Banana' })
  })

  test('a bare null written by an older encoder still decodes as null', () => {
    const out = decodeDocumentJSON('{"volumes":[{"calMinNeg":null}]}') as {
      volumes: { calMinNeg: unknown }[]
    }
    expect(out.volumes[0].calMinNeg).toBeNull()
  })

  test('non-finite values inside a Float32Array go through the $ta path', () => {
    const doc = {
      f32: new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]),
    }
    const json = encodeDocumentJSON(doc)
    expect(json).not.toContain('$num')
    const out = decodeDocumentJSON(json) as typeof doc
    expect(Number.isNaN(out.f32[0])).toBe(true)
    expect(out.f32[1]).toBe(Number.POSITIVE_INFINITY)
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
