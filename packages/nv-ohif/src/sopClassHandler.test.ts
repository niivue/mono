import { describe, expect, it } from 'bun:test'
import {
  getNiivueSopClassHandlerModule,
  NIIVUE_SOP_CLASS_HANDLER_ID,
} from './sopClassHandler'

const SM_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.77.1.6'

function handler() {
  const entry = getNiivueSopClassHandlerModule()[0]
  if (!entry) throw new Error('no handler entry')
  return entry
}

describe('niivue SOP class handler', () => {
  it('claims the VL Whole Slide Microscopy Image Storage SOP class', () => {
    expect(handler().sopClassUids).toEqual([SM_SOP_CLASS])
  })

  it('returns no display sets for an empty series', () => {
    expect(handler().getDisplaySetsFromSeries([])).toEqual([])
  })

  it('builds one SM display set with aligned imageIds and no WHOLE_SLIDE viewportType', () => {
    const instances = [
      {
        imageId: 'wadors:https://h/instances/a/frames/1',
        SeriesInstanceUID: 's-1',
        StudyInstanceUID: 'st-1',
        SeriesDescription: 'HE normal',
        SeriesNumber: 2,
        SOPClassUID: SM_SOP_CLASS,
      },
      { imageId: 'wadors:https://h/instances/b/frames/1' },
    ]
    const sets = handler().getDisplaySetsFromSeries(instances)
    expect(sets).toHaveLength(1)
    const ds = sets[0]
    if (!ds) throw new Error('expected a display set')
    expect(ds.Modality).toBe('SM')
    expect(ds.SeriesInstanceUID).toBe('s-1')
    expect(ds.StudyInstanceUID).toBe('st-1')
    expect(ds.displaySetInstanceUID).toBe('s-1-niivue-wsi')
    expect(ds.SOPClassHandlerId).toBe(NIIVUE_SOP_CLASS_HANDLER_ID)
    expect(ds.imageIds).toEqual([
      'wadors:https://h/instances/a/frames/1',
      'wadors:https://h/instances/b/frames/1',
    ])
    expect(ds.instances).toHaveLength(2)
    // Must NOT force OHIF's microscopy viewport.
    expect(ds.viewportType).toBeUndefined()
  })

  it('drops instances that carry no imageId from the imageIds list', () => {
    const instances = [
      {
        imageId: 'wadors:https://h/instances/a/frames/1',
        SeriesInstanceUID: 's-2',
      },
      { SeriesInstanceUID: 's-2' },
    ]
    const ds = handler().getDisplaySetsFromSeries(instances)[0]
    expect(ds?.imageIds).toEqual(['wadors:https://h/instances/a/frames/1'])
    // Every level instance is still retained for the manifest builder.
    expect(ds?.instances).toHaveLength(2)
  })
})
