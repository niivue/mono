import * as NVCmaps from '@/cmap/NVCmaps'
import { colormapLookup } from '@/mesh/connectome'
import type { NVImage, NVMesh } from '@/NVTypes'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import { estimateFontSize } from './NVUILayout'

export type LegendEntry = {
  label: string
  color: [number, number, number, number] // RGBA 0-255
  centroid?: [number, number, number] // center-of-mass in mm (for crosshair navigation)
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
}

// Constants
const LEGEND_MARGIN = 20
const LEGEND_GAP = 8
const LEGEND_TEXT_PADDING = 8
const LINE_HEIGHT_RATIO = 1.2
const FONT_XADV = 0.7 // Character width estimation (increased for longer labels)
const LEGEND_FONT_SCALE = 0.8 // Legend uses slightly smaller font than default

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
  for (const volume of volumes) {
    // Skip if showLegend is explicitly false
    if (volume.showLegend === false) continue
    if (!volume.colormapLabel) continue

    const lut = volume.colormapLabel
    const labels = lut.labels ?? []

    // Extract each label with its color from the LUT
    for (let i = 0; i < labels.length; i++) {
      const lutOffset = i * 4
      const alpha = lut.lut[lutOffset + 3]

      // Skip transparent labels (typically index 0 = background)
      if (alpha === 0) continue

      entries.push({
        label: labels[i],
        color: [
          lut.lut[lutOffset],
          lut.lut[lutOffset + 1],
          lut.lut[lutOffset + 2],
          lut.lut[lutOffset + 3],
        ],
        centroid: lut.centroids?.[labels[i]],
      })
    }
  }

  // Collect from mesh layers with label colormaps
  for (const mesh of meshes) {
    // Skip if showLegend is explicitly false
    if (mesh.showLegend === false) continue
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

        entries.push({
          label: labels[i],
          color: [
            lut.lut[lutOffset],
            lut.lut[lutOffset + 1],
            lut.lut[lutOffset + 2],
            lut.lut[lutOffset + 3],
          ],
          centroid: lut.centroids?.[labels[i]],
        })
      }
    }
  }

  // Collect from connectome meshes (named nodes)
  for (const mesh of meshes) {
    if (mesh.showLegend === false) continue
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
          Math.round(clr[3] * 255),
        ],
        centroid: [node.x, node.y, node.z],
      })
    }
  }

  return entries
}

/**
 * Calculate total width needed for legend.
 * Returns 0 if no entries.
 */
export function legendTotalWidth(
  entries: LegendEntry[],
  canvasWidth: number,
  canvasHeight: number,
): number {
  if (entries.length === 0) return 0

  const baseFontSize = estimateFontSize(canvasWidth, canvasHeight)
  const fontSize = baseFontSize * LEGEND_FONT_SCALE

  // Estimate max label width with extra padding
  const maxLabelChars = Math.max(...entries.map((e) => e.label.length))
  const maxLabelWidth = maxLabelChars * fontSize * FONT_XADV

  // Add extra width for padding and ensure minimum width
  return (
    LEGEND_MARGIN +
    fontSize +
    LEGEND_TEXT_PADDING +
    maxLabelWidth +
    LEGEND_MARGIN * 2
  )
}

/**
 * Compute legend layout with font scaling if needed.
 * Returns null if no entries.
 */
export function computeLegendLayout(
  entries: LegendEntry[],
  canvasWidth: number,
  canvasHeight: number,
  colorbarHeight: number,
  x = 0,
): LegendLayout | null {
  if (entries.length === 0) return null

  const baseFontSize = estimateFontSize(canvasWidth, canvasHeight)

  // Calculate available vertical space (canvas height minus colorbar and margins)
  const availableHeight = canvasHeight - colorbarHeight - LEGEND_MARGIN * 2

  // Calculate required height for all entries at base scale
  const entryHeight = baseFontSize * LEGEND_FONT_SCALE * LINE_HEIGHT_RATIO
  const requiredHeight =
    entries.length * entryHeight + (entries.length - 1) * LEGEND_GAP

  // Scale font down further if needed to fit all entries
  let fontScale = LEGEND_FONT_SCALE
  if (requiredHeight > availableHeight && availableHeight > 0) {
    fontScale = LEGEND_FONT_SCALE * (availableHeight / requiredHeight)
  }

  const fontSize = baseFontSize * fontScale
  const boxSize = fontSize

  // Recalculate max label width with scaled font
  const maxLabelChars = Math.max(...entries.map((e) => e.label.length))
  const maxLabelWidth = maxLabelChars * fontSize * FONT_XADV

  const totalWidth =
    LEGEND_MARGIN +
    boxSize +
    LEGEND_TEXT_PADDING +
    maxLabelWidth +
    LEGEND_MARGIN * 2

  // Calculate total height of all entries
  const entryHeightFinal = boxSize * LINE_HEIGHT_RATIO
  const totalEntriesHeight =
    entries.length * entryHeightFinal + (entries.length - 1) * LEGEND_GAP

  // Center vertically in available space
  const availableHeightForCentering = canvasHeight - colorbarHeight
  const yStart = (availableHeightForCentering - totalEntriesHeight) / 2

  return {
    entries,
    x,
    y: Math.max(LEGEND_MARGIN, yStart), // Don't go above top margin
    width: totalWidth,
    boxSize,
    gap: LEGEND_GAP,
    fontScale,
    textPadding: LEGEND_TEXT_PADDING,
    margin: LEGEND_MARGIN,
  }
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

  if (layout.entries.length === 0) return batches

  // Calculate bounding box for unified backing
  const entryHeight = layout.boxSize * LINE_HEIGHT_RATIO
  const totalHeight =
    layout.entries.length * entryHeight +
    (layout.entries.length - 1) * layout.gap
  const backingPadding = layout.margin * 0.5

  // Compute backing color offset from canvas background
  const backingColor = computeBackingColor(canvasBackColor)

  // Compute high-contrast font color based on backing
  const fontColor = computeFontColor(backingColor)

  // Create single unified backing for entire legend
  const unifiedBacking: GlyphBatch = {
    data: new Float32Array(0),
    count: 0,
    backColor: backingColor,
    backRect: [
      layout.x + backingPadding,
      layout.y - backingPadding,
      layout.width - backingPadding * 2,
      totalHeight + backingPadding * 2,
    ],
    backRadius: 8, // Rounded corners in pixels
  }
  batches.push(unifiedBacking)

  // Now add color boxes and text labels (without individual backings)
  let yPos = layout.y

  for (const entry of layout.entries) {
    const boxX = layout.x + layout.margin
    const boxY = yPos

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
    const colorBoxBatch: GlyphBatch = {
      data: new Float32Array(0),
      count: 0,
      backColor: [
        entry.color[0] / 255,
        entry.color[1] / 255,
        entry.color[2] / 255,
        entry.color[3] / 255,
      ],
      backRect: [boxX, boxY, layout.boxSize, layout.boxSize],
      backRadius: 0, // Sharp corners for color box
    }
    batches.push(colorBoxBatch)

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
    // Remove backRect to avoid hitting MAX_PANELS limit (128)
    // Text renders without individual backing (unified backing already provides background)
    textBatch.backRect = []
    batches.push(textBatch)

    // Move to next entry position
    yPos += layout.boxSize * LINE_HEIGHT_RATIO + layout.gap
  }

  return batches
}
