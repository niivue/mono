import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseSidecar } from '../sidecar'
import { parseTsv } from './tsv'

const SIGNALS_DIR = join(
  import.meta.dir,
  '../../../../dev-images/images/signals',
)

describe('parseTsv', () => {
  test('parsesPlainColumns', () => {
    const r = parseTsv('1\t10\n2\t20\n3\t30\n')
    expect(r.kind).toBe('physio')
    expect(r.columns.length).toBe(2)
    expect(Array.from(r.columns[0])).toEqual([1, 2, 3])
    expect(Array.from(r.columns[1])).toEqual([10, 20, 30])
    expect(r.samplingFrequency).toBeNull()
    expect(r.startTime).toBe(0)
  })

  test('detectsLeadingHeaderRow', () => {
    const r = parseTsv('cardiac\ttrigger\n2288\t0\n2345\t0\n')
    expect(r.columnLabels).toEqual(['cardiac', 'trigger'])
    expect(r.columns[0].length).toBe(2)
    expect(Array.from(r.columns[0])).toEqual([2288, 2345])
  })

  test('allMissingFirstRowKeptAsData', () => {
    // A first data row of all missing tokens must not be mistaken for a header.
    const r = parseTsv('n/a\tn/a\n2288\t0\n')
    expect(r.columns[0].length).toBe(2)
    expect(Number.isNaN(r.columns[0][0])).toBe(true)
    expect(r.columns[0][1]).toBe(2288)
    expect(r.columnLabels).toEqual(['column 0', 'column 1'])
  })

  test('nonNumericCellsBecomeNaN', () => {
    const r = parseTsv('1\tn/a\n2\t\n3\tx\n')
    expect(Number.isNaN(r.columns[1][0])).toBe(true)
    expect(Number.isNaN(r.columns[1][1])).toBe(true)
    expect(Number.isNaN(r.columns[1][2])).toBe(true)
    expect(r.columns[0][2]).toBe(3)
  })

  test('sidecarSuppliesLabelsAndTiming', () => {
    const sidecar = parseSidecar({
      Columns: ['cardiac', 'trigger'],
      SamplingFrequency: 200,
      StartTime: -13.72,
    })
    const r = parseTsv('2288\t0\n2345\t0\n', sidecar)
    expect(r.columnLabels).toEqual(['cardiac', 'trigger'])
    expect(r.samplingFrequency).toBe(200)
    expect(r.startTime).toBe(-13.72)
  })

  test('shortRowsPaddedWithNaN', () => {
    const r = parseTsv('1\t2\t3\n4\n')
    expect(r.columns.length).toBe(3)
    expect(r.columns[2][0]).toBe(3)
    expect(Number.isNaN(r.columns[1][1])).toBe(true)
    expect(Number.isNaN(r.columns[2][1])).toBe(true)
  })

  test('throwsOnEmpty', () => {
    expect(() => parseTsv('\n\n')).toThrow()
  })
})

describe('tsv fixtures (real BIDS physio)', () => {
  function loadFixture(stem: string) {
    const gz = readFileSync(join(SIGNALS_DIR, `${stem}.tsv.gz`))
    const text = new TextDecoder().decode(gunzipSync(gz))
    const json = JSON.parse(
      readFileSync(join(SIGNALS_DIR, `${stem}.json`), 'utf8'),
    )
    return parseTsv(text, parseSidecar(json))
  }

  test('cardiac_200Hz_twoColumns', () => {
    const r = loadFixture('cardiac')
    expect(r.columnLabels).toEqual(['cardiac', 'trigger'])
    expect(r.samplingFrequency).toBe(200)
    expect(r.startTime).toBeCloseTo(-9.652, 5)
    expect(r.columns.length).toBe(2)
    expect(r.columns[0].length).toBeGreaterThan(1000)
  })

  test('respiratory_50Hz_twoColumns', () => {
    const r = loadFixture('respiratory')
    expect(r.columnLabels).toEqual(['respiratory', 'trigger'])
    expect(r.samplingFrequency).toBe(50)
    expect(r.columns.length).toBe(2)
    expect(r.columns[0].length).toBeGreaterThan(1000)
  })
})
