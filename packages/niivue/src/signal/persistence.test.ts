import { describe, expect, test } from 'bun:test'
import { decode, encode } from 'cbor-x'
import type { NVSignal } from '@/NVTypes'
import { reconstructSignal, serializeSignal } from './persistence'
import { defaultSignalDisplay } from './processing'

function roundTrip(sig: NVSignal): NVSignal {
  // Exercise the real CBOR path the NVD document uses.
  const encoded = encode(serializeSignal(sig))
  return reconstructSignal(decode(encoded))
}

describe('signal persistence round-trip', () => {
  test('physioPreservesColumnsAndTiming', () => {
    const sig: NVSignal = {
      id: 'cardiac',
      name: 'cardiac',
      url: '/x/cardiac.tsv.gz',
      kind: 'physio',
      raw: {
        kind: 'physio',
        columns: [
          new Float32Array([1, 2, 3, 4]),
          new Float32Array([0, 1, 0, 1]),
        ],
        columnLabels: ['cardiac', 'trigger'],
        samplingFrequency: 200,
        startTime: -13.72,
      },
      display: { ...defaultSignalDisplay(), selectedColumns: [0] },
      attachedToId: 'bold',
    }
    const out = roundTrip(sig)
    expect(out.kind).toBe('physio')
    expect(out.id).toBe('cardiac')
    expect(out.attachedToId).toBe('bold')
    expect(out.display.selectedColumns).toEqual([0])
    if (out.raw.kind !== 'physio') throw new Error('kind')
    expect(out.raw.samplingFrequency).toBe(200)
    expect(out.raw.startTime).toBeCloseTo(-13.72, 5)
    expect(out.raw.columnLabels).toEqual(['cardiac', 'trigger'])
    expect(Array.from(out.raw.columns[0])).toEqual([1, 2, 3, 4])
    expect(Array.from(out.raw.columns[1])).toEqual([0, 1, 0, 1])
  })

  test('spectroscopyPreservesFidAndMeta', () => {
    const fid = new Float32Array([33184, 0, 24368.6, -1.5, 100, 200])
    const sig: NVSignal = {
      id: 'svs',
      name: 'svs',
      kind: 'spectroscopy',
      raw: {
        kind: 'spectroscopy',
        fid,
        nPoints: 3,
        nTransients: 1,
        dwell: 0.0005,
        spectrometerFreq: 297.155,
        nucleus: '1H',
      },
      display: { ...defaultSignalDisplay(), ppmRange: [1.9, 3.3] },
    }
    const out = roundTrip(sig)
    expect(out.kind).toBe('spectroscopy')
    expect(out.display.ppmRange).toEqual([1.9, 3.3])
    if (out.raw.kind !== 'spectroscopy') throw new Error('kind')
    expect(out.raw.nPoints).toBe(3)
    expect(out.raw.nTransients).toBe(1)
    expect(out.raw.dwell).toBeCloseTo(0.0005, 7)
    expect(out.raw.spectrometerFreq).toBeCloseTo(297.155, 3)
    expect(out.raw.nucleus).toBe('1H')
    expect(Array.from(out.raw.fid)).toEqual(Array.from(fid))
  })

  test('annotationsRoundTripIncludingInfiniteY', () => {
    const sig: NVSignal = {
      id: 'svs',
      name: 'svs',
      kind: 'spectroscopy',
      raw: {
        kind: 'spectroscopy',
        fid: new Float32Array([1, 0, 2, 0]),
        nPoints: 2,
        nTransients: 1,
        dwell: 0.0005,
        spectrometerFreq: 297.155,
        nucleus: '1H',
      },
      display: { ...defaultSignalDisplay() },
      annotations: [
        { text: 'NAA', x: 2.0, y: Number.NEGATIVE_INFINITY },
        { text: 'Cho', x: 3.2, y: 1.5, color: [1, 0, 0, 1] },
      ],
    }
    const out = roundTrip(sig)
    expect(out.annotations).toHaveLength(2)
    expect(out.annotations?.[0]).toEqual({
      text: 'NAA',
      x: 2.0,
      y: Number.NEGATIVE_INFINITY,
    })
    expect(out.annotations?.[1]).toEqual({
      text: 'Cho',
      x: 3.2,
      y: 1.5,
      color: [1, 0, 0, 1],
    })
  })
})
