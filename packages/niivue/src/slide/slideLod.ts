import type { ByteLru } from '@/byteLru'
import type {
  NVSlide,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideScreen,
  NVSlideTileManifest,
  NVSlideViewport,
  NVSlideVisibleTile,
} from './NVSlide'
import { isMonochrome } from './slideChannels'
import type { SlideRendererBudget } from './slideFuse'
import { gutterTextureBytes } from './tileGutter'

// Safety valve for pathological manifests (e.g. a missing tileSize defaulting
// to 1px tiles): never enumerate more visible tiles than this per frame. A
// sane pyramid level never exceeds a few hundred on screen.
export const MAX_VISIBLE_TILES = 4096

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function levelTileWidth(
  manifest: NVSlideManifest,
  level: NVSlideLevelManifest,
): number {
  return level.tileWidth ?? manifest.tileSize ?? 1
}

export function levelTileHeight(
  manifest: NVSlideManifest,
  level: NVSlideLevelManifest,
): number {
  return level.tileHeight ?? manifest.tileSize ?? 1
}

export function tileAt(
  level: NVSlideLevelManifest,
  x: number,
  y: number,
): NVSlideTileManifest | null {
  if (x < 0 || y < 0 || x >= level.columns || y >= level.rows) return null
  return level.tiles[y * level.columns + x] ?? null
}

// A level holds until the device px per level px it gives moves this far past
// the target, so a zoom resting on a boundary does not flip levels each frame.
export const LOD_HYSTERESIS = 1.1

/**
 * The finest level of `levels` (finest first) giving at least `target` device
 * px per level px at `devicePxPerBasePx`, else the coarsest. `current` holds
 * while it stays within LOD_HYSTERESIS of the target. Shared by the 2D view
 * and the 3D plane (ENG-05); each projects its own `devicePxPerBasePx`.
 */
export function pickLevel(
  levels: readonly NVSlideLevelManifest[],
  devicePxPerBasePx: number,
  target: number,
  current?: NVSlideLevelManifest | null,
): NVSlideLevelManifest | null {
  const finest = (t: number) => {
    for (const level of levels)
      if (devicePxPerBasePx * level.downsample >= t) return level
    return levels[levels.length - 1] ?? null
  }
  // By manifest index, not identity: a plane switch replaces the level objects.
  const pos = current
    ? levels.findIndex((level) => level.index === current.index)
    : -1
  if (
    pos >= 0 &&
    pos >=
      levels.indexOf(finest(target / LOD_HYSTERESIS) as NVSlideLevelManifest) &&
    pos <=
      levels.indexOf(finest(target * LOD_HYSTERESIS) as NVSlideLevelManifest)
  )
    return levels[pos] ?? null
  return finest(target)
}

/**
 * The pinned level, or for 'auto' the finest level giving at least
 * `targetScreenPixelsPerTilePixel` device pixels per tile pixel (with
 * hysteresis around `current`). Pass the `screen` drawn: `viewport.scale` is
 * CSS pixels per slide pixel, so without its devicePixelRatio a 2x display
 * gets half the detail it can show.
 */
export function selectLevel(
  slide: NVSlide,
  screen?: NVSlideScreen,
  current?: NVSlideLevelManifest | null,
): NVSlideLevelManifest | null {
  const { levels } = slide.manifest
  if (typeof slide.levelChoice === 'number')
    return levels.find((level) => level.index === slide.levelChoice) ?? null
  return pickLevel(
    levels,
    slide.viewport.scale * (screen?.devicePixelRatio ?? 1),
    slide.targetScreenPixelsPerTilePixel,
    current,
  )
}

/** What bounds a level's visible tiles (NVSlideVisibleTiles.limitedBy). */
export type NVSlideCapacityLimit = 'cache' | 'texture' | 'tiles'

// Tiles of `level` that can stay decoded at once, and which budget bounds
// them. A quarter of the cache stays free for the other owners (plane3d,
// thumbnail, prefetch). `budget`: the smallest its renderers registered.
export function tileCapacity(
  manifest: NVSlideManifest,
  level: NVSlideLevelManifest,
  maxCacheBytes: number,
  samplePlanes: number | undefined,
  budget: SlideRendererBudget,
): { tiles: number; limitedBy: NVSlideCapacityLimit } {
  // Full tiles, not clipped edge extents: an upper bound, since a padded
  // edge frame is held whole until decodeTileBitmap crops it.
  // Sample tiles keep only their samples (1, 2 or 4 bytes each), one plane
  // per fetched channel; bitmap tiles 4 bytes of RGBA. Without bitsStored,
  // JPEG 2000 and JPEG-LS may decode 16-bit samples.
  const bits = level.bitsStored ?? (level.codec === 'image/jpeg' ? 8 : 16)
  const sampleBytes =
    level.sampleType === 'f32'
      ? 4
      : level.sampleType === 'i16'
        ? 2
        : bits > 16
          ? 4
          : bits > 8
            ? 2
            : 1
  // A grey JPEG stays an RGBA bitmap without OffscreenCanvas (decodeTileBitmap).
  const greyBitmap =
    level.codec === 'image/jpeg' && typeof OffscreenCanvas === 'undefined'
  const planes = samplePlanes ?? (isMonochrome(level) && !greyBitmap ? 1 : 0)
  const pixelBytes = planes ? planes * sampleBytes : 4
  const tw = levelTileWidth(manifest, level)
  const th = levelTileHeight(manifest, level)
  // Every tile in view is also an RGBA8 texture its renderer cannot evict:
  // cap by the texture budget too, less the raw pool for scalar tiles.
  const textureBytes = Math.max(
    0,
    budget.tileBytes - (planes ? budget.rawPoolBytes : 0),
  )
  const cache = Math.floor((0.75 * maxCacheBytes) / (tw * th * pixelBytes))
  const texture = Math.floor((0.75 * textureBytes) / gutterTextureBytes(tw, th))
  if (MAX_VISIBLE_TILES <= cache && MAX_VISIBLE_TILES <= texture)
    return { tiles: MAX_VISIBLE_TILES, limitedBy: 'tiles' }
  return cache <= texture
    ? { tiles: cache, limitedBy: 'cache' }
    : { tiles: texture, limitedBy: 'texture' }
}

/**
 * Cached tiles from the levels coarser than `target` that cover the viewport
 * (`walk` lists a level's tiles in view),
 * coarsest first, for the renderer to paint under the target. Empty when
 * every target tile is resident (the steady state) or `target` is the
 * coarsest level. Bounded: levels coarser than the first one fully resident
 * in view are skipped (it hides them), as are levels that cannot be resident.
 */
export function fallbackTiles(
  slide: NVSlide,
  target: NVSlideLevelManifest,
  tiles: readonly NVSlideVisibleTile[],
  cache: Pick<ByteLru<string, unknown>, 'has'>,
  walk: (level: NVSlideLevelManifest) => NVSlideVisibleTile[] | null,
): NVSlideVisibleTile[] {
  let missing = false
  for (const item of tiles) {
    if (!cache.has(item.key)) {
      missing = true
      break
    }
  }
  if (!missing) return []
  const levels = slide.manifest.levels
  // Position in the array, not `level.index`: `selectLevel` walks the array
  // finest-to-coarsest and a manifest may number its levels however it likes.
  const targetPos = levels.indexOf(target)
  if (targetPos < 0) return []
  const layers: NVSlideVisibleTile[][] = []
  for (let pos = targetPos + 1; pos < levels.length; pos++) {
    // null: the level cannot be resident in view (too many tiles).
    const all = walk(levels[pos] as NVSlideLevelManifest)
    if (!all) continue
    // Only what is ALREADY decoded: the fallback layer never issues a fetch.
    const resident = all.filter((item) => cache.has(item.key))
    if (resident.length) layers.push(resident)
    if (resident.length === all.length) break
  }
  return layers.reverse().flat()
}

/** A level's tile columns/rows covering the viewport, and the view geometry. */
export type TileSpan = ReturnType<typeof tileSpan>

/** The tile columns/rows of one level covering the viewport, and the view geometry. */
export function tileSpan(
  manifest: NVSlideManifest,
  viewport: NVSlideViewport,
  level: NVSlideLevelManifest,
  screen: NVSlideScreen,
) {
  const viewLeft = viewport.centerX - screen.widthCss / (2 * viewport.scale)
  const viewTop = viewport.centerY - screen.heightCss / (2 * viewport.scale)
  const viewRight = viewport.centerX + screen.widthCss / (2 * viewport.scale)
  const viewBottom = viewport.centerY + screen.heightCss / (2 * viewport.scale)
  // Map level pixels <-> base pixels by each level's ACTUAL per-axis scale
  // (base / level dims), not the nominal `downsample`. When a pyramid level's
  // dimensions are not an exact `base / 2^L` (rounding), `level.width *
  // downsample != base width`, so a downsample-based mapping places the level's
  // tiles over a slightly different base extent than the true [0, base] the
  // drawing overlay (screenToSlide/slideToCss) uses — and the offset changes at
  // each LOD boundary, so annotations appear to jump when zooming across a
  // level. Using the exact scale makes every level cover exactly [0, base], so
  // tiles register with each other and with slide-space drawings across zoom.
  // It is also what lets a coarse fallback tile sit exactly under the target
  // tiles it stands in for.
  const dsX = level.width > 0 ? manifest.width / level.width : level.downsample
  const dsY =
    level.height > 0 ? manifest.height / level.height : level.downsample
  const levelLeft = Math.floor(viewLeft / dsX)
  const levelTop = Math.floor(viewTop / dsY)
  const levelRight = Math.ceil(viewRight / dsX)
  const levelBottom = Math.ceil(viewBottom / dsY)
  const tileWidth = levelTileWidth(manifest, level)
  const tileHeight = levelTileHeight(manifest, level)
  const firstX = clamp(Math.floor(levelLeft / tileWidth), 0, level.columns - 1)
  const firstY = clamp(Math.floor(levelTop / tileHeight), 0, level.rows - 1)
  const lastX = clamp(
    Math.floor((levelRight - 1) / tileWidth),
    0,
    level.columns - 1,
  )
  const lastY = clamp(
    Math.floor((levelBottom - 1) / tileHeight),
    0,
    level.rows - 1,
  )
  const count = (lastX - firstX + 1) * (lastY - firstY + 1)
  return {
    ...{ firstX, lastX, firstY, lastY, count },
    ...{ dsX, dsY, tileWidth, tileHeight, viewLeft, viewTop, viewBottom },
  }
}

/** The centred block of at most `limit` cells of inclusive cell range `span`, shaped like it. */
export function centredBlock(
  span: { firstX: number; lastX: number; firstY: number; lastY: number },
  limit: number,
) {
  const spanW = span.lastX - span.firstX + 1
  const spanH = span.lastY - span.firstY + 1
  // w <= limit keeps w * h <= limit when the span is a single row (#666).
  const w = clamp(
    Math.floor(Math.sqrt((limit * spanW) / spanH)),
    1,
    Math.min(spanW, limit),
  )
  const h = clamp(Math.floor(limit / w), 1, spanH)
  const firstX = span.firstX + Math.floor((spanW - w) / 2)
  const firstY = span.firstY + Math.floor((spanH - h) / 2)
  return { firstX, lastX: firstX + w - 1, firstY, lastY: firstY + h - 1 }
}

/**
 * The tiles of one pyramid level covering the current viewport, or when more
 * than `limit` do, the centred block of at most `limit` shaped like the view.
 */
export function tilesForLevel(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  screen: NVSlideScreen,
  limit = MAX_VISIBLE_TILES,
  span = tileSpan(slide.manifest, slide.viewport, level, screen),
): NVSlideVisibleTile[] {
  const dpr = screen.devicePixelRatio ?? 1
  const { firstX, lastX, firstY, lastY } =
    span.count > limit ? centredBlock(span, limit) : span
  const { dsX, dsY } = span
  const { tileWidth, tileHeight, viewLeft, viewTop, viewBottom } = span
  const screenScale = slide.viewport.scale * dpr
  const flipY = slide.isYAxisUp()
  const tiles: NVSlideVisibleTile[] = []
  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      const tile = tileAt(level, x, y)
      if (!tile) continue
      const baseX = tile.x * tileWidth * dsX
      const baseY = tile.y * tileHeight * dsY
      const baseWidth = tile.width * dsX
      const baseHeight = tile.height * dsY
      const screenY = flipY
        ? (viewBottom - (baseY + baseHeight)) * screenScale
        : (baseY - viewTop) * screenScale
      tiles.push({
        slide,
        level,
        tile,
        key: slide.tileKey(level, tile),
        screenX: (baseX - viewLeft) * screenScale,
        screenY,
        screenWidth: baseWidth * screenScale,
        screenHeight: baseHeight * screenScale,
        flipY,
      })
    }
  }
  return tiles
}
