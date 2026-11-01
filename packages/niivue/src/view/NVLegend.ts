import * as NVCmaps from '@/cmap/NVCmaps'
import { colormapLookup } from '@/mesh/connectome'
import type { NVImage, NVMesh } from '@/NVTypes'
import { meshLabelCentroid, volumeLabelCentroid } from './legendCentroids'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import { isMeshDrawn } from './NVMeshVisibility'
import { estimateFontSize } from './NVUILayout'

export type LegendEntry = {
  label: string
  color: [number, number, number, number] // RGBA 0-255
  /** Center-of-mass in mm, for crosshair navigation on click */
  centroid?: () => [number, number, number] | undefined
  /** Set on volume label entries; used by the legend toggle */
  volumeIndex?: number
  labelValue?: number
  /** The label is in its volume's `hiddenLabels`: drawn as an outlined box */
  isHidden?: boolean
}

export type LegendLayout = {
  entries: LegendEntry[]
  x: number // Left edge
  y: number // Top edge
  width: number // Total width
  boxSize: number // Color box size (px)
  gap: number // Vertical gap between entries (px)
  fontScale: number // Font scale multiplier (relative to base font size)
  textPadding: number // Space between box and text
  margin: number // Edge margin
  /** Columns of contiguous entries, each `columnWidth` wide. */
  columns: number
  columnWidth: number
  /** Entries per column, and how many of those rows fit on screen. */
  rows: number
  visibleRows: number
  /** First visible row; all columns scroll together. */
  scrollRow: number
  /** Row height (box plus line spacing) and row-to-row distance, in px. */
  rowHeight: number
  pitch: number
}

// Constants
const LEGEND_MARGIN = 20
const LEGEND_GAP = 8
const LEGEND_TEXT_PADDING = 8
const LINE_HEIGHT_RATIO = 1.2
const FONT_XADV = 0.7 // Character width estimation (increased for longer labels)
const LEGEND_FONT_SCALE = 0.8 // Legend uses slightly smaller font than default
// Extra columns may take this much of the canvas; past it the legend scrolls.
const MAX_WIDTH_FRACTION = 0.4

/** The font the legend draws with, so layout and text agree. */
export type LegendFont = {
  /** Font renderer's size in device px (fontMinSize, fontScale and DPR included). */
  fontPx: number
  /** Width of a label in px at the given font scale. */
  measure: (label: string, scale: number) => number
}

type LegendGrid = Pick<
  LegendLayout,
  | 'width'
  | 'boxSize'
  | 'fontScale'
  | 'columns'
  | 'columnWidth'
  | 'rows'
  | 'visibleRows'
  | 'rowHeight'
  | 'pitch'
>

/**
 * Columns, rows and width at the legend's fixed font size. Text never shrinks
 * to fit (a large atlas became unreadable): entries wrap into columns, then
 * scroll. Without `font` (no renderer yet) sizes come from an estimate.
 */
function legendGrid(
  entries: LegendEntry[],
  canvasWidth: number,
  canvasHeight: number,
  colorbarHeight: number,
  font?: LegendFont,
): LegendGrid {
  const fontScale = LEGEND_FONT_SCALE
  const boxSize =
    (font?.fontPx ?? estimateFontSize(canvasWidth, canvasHeight)) * fontScale
  const rowHeight = boxSize * LINE_HEIGHT_RATIO
  const pitch = rowHeight + LEGEND_GAP
  const labelWidth = (label: string): number =>
    font ? font.measure(label, fontScale) : label.length * boxSize * FONT_XADV
  const maxLabelWidth = entries.reduce(
    (max, e) => Math.max(max, labelWidth(e.label)),
    0,
  )
  const columnWidth =
    boxSize + LEGEND_TEXT_PADDING + maxLabelWidth + LEGEND_MARGIN
  const available = canvasHeight - colorbarHeight - LEGEND_MARGIN * 2
  const fitRows = Math.max(1, Math.floor((available + LEGEND_GAP) / pitch))
  const maxColumns = Math.max(
    1,
    Math.floor(
      (canvasWidth * MAX_WIDTH_FRACTION - LEGEND_MARGIN * 2) / columnWidth,
    ),
  )
  const rows = Math.ceil(
    entries.length / Math.min(Math.ceil(entries.length / fitRows), maxColumns),
  )
  // Recount: rounding rows up can leave the last capped column empty.
  const columns = Math.ceil(entries.length / rows)
  return {
    width: LEGEND_MARGIN * 2 + columns * columnWidth,
    boxSize,
    fontScale,
    columns,
    columnWidth,
    rows,
    visibleRows: Math.min(rows, fitRows),
    rowHeight,
    pitch,
  }
}

/** Top-left of entry `i`'s colour box, or null when scrolled out of view. */
function entryOrigin(layout: LegendLayout, i: number): [number, number] | null {
  const row = (i % layout.rows) - layout.scrollRow
  if (row < 0 || row >= layout.visibleRows) return null
  const col = Math.floor(i / layout.rows)
  return [
    layout.x + layout.margin + col * layout.columnWidth,
    layout.y + row * layout.pitch,
  ]
}

function visibleHeight(layout: LegendLayout): number {
  return layout.visibleRows * layout.pitch - layout.gap
}

/** Rows overflow the canvas, so the legend scrolls. */
export function isLegendScrollable(layout: LegendLayout): boolean {
  return layout.rows > layout.visibleRows
}

// The legend's backing [x, y, width, height]: drawn, and where the wheel
// scrolls it.
function backingRect(layout: LegendLayout): number[] {
  const pad = layout.margin * 0.5
  return [
    layout.x + pad,
    layout.y - pad,
    layout.width - 2 * pad,
    visibleHeight(layout) + 2 * pad,
  ]
}

// The scrollbar, inside the backing's right edge (the wheel scrolls over all of
// it): track [x, y, w, h] and the thumb's span.
function scrollTrack(layout: LegendLayout): {
  x: number
  y: number
  w: number
  h: number
  thumbY: number
  thumbH: number
} {
  // Backing strip right of the columns; a big font must not widen the bar past it.
  const strip = layout.margin * 0.5
  const w = Math.min(strip - 2, Math.max(3, layout.boxSize * 0.3))
  const h = visibleHeight(layout)
  return {
    x: layout.x + layout.width - layout.margin + (strip - w) / 2,
    y: layout.y,
    w,
    h,
    thumbY: layout.y + (h * layout.scrollRow) / layout.rows,
    thumbH: (h * layout.visibleRows) / layout.rows,
  }
}

/**
 * Collect legend entries from meshes and volumes with label colormaps.
 * Returns a flat array of label names and their colors.
 */
export function collectLegendEntries(
  meshes: NVMesh[],
  volumes: NVImage[],
): LegendEntry[] {
  const entries: LegendEntry[] = []

  // Collect from volumes with label colormaps
  for (const [volumeIndex, volume] of volumes.entries()) {
    // Unset counts as visible: an NVImage built by hand may omit the flag.
    if (volume.isLegendVisible === false) continue
    if (!volume.colormapLabel) continue

    const lut = volume.colormapLabel
    const labels = lut.labels ?? []
    const hidden = new Set(volume.hiddenLabels)

    // Extract each label with its color from the LUT
    for (let i = 0; i < labels.length; i++) {
      const lutOffset = i * 4
      const alpha = lut.lut[lutOffset + 3]

      // Skip transparent labels (typically index 0 = background)
      if (alpha === 0) continue

      const label = labels[i]
      const labelValue = (lut.min ?? 0) + i
      entries.push({
        label,
        color: [
          lut.lut[lutOffset],
          lut.lut[lutOffset + 1],
          lut.lut[lutOffset + 2],
          lut.lut[lutOffset + 3],
        ],
        centroid: () => volumeLabelCentroid(volume, label),
        volumeIndex,
        labelValue,
        isHidden: hidden.has(labelValue),
      })
    }
  }

  // Collect from mesh layers with label colormaps
  for (const mesh of meshes) {
    if (mesh.isLegendVisible === false || !isMeshDrawn(mesh)) continue
    if (!mesh.layers) continue

    for (const layer of mesh.layers) {
      if (!layer.colormapLabel) continue

      const lut = layer.colormapLabel
      const labels = lut.labels ?? []

      // Extract each label with its color from the LUT
      for (let i = 0; i < labels.length; i++) {
        const lutOffset = i * 4
        const alpha = lut.lut[lutOffset + 3]

        // Skip transparent labels (typically index 0 = background)
        if (alpha === 0) continue

        const label = labels[i]
        entries.push({
          label,
          color: [
            lut.lut[lutOffset],
            lut.lut[lutOffset + 1],
            lut.lut[lutOffset + 2],
            lut.lut[lutOffset + 3],
          ],
          centroid: () => meshLabelCentroid(mesh, layer, label),
        })
      }
    }
  }

  // Collect from connectome meshes (named nodes)
  for (const mesh of meshes) {
    if (mesh.isLegendVisible === false || !isMeshDrawn(mesh)) continue
    if (mesh.kind !== 'connectome' || !mesh.jcon || !mesh.connectomeOptions)
      continue

    const opts = mesh.connectomeOptions
    const nodeLut = NVCmaps.lutrgba8(opts.nodeColormap)
    const nodeLutNeg = opts.nodeColormapNegative
      ? NVCmaps.lutrgba8(opts.nodeColormapNegative)
      : null

    for (const node of mesh.jcon.nodes) {
      if (!node.name) continue
      const radius = Math.abs(node.sizeValue) * opts.nodeScale
      if (radius <= 0) continue

      const clr = colormapLookup(
        node.colorValue,
        opts.nodeMinColor,
        opts.nodeMaxColor,
        nodeLut,
        nodeLutNeg,
      )
      entries.push({
        label: node.name,
        color: [
          Math.round(clr[0] * 255),
          Math.round(clr[1] * 255),
          Math.round(clr[2] * 255),
          // Nodes render opaque; the LUT alpha (e.g. viridis 0 at min) is for volume overlays
          255,
        ],
        centroid: () => [node.x, node.y, node.z],
      })
    }
  }

  return entries
}

/**
 * What the legend lists, compared by identity to tell when its source changed:
 * volume and mesh objects, their colormaps, and the same skips as
 * collectLegendEntries. Not `hiddenLabels`, so toggling a label keeps the scroll
 * position, nor a volume's `colormapLabel`, which grows as streamed bricks
 * decode (the colormap name stays).
 */
export function legendSources(meshes: NVMesh[], volumes: NVImage[]): unknown[] {
  const sources: unknown[] = []
  for (const volume of volumes) {
    if (volume.isLegendVisible === false || !volume.colormapLabel) continue
    sources.push(volume, NVCmaps.colormapKey(volume.colormap))
  }
  for (const mesh of meshes) {
    if (mesh.isLegendVisible === false || !isMeshDrawn(mesh)) continue
    for (const layer of mesh.layers ?? []) {
      if (layer.colormapLabel) sources.push(mesh, layer, layer.colormapLabel)
    }
    if (mesh.kind === 'connectome') sources.push(mesh)
  }
  return sources
}

/** Whether two `legendSources` results are the same source. */
export function isSameLegendSource(
  a: readonly unknown[],
  b: readonly unknown[],
): boolean {
  return a.length === b.length && a.every((source, i) => source === b[i])
}

/**
 * Legend layout: columns at a fixed font size, scrolled to `scrollRow`
 * (clamped). The caller reserves `width` and then sets `x`. Returns null if
 * no entries.
 */
export function computeLegendLayout(
  entries: LegendEntry[],
  canvasWidth: number,
  canvasHeight: number,
  colorbarHeight: number,
  scrollRow = 0,
  font?: LegendFont,
): LegendLayout | null {
  if (entries.length === 0) return null
  const grid = legendGrid(
    entries,
    canvasWidth,
    canvasHeight,
    colorbarHeight,
    font,
  )
  const layout: LegendLayout = {
    ...grid,
    entries,
    x: 0,
    y: 0,
    gap: LEGEND_GAP,
    textPadding: LEGEND_TEXT_PADDING,
    margin: LEGEND_MARGIN,
    scrollRow: Math.max(
      0,
      Math.min(Math.floor(scrollRow), grid.rows - grid.visibleRows),
    ),
  }
  // Center vertically in the space above the colorbar.
  const yStart = (canvasHeight - colorbarHeight - visibleHeight(layout)) / 2
  layout.y = Math.max(LEGEND_MARGIN, yStart)
  return layout
}

/**
 * Compute backing color offset from canvas background (highlights are brighter).
 */
function computeBackingColor(
  canvasBackColor: number[],
): [number, number, number, number] {
  const canvasLum = canvasBackColor[0] + canvasBackColor[1] + canvasBackColor[2]

  // Offset by 0.3 total (0.1 per component)
  let r: number, g: number, b: number
  if (canvasLum > 2.7) {
    // Canvas is very bright, darken backing
    r = Math.max(0, canvasBackColor[0] - 0.1)
    g = Math.max(0, canvasBackColor[1] - 0.1)
    b = Math.max(0, canvasBackColor[2] - 0.1)
  } else {
    // Canvas is dark/medium, brighten backing (highlights are brighter)
    r = Math.min(1, canvasBackColor[0] + 0.3)
    g = Math.min(1, canvasBackColor[1] + 0.3)
    b = Math.min(1, canvasBackColor[2] + 0.3)
  }

  return [r, g, b, 0.7]
}

/**
 * Compute high-contrast font color (black or white) based on backing luminance.
 */
function computeFontColor(
  backingColor: [number, number, number, number],
): [number, number, number, number] {
  const backingLum = backingColor[0] + backingColor[1] + backingColor[2]
  return backingLum > 1.5
    ? [0, 0, 0, 1] // Black text on bright backing
    : [1, 1, 1, 1] // White text on dark backing
}

/**
 * Build GlyphBatches for legend rendering (color boxes + text labels).
 */
export function buildLegendLabels(
  layout: LegendLayout,
  buildText: BuildTextFn,
  canvasBackColor: number[],
): GlyphBatch[] {
  const batches: GlyphBatch[] = []

  // Compute backing color offset from canvas background
  const backingColor = computeBackingColor(canvasBackColor)

  // Compute high-contrast font color based on backing
  const fontColor = computeFontColor(backingColor)

  // Create single unified backing for entire legend
  const unifiedBacking: GlyphBatch = {
    data: new Float32Array(0),
    count: 0,
    backColor: backingColor,
    backRect: backingRect(layout),
    backRadius: 8, // Rounded corners in pixels
  }
  batches.push(unifiedBacking)

  // Scrollbar in the right margin: the track, and a thumb for the rows shown.
  if (isLegendScrollable(layout)) {
    const bar = scrollTrack(layout)
    for (const [y, h, alpha] of [
      [bar.y, bar.h, 0.25],
      [bar.thumbY, bar.thumbH, 0.8],
    ]) {
      batches.push({
        data: new Float32Array(0),
        count: 0,
        backColor: [fontColor[0], fontColor[1], fontColor[2], alpha],
        backRect: [bar.x, y, bar.w, h],
        backRadius: bar.w / 2,
      })
    }
  }

  // Now add color boxes and text labels (without individual backings)
  for (const [i, entry] of layout.entries.entries()) {
    const origin = entryOrigin(layout, i)
    if (!origin) continue
    const [boxX, boxY] = origin

    // Add 1px margin around color box in canvas back color for distinction
    const marginBatch: GlyphBatch = {
      data: new Float32Array(0),
      count: 0,
      backColor: [...canvasBackColor, 1], // Canvas background color
      backRect: [boxX - 1, boxY - 1, layout.boxSize + 2, layout.boxSize + 2],
      backRadius: 0,
    }
    batches.push(marginBatch)

    // Create color box as a GlyphBatch with no glyphs, just a colored backing
    const color: [number, number, number, number] = [
      entry.color[0] / 255,
      entry.color[1] / 255,
      entry.color[2] / 255,
      entry.color[3] / 255,
    ]
    const box = (x: number, y: number, w: number, h: number): GlyphBatch => ({
      data: new Float32Array(0),
      count: 0,
      backColor: color,
      backRect: [x, y, w, h],
      backRadius: 0, // Sharp corners for color box
    })
    const size = layout.boxSize
    if (entry.isHidden) {
      // Hidden label: an outline in the label colour. Four bars rather than a
      // punched-out centre, which would need an opaque colour matching the
      // backing and vanishes on a transparent canvas.
      const t = Math.max(1, Math.round(size * 0.2))
      batches.push(
        box(boxX, boxY, size, t),
        box(boxX, boxY + size - t, size, t),
        box(boxX, boxY + t, t, size - 2 * t),
        box(boxX + size - t, boxY + t, t, size - 2 * t),
      )
    } else {
      batches.push(box(boxX, boxY, size, size))
    }

    // Create text label next to the color box (no backing)
    const textX = boxX + layout.boxSize + layout.textPadding
    const textY = boxY + layout.boxSize / 2

    // No individual backing for text (transparent)
    const noBackColor = [0, 0, 0, 0]

    const textBatch = buildText(
      entry.label,
      textX,
      textY,
      layout.fontScale, // Use scale factor, not absolute font size
      fontColor, // Use computed high-contrast font color
      0, // anchorX = 0 (left-aligned)
      0.5, // anchorY = 0.5 (vertically centered)
      noBackColor,
    )
    // Text renders without individual backing (unified backing already provides background)
    textBatch.backRect = []
    batches.push(textBatch)
  }

  return batches
}

/**
 * The legend entry under canvas pixel (x, y), and whether the point is on its
 * colour box rather than its name.
 */
export function legendHitTest(
  x: number,
  y: number,
  layout: LegendLayout | null,
): { entry: LegendEntry; isOnBox: boolean } | null {
  if (!layout) return null
  const pitch = layout.pitch
  const col = Math.floor((x - layout.x - layout.margin) / layout.columnWidth)
  const row = Math.floor((y - layout.y) / pitch)
  if (col < 0 || col >= layout.columns || row < 0 || row >= layout.visibleRows)
    return null
  const dy = y - layout.y - row * pitch
  if (dy >= layout.rowHeight) return null // gap between rows
  const entry = layout.entries[col * layout.rows + row + layout.scrollRow]
  if (!entry) return null
  const dx = x - layout.x - layout.margin - col * layout.columnWidth
  return { entry, isOnBox: dx <= layout.boxSize && dy <= layout.boxSize }
}

/** Whether (x, y) is on the legend's backing, where the wheel scrolls it. */
export function isInLegend(
  x: number,
  y: number,
  layout: LegendLayout | null,
): boolean {
  if (!layout) return false
  const [bx, by, bw, bh] = backingRect(layout)
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh
}

/**
 * A click on the scrollbar: pages to scroll (-1 above the thumb, 1 below, 0
 * on it), or null off the scrollbar or when the legend does not scroll.
 */
export function legendScrollHit(
  x: number,
  y: number,
  layout: LegendLayout | null,
): number | null {
  if (!layout || !isLegendScrollable(layout)) return null
  const bar = scrollTrack(layout)
  // A thin bar is hard to hit: accept a bar's width to its left and the rest of
  // the backing to its right.
  const [bx, , bw] = backingRect(layout)
  if (x < bar.x - bar.w || x > bx + bw) return null
  if (y < bar.y || y > bar.y + bar.h) return null
  return y < bar.thumbY ? -1 : y > bar.thumbY + bar.thumbH ? 1 : 0
}
