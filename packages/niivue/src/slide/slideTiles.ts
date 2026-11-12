// Backend-neutral parts of drawing a slide, shared by the WebGL2 and WebGPU
// slide renderers (gl/slide.ts, wgpu/slide.ts).

import type {
  NVSlide,
  NVSlideCachedTile,
  NVSlideScreen,
  NVSlideScreenRect,
  NVSlideVisibleTile,
} from './NVSlide'

/**
 * Visit one slide's tiles in paint order. Coarser fallback levels come first,
 * painted UNDER the target level: non-empty only while target tiles are still
 * arriving, so the previous resolution stays on screen and is overpainted tile
 * by tile as the finer data lands. Only cached fallback tiles are visited.
 * A target tile without a bitmap is visited (to draw a flat placeholder) only
 * when nothing coarser is behind it; otherwise the placeholder would hide the
 * very fallback layer that is standing in for it.
 */
export function forEachSlideTile(
  slide: NVSlide,
  screen: NVSlideScreen,
  visit: (
    tile: NVSlideVisibleTile,
    cached: NVSlideCachedTile | null,
    rect: NVSlideScreenRect,
    isFallback: boolean,
  ) => void,
): void {
  const visible = slide.requestVisibleTiles(screen)
  for (const tile of visible.fallback) {
    const cached = slide.cachedTile(tile.key)
    if (cached) visit(tile, cached, tileRect(tile), true)
  }
  for (const tile of visible.tiles) {
    const cached = slide.cachedTile(tile.key)
    if (!cached && visible.fallback.length > 0) continue
    visit(tile, cached, tileRect(tile), false)
  }
}

function tileRect(tile: NVSlideVisibleTile): NVSlideScreenRect {
  return {
    x: tile.screenX,
    y: tile.screenY,
    width: tile.screenWidth,
    height: tile.screenHeight,
  }
}

/**
 * Clip-space corners [x0, y0, x1, y1] of a screen rect (y down) on a
 * width x height target, or null when the rect is empty or entirely off it.
 */
export function slideRectNdc(
  rect: NVSlideScreenRect,
  width: number,
  height: number,
): [number, number, number, number] | null {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    rect.x + rect.width < 0 ||
    rect.y + rect.height < 0 ||
    rect.x > width ||
    rect.y > height
  ) {
    return null
  }
  return [
    (rect.x / width) * 2 - 1,
    1 - (rect.y / height) * 2,
    ((rect.x + rect.width) / width) * 2 - 1,
    1 - ((rect.y + rect.height) / height) * 2,
  ]
}
