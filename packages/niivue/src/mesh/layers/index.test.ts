import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadLayerFromUrl } from './index'

// A non-label FreeSurfer INT32 volume (version 1, not a label file name).
// Max and sum are its big-endian int32 values (see mgh.test.ts).
const MGZ = join(
  import.meta.dir,
  '../../../../dev-images/images/volumes/fs',
  'brainmask-int.mgz',
)

describe('loadLayerFromUrl', () => {
  // Issue #427: the volume-format layer path called mgh.read without a name,
  // and mgh's label check ran filename.includes on undefined. The raw INT32
  // buffer was also read as float32 bits instead of converted.
  test('readsAnMgzLayerThatIsNotALabelVolume', async () => {
    const file = new File([readFileSync(MGZ)], 'brainmask-int.mgz')
    const nVert = 256 * 256 * 256
    const layer = await loadLayerFromUrl(file, nVert)
    expect(layer.values.length).toBe(nVert)
    expect(layer.nFrame4D).toBe(1)
    let max = Number.NEGATIVE_INFINITY
    let sum = 0
    for (const v of layer.values) {
      if (v > max) max = v
      sum += v
    }
    expect(max).toBe(250)
    expect(sum).toBe(109423756)
  })
})
