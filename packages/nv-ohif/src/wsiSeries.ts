import {
  type DicomJsonSlide,
  indexDicomWsiMetadata,
} from '@niivue/nv-ext-tile/dicom'
import { seriesUrlFromImageId } from './dicomWadoRs'
import type { OhifDisplaySet } from './ohif-types'

/** The one slide an SM display set shows and its WADO-RS series URL, or a note saying why there is none. */
export function wsiSeriesSlide(
  ds: OhifDisplaySet,
): { slide: DicomJsonSlide; seriesUrl: string } | { note: string } {
  // TILED_FULL and TILED_SPARSE alike: the index places each frame.
  const instances = ds.instances ?? []
  const { slides, skipped } = indexDicomWsiMetadata(instances)
  // The first id naming a series: a skipped side image may come first.
  const seriesUrl =
    [...instances.map((i) => i.imageId), ...(ds.imageIds ?? [])]
      .filter((id): id is string => typeof id === 'string')
      .map(seriesUrlFromImageId)
      .find((url) => url !== null) ?? null
  const slide = slides[0]
  if (!slide) {
    const why = skipped[0]?.message
    return {
      note: `This slide has no tiled (VOLUME) pyramid levels to display${why ? ` (${why})` : ''}.`,
    }
  }
  if (!seriesUrl)
    return { note: "This slide's imageIds do not name a WADO-RS series." }
  // The index makes each optical path and focal plane its own slide; showing
  // the first alone would pass for the whole series.
  if (slides.length > 1) {
    const paths = new Set(slides.map((s) => s.opticalPath)).size
    const planes = new Set(slides.map((s) => s.focalPlane)).size
    return {
      note:
        paths > 1 || planes > 1
          ? `This slide has ${paths} optical paths and ${planes} focal planes; slides with more than one of either cannot be shown yet.`
          : `This series holds ${slides.length} slides; a series with more than one cannot be shown yet.`,
    }
  }
  return { slide, seriesUrl }
}

interface BulkDataSource {
  retrieve?: {
    bulkDataURI?: (options: {
      StudyInstanceUID?: string
      BulkDataURI: string
    }) => Promise<ArrayBuffer | undefined>
  }
}

/**
 * DicomWebWsiSource's `retrieveBulkData` backed by the OHIF data source, so the
 * host's auth and client config apply; undefined when the data source has no
 * `retrieve.bulkDataURI`. OHIF takes no AbortSignal or byte cap: an abort
 * rejects at once but the download runs on, and the 64 MB cap applies after it.
 * DicomWebWsiSource calls it only for URLs on the series' origin, so the
 * host's auth never reaches another server. With `singlepart`
 * including `bulkdata`, OHIF resolves undefined and the source fetches itself.
 */
export function wsiRetrieveBulkData(
  dataSource: unknown,
  StudyInstanceUID: string | undefined,
):
  | ((url: string, signal?: AbortSignal) => Promise<ArrayBuffer | undefined>)
  | undefined {
  const retrieve = (dataSource as BulkDataSource | undefined)?.retrieve
  const bulkDataURI = retrieve?.bulkDataURI
  if (typeof bulkDataURI !== 'function') return undefined
  return async (BulkDataURI, signal) => {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      bulkDataURI
        .call(retrieve, { StudyInstanceUID, BulkDataURI })
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener('abort', onAbort))
    })
  }
}
