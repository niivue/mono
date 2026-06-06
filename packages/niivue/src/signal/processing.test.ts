import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  NVSignalDisplay,
  NVSignalPhysioRaw,
  NVSignalSpectroscopyRaw,
} from '@/NVTypes'
import {
  defaultSignalDisplay,
  derivePhysioSeries,
  deriveSpectroscopySeries,
  fft,
  ppmRefForNucleus,
} from './processing'
import { read } from './readers/nii'
import { parseSidecar } from './sidecar'

const SIGNALS_DIR = join(import.meta.dir, '../../../dev-images/images/signals')

function argmax(a: Float32Array): number {
  let best = 0
  for (let i = 1; i < a.length; i++) if (a[i] > a[best]) best = i
  return best
}

describe('fft', () => {
  test('radix2_peaksAtToneBin', () => {
    const n = 64
    const k0 = 5
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let t = 0; t < n; t++) {
      re[t] = Math.cos((2 * Math.PI * k0 * t) / n)
      im[t] = Math.sin((2 * Math.PI * k0 * t) / n)
    }
    fft(re, im)
    const mag = new Float32Array(n)
    for (let i = 0; i < n; i++) mag[i] = Math.hypot(re[i], im[i])
    expect(argmax(mag)).toBe(k0)
    expect(mag[k0]).toBeCloseTo(n, 3)
  })

  test('dft_fallbackMatchesForNonPow2', () => {
    const n = 6 // not a power of two -> DFT path
    const k0 = 2
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    for (let t = 0; t < n; t++) {
      re[t] = Math.cos((2 * Math.PI * k0 * t) / n)
      im[t] = Math.sin((2 * Math.PI * k0 * t) / n)
    }
    fft(re, im)
    const mag = new Float32Array(n)
    for (let i = 0; i < n; i++) mag[i] = Math.hypot(re[i], im[i])
    expect(argmax(mag)).toBe(k0)
    expect(mag[k0]).toBeCloseTo(n, 3)
  })
})

describe('ppmRefForNucleus', () => {
  test('protonDefaults', () => {
    expect(ppmRefForNucleus('1H')).toBe(4.65)
    expect(ppmRefForNucleus('31P')).toBe(0)
    expect(ppmRefForNucleus('unknown')).toBe(0)
  })
})

describe('deriveSpectroscopySeries', () => {
  // Build a single-transient FID that is a complex tone at bin k0, so its
  // spectrum is a delta whose ppm location we can predict analytically.
  function syntheticTone(
    n: number,
    k0: number,
    dwell: number,
    sf: number,
  ): NVSignalSpectroscopyRaw {
    const fid = new Float32Array(n * 2)
    for (let p = 0; p < n; p++) {
      fid[2 * p] = Math.cos((2 * Math.PI * k0 * p) / n)
      fid[2 * p + 1] = Math.sin((2 * Math.PI * k0 * p) / n)
    }
    return {
      kind: 'spectroscopy',
      fid,
      nPoints: n,
      nTransients: 1,
      dwell,
      spectrometerFreq: sf,
      nucleus: '1H',
    }
  }

  test('peakLandsAtExpectedPpm', () => {
    const n = 256
    const k0 = 20
    const dwell = 0.0005
    const sf = 297.155
    const raw = syntheticTone(n, k0, dwell, sf)
    const display: NVSignalDisplay = {
      ...defaultSignalDisplay(),
      mode: 'magnitude',
    }
    const { series, axis } = deriveSpectroscopySeries(raw, display)
    expect(series.length).toBe(1)
    expect(axis.label).toBe('Chemical shift (ppm)')
    expect(axis.reversed).toBe(true)
    // x ascending
    const x = series[0].x as Float32Array
    expect(x[0]).toBeLessThan(x[x.length - 1])
    // Expected: tone at bin k0 -> Hz = k0/(n*dwell); ppm = -Hz/sf + 4.65
    const hz = k0 / (n * dwell)
    const expectedPpm = -hz / sf + 4.65
    const peakPpm = x[argmax(series[0].y)]
    expect(peakPpm).toBeCloseTo(expectedPpm, 2)
  })

  test('averageProducesSingleSeries', () => {
    const n = 64
    const base = syntheticTone(n, 8, 0.0005, 297)
    // duplicate into 4 transients
    const nT = 4
    const fid = new Float32Array(n * nT * 2)
    for (let t = 0; t < nT; t++) fid.set(base.fid, t * n * 2)
    const raw: NVSignalSpectroscopyRaw = { ...base, fid, nTransients: nT }
    const avg = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      average: true,
    })
    expect(avg.series.length).toBe(1)
    const all = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      average: false,
    })
    expect(all.series.length).toBe(nT)
  })

  test('ppmRangeSetsAxisWindow', () => {
    const raw = syntheticTone(64, 8, 0.0005, 297)
    const { axis } = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      ppmRange: [3.3, 1.9],
    })
    expect(axis.min).toBe(1.9)
    expect(axis.max).toBe(3.3)
  })

  test('useHzGivesHzAxisNotReversed', () => {
    const raw = syntheticTone(64, 8, 0.0005, 297)
    const { axis, series } = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      useHz: true,
    })
    expect(axis.label).toBe('Frequency (Hz)')
    expect(axis.reversed).toBe(false)
    const x = series[0].x as Float32Array
    expect(x[0]).toBeLessThan(x[x.length - 1])
  })
})

describe('derivePhysioSeries', () => {
  function raw(fs: number | null): NVSignalPhysioRaw {
    return {
      kind: 'physio',
      columns: [new Float32Array([1, 2, 3, 4]), new Float32Array([0, 0, 1, 0])],
      columnLabels: ['cardiac', 'trigger'],
      samplingFrequency: fs,
      startTime: -2,
    }
  }

  test('timeAxisFromRateAndStartTime', () => {
    const { series, axis } = derivePhysioSeries(raw(50), defaultSignalDisplay())
    expect(axis.label).toBe('Time (s)')
    const x = series[0].x as Float32Array
    expect(x[0]).toBeCloseTo(-2, 6) // startTime
    expect(x[1]).toBeCloseTo(-2 + 1 / 50, 6)
    expect(series.length).toBe(2)
  })

  test('sampleAxisWhenRateUnknown', () => {
    const { series, axis } = derivePhysioSeries(
      raw(null),
      defaultSignalDisplay(),
    )
    expect(axis.label).toBe('Sample')
    expect(series[0].x).toBeNull()
  })

  test('selectedColumnsFilters', () => {
    const { series } = derivePhysioSeries(raw(50), {
      ...defaultSignalDisplay(),
      selectedColumns: [0],
    })
    expect(series.length).toBe(1)
    expect(series[0].label).toBe('cardiac')
  })
})

describe('real SVS fixture transform', () => {
  test('averagedRealSpectrumHasExpectedShape', async () => {
    const buf = readFileSync(join(SIGNALS_DIR, 'svs_se_30.nii.gz'))
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer
    const json = JSON.parse(
      readFileSync(join(SIGNALS_DIR, 'svs_se_30.json'), 'utf8'),
    )
    const raw = (await read(
      ab,
      'svs_se_30.nii.gz',
      parseSidecar(json),
    )) as NVSignalSpectroscopyRaw
    const { series, axis } = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      ppmRange: [1.9, 3.3],
    })
    expect(series.length).toBe(1)
    expect(series[0].y.length).toBe(1024)
    expect(axis.label).toBe('Chemical shift (ppm)')
    expect(axis.reversed).toBe(true)
    expect(axis.min).toBe(1.9)
    expect(axis.max).toBe(3.3)
    // spectrum should contain finite, non-trivial signal
    const peak = Math.max(...series[0].y)
    expect(Number.isFinite(peak)).toBe(true)
    expect(peak).toBeGreaterThan(0)
  })
})
