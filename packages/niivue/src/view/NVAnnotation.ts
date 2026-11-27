import { type vec3, vec4 } from 'gl-matrix'
import {
  isOnSlice,
  slice2DToMM,
  slice2DToMMOnPlane,
} from '@/annotation/sliceProjection'
import { triangulatePolygon } from '@/annotation/triangulate'
import { slicePlaneEquation } from '@/math/NVTransforms'
import { SLICE_TYPE, sliceTypeDim } from '@/NVConstants'
import type NVModel from '@/NVModel'
import type {
  AnnotationCalibration,
  AnnotationPoint,
  AnnotationScreenShape,
  AnnotationStats,
  AnnotationTool,
  VectorAnnotation,
} from '@/NVTypes'
import type { BuildTextFn, GlyphBatch } from '@/view/NVFont'
import { projectMMToCanvas, tilePlane } from '@/view/sliceUtils'
import {
  chunkExplodeEnabled,
  explodeOffsetMMAtFrac,
} from '@/volume/ChunkExplode'
import { sceneUnit } from '@/volume/utils'
import type { BuildLineFn, LineData } from './NVLine'
import { buildRulers } from './NVMeasurement'
import type { SliceTile } from './NVSliceLayout'

export type AnnotationRenderData = {
  fillVertices: Float32Array
  fillIndices: Uint32Array
  strokeLines: LineData[]
  labels: GlyphBatch[]
}

/**
 * Get the anchor mm point for an annotation, used for isOnSlice checks.
 * Prefers the stored anchorMM (correct for sheared volumes), falls back
 * to slice2DToMM reconstruction (correct only for axis-aligned volumes).
 */
function getAnchorMM(ann: VectorAnnotation): [number, number, number] | null {
  if (ann.anchorMM) return ann.anchorMM
  const pt = ann.polygons[0]?.outer[0]
  if (!pt) return null
  return slice2DToMM(pt, ann.slicePosition, ann.sliceType)
}

export function computeTolerance(model: NVModel): number {
  const vol = model.getVolumes()[0]
  if (!vol?.pixDimsRAS) return 0.5
  const pd = vol.pixDimsRAS
  return Math.max(pd[1], pd[2], pd[3]) * 0.5
}

const CURSOR_SEGMENTS = 32

function buildBrushCursor(
  model: NVModel,
  screenSlices: SliceTile[],
  buildLine: BuildLineFn,
  strokeLines: LineData[],
  tolerance: number,
): void {
  const cursor = model._annotationCursor
  if (!cursor) return
  const cfg = model.annotation
  if (!cfg.isEnabled) return
  if (cfg.tool !== 'freehand') return
  const radius = cfg.brushRadius
  if (radius <= 0) return

  const { mm, sliceType } = cursor
  const [sr, sg, sb, sa] = cfg.isErasing
    ? ([1, 0.3, 0.3, 0.8] as const)
    : cfg.style.strokeColor
  const strokeW = cfg.style.strokeWidth

  for (const tile of screenSlices) {
    if (tile.axCorSag !== sliceType) continue
    const plane = tilePlane(tile)
    if (!plane) continue
    const { mvp, ltwh, pn, pp } = plane
    if (!isOnSlice(mm, pn, pp, tolerance)) continue

    // Generate circle points in mm-space on the slice plane
    const circleCanvas: [number, number][] = []
    for (let i = 0; i < CURSOR_SEGMENTS; i++) {
      const angle = (i / CURSOR_SEGMENTS) * Math.PI * 2
      const dx = Math.cos(angle) * radius
      const dy = Math.sin(angle) * radius
      // Offset in the two in-plane axes
      const ptMM: [number, number, number] = [mm[0], mm[1], mm[2]]
      if (sliceType === SLICE_TYPE.AXIAL) {
        ptMM[0] += dx
        ptMM[1] += dy
      } else if (sliceType === SLICE_TYPE.CORONAL) {
        ptMM[0] += dx
        ptMM[2] += dy
      } else {
        ptMM[1] += dx
        ptMM[2] += dy
      } // SAGITTAL
      circleCanvas.push(projectMMToCanvas(ptMM, mvp, ltwh))
    }

    for (let i = 0; i < CURSOR_SEGMENTS; i++) {
      const a = circleCanvas[i] as [number, number]
      const b = circleCanvas[(i + 1) % CURSOR_SEGMENTS] as [number, number]
      strokeLines.push(
        buildLine(a[0], a[1], b[0], b[1], strokeW, [sr, sg, sb, sa]),
      )
    }
  }
}

function buildSelectionHandles(
  model: NVModel,
  screenSlices: SliceTile[],
  buildLine: BuildLineFn,
  fillVerts: number[],
  fillIndices: number[],
  strokeLines: LineData[],
  startOffset: number,
  tolerance: number,
  dpr: number,
): number {
  const sel = model._annotationSelection
  if (!sel) return startOffset
  const ann = model.annotations.find((a) => a.id === sel.annotationId)
  if (!ann?.shape) return startOffset
  const handleSize = 4 * dpr // canvas pixels
  let offset = startOffset
  const anchor = getAnchorMM(ann)
  if (!anchor) return startOffset

  for (const tile of screenSlices) {
    if (tile.axCorSag !== ann.sliceType) continue
    const plane = tilePlane(tile)
    if (!plane) continue
    const { mvp, ltwh, pn, pp } = plane
    if (!isOnSlice(anchor, pn, pp, tolerance)) continue

    // Project control points to canvas using plane-aware depth
    const cpCanvas: [number, number][] = sel.controlPoints.map((cp) => {
      const mm = slice2DToMMOnPlane(cp, ann.sliceType, pn, pp)
      return projectMMToCanvas(mm, mvp, ltwh)
    })

    // Draw filled squares at each control point
    for (const [cx, cy] of cpCanvas) {
      const hs = handleSize
      fillVerts.push(cx - hs, cy - hs, 1, 1, 1, 0.9)
      fillVerts.push(cx + hs, cy - hs, 1, 1, 1, 0.9)
      fillVerts.push(cx + hs, cy + hs, 1, 1, 1, 0.9)
      fillVerts.push(cx - hs, cy + hs, 1, 1, 1, 0.9)
      fillIndices.push(offset, offset + 1, offset + 2)
      fillIndices.push(offset, offset + 2, offset + 3)
      offset += 4

      strokeLines.push(
        buildLine(cx - hs, cy - hs, cx + hs, cy - hs, 1, [0.2, 0.2, 0.2, 1]),
      )
      strokeLines.push(
        buildLine(cx + hs, cy - hs, cx + hs, cy + hs, 1, [0.2, 0.2, 0.2, 1]),
      )
      strokeLines.push(
        buildLine(cx + hs, cy + hs, cx - hs, cy + hs, 1, [0.2, 0.2, 0.2, 1]),
      )
      strokeLines.push(
        buildLine(cx - hs, cy + hs, cx - hs, cy - hs, 1, [0.2, 0.2, 0.2, 1]),
      )
    }
  }
  return offset
}

// The shapes on screen: the store (or an eraser's preview of it) plus a shape
// being drawn, minus those the host hides (annotationIsHidden).
function resolveAnnotations(model: NVModel) {
  const base = model._annotationErasePreview ?? model.annotations
  const all = model._annotationPreview
    ? [...base, model._annotationPreview]
    : base
  const isHidden = model.annotationIsHidden
  return isHidden ? all.filter((a) => !isHidden(a)) : all
}

export type Annotation3DRenderData = {
  vertices: Float32Array // (x_mm, y_mm, z_mm, r, g, b, a) per vertex = 28 bytes
  indices: Uint32Array
}

const _anchorSrc = vec4.fromValues(0, 0, 0, 1)
const _anchorTmp = vec4.create()

export function buildAnnotation3DRenderData(
  model: NVModel,
): Annotation3DRenderData | null {
  const annotations = resolveAnnotations(model)

  if (annotations.length === 0) return null
  const frac2mm = model.tex2mm
  const mm2tex = model.mm2tex

  // When the background volume is a chunked, exploded plan, shift each vertex by
  // the explode offset of the block that contains it (its un-exploded position),
  // so the vector geometry tracks its block as the volume explodes — the same
  // per-block offset the volume shader and the 3D crosshair use.
  const bgVol = model.volumes[0]
  const explodePlan =
    bgVol?.chunkPlan &&
    bgVol.matRAS &&
    mm2tex &&
    chunkExplodeEnabled(bgVol.chunkExplode)
      ? {
          plan: bgVol.chunkPlan,
          explode: bgVol.chunkExplode,
          matRAS: bgVol.matRAS,
        }
      : null

  const allVerts: number[] = []
  const allIndices: number[] = []
  let vertexOffset = 0

  for (const ann of annotations) {
    const [fr, fg, fb, fa] = ann.style.fillColor

    // Compute plane equation for this annotation's slice to get correct depth
    let planeNormal: vec3 | null = null
    let planePoint: vec3 | null = null
    if (frac2mm && mm2tex && ann.anchorMM) {
      _anchorSrc[0] = ann.anchorMM[0]
      _anchorSrc[1] = ann.anchorMM[1]
      _anchorSrc[2] = ann.anchorMM[2]
      vec4.transformMat4(_anchorTmp, _anchorSrc, mm2tex)
      const depthDim = sliceTypeDim(ann.sliceType)
      const plane = slicePlaneEquation(
        frac2mm,
        ann.sliceType,
        _anchorTmp[depthDim],
      )
      if (plane) {
        planeNormal = plane.normal
        planePoint = plane.point
      }
    }

    for (const poly of ann.polygons) {
      const { vertices, indices } = triangulatePolygon(poly.outer, poly.holes)
      const nVerts = vertices.length / 2
      for (let i = 0; i < nVerts; i++) {
        const pt: AnnotationPoint = {
          x: vertices[i * 2] as number,
          y: vertices[i * 2 + 1] as number,
        }
        const mm =
          planeNormal && planePoint
            ? slice2DToMMOnPlane(pt, ann.sliceType, planeNormal, planePoint)
            : slice2DToMM(pt, ann.slicePosition, ann.sliceType)
        if (explodePlan && mm2tex) {
          // mm -> volume texture fraction -> per-block explode offset (mm).
          _anchorSrc[0] = mm[0]
          _anchorSrc[1] = mm[1]
          _anchorSrc[2] = mm[2]
          vec4.transformMat4(_anchorTmp, _anchorSrc, mm2tex)
          const off = explodeOffsetMMAtFrac(
            explodePlan.plan,
            explodePlan.explode,
            explodePlan.matRAS,
            [_anchorTmp[0], _anchorTmp[1], _anchorTmp[2]],
          )
          mm[0] += off[0]
          mm[1] += off[1]
          mm[2] += off[2]
        }
        allVerts.push(mm[0], mm[1], mm[2], fr, fg, fb, fa)
      }
      for (let i = 0; i < indices.length; i++) {
        allIndices.push((indices[i] as number) + vertexOffset)
      }
      vertexOffset += nVerts
    }
  }

  if (allVerts.length === 0) return null

  return {
    vertices: new Float32Array(allVerts),
    indices: new Uint32Array(allIndices),
  }
}

function formatAnnotationStats(
  stats: AnnotationStats,
  unit: string,
  cal: AnnotationCalibration | null,
): string[] {
  // Integers exact (uint16 65535 must not read 65540); else 4 significant
  // digits so an SUV of 0.04 does not read 0.0.
  if (stats.value !== undefined) {
    const v = stats.value
    return [Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)))]
  }
  if (stats.angle !== undefined) return [`${stats.angle.toFixed(1)}°`]
  const s = cal?.scale ?? 1
  const lu = cal?.lengthUnit ?? unit
  if (stats.length !== undefined) {
    const len = (stats.length * s).toFixed(1)
    // Bidirectional carries both axes: long (length) + short (shortLength).
    if (stats.shortLength !== undefined) {
      return [
        `L: ${len} ${lu}`,
        `W: ${(stats.shortLength * s).toFixed(1)} ${lu}`,
      ]
    }
    return [`${len} ${lu}`]
  }
  return [
    `Area: ${(stats.area * s * s).toFixed(1)} ${cal?.areaUnit ?? `${unit}²`}`,
    `Min: ${stats.min.toFixed(1)}  Max: ${stats.max.toFixed(1)}`,
    `Mean: ${stats.mean.toFixed(1)}  SD: ${stats.stdDev.toFixed(1)}`,
  ]
}

/** The two strokes of an arrow head at `end`, `size` px long. */
function arrowHead(
  start: AnnotationPoint,
  end: AnnotationPoint,
  size: number,
  line: (p: AnnotationPoint, q: AnnotationPoint) => void,
): void {
  const len = Math.hypot(end.x - start.x, end.y - start.y)
  if (len === 0) return
  const ux = (start.x - end.x) / len
  const uy = (start.y - end.y) / len
  const c = Math.cos(Math.PI / 7)
  const s = Math.sin(Math.PI / 7)
  for (const sign of [1, -1])
    line(end, {
      x: end.x + size * (ux * c - sign * uy * s),
      y: end.y + size * (uy * c + sign * ux * s),
    })
}

/** Centre of the bottom edge of the polygons' bounding box, `gap` px below. */
function belowBox(
  polygons: readonly { outer: readonly AnnotationPoint[] }[],
  gap: number,
): AnnotationPoint {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const { outer } of polygons)
    for (const p of outer) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  return { x: (minX + maxX) / 2, y: maxY + gap }
}

export function buildAnnotationRenderData(
  model: NVModel,
  screenSlices: SliceTile[],
  buildLine: BuildLineFn,
  buildText: BuildTextFn | undefined,
  dpr: number,
  numberPx = 12,
): AnnotationRenderData | null {
  const tolerance = computeTolerance(model)
  const allFillVerts: number[] = []
  const allFillIndices: number[] = []
  const strokeLines: LineData[] = []
  const labels: GlyphBatch[] = []
  let vertexOffset = 0

  // projectAnnotationScreenShapes ran earlier this frame. With isAnnotationDrawn
  // off a host draws the shapes; the brush cursor and handles below still show.
  const shapes = model.ui.isAnnotationDrawn
    ? model._persistedAnnotationScreenShapes
    : []
  for (const shape of shapes) {
    const { polygons, style, label } = shape
    const [fr, fg, fb, fa] = style.fillColor
    const width = Math.max(1, style.strokeWidth * dpr)
    const stroke = style.strokeColor
    const line = (p: AnnotationPoint, q: AnnotationPoint) =>
      strokeLines.push(buildLine(p.x, p.y, q.x, q.y, width, stroke))
    // An open shape's polygon is its thin hit-test rectangle: drawn as centre
    // lines below, never filled (zoomed in, a fill shows as a wide band).
    if (shape.isClosed)
      for (const { outer, holes } of polygons) {
        const { vertices, indices } = triangulatePolygon(outer, holes)
        const nVerts = vertices.length / 2
        for (let i = 0; i < nVerts; i++) {
          allFillVerts.push(
            vertices[i * 2],
            vertices[i * 2 + 1],
            fr,
            fg,
            fb,
            fa,
          )
        }
        for (let i = 0; i < indices.length; i++) {
          allFillIndices.push(indices[i] + vertexOffset)
        }
        vertexOffset += nVerts
        for (const ring of [outer, ...holes])
          for (let i = 0; i < ring.length; i++)
            line(
              ring[i] as AnnotationPoint,
              ring[(i + 1) % ring.length] as AnnotationPoint,
            )
      }
    const { start, end } = shape
    if (!shape.isClosed && start && end) {
      if (
        shape.tool === 'measureLine' &&
        shape.length !== undefined &&
        buildText
      ) {
        // A measured line is a graduated ruler in the shape's own colour; its
        // label (projectAnnotations) then carries only the free text.
        const [sr, sg, sb] = stroke
        const ruler = buildRulers(
          [
            {
              sx: start.x,
              sy: start.y,
              ex: end.x,
              ey: end.y,
              distance: shape.length,
            },
          ],
          {
            measureLineColor: stroke,
            measureTextColor: [sr, sg, sb, 1],
            rulerWidth: width,
            isMeasureUnitsVisible: true,
          },
          buildText,
          buildLine,
          numberPx,
          shape.unit,
        )
        strokeLines.push(...ruler.lines)
        labels.push(...ruler.labels)
      } else {
        line(start, end)
        if (shape.tool === 'arrow') arrowHead(start, end, 12 * dpr, line)
      }
      if (shape.start2 && shape.end2) line(shape.start2, shape.end2)
    }
    if (buildText && label) {
      const [sr, sg, sb] = stroke
      const at = shape.isClosed ? belowBox(polygons, 4 * dpr) : label
      const left = !shape.isClosed && label.align === 'left'
      labels.push(
        buildText(
          label.lines.join('\n'),
          at.x,
          at.y,
          0.7,
          [sr, sg, sb, 1],
          left ? 0 : 0.5,
          // A closed shape's label hangs below its box.
          shape.isClosed ? 0 : left ? 0.5 : 1,
          [0, 0, 0, 0.6],
        ),
      )
    }
  }

  // Brush cursor circle
  buildBrushCursor(model, screenSlices, buildLine, strokeLines, tolerance)

  // Selection handles for shape annotations
  buildSelectionHandles(
    model,
    screenSlices,
    buildLine,
    allFillVerts,
    allFillIndices,
    strokeLines,
    vertexOffset,
    tolerance,
    dpr,
  )

  if (
    allFillVerts.length === 0 &&
    strokeLines.length === 0 &&
    labels.length === 0
  )
    return null

  return {
    fillVertices: new Float32Array(allFillVerts),
    fillIndices: new Uint32Array(allFillIndices),
    strokeLines,
    labels,
  }
}

// Line/arrow/bidirectional/angle are open paths; every other tool is an area shape drawn closed.
const OPEN_ANNOTATION_TOOLS: ReadonlySet<AnnotationTool> = new Set([
  'line',
  'arrow',
  'measureLine',
  'bidirectional',
  'measureBidirectional',
  'measureAngle',
  'measureCobbAngle',
])

/**
 * Free text above the stats lines. A measured line (measureLine) is drawn as a
 * graduated ruler that prints its own length, so its label is the text alone.
 */
function annotationLabelLines(
  ann: VectorAnnotation,
  unit: string,
  cal: AnnotationCalibration | null,
): string[] {
  const text = ann.text ? [ann.text] : []
  if (ann.shape?.type === 'measureLine' && ann.stats?.length !== undefined)
    return text
  return [
    ...text,
    ...(ann.stats ? formatAnnotationStats(ann.stats, unit, cal) : []),
  ]
}

/**
 * Every visible annotation projected to canvas pixels, one shape per tile that
 * shows it (a mosaic or hero layout can show it in several, #116). The single
 * source of screen geometry and label anchors for both the built-in draw and
 * annotationScreenShapes.
 */
function projectAnnotations(
  model: NVModel,
  screenSlices: readonly SliceTile[],
): AnnotationScreenShape[] {
  const shapes: AnnotationScreenShape[] = []
  const annotations = resolveAnnotations(model)
  if (annotations.length === 0) return shapes
  const unit = sceneUnit(model).label
  const cal = model.annotationCalibration
  const tolerance = computeTolerance(model)
  const anchors = annotations.map(getAnchorMM)
  for (const [tileIndex, tile] of screenSlices.entries()) {
    const plane = tilePlane(tile)
    if (!plane) continue
    const { mvp, ltwh, pn, pp } = plane
    const project = (
      pt: AnnotationPoint,
      sliceType: number,
    ): AnnotationPoint => {
      const mm = slice2DToMMOnPlane(pt, sliceType, pn, pp)
      const [x, y] = projectMMToCanvas(mm, mvp, ltwh)
      return { x, y }
    }
    for (let i = 0; i < annotations.length; i++) {
      const ann = annotations[i] as VectorAnnotation
      if (ann.sliceType !== tile.axCorSag) continue
      const anchor = anchors[i]
      if (!anchor || !isOnSlice(anchor, pn, pp, tolerance)) continue
      const polygons = ann.polygons.map((poly) => ({
        outer: poly.outer.map((pt) => project(pt, ann.sliceType)),
        holes: poly.holes.map((h) => h.map((pt) => project(pt, ann.sliceType))),
      }))
      const tool = ann.shape?.type ?? 'freehand'
      const shape: AnnotationScreenShape = {
        id: ann.id,
        tileIndex,
        tool,
        outer: polygons[0]?.outer ?? [],
        holes: polygons[0]?.holes ?? [],
        polygons,
        isClosed: !OPEN_ANNOTATION_TOOLS.has(tool),
        style: ann.style,
      }
      if (ann.shape) {
        shape.start = project(ann.shape.start, ann.sliceType)
        shape.end = project(ann.shape.end, ann.sliceType)
        if (ann.shape.start2 && ann.shape.end2) {
          shape.start2 = project(ann.shape.start2, ann.sliceType)
          shape.end2 = project(ann.shape.end2, ann.sliceType)
        }
      }
      const isMeasureLine =
        ann.shape?.type === 'measureLine' && ann.stats?.length !== undefined
      if (isMeasureLine) {
        shape.length = (ann.stats?.length ?? 0) * (cal?.scale ?? 1)
        shape.unit = cal?.lengthUnit ?? unit
      }
      const lines = annotationLabelLines(ann, unit, cal)
      if (ann.shape && shape.start && shape.end && lines.length > 0) {
        if (isMeasureLine) {
          const mid = project(
            {
              x: (ann.shape.start.x + ann.shape.end.x) / 2,
              y: (ann.shape.start.y + ann.shape.end.y) / 2,
            },
            ann.sliceType,
          )
          shape.label = { lines, x: mid.x, y: mid.y - 8, align: 'center' }
        } else if (ann.shape.type === 'arrow') {
          // Anchor the arrow's label just beyond its start (the tail), offset
          // backward (away from the arrowhead) so it does not cover the start.
          const { start: s, end: e } = shape
          const dx = s.x - e.x
          const dy = s.y - e.y
          const len = Math.hypot(dx, dy) || 1
          const off = 22
          shape.label = {
            lines,
            x: s.x + (dx / len) * off,
            y: s.y + (dy / len) * off,
            align: 'center',
          }
        } else {
          const right = project(
            {
              x: Math.max(ann.shape.start.x, ann.shape.end.x),
              y: (ann.shape.start.y + ann.shape.end.y) / 2,
            },
            ann.sliceType,
          )
          shape.label = { lines, x: right.x + 6, y: right.y, align: 'left' }
        }
      }
      shapes.push(shape)
    }
  }
  return shapes
}

/**
 * Project the annotations for this frame into
 * `model._persistedAnnotationScreenShapes`: what the built-in draw renders,
 * what pickAnnotation hit-tests, and NVControlBase.annotationScreenShapes.
 */
export function projectAnnotationScreenShapes(
  model: NVModel,
  screenSlices: SliceTile[],
): void {
  // An annotation without polygons has nothing to draw or pick.
  model._persistedAnnotationScreenShapes = projectAnnotations(
    model,
    screenSlices,
  ).filter((s) => s.polygons.length > 0)
}
