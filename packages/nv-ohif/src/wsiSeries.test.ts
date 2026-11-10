import { describe, expect, it } from 'bun:test'
import { wsiSeriesSlide } from './wsiSeries'

// nv-ext-tile's DICOM-WSI fixtures, as PS3.18 DICOM JSON.
const DIR = `${import.meta.dir}/../../nv-ext-tile/fixtures/dicom-wsi`
const instance = async (name: string): Promise<Record<string, unknown>> => ({
  ...(await Bun.file(`${DIR}/${name}.json`).json()),
  imageId: 'wadors:https://h/dicomweb/studies/1/series/2/instances/3/frames/1',
})

describe('wsiSeriesSlide', () => {
  it('returns the slide and its series URL', async () => {
    const r = wsiSeriesSlide({ instances: [await instance('bot')] })
    expect('slide' in r && r.seriesUrl).toBe(
      'https://h/dicomweb/studies/1/series/2',
    )
  })

  it('refuses several optical paths rather than showing the first', async () => {
    const r = wsiSeriesSlide({ instances: [await instance('paths')] })
    expect('note' in r && r.note).toContain('2 optical paths')
  })

  it('refuses several focal planes rather than showing the first', async () => {
    const r = wsiSeriesSlide({ instances: [await instance('planes')] })
    expect('note' in r && r.note).toContain('2 focal planes')
  })

  it('takes the series URL past a side image that names no series', async () => {
    const r = wsiSeriesSlide({
      instances: [
        { imageId: 'wadouri:https://h/side.dcm' },
        await instance('bot'),
      ],
    })
    expect('slide' in r && r.seriesUrl).toBe(
      'https://h/dicomweb/studies/1/series/2',
    )
  })

  it('notes imageIds that name no WADO-RS series', async () => {
    const r = wsiSeriesSlide({
      instances: [{ ...(await instance('bot')), imageId: 'wadouri:x.dcm' }],
    })
    expect('note' in r && r.note).toContain('WADO-RS series')
  })

  it('notes a series without tiled levels', () => {
    const r = wsiSeriesSlide({ instances: [] })
    expect('note' in r && r.note).toContain('no tiled (VOLUME) pyramid levels')
  })
})
