import * as NVLoader from "@/NVLoader"

// --- Shared types and constants for both GL and GPU font renderers ---

export type GlyphBatch = {
  data: Float32Array
  count: number
  backColor: number[]
  backRect: number[]
  backRadius: number
}

export type BuildTextFn = (
  str: string,
  x: number,
  y: number,
  scale: number,
  color?: number[],
  anchorX?: number,
  anchorY?: number,
  backColor?: number[],
) => GlyphBatch

export const FLOATS_PER_PANEL = 12
export const BACK_PADDING = 0.3
export const BACK_RADIUS = 0.25

export function emptyBatch(): GlyphBatch {
  return {
    data: new Float32Array(0),
    count: 0,
    backColor: [0, 0, 0, 0],
    backRect: [0, 0, 0, 0],
    backRadius: 0,
  }
}

/**
 * Resolve the header label drawn at the top of the view.
 * - When no content is loaded: return the user-configured placeholder.
 * - When content is loaded: return the backend name only in debug mode
 *   (as a developer hint); otherwise return '' and the caller should skip
 *   drawing. Keeps the NVViewGL and NVViewGPU paths in sync.
 */
export function resolveHeaderLabel(
  placeholderText: string,
  hasContent: boolean,
  backendName: string,
  isDebug: boolean,
): string {
  if (!hasContent) return placeholderText
  return isDebug ? backendName : ""
}

export function calculateFontSizePx(
  width: number,
  height: number,
  dpi: number,
  fontSizeScaling: number,
  fontMinPx: number,
): number {
  const screenWidthPts = width / dpi
  const screenHeightPts = height / dpi
  const screenAreaPts = screenWidthPts * screenHeightPts
  const refAreaPts = 800 * 600
  const normalizedArea = Math.max(screenAreaPts / refAreaPts, 1)
  const scale = normalizedArea ** fontSizeScaling
  return fontMinPx * scale * dpi
}

export function buildTextLayout(
  str: string,
  x: number,
  y: number,
  fontPx: number,
  scale: number,
  fontMets: FontMetrics,
  color: number[],
  anchorX: number,
  anchorY: number,
  backColor: number[],
): GlyphBatch {
  const fontSize = fontPx * scale
  const atlasRange = fontMets.distanceRange
  const lineHeight = fontSize * 1.2
  const lines = str.split("\n")
  const lineCodes: number[][] = []
  let totalGlyphs = 0
  let maxWidth = 0
  for (const line of lines) {
    // Iterate by Unicode code points (handles surrogate pairs), not UTF-8 bytes.
    const codes: number[] = []
    for (const ch of line) codes.push(ch.codePointAt(0) ?? 0)
    lineCodes.push(codes)
    totalGlyphs += codes.length
    let w = 0
    for (let i = 0; i < codes.length; i++) {
      const m = fontMets.mets[codes[i]]
      if (m) w += fontSize * m.xadv
    }
    if (w > maxWidth) maxWidth = w
  }
  if (totalGlyphs === 0) return emptyBatch()
  const totalHeight = lines.length * lineHeight
  const blockX = x - maxWidth * anchorX
  const blockTopY = y - totalHeight * anchorY
  const glyphs = new Float32Array(totalGlyphs * 16)
  let glyphIdx = 0
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let li = 0; li < lines.length; li++) {
    const codes = lineCodes[li]
    const baselineY = blockTopY + fontSize + li * lineHeight
    let currX = blockX
    for (let i = 0; i < codes.length; i++) {
      const m = fontMets.mets[codes[i]]
      if (!m) continue
      const offset = glyphIdx * 16
      const gx = currX + fontSize * m.lbwh[0]
      const gy = baselineY - fontSize * (m.lbwh[1] + m.lbwh[3])
      const gw = fontSize * m.lbwh[2]
      const gh = fontSize * m.lbwh[3]
      glyphs.set([gx, gy, gw, gh], offset)
      glyphs.set(m.uv_lbwh, offset + 4)
      glyphs.set(color, offset + 8)
      glyphs[offset + 12] = atlasRange
      if (gx < minX) minX = gx
      if (gy < minY) minY = gy
      if (gx + gw > maxX) maxX = gx + gw
      if (gy + gh > maxY) maxY = gy + gh
      currX += fontSize * m.xadv
      glyphIdx++
    }
  }
  // If every code point in the string was missing from the font atlas, the
  // min/max accumulators are still ±Infinity — bail out before they poison
  // backRect. Matches the totalGlyphs === 0 fast path above.
  if (glyphIdx === 0) return emptyBatch()
  const pad = fontSize * BACK_PADDING
  const radius = fontSize * BACK_RADIUS
  const backRect = [
    minX - pad,
    minY - pad,
    maxX - minX + 2 * pad,
    maxY - minY + 2 * pad,
  ]
  // Trim to the glyphs that were actually written — skipped code points
  // leave holes in the allocated buffer that downstream consumers (which
  // size their target from `count`) must not copy past.
  return {
    data: glyphs.subarray(0, glyphIdx * 16),
    count: glyphIdx,
    backColor,
    backRect,
    backRadius: radius,
  }
}

// --- Font metrics parsing ---

export type FontMetrics = {
  distanceRange: number
  size: number
  mets: Record<number, { xadv: number; uv_lbwh: number[]; lbwh: number[] }>
}

type FontJson = {
  atlas: { distanceRange: number; size: number; width: number; height: number }
  glyphs: Array<{
    unicode: number
    advance: number
    atlasBounds?: { left: number; right: number; top: number; bottom: number }
    planeBounds?: { left: number; right: number; top: number; bottom: number }
  }>
}

export function parseFontMetrics(jsonMetrics: FontJson): FontMetrics {
  const fontMets: FontMetrics = {
    distanceRange: jsonMetrics.atlas.distanceRange,
    size: jsonMetrics.atlas.size,
    mets: {},
  }
  // Sparse: only define entries for glyphs the font actually ships, keyed by
  // Unicode code point. Missing glyphs are skipped in buildTextLayout.
  const scaleW = jsonMetrics.atlas.width
  const scaleH = jsonMetrics.atlas.height
  for (const glyph of jsonMetrics.glyphs) {
    const id = glyph.unicode
    const m = {
      xadv: glyph.advance,
      uv_lbwh: [0, 0, 0, 0],
      lbwh: [0, 0, 0, 0],
    }
    if (glyph.atlasBounds && glyph.planeBounds) {
      const al = glyph.atlasBounds.left / scaleW
      const ab = (scaleH - glyph.atlasBounds.top) / scaleH
      const aw = (glyph.atlasBounds.right - glyph.atlasBounds.left) / scaleW
      const ah = (glyph.atlasBounds.top - glyph.atlasBounds.bottom) / scaleH
      m.uv_lbwh = [al, ab, aw, ah]
      const pl = glyph.planeBounds.left
      const pb = glyph.planeBounds.bottom
      const pw = glyph.planeBounds.right - glyph.planeBounds.left
      const ph = glyph.planeBounds.top - glyph.planeBounds.bottom
      m.lbwh = [pl, pb, pw, ph]
    }
    fontMets.mets[id] = m
  }
  return fontMets
}

export async function getFontMetrics(fnm: string): Promise<FontMetrics> {
  const fontBuffer = await NVLoader.fetchFile(fnm)
  const decoder = new TextDecoder("utf-8")
  const jsonString = decoder.decode(fontBuffer)
  const jsonMetrics = JSON.parse(jsonString) as FontJson
  return parseFontMetrics(jsonMetrics)
}
