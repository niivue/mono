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
