// Parsed MSDF font model for UIKit text. The raw shape is the standard
// msdf-atlas-gen JSON (atlas + metrics + glyphs with planeBounds/atlasBounds),
// the same format NiiVue's fonts use. Parsing normalizes each glyph into:
//   - uv:   [left, bottom, width, height] in [0,1] atlas texture space (y-up
//           flipped to texture space)
//   - plane:[left, bottom, width, height] in em units (the quad to place, scaled
//           by the text size)
//   - xadv: horizontal advance in em units
// This is pure data — no GPU. A renderer uploads the atlas image separately.
// Ported from the old niivue/niivue uikit (UIKFont) during the UIKit build-out.

export interface UIKitGlyph {
  /** [left, bottom, width, height] in [0,1] atlas UV space. */
  readonly uv: readonly [number, number, number, number]
  /** [left, bottom, width, height] in em units (quad to place). */
  readonly plane: readonly [number, number, number, number]
  /** Horizontal advance in em units. */
  readonly xadv: number
}

export interface UIKitFontMetrics {
  /** MSDF distance range in pixels (from atlas gen). */
  readonly distanceRange: number
  /** Atlas glyph em size in pixels. */
  readonly size: number
  /** Atlas texture dimensions in pixels. */
  readonly textureSize: readonly [number, number]
  readonly glyphs: ReadonlyMap<string, UIKitGlyph>
}

/** A parsed font plus its uploaded-once atlas image, consumed by the renderers. */
export interface UIKitFont {
  readonly metrics: UIKitFontMetrics
  readonly image: ImageBitmap
}

interface RawGlyph {
  unicode: number
  advance: number
  atlasBounds?: { left: number; top: number; right: number; bottom: number }
  planeBounds?: { left: number; top: number; right: number; bottom: number }
}

export interface RawFontFile {
  atlas: {
    width: number
    height: number
    distanceRange: number
    size: number
  }
  glyphs: RawGlyph[]
}

/** Parse msdf-atlas-gen JSON into a UIKit font metrics table. */
export function parseFont(raw: RawFontFile): UIKitFontMetrics {
  const atlas = raw.atlas
  const glyphs = new Map<string, UIKitGlyph>()
  for (const glyph of raw.glyphs) {
    if (!glyph.atlasBounds || !glyph.planeBounds) continue
    const char = String.fromCodePoint(glyph.unicode)
    const a = glyph.atlasBounds
    const p = glyph.planeBounds
    const uvL = a.left / atlas.width
    const uvB = (atlas.height - a.top) / atlas.height
    const uvW = (a.right - a.left) / atlas.width
    const uvH = (a.top - a.bottom) / atlas.height
    glyphs.set(char, {
      uv: [uvL, uvB, uvW, uvH],
      plane: [p.left, p.bottom, p.right - p.left, p.top - p.bottom],
      xadv: glyph.advance,
    })
  }
  return {
    distanceRange: atlas.distanceRange,
    size: atlas.size,
    textureSize: [atlas.width, atlas.height],
    glyphs,
  }
}

/**
 * MSDF anti-aliasing range in screen pixels for a given text size, matching the
 * old uikit: `max((size / atlasSize) * distanceRange, 1)`. Passed to the shader.
 */
export function screenPxRange(
  metrics: UIKitFontMetrics,
  sizePx: number,
): number {
  return Math.max((sizePx / metrics.size) * metrics.distanceRange, 1)
}
