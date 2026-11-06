import type {
  NVSlideManifest,
  NVSlideTileFragment,
  NVSlideTileManifest,
} from '@niivue/niivue'
import type {
  SlideIndexInstance,
  SlideIndexLevel,
  SlideIndexSlide,
} from './dicomIndex'
import { tileMap } from './dicomIndex'
import { filesFor, fragmentsOf, manifestOf } from './dicomWsiSource'

/**
 * A `dicom-wsi-range-v1` manifest for hosting one indexed slide: NVSlide reads
 * each tile by HTTP Range from `fileUrlFor(instance)`. `files` are the indexed
 * files; each frame's span is read to split multi-fragment frames.
 * Sparse levels list only their present tiles; a level split across files
 * (a concatenation) names each tile's file.
 */
export async function manifestFromIndex(
  slide: SlideIndexSlide,
  files: readonly File[],
  fileUrlFor: (instance: SlideIndexInstance) => string,
): Promise<NVSlideManifest> {
  const byInstance = filesFor(slide, files)
  const maps = slide.levels.map(tileMap)
  const manifest = manifestOf(slide, maps, {
    format: 'dicom-wsi-range-v1',
    fileUrl: fileUrlFor,
  })
  for (const [i, level] of manifest.levels.entries()) {
    // manifestOf builds one manifest level per indexed level.
    const indexed = slide.levels[i] as SlideIndexLevel
    const { frames } = indexed
    const split = indexed.instances.length > 1
    if (!split)
      level.fileUrl = fileUrlFor(
        slide.instances[indexed.instances[0] as number] as SlideIndexInstance,
      )
    const tiles: NVSlideTileManifest[] = []
    // manifestOf lays level.tiles out like the map: one entry per tile.
    for (const [ti, slot] of (maps[i] as Int32Array).entries()) {
      if (slot < 0) continue
      const t = level.tiles[ti] as NVSlideTileManifest
      const k = frames.instance[slot] as number
      const ranges = await frameRanges(
        byInstance[k] as File,
        frames.offset[slot] as number,
        frames.length[slot] as number,
      )
      tiles.push({
        ...t,
        ...ranges,
        ...(split
          ? { fileUrl: fileUrlFor(slide.instances[k] as SlideIndexInstance) }
          : {}),
      })
    }
    level.tiles = tiles
  }
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
  // Most frames are one fragment: its item header alone proves it, without reading the tile.
  const head = new Uint8Array(
    await file.slice(offset - 8, offset).arrayBuffer(),
  )
  const what = `${file.name} at byte ${offset - 8}`
  const dv = new DataView(head.buffer)
  if (dv.getUint32(4, true) === length) {
    if (dv.getUint32(0, true) !== 0xe000fffe)
      throw new Error(`${what}: no item where the index says`)
    return { offset, length }
  }
  const span = new Uint8Array(
    await file.slice(offset - 8, offset + length).arrayBuffer(),
  )
  const parts = fragmentsOf(span, what)
  return {
    fragments: parts.map((p) => ({
      offset: offset - 8 + p.offset,
      length: p.length,
    })),
  }
}
