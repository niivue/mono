import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  NVSignalDisplay,
  NVSignalPhysioRaw,
  NVSignalSpectroscopyRaw,
} from '@/NVTypes'
import {
  apodize,
  defaultSignalDisplay,
  derivePhysioSeries,
  deriveSpectroscopySeries,
  fft,
  halveFirstPoint,
  integratePpmBandMap,
  PPM_RANGE,
  PPM_SHIFT,
  phaseCorrection,
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

describe('FSL-MRS parity (fsleyes-plugin-mrs)', () => {
  test('nucleusConstants', () => {
    expect(PPM_SHIFT['1H']).toBe(4.65)
    expect(PPM_SHIFT['2H']).toBe(4.8)
    expect(PPM_RANGE['1H']).toEqual([0.2, 4.2])
    expect(PPM_RANGE['31P']).toEqual([-20, 10])
  })

  test('halveFirstPointScalesDcSample', () => {
    const re = new Float64Array([1, 2, 3, 4])
    const im = new Float64Array([5, 6, 7, 8])
    halveFirstPoint(re, im)
    expect(re[0]).toBe(0.5)
    expect(im[0]).toBe(2.5)
    expect(re[1]).toBe(2) // unchanged
    expect(im[3]).toBe(8)
  })

  test('apodizeMatchesExpWindow', () => {
    // fsleyes test_utils.py: data [1,2,3,4], dwell 0.1, broadening 1.
    const re = new Float64Array([1, 2, 3, 4])
    const im = new Float64Array(4)
    apodize(re, im, 0.1, 1)
    const t = [0, 0.1, 0.2, 0.3]
    for (let i = 0; i < 4; i++) {
      expect(re[i]).toBeCloseTo([1, 2, 3, 4][i] * Math.exp(-t[i] * 1), 6)
    }
  })

  test('apodizeNonPositiveIsNoOp', () => {
    const re = new Float64Array([1, 2, 3, 4])
    const im = new Float64Array(4)
    apodize(re, im, 0.1, 0)
    expect(Array.from(re)).toEqual([1, 2, 3, 4])
  })

  test('phaseCorrectionZeroOrderRotates', () => {
    // p0 = 90 deg, freqs = 0 -> multiply by exp(i*pi/2) = i: (1,0) -> (0,1).
    const re = new Float64Array([1])
    const im = new Float64Array([0])
    phaseCorrection(re, im, new Float64Array([0]), 90, 0)
    expect(re[0]).toBeCloseTo(0, 6)
    expect(im[0]).toBeCloseTo(1, 6)
  })

  test('calcSpectrumMatchesNumpyFftshift', () => {
    // fsleyes calcSpectrum([1,2,3,4]): fid[0]*=0.5 -> fft -> fftshift.
    // numpy reference: fftshift(fft([0.5,2,3,4])) = [-2.5, -2.5-2j, 9.5, -2.5+2j]
    const raw: NVSignalSpectroscopyRaw = {
      kind: 'spectroscopy',
      fid: new Float32Array([1, 0, 2, 0, 3, 0, 4, 0]),
      nPoints: 4,
      nTransients: 1,
      dwell: 0.001,
      spectrometerFreq: 100,
      nucleus: '1H',
    }
    const reSpec = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      useHz: true, // avoid ppm reversal so order matches numpy fftshift
      halveFirstPoint: true,
      mode: 'real',
    })
    const imSpec = deriveSpectroscopySeries(raw, {
      ...defaultSignalDisplay(),
      useHz: true,
      halveFirstPoint: true,
      mode: 'imag',
    })
    const expRe = [-2.5, -2.5, 9.5, -2.5]
    const expIm = [0, -2, 0, 2]
    for (let i = 0; i < 4; i++) {
      expect(reSpec.series[0].y[i]).toBeCloseTo(expRe[i], 5)
      expect(imSpec.series[0].y[i]).toBeCloseTo(expIm[i], 5)
    }
  })

  test('integratePpmBandMapFirstPointMagnitudeFallback', () => {
    // No spectrometer freq -> first-point magnitude map. One voxel, FID[0]=3+4i.
    const fid = new Float32Array([3, 4, 0, 0, 0, 0, 0, 0])
    const map = integratePpmBandMap(fid, 1, 4, 1, 0.1, null, '1H', [0, 5])
    expect(map.length).toBe(1)
    expect(map[0]).toBeCloseTo(5, 6)
  })

  test('integratePpmBandMapSumsRealOverBand', () => {
    // One voxel, FID [1,2,3,4] real. nFFT=4, dwell=0.1, sf=1 MHz, ref 4.65.
    // ppm bins (ascending Hz order) = [9.65, 7.15, 4.65, 2.15].
    // band [2,8] -> bins 1,2,3. shifted real spectrum = [-2, -2, 10, -2].
    // sum real over bins 1..3 = -2 + 10 - 2 = 6.
    const fid = new Float32Array([1, 0, 2, 0, 3, 0, 4, 0])
    const map = integratePpmBandMap(fid, 1, 4, 1, 0.1, 1, '1H', [2, 8], {
      mode: 'real',
    })
    expect(map[0]).toBeCloseTo(6, 5)
  })
})

describe('derivePhysioSeries', () => {
  // BIDS/bidsphysio layout: recording, the scanner VOLUME trigger ("trigger"),
  // and the measure-specific event trigger ("cardiac_trigger").
  function raw(fs: number | null): NVSignalPhysioRaw {
    return {
      kind: 'physio',
      columns: [
        new Float32Array([1, 2, 3, 4]), // cardiac recording
        new Float32Array([1, 0, 1, 0]), // volume trigger (NOT shown)
        new Float32Array([0, 0, 1, 0]), // cardiac_trigger -> event at index 2
      ],
      columnLabels: ['cardiac', 'trigger', 'cardiac_trigger'],
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
    // default excludes the "trigger" + "cardiac_trigger" columns -> only cardiac
    expect(series.length).toBe(1)
    expect(series[0].label).toBe('cardiac')
  })

  test('defaultExcludesTriggerColumnsFromLines', () => {
    const { series } = derivePhysioSeries(raw(50), defaultSignalDisplay())
    const labels = series.map((s) => s.label)
    expect(labels).toEqual(['cardiac'])
    expect(labels).not.toContain('trigger')
    expect(labels).not.toContain('cardiac_trigger')
  })

  test('multiMeasureRoutesTriggersPerSeries', () => {
    // [cardiac, respiratory, trigger, cardiac_trigger, respiratory_trigger]
    const r: NVSignalPhysioRaw = {
      kind: 'physio',
      columns: [
        new Float32Array([1, 2, 3, 4]), // cardiac
        new Float32Array([5, 6, 7, 8]), // respiratory
        new Float32Array([1, 0, 1, 0]), // volume trigger
        new Float32Array([0, 1, 0, 0]), // cardiac_trigger -> index 1
        new Float32Array([0, 0, 0, 1]), // respiratory_trigger -> index 3
      ],
      columnLabels: [
        'cardiac',
        'respiratory',
        'trigger',
        'cardiac_trigger',
        'respiratory_trigger',
      ],
      samplingFrequency: null,
      startTime: 0,
    }
    const { series } = derivePhysioSeries(r, defaultSignalDisplay())
    expect(series.map((s) => s.label)).toEqual(['cardiac', 'respiratory'])
    // each measure gets ITS OWN trigger events, not the first column's
    expect(series[0].triggers).toEqual([1]) // cardiac_trigger
    expect(series[1].triggers).toEqual([3]) // respiratory_trigger
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

  test('measureTriggerColumnReportedOnFirstPlottedSeries', () => {
    // "cardiac_trigger" = [0, 0, 1, 0] -> one event at index 2 (x = -2 + 2/50)
    const { series } = derivePhysioSeries(raw(50), {
      ...defaultSignalDisplay(),
      selectedColumns: [0], // trigger columns are not plotted as lines
    })
    expect(series[0].triggers).toHaveLength(1)
    expect(series[0].triggers?.[0]).toBeCloseTo(-2 + 2 / 50, 6)
  })

  test('plainVolumeTriggerColumnNotShown', () => {
    // Only the scanner "trigger" column (no "<measure>_trigger"): no rug. The
    // volume trigger is the acquisition grid, not a feature of the signal.
    const r: NVSignalPhysioRaw = {
      kind: 'physio',
      columns: [new Float32Array([1, 2, 3, 4]), new Float32Array([1, 0, 1, 0])],
      columnLabels: ['cardiac', 'trigger'],
      samplingFrequency: 50,
      startTime: 0,
    }
    const { series } = derivePhysioSeries(r, {
      ...defaultSignalDisplay(),
      selectedColumns: [0],
    })
    expect(series[0].triggers).toBeUndefined()
  })

  test('triggerOnlyNumericNonZero', () => {
    // n/a (NaN) and 0 are not triggers; any other numeric value is
    const r: NVSignalPhysioRaw = {
      kind: 'physio',
      columns: [
        new Float32Array([1, 2, 3, 4, 5]),
        new Float32Array([0, Number.NaN, 2, 0, -1]),
      ],
      columnLabels: ['cardiac', 'cardiac_trigger'],
      samplingFrequency: null,
      startTime: 0,
    }
    const { series } = derivePhysioSeries(r, {
      ...defaultSignalDisplay(),
      selectedColumns: [0],
    })
    // sample-index x (rate unknown): events at indices 2 (=2) and 4 (=-1)
    expect(series[0].triggers).toEqual([2, 4])
  })

  test('noTriggersWithoutTriggerColumn', () => {
    const r: NVSignalPhysioRaw = {
      kind: 'physio',
      columns: [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])],
      columnLabels: ['x', 'y'],
      samplingFrequency: null,
      startTime: 0,
    }
    const { series } = derivePhysioSeries(r, defaultSignalDisplay())
    expect(series[0].triggers).toBeUndefined()
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
