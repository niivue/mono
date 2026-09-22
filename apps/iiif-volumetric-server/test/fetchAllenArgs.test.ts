import { describe, expect, test } from 'bun:test'

import { parseConcurrency } from '../scripts/fetch-allen'

describe('parseConcurrency', () => {
  test('accepts positive integers', () => {
    expect(parseConcurrency('1')).toBe(1)
    expect(parseConcurrency('8')).toBe(8)
  })

  // NaN or 0 would make runWithConcurrency spawn no workers and the fetch
  // would "succeed" downloading nothing, so every non-positive-integer form
  // must throw instead.
  for (const raw of ['abc', '0', '-2', '2.5', 'NaN', 'Infinity', '']) {
    test(`rejects '${raw}'`, () => {
      expect(() => parseConcurrency(raw)).toThrow(/positive integer/)
    })
  }
})
