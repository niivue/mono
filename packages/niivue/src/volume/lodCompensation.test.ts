import { expect, test } from 'bun:test'
import NiiVue, { chunkVolumeMultiLOD } from '@/index'
import { captureWarnings, devImageUrl } from '@/testing/headless'

// nv.lodCompensation() exists because both LOD compensation settings are
// exact no-ops on anything that is not a multi-LOD chunked volume, with
// nothing on screen to say so. These pin the two answers that matter: the
// inactive case names its reason, and the active case reports the SAME
// numbers the shader is given. The report's `floor` comes from an attached
// view, so it is null throughout here.

const HIPPO = devImageUrl('volumes/hippo.nii.gz')
const LEVEL_DIMS: [number, number, number][] = [
  [256, 256, 256],
  [128, 128, 128],
  [64, 64, 64],
]

/** A real multi-LOD plan, assigned directly: the report reads plan.levelDims
 *  and each chunk's sourceLevel, exactly what the renderer reads. */
async function withPlan(): Promise<NiiVue> {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: HIPPO }])
  nv.volumes[0].chunkPlan = chunkVolumeMultiLOD(
    LEVEL_DIMS,
    { center: [128, 128, 128], radius: 4 },
    256,
    { cellEdge: 16 },
  )
  return nv
}

test('reports inactive, with a reason, before a volume is loaded', () => {
  const r = new NiiVue({ backend: 'webgl2' }).lodCompensation()
  expect(r.isActive).toBe(false)
  expect(r.inactiveReason).toBe('no volume is loaded')
  expect(r.levels).toEqual([])
  expect(r.floor).toBe(null)
})

test('names an ordinary volume as the reason it is doing nothing', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes([{ url: HIPPO }])
  const warnings = captureWarnings()
  nv.volumeLodBrightnessCompensation = 0.05
  warnings.restore()
  const r = nv.lodCompensation()
  expect(warnings.messages.join('\n')).toContain('has no effect')
  expect(r.isActive).toBe(false)
  expect(r.inactiveReason).toBe('volume 0 is not a chunked volume')
  // The setting still round-trips; it just reaches nothing.
  expect(r.brightnessCompensation).toBeCloseTo(0.05, 10)
})

test('reports per-level downsample, brick counts and shader numbers', async () => {
  const nv = await withPlan()
  nv.volumeLodBrightnessCompensation = 0.1
  nv.volumeLodOpacityCompensation = 0.25
  const r = nv.lodCompensation()

  expect(r.isActive).toBe(true)
  expect(r.inactiveReason).toBe(null)
  expect(r.levels.length).toBe(3)

  const [fine, mid, coarse] = r.levels
  expect(fine.level).toBe(0)
  expect(fine.downsample).toBeCloseTo(1, 10)
  // The finest level is uncompensated by definition, whatever the coefficients.
  expect(fine.brightnessExponent).toBe(1)
  expect(fine.opacityScale).toBe(1)

  expect(mid.downsample).toBeCloseTo(2, 10)
  expect(mid.brightnessExponent).toBeCloseTo(1 - 0.1 * 1, 10)
  expect(mid.opacityScale).toBeCloseTo(1 + 0.25 * 1, 10)

  expect(coarse.downsample).toBeCloseTo(4, 10)
  // Brightness grows per pyramid level (log2 of the downsample); opacity is linear.
  expect(coarse.brightnessExponent).toBeCloseTo(1 - 0.1 * Math.log2(4), 10)
  expect(coarse.opacityScale).toBeCloseTo(1 + 0.25 * 3, 10)

  // Every brick in the plan is accounted for by exactly one level.
  const counted = r.levels.reduce((sum, l) => sum + l.brickCount, 0)
  expect(counted).toBeGreaterThan(0)
  expect(r.levels.some((l) => l.brickCount > 0 && l.downsample > 1)).toBe(true)
})

test('zeroed coefficients read as inactive even with a coarse level drawn', async () => {
  const nv = await withPlan()
  nv.volumeLodBrightnessCompensation = 0
  nv.volumeLodOpacityCompensation = 0
  const r = nv.lodCompensation()
  expect(r.isActive).toBe(false)
  expect(r.inactiveReason).toBe('both coefficients are 0')
})

test('both coefficients accept the same range', () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.volumeLodBrightnessCompensation = 0.5
  nv.volumeLodOpacityCompensation = 0.5
  // A value copied from one knob into the other must not silently clamp.
  expect(nv.volumeLodBrightnessCompensation).toBeCloseTo(0.5, 10)
  expect(nv.volumeLodOpacityCompensation).toBeCloseTo(0.5, 10)
  nv.volumeLodBrightnessCompensation = 5
  nv.volumeLodOpacityCompensation = 5
  expect(nv.volumeLodBrightnessCompensation).toBe(1)
  expect(nv.volumeLodOpacityCompensation).toBe(1)
})
