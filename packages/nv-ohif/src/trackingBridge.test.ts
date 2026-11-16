import { expect, test } from 'bun:test'
import { forwardMeasurement } from './trackingBridge'

test('the active pane forwards a new measurement to OHIF tracking', () => {
  const sent: unknown[] = []
  const send = (event: string, payload: Record<string, unknown>) =>
    sent.push([event, payload])
  const m = {
    uid: 'm1',
    toolName: 'Length',
    referenceStudyUID: 'st',
    referenceSeriesUID: 'se',
  }
  forwardMeasurement(send, 'other', 'vp', m)
  forwardMeasurement(undefined, 'vp', 'vp', m)
  expect(sent).toEqual([])
  forwardMeasurement(send, 'vp', 'vp', m)
  expect(sent).toEqual([
    ['SET_DIRTY', { SeriesInstanceUID: 'se' }],
    [
      'TRACK_SERIES',
      {
        viewportId: 'vp',
        StudyInstanceUID: 'st',
        SeriesInstanceUID: 'se',
        measurementId: 'm1',
        toolName: 'Length',
      },
    ],
  ])
})
