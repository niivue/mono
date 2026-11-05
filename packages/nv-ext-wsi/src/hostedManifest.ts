import type {
  NVSlideManifest,
  NVSlideTileFragment,
  NVSlideTileManifest,
} from '@niivue/niivue'
import type { SlideIndexInstance, SlideIndexSlide } from './dicomIndex'
import { fileKey, manifestOf } from './dicomWsiSource'

/**
 * A `dicom-wsi-range-v1` manifest for hosting one indexed slide: NVSlide reads
 * each tile by HTTP Range from `fileUrlFor(instance)`. `files` are the indexed
 * files; each frame's item header is read to split multi-fragment frames.
 * Sparse levels list only their present tiles; a level split across files
 * (a concatenation) names each tile's file.
 */
export async function manifestFromIndex(
  slide: SlideIndexSlide,
  files: readonly File[],
  fileUrlFor: (instance: SlideIndexInstance) => string,
): Promise<NVSlideManifest> {
  const byKey = new Map(files.map((f) => [fileKey(f), f]))
  const fileOf = (instance: SlideIndexInstance): File => {
    const file = byKey.get(instance.file)
    if (!file) throw new Error(`${instance.file} is not among the files`)
    return file
  }
  const manifest = manifestOf(slide)
  for (const [i, level] of manifest.levels.entries()) {
    const indexed = slide.levels[i]
    if (!indexed) continue
    const { frames } = indexed
    const split = indexed.instances.length > 1
    if (!split)
      level.fileUrl = fileUrlFor(
        slide.instances[indexed.instances[0] as number] as SlideIndexInstance,
      )
    const tiles: NVSlideTileManifest[] = []
    for (const t of level.tiles) {
      if (!t) continue
      const slot = t.frame as number
      const instance = slide.instances[
        frames.instance[slot] as number
      ] as SlideIndexInstance
      const ranges = await frameRanges(
        fileOf(instance),
        frames.offset[slot] as number,
        frames.length[slot] as number,
      )
      tiles.push({
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        frame: frames.frame[slot] as number,
        ...ranges,
        ...(split ? { fileUrl: fileUrlFor(instance) } : {}),
      })
    }
    level.tiles = tiles
  }
  manifest.format = 'dicom-wsi-range-v1'
  const l0 = slide.levels[0]
  if (manifest.iccProfile && l0)
    manifest.iccProfile.url = fileUrlFor(
      slide.instances[l0.instances[0] as number] as SlideIndexInstance,
    )
  return manifest
}

/** One frame's byte ranges: the whole span, or its fragments without item headers. */
async function frameRanges(
  file: File,
  offset: number,
  length: number,
): Promise<
  { offset: number; length: number } | { fragments: NVSlideTileFragment[] }
> {
  const head = new DataView(await file.slice(offset - 8, offset).arrayBuffer())
  if (head.getUint32(0, true) !== 0xe000fffe)
    throw new Error(`${file.name}: no item at byte ${offset - 8}`)
  if (head.getUint32(4, true) === length) return { offset, length }
  const span = new DataView(
    await file.slice(offset - 8, offset + length).arrayBuffer(),
  )
  const fragments: NVSlideTileFragment[] = []
  for (let p = 0; p < span.byteLength; ) {
    if (span.getUint32(p, true) !== 0xe000fffe)
      throw new Error(
        `${file.name}: no fragment item at byte ${offset - 8 + p}`,
      )
    const n = span.getUint32(p + 4, true)
    fragments.push({ offset: offset + p, length: n })
    p += 8 + n
  }
  return { fragments }
}
