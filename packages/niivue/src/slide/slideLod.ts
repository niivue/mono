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
import type { NVSlideTileCache } from './tileLru'

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

/**
 * The pinned level, or for 'auto' the finest level giving at least
 * `targetScreenPixelsPerTilePixel` device pixels per tile pixel. Pass the
 * `screen` drawn: `viewport.scale` is CSS pixels per slide pixel, so without
 * its devicePixelRatio a 2x display gets half the detail it can show.
 */
export function selectLevel(
  slide: NVSlide,
  screen?: NVSlideScreen,
): NVSlideLevelManifest | null {
  if (typeof slide.levelChoice === 'number') {
    return (
      slide.manifest.levels.find(
        (level) => level.index === slide.levelChoice,
      ) ?? null
    )
  }
  const devicePixelsPerSlidePixel =
    slide.viewport.scale * (screen?.devicePixelRatio ?? 1)
  for (const level of slide.manifest.levels) {
    if (
      devicePixelsPerSlidePixel * level.downsample >=
      slide.targetScreenPixelsPerTilePixel
    ) {
      return level
    }
  }
  return slide.manifest.levels[slide.manifest.levels.length - 1] ?? null
}

// Tiles of `level` that can stay decoded at once. A quarter of the cache
// stays free for the coarse fallback layer and for requestTile() users (the
// wand, the 3D slide plane). `budget`: the smallest its renderers registered.
export function tileCapacity(
  manifest: NVSlideManifest,
  level: NVSlideLevelManifest,
  maxCacheBytes: number,
  samplePlanes: number | undefined,
  budget: SlideRendererBudget,
): number {
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
  return Math.min(
    MAX_VISIBLE_TILES,
    Math.floor((0.75 * maxCacheBytes) / (tw * th * pixelBytes)),
    Math.floor((0.75 * textureBytes) / gutterTextureBytes(tw, th)),
  )
}

/**
 * Cached tiles from every level coarser than `target` that covers the
 * viewport, coarsest first. Empty when every target tile is already cached
 * (the steady state) or when `target` is the coarsest level.
 */
export function fallbackTiles(
  slide: NVSlide,
  target: NVSlideLevelManifest,
  tiles: readonly NVSlideVisibleTile[],
  screen: NVSlideScreen,
  cache: Pick<NVSlideTileCache, 'has'>,
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
  const out: NVSlideVisibleTile[] = []
  for (let pos = levels.length - 1; pos > targetPos; pos--) {
    const coarse = levels[pos]
    if (!coarse) continue
    for (const item of tilesForLevel(slide, coarse, screen)) {
      // Only what is ALREADY decoded: the fallback layer never issues a
      // fetch, so it cannot compete with the target level for the load slots
      // that will actually retire it.
      if (cache.has(item.key)) out.push(item)
    }
  }
  return out
}

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

/**
 * The tiles of one pyramid level covering the current viewport, or when more
 * than `limit` do, the centred block of at most `limit` shaped like the view.
 */
export function tilesForLevel(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  screen: NVSlideScreen,
  limit = MAX_VISIBLE_TILES,
): NVSlideVisibleTile[] {
  const dpr = screen.devicePixelRatio ?? 1
  const span = tileSpan(slide.manifest, slide.viewport, level, screen)
  let { firstX, lastX, firstY, lastY } = span
  if (span.count > limit) {
    const spanW = lastX - firstX + 1
    const spanH = lastY - firstY + 1
    // w <= limit keeps w * h <= limit when the span is a single row (#666).
    const w = clamp(
      Math.floor(Math.sqrt((limit * spanW) / spanH)),
      1,
      Math.min(spanW, limit),
    )
    const h = clamp(Math.floor(limit / w), 1, spanH)
    firstX += Math.floor((spanW - w) / 2)
    firstY += Math.floor((spanH - h) / 2)
    lastX = firstX + w - 1
    lastY = firstY + h - 1
  }
  const { dsX, dsY } = span
  const { tileWidth, tileHeight, viewLeft, viewTop, viewBottom } = span
  const screenScale = slide.viewport.scale * dpr
  const tiles: NVSlideVisibleTile[] = []
  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      const tile = tileAt(level, x, y)
      if (!tile) continue
      const baseX = tile.x * tileWidth * dsX
      const baseY = tile.y * tileHeight * dsY
      const baseWidth = tile.width * dsX
      const baseHeight = tile.height * dsY
      const screenY = slide.isYAxisUp()
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
        flipY: slide.isYAxisUp(),
      })
    }
  }
  return tiles
}
