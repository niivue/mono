import { expect, test } from 'bun:test'
import type { OhifDisplaySet } from './ohif-types'
import type { SliceFrames } from './sliceFrames'
import { stackPosition, studyDateLabel } from './viewportOverlay'

test('study date reads as OHIF shows it', () => {
  expect(studyDateLabel('20140522')).toBe('22-May-2014')
  expect(studyDateLabel(undefined)).toBeUndefined()
})

test('the stack position comes from the source frame, not the NiiVue slice', () => {
  // Acquired head-first, so instance 1 is the most superior slice; NiiVue's
  // RAS volume puts it last. Slice k = dot(LPS - origin, normal).
  const ds = {
    instances: [
      { SOPInstanceUID: 'top', InstanceNumber: 1 },
      { SOPInstanceUID: 'mid', InstanceNumber: 2 },
      { SOPInstanceUID: 'bot', InstanceNumber: 3 },
    ],
  } as unknown as OhifDisplaySet
  const sf: SliceFrames = {
    origin: [0, 0, 0],
    normal: [0, 0, 1],
    frames: [
      { SOPInstanceUID: 'bot', frameNumber: 1 },
      { SOPInstanceUID: 'mid', frameNumber: 1 },
      { SOPInstanceUID: 'top', frameNumber: 1 },
    ],
  }
  expect(stackPosition(ds, sf, [0, 0, 2])).toEqual({
    instanceNumber: 1,
    index: 1,
    total: 3,
  })
  expect(stackPosition(ds, sf, [0, 0, 0])).toEqual({
    instanceNumber: 3,
    index: 3,
    total: 3,
  })
  // A volume viewport counts along the volume (cornerstone's volume order).
  expect(stackPosition(ds, sf, [0, 0, 2], true)).toEqual({
    instanceNumber: 1,
    index: 3,
    total: 3,
  })
  // Between slices (a reformat or off-plane point): no stack position.
  expect(stackPosition(ds, sf, [0, 0, 0.5])).toBeUndefined()
})

test('the stack counts only the instances the shown output holds', () => {
  // Coronal + sagittal localizers in one series; the pane shows only sag.
  const ds = {
    instances: [
      { SOPInstanceUID: 'cor', InstanceNumber: 1 },
      { SOPInstanceUID: 'sag', InstanceNumber: 2 },
    ],
  } as unknown as OhifDisplaySet
  const sf: SliceFrames = {
    origin: [0, 0, 0],
    normal: [0, 0, 1],
    frames: [{ SOPInstanceUID: 'sag', frameNumber: 1 }],
  }
  expect(stackPosition(ds, sf, [0, 0, 0])).toEqual({
    instanceNumber: 2,
    index: 1,
    total: 1,
  })
})
