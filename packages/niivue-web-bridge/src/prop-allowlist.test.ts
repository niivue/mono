import { describe, expect, test } from 'bun:test'
import { coerce, DEFAULT_PROP_ALLOWLIST } from './prop-allowlist'

describe('coerce', () => {
  test('boolean', () => {
    expect(coerce('boolean', 0)).toBe(false)
    expect(coerce('boolean', 1)).toBe(true)
    expect(coerce('boolean', 'anything')).toBe(true)
    expect(coerce('boolean', '')).toBe(false)
  })

  test('number', () => {
    expect(coerce('number', '3.14')).toBe(3.14)
    expect(coerce('number', 7)).toBe(7)
  })

  test('enum coerces to number', () => {
    expect(coerce('enum', '2')).toBe(2)
  })

  test('string coerces null/undefined to ""', () => {
    expect(coerce('string', null)).toBe('')
    expect(coerce('string', undefined)).toBe('')
    expect(coerce('string', 42)).toBe('42')
  })

  test('rgba accepts [r,g,b] and fills alpha=1', () => {
    expect(coerce('rgba', [0.1, 0.2, 0.3])).toEqual([0.1, 0.2, 0.3, 1])
  })

  test('rgba accepts [r,g,b,a]', () => {
    expect(coerce('rgba', [0.1, 0.2, 0.3, 0.5])).toEqual([0.1, 0.2, 0.3, 0.5])
  })

  test('rgba rejects short or non-array values', () => {
    expect(() => coerce('rgba', [1, 2])).toThrow()
    expect(() => coerce('rgba', 'not-an-array')).toThrow()
  })
})

describe('DEFAULT_PROP_ALLOWLIST', () => {
  test('contains expected anchor entries with correct kinds', () => {
    expect(DEFAULT_PROP_ALLOWLIST.sliceType?.kind).toBe('enum')
    expect(DEFAULT_PROP_ALLOWLIST.backgroundColor?.kind).toBe('rgba')
    expect(DEFAULT_PROP_ALLOWLIST.isColorbarVisible?.kind).toBe('boolean')
    expect(DEFAULT_PROP_ALLOWLIST.mosaicString?.kind).toBe('string')
    expect(DEFAULT_PROP_ALLOWLIST.gamma?.kind).toBe('number')
  })

  test('entries emit on change by default', () => {
    for (const spec of Object.values(DEFAULT_PROP_ALLOWLIST)) {
      expect(spec.emitOnChange).toBe(true)
    }
  })
})
