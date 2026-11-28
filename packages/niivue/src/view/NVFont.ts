import {
  measureWidth,
  parseFont,
  type RawFontFile,
  type UIKitFontMetrics,
} from '@niivue/uikit'
import * as NVLoader from '@/NVLoader'

// --- Shared types and constants for both GL and GPU font renderers ---

export type GlyphBatch = {
  data: Float32Array
  count: number
  backColor: number[]
  backRect: number[]
  backRadius: number
  /** Draw only a ring this many px wide inside backRect; 0 or absent fills it. */
  backBorder?: number
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
const BACK_PADDING = 0.3
const BACK_RADIUS = 0.25

/**
 * The backing panels of `textList` packed FLOATS_PER_PANEL floats each
 * (rect, color, radius, border), or null when no batch has a visible one.
 */
export function packPanels(
  textList: GlyphBatch[],
): Float32Array<ArrayBuffer> | null {
  let panelCount = 0
  for (const item of textList) {
    if (item.backColor && item.backColor[3] > 0) panelCount++
  }
  if (panelCount === 0) return null
  const panelData = new Float32Array(panelCount * FLOATS_PER_PANEL)
  let idx = 0
  for (const item of textList) {
    if (!item.backColor || item.backColor[3] <= 0) continue
    const off = idx * FLOATS_PER_PANEL
    panelData.set(item.backRect, off)
    panelData.set(item.backColor, off + 4)
    panelData[off + 8] = item.backRadius
    panelData[off + 9] = item.backBorder ?? 0
    idx++
  }
  return panelData
}

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
/** Backing of the header (placeholder text, debug backend name); both views. */
export const HEADER_BACK_COLOR: [number, number, number, number] = [
  0.5, 0.2, 0.6, 0.8,
]

export function resolveHeaderLabel(
  placeholderText: string,
  hasContent: boolean,
  backendName: string,
  isDebug: boolean,
): string {
  if (!hasContent) return placeholderText
  return isDebug ? backendName : ''
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

/** Widest line of `str` as buildTextLayout draws it, in px. */
export function measureTextWidth(
  str: string,
  fontPx: number,
  scale: number,
  fontMets: FontMetrics,
): number {
  let maxWidth = 0
  for (const line of str.split('\n'))
    maxWidth = Math.max(maxWidth, measureWidth(fontMets, line, fontPx * scale))
  return maxWidth
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
  const lines = str.split('\n')
  // By code point (handles surrogate pairs), as the font's glyphs are keyed.
  const lineChars = lines.map((line) => [...line])
  let totalGlyphs = 0
  let maxWidth = 0
  for (let li = 0; li < lines.length; li++) {
    totalGlyphs += lineChars[li].length
    maxWidth = Math.max(maxWidth, measureWidth(fontMets, lines[li], fontSize))
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
    const baselineY = blockTopY + fontSize + li * lineHeight
    let currX = blockX
    for (const ch of lineChars[li]) {
      const m = fontMets.glyphs.get(ch)
      if (!m) continue
      const offset = glyphIdx * 16
      const [pl, pb, pw, ph] = m.plane
      const gx = currX + fontSize * pl
      const gy = baselineY - fontSize * (pb + ph)
      const gw = fontSize * pw
      const gh = fontSize * ph
      glyphs.set([gx, gy, gw, gh], offset)
      glyphs.set(m.uv, offset + 4)
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

// --- Font metrics ---

/** uikit's font model: the one msdf-atlas-gen parser (`parseFont`). */
export type FontMetrics = UIKitFontMetrics

export async function getFontMetrics(fnm: string): Promise<FontMetrics> {
  const fontBuffer = await NVLoader.fetchFile(fnm)
  const json = JSON.parse(new TextDecoder('utf-8').decode(fontBuffer))
  return parseFont(json as RawFontFile)
}
