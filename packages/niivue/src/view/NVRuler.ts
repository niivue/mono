import { mmPerPixel2D, mmPerPixelRender } from '@/math/NVTransforms'
import { SLICE_TYPE } from '@/NVConstants'
import type { RulerUnits } from '@/NVTypes'
import type { BuildTextFn, GlyphBatch } from './NVFont'
import type { BuildLineFn, LineData } from './NVLine'
import { type SliceTile, slicePanUV } from './NVSliceLayout'

// slicePanUV indexes by orientation, so anything else (RENDER, or a tile from
// an externally assigned screenSlices) would throw rather than draw no ruler.
const IS_2D: number[] = [
  SLICE_TYPE.AXIAL,
  SLICE_TYPE.CORONAL,
  SLICE_TYPE.SAGITTAL,
]

// Nice ruler lengths to try, in descending order (in current unit)
const NICE_VALUES = [10, 5, 2, 1]

/**
 * Select the 2D tile with the longest in-plane dimension.
 * Returns null if no 2D tiles exist.
 */
function selectRulerTile(tiles: SliceTile[]): SliceTile | null {
  let best: SliceTile | null = null
  let bestSpan = 0
  for (const tile of tiles) {
    if (!IS_2D.includes(tile.axCorSag)) continue
    if (!tile.screen || !tile.leftTopWidthHeight) continue
    // fovMM is tile-local [u, v, depth], never world XYZ: buildScreens already
    // remapped it, and world axes read sagittal's vertical span as horizontal.
    const fov = tile.screen.fovMM
    const span = Math.max(Math.abs(fov[0]), Math.abs(fov[1]))
    if (span > bestSpan) {
      bestSpan = span
      best = tile
    }
  }
  return best
}

// Millimetres per unit for a fixed `rulerUnits`.
const UNIT_MM: Record<Exclude<RulerUnits, 'auto'>, number> = {
  nm: 1e-6,
  um: 1e-3,
  mm: 1,
  cm: 10,
}

// The largest 1/2/5 x 10^n at most `max`.
function largestNice(max: number): number {
  const decade = 10 ** Math.floor(Math.log10(max))
  // toPrecision drops float noise such as 0.30000000000000004.
  return Number(
    (
      (NICE_VALUES.slice(1).find((v) => v * decade <= max) ?? 1) * decade
    ).toPrecision(1),
  )
}

/**
 * Choose a ruler length (in mm) and label string. `units` 'auto' picks km, m,
 * cm, mm or um by the field; a fixed unit labels the largest 1/2/5 x 10^n of
 * it that fits. Returns { lengthMM, label } or null if nothing reasonable fits.
 */
export function chooseRulerSize(
  fovMM: number,
  units: RulerUnits = 'auto',
): { lengthMM: number; label: string } | null {
  // Ruler should fit within ~65% of tile width
  const maxMM = fovMM * 0.65
  if (maxMM <= 0) return null
  const perUnit = units === 'auto' ? undefined : UNIT_MM[units]
  if (perUnit) {
    const value = largestNice(maxMM / perUnit)
    return { lengthMM: value * perUnit, label: `${value} ${units}` }
  }
  // Metres and kilometres for geographic fields (Sentinel-2: 10 m/px).
  for (const [mmPer, unit] of [
    [1e6, 'km'],
    [1e3, 'm'],
  ] as const) {
    if (maxMM >= mmPer) {
      const value = largestNice(maxMM / mmPer)
      return { lengthMM: value * mmPer, label: `${value} ${unit}` }
    }
  }

  // Try cm first (if object is large enough)
  if (fovMM >= 50) {
    for (const v of NICE_VALUES) {
      const mm = v * 10 // cm → mm
      if (mm <= maxMM) {
        return { lengthMM: mm, label: `${v} cm` }
      }
    }
  }
  // Fall back to mm
  for (const v of NICE_VALUES) {
    if (v <= maxMM) {
      return { lengthMM: v, label: `${v} mm` }
    }
  }
  // Fall back to um for sub-mm fields of view. One pass of the nice-value
  // ladder only spans a factor of ten, so walk it across sub-mm powers of
  // ten: a slide zoomed to a few hundred microns gets a 100 um bar, not a
  // 10 um sliver.
  for (const scale of [100, 10, 1]) {
    for (const v of NICE_VALUES) {
      const um = v * scale
      const mm = um / 1000 // um -> mm
      if (mm <= maxMM) {
        return { lengthMM: mm, label: `${um} um` }
      }
    }
  }
  return null
}

/**
 * The checkerboard bar (5 segments, outlined) from `rulerLeft`, centred on
 * `rulerY`, in the caller's pixels. Shared with the slide overlay's scale bar.
 */
export function scaleBarLines(
  rulerLeft: number,
  rulerY: number,
  rulerPx: number,
  thickness: number,
  borderThick: number,
  buildLine: BuildLineFn,
  fontColor: number[],
): LineData[] {
  const segments = 5
  const segPx = rulerPx / segments
  const rulerRight = rulerLeft + rulerPx

  const lines: LineData[] = []
  // Draw checkerboard segments (only odd segments filled)
  for (let i = 0; i < segments; i++) {
    if (i % 2 === 0) {
      const x0 = rulerLeft + i * segPx
      const x1 = rulerLeft + (i + 1) * segPx
      lines.push(buildLine(x0, rulerY, x1, rulerY, thickness, fontColor))
    }
  }
  // Top and bottom border lines (thin)
  const borderTop = rulerY - thickness / 2
  const borderBot = rulerY + thickness / 2
  lines.push(
    buildLine(
      rulerLeft,
      borderTop,
      rulerRight,
      borderTop,
      borderThick,
      fontColor,
    ),
  )
  lines.push(
    buildLine(
      rulerLeft,
      borderBot,
      rulerRight,
      borderBot,
      borderThick,
      fontColor,
    ),
  )
  // Left and right caps
  lines.push(
    buildLine(
      rulerLeft,
      borderTop,
      rulerLeft,
      borderBot,
      borderThick,
      fontColor,
    ),
  )
  lines.push(
    buildLine(
      rulerRight,
      borderTop,
      rulerRight,
      borderBot,
      borderThick,
      fontColor,
    ),
  )
  // Segment dividers
  for (let i = 1; i < segments; i++) {
    const x = rulerLeft + i * segPx
    lines.push(buildLine(x, borderTop, x, borderBot, borderThick, fontColor))
  }
  return lines
}

export type RulerResult = { lines: LineData[]; labels: GlyphBatch[] }

/** The 3D render's scale, passed when a slide plane is shown there. */
export type RenderRulerScale = {
  furthestFromPivot: number
  scaleMultiplier: number
}

/**
 * Build a checkerboard scale ruler on the best 2D tile; with no 2D tile, on
 * the widest mosaic render tile ("A R 0", projected orthographically from its
 * own screen bounds), else with `renderScale` on the 3D render tile (an
 * orthographic projection, so one mm-per-pixel holds at any rotation; this is
 * how a `setSlidePlane` slide gets a scale bar). `global3d` tiles get none:
 * their camera is perspective, so no single length holds across the tile.
 * `mmPerUnit` converts scene units to mm (1e-3 for a micrometer volume, see
 * `spatialUnit`); `units` fixes the label's unit (see {@link chooseRulerSize}).
 * Returns lines and labels in canvas-pixel coordinates, or null if no ruler
 * should be drawn.
 */
export function buildRuler(
  tiles: SliceTile[],
  buildText: BuildTextFn,
  buildLine: BuildLineFn,
  fontColor: number[],
  pan2Dxyzmm: ArrayLike<number>,
  mmPerUnit = 1,
  renderScale?: RenderRulerScale,
  units: RulerUnits = 'auto',
): RulerResult | null {
  const tile = selectRulerTile(tiles)
  let ltwh: number[]
  let mmPerPx: number
  let fieldMM: number
  if (tile?.screen && tile.leftTopWidthHeight) {
    ltwh = tile.leftTopWidthHeight
    // Size against what is on screen: the 2D zoom narrows the ortho window, so
    // tileWidth / fovMM would mislabel the bar by the zoom factor.
    mmPerPx =
      mmPerPixel2D(
        tile.screen.mnMM,
        tile.screen.mxMM,
        ltwh,
        slicePanUV(pan2Dxyzmm, tile.axCorSag),
        tile.clipRot,
      ) * mmPerUnit
    // Cap by the DATA span too: a filled tile is the whole canvas, so sizing on
    // it alone grows the bar past the image whenever the volume is small. The
    // bar is horizontal, so a quarter turn caps it by the V span.
    const dataSpan = tile.screen.fovMM[(tile.clipRot ?? 0) % 180 ? 1 : 0]
    fieldMM = Math.min(ltwh[2] * mmPerPx, Math.abs(dataSpan) * mmPerUnit)
  } else {
    // A mosaic render tile's ortho window is its screen's u span across the
    // tile width (calculateMvpMatrix2D with an origin), whatever its rotation.
    let mosaic: SliceTile | null = null
    for (const t of tiles)
      if (
        t.axCorSag === SLICE_TYPE.RENDER &&
        t.space !== 'global3d' &&
        t.renderOrientation !== undefined &&
        t.screen &&
        t.leftTopWidthHeight &&
        t.leftTopWidthHeight[2] > (mosaic?.leftTopWidthHeight?.[2] ?? 0)
      )
        mosaic = t
    const render =
      renderScale &&
      tiles.find(
        (t) =>
          t.axCorSag === SLICE_TYPE.RENDER &&
          t.space !== 'global3d' &&
          t.renderOrientation === undefined &&
          t.leftTopWidthHeight,
      )
    if (mosaic?.screen && mosaic.leftTopWidthHeight) {
      ltwh = mosaic.leftTopWidthHeight
      mmPerPx =
        mmPerPixel2D(mosaic.screen.mnMM, mosaic.screen.mxMM, ltwh) * mmPerUnit
    } else if (render?.leftTopWidthHeight && renderScale) {
      ltwh = render.leftTopWidthHeight
      mmPerPx =
        mmPerPixelRender(
          ltwh,
          renderScale.furthestFromPivot,
          renderScale.scaleMultiplier,
        ) * mmPerUnit
    } else return null
    fieldMM = ltwh[2] * mmPerPx
  }
  if (!(mmPerPx > 0)) return null
  const [tileLeft, tileTop, tileWidth, tileHeight] = ltwh
  const ruler = chooseRulerSize(fieldMM, units)
  if (!ruler) return null

  const rulerPx = ruler.lengthMM / mmPerPx

  const thickness = 4

  // Position: bottom-right of tile, inset by 8px from edges
  const inset = 8
  const rulerRight = tileLeft + tileWidth - inset
  const rulerLeft = rulerRight - rulerPx
  const rulerY = tileTop + tileHeight - inset - thickness
  const lines = scaleBarLines(
    rulerLeft,
    rulerY,
    rulerPx,
    thickness,
    1,
    buildLine,
    fontColor,
  )

  // Label centred above the bar: below it ran off a tile at the canvas edge.
  const labelX = rulerLeft + rulerPx / 2
  const labelY = rulerY - thickness
  const labels: GlyphBatch[] = []
  const label = buildText(ruler.label, labelX, labelY, 0.8, fontColor, 0.5, 1)
  if (label.count > 0) labels.push(label)

  return { lines, labels }
}
