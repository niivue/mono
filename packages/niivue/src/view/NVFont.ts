import {
  buildRect,
  FLOATS_PER_GLYPH,
  layoutText,
  measureWidth,
  parseFont,
  type RawFontFile,
  type RectData,
  type RGBA,
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

const BACK_PADDING = 0.3
const BACK_RADIUS = 0.25

/**
 * The visible backing panels of `textList` as uikit rects. A ring-only panel
 * (`backBorder`) is a transparent fill inside a border of its colour.
 */
export function panelRects(textList: GlyphBatch[]): RectData[] {
  const rects: RectData[] = []
  for (const {
    backColor: c,
    backRect,
    backRadius,
    backBorder = 0,
  } of textList) {
    if (!c || c[3] <= 0) continue
    const [x, y, width, height] = backRect
    rects.push(
      buildRect({
        x,
        y,
        width,
        height,
        radius: backRadius,
        borderWidth: backBorder,
        fill: backBorder > 0 ? [c[0], c[1], c[2], 0] : c,
        border: c,
      }),
    )
  }
  return rects
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
  const lineHeight = fontSize * 1.2
  const lines = str.split('\n')
  let maxWidth = 0
  for (const line of lines)
    maxWidth = Math.max(maxWidth, measureWidth(fontMets, line, fontSize))
  const blockX = x - maxWidth * anchorX
  const blockTopY = y - lines.length * lineHeight * anchorY
  const rgba: RGBA = [
    color[0] ?? 1,
    color[1] ?? 1,
    color[2] ?? 1,
    color[3] ?? 1,
  ]
  // Each line is uikit's layout at its baseline; the block anchors them.
  const runs = lines.map(
    (line, li) =>
      layoutText(fontMets, line, {
        x: blockX,
        y: blockTopY + fontSize + li * lineHeight,
        sizePx: fontSize,
        color: rgba,
      }).glyphs,
  )
  let glyphs = runs[0] ?? new Float32Array(0)
  if (runs.length > 1) {
    glyphs = new Float32Array(runs.reduce((n, r) => n + r.length, 0))
    let at = 0
    for (const r of runs) {
      glyphs.set(r, at)
      at += r.length
    }
  }
  const glyphIdx = glyphs.length / FLOATS_PER_GLYPH
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (let o = 0; o < glyphs.length; o += FLOATS_PER_GLYPH) {
    const gx = glyphs[o]
    const gy = glyphs[o + 1]
    if (gx < minX) minX = gx
    if (gy < minY) minY = gy
    if (gx + glyphs[o + 2] > maxX) maxX = gx + glyphs[o + 2]
    if (gy + glyphs[o + 3] > maxY) maxY = gy + glyphs[o + 3]
  }
  // No drawable glyph (empty, or every code point missing from the atlas):
  // the min/max accumulators are still ±Infinity, so bail before backRect.
  if (glyphIdx === 0) return emptyBatch()
  const pad = fontSize * BACK_PADDING
  const radius = fontSize * BACK_RADIUS
  const backRect = [
    minX - pad,
    minY - pad,
    maxX - minX + 2 * pad,
    maxY - minY + 2 * pad,
  ]
  return {
    data: glyphs,
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
