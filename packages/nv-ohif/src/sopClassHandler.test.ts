import { afterEach, describe, expect, it, spyOn } from 'bun:test'
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

describe('WSI thumbnail cache', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function thumbnailGetter(seriesUID = 's-1') {
    const ds = handler().getDisplaySetsFromSeries([
      {
        imageId: `wadors:https://h/instances/${seriesUID}/frames/1`,
        SeriesInstanceUID: seriesUID,
      },
    ])[0]
    if (!ds?.getThumbnailSrc) throw new Error('expected thumbnail getter')
    return ds.getThumbnailSrc
  }

  function jpegResponse() {
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { 'Content-Type': 'image/jpeg' },
    })
  }

  it('shares concurrent work and reuses a successful result only within its display set', async () => {
    const response = Promise.withResolvers<Response>()
    const fetch = spyOn(globalThis, 'fetch').mockReturnValue(response.promise)
    const getThumbnail = thumbnailGetter()
    const first = getThumbnail()
    const second = getThumbnail()
    expect(second).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)
    response.resolve(jpegResponse())
    const src = await first
    expect(src).toStartWith('data:image/jpeg;base64,')
    expect(await second).toBe(src)
    expect(getThumbnail()).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockResolvedValue(jpegResponse())
    expect(await thumbnailGetter('s-2')()).toBe(src)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    'http',
    'network',
  ])('retries a %s failure and shares the retry', async (failure) => {
    const fetch = spyOn(globalThis, 'fetch')
    if (failure === 'http')
      fetch.mockResolvedValueOnce(new Response(null, { status: 503 }))
    else fetch.mockRejectedValueOnce(new Error('network unavailable'))
    const getThumbnail = thumbnailGetter()
    expect(await getThumbnail()).toBeNull()
    fetch.mockResolvedValueOnce(jpegResponse())
    const retry = getThumbnail()
    expect(getThumbnail()).toBe(retry)
    expect(await retry).toStartWith('data:image/jpeg;base64,')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('does not start work for a caller that is already aborted', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(jpegResponse())
    const getThumbnail = thumbnailGetter()
    expect(await getThumbnail({ signal: AbortSignal.abort() })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    expect(await getThumbnail()).toStartWith('data:image/jpeg;base64,')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels one waiter without cancelling another or discarding the cached result', async () => {
    const response = Promise.withResolvers<Response>()
    const fetch = spyOn(globalThis, 'fetch').mockReturnValue(response.promise)
    const getThumbnail = thumbnailGetter()
    const cancelled = new AbortController()
    const active = new AbortController()
    const removeListener = spyOn(active.signal, 'removeEventListener')
    const first = getThumbnail({ signal: cancelled.signal })
    const second = getThumbnail({ signal: active.signal })
    cancelled.abort()
    expect(await first).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeUndefined()
    response.resolve(jpegResponse())
    const src = await second
    expect(src).toStartWith('data:image/jpeg;base64,')
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(await getThumbnail()).toBe(src)
    expect(fetch).toHaveBeenCalledTimes(1)
    removeListener.mockRestore()
  })

  it('lets a later caller join shared work after all earlier waiters cancel', async () => {
    const response = Promise.withResolvers<Response>()
    const fetch = spyOn(globalThis, 'fetch').mockReturnValue(response.promise)
    const getThumbnail = thumbnailGetter()
    const controller = new AbortController()
    const first = getThumbnail({ signal: controller.signal })
    controller.abort()
    expect(await first).toBeNull()
    const later = getThumbnail()
    response.resolve(jpegResponse())
    expect(await later).toStartWith('data:image/jpeg;base64,')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
