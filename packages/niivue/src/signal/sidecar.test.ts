import { describe, expect, test } from 'bun:test'
import { hasMrsFields, parseSidecar, siblingJsonUrl } from './sidecar'

describe('siblingJsonUrl', () => {
  test('stripsDoubleExtensions', () => {
    expect(siblingJsonUrl('/a/b/foo_physio.tsv.gz')).toBe(
      '/a/b/foo_physio.json',
    )
    expect(siblingJsonUrl('/a/b/svs.nii.gz')).toBe('/a/b/svs.json')
  })

  test('stripsSingleExtensions', () => {
    expect(siblingJsonUrl('foo.tsv')).toBe('foo.json')
    expect(siblingJsonUrl('foo.nii')).toBe('foo.json')
  })

  test('fallsBackToFinalExtension', () => {
    expect(siblingJsonUrl('foo.dat')).toBe('foo.json')
    expect(siblingJsonUrl('noext')).toBe('noext.json')
  })
})

describe('parseSidecar', () => {
  test('parsesPhysioFields', () => {
    const s = parseSidecar({
      Columns: ['cardiac', 'trigger'],
      SamplingFrequency: 200,
      StartTime: -13.72,
    })
    expect(s.columns).toEqual(['cardiac', 'trigger'])
    expect(s.samplingFrequency).toBe(200)
    expect(s.startTime).toBe(-13.72)
  })

  test('parsesMrsFields', () => {
    const s = parseSidecar({
      SpectrometerFrequency: 297.155,
      ResonantNucleus: '1H',
      DwellTime: 0.0005,
    })
    expect(s.spectrometerFrequency).toBe(297.155)
    expect(s.resonantNucleus).toBe('1H')
    expect(s.dwellTime).toBe(0.0005)
  })

  test('acceptsArrayWrappedScalars', () => {
    const s = parseSidecar({
      SpectrometerFrequency: [297.155],
      ResonantNucleus: ['1H'],
    })
    expect(s.spectrometerFrequency).toBe(297.155)
    expect(s.resonantNucleus).toBe('1H')
  })

  test('imagingFrequencyIsNotAnMrsMarker', () => {
    // ImagingFrequency appears in plain fMRI sidecars; it must not flag MRS.
    const s = parseSidecar({ ImagingFrequency: 297.15, SamplingFrequency: 50 })
    expect(s.spectrometerFrequency).toBeUndefined()
    expect(hasMrsFields(s)).toBe(false)
  })

  test('toleratesNonObject', () => {
    expect(parseSidecar(null)).toEqual({})
    expect(parseSidecar('nope')).toEqual({})
  })
})

describe('hasMrsFields', () => {
  test('trueWhenSpectrometerFreqPresent', () => {
    expect(hasMrsFields({ spectrometerFrequency: 297 })).toBe(true)
  })
  test('trueWhenNucleusPresent', () => {
    expect(hasMrsFields({ resonantNucleus: '1H' })).toBe(true)
  })
  test('falseForPlainPhysio', () => {
    expect(hasMrsFields({ samplingFrequency: 200, startTime: 0 })).toBe(false)
  })
})
