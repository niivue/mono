import { describe, expect, test } from 'bun:test'
import type { NVDocumentVolume } from '@/NVDocument'
import { urlVolumeOptions } from './documentVolumeOptions'

// Guards the fix for URL-referenced document volumes losing their auto-computed
// contrast window: reconstructVolume forwards only document-specified fields to
// addVolume, so an omitted calMin/calMax no longer clobbers what nii2volume
// computes (which left the volume unrendered until a manual contrast reset).
describe('urlVolumeOptions', () => {
  test('dropsUndefinedFieldsSoComputedWindowSurvives', () => {
    const opts = urlVolumeOptions({
      url: 'brain.nii.gz',
      name: 'brain',
      colormap: 'gray',
    })
    expect(opts.url).toBe('brain.nii.gz')
    expect(opts.name).toBe('brain')
    expect(opts.colormap).toBe('gray')
    // The document omitted these, so they must NOT appear as undefined keys
    // (that is exactly what clobbered the computed window).
    expect('calMin' in opts).toBe(false)
    expect('calMax' in opts).toBe(false)
    expect('calMinNeg' in opts).toBe(false)
    expect('calMaxNeg' in opts).toBe(false)
    expect('colormapType' in opts).toBe(false)
    expect('opacity' in opts).toBe(false)
    expect('isColorbarVisible' in opts).toBe(false)
  })

  test('forwardsDefinedFields', () => {
    const v: NVDocumentVolume = {
      url: 'brain.nii.gz',
      colormapNegative: 'winter',
      calMin: 30,
      calMax: 80,
      calMinNeg: -80,
      calMaxNeg: -30,
      colormapType: 1,
      isTransparentBelowCalMin: false,
      modulateAlpha: 1,
    }
    const opts = urlVolumeOptions(v)
    expect(opts.calMin).toBe(30)
    expect(opts.calMax).toBe(80)
    expect(opts.calMinNeg).toBe(-80)
    expect(opts.calMaxNeg).toBe(-30)
    expect(opts.colormapNegative).toBe('winter')
    expect(opts.colormapType).toBe(1)
    expect(opts.isTransparentBelowCalMin).toBe(false)
    expect(opts.modulateAlpha).toBe(1)
  })

  test('keepsFalsyButDefinedValues', () => {
    // 0 / false are defined and must be forwarded — a naive truthy check would
    // wrongly drop `calMin: 0` (a valid window minimum).
    const opts = urlVolumeOptions({
      url: 'x.nii.gz',
      opacity: 0,
      calMin: 0,
      isColorbarVisible: false,
    })
    expect(opts.opacity).toBe(0)
    expect(opts.calMin).toBe(0)
    expect(opts.isColorbarVisible).toBe(false)
  })

  test('throwsWithoutUrl', () => {
    expect(() => urlVolumeOptions({ name: 'no-url' })).toThrow()
  })
})
