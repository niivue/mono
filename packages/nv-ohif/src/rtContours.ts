import {
  type AnnotationPoint,
  type PolygonWithHoles,
  polygonBoolean,
  type VectorAnnotation,
} from '@niivue/niivue'
import {
  addContourSegmentation,
  contourGroup,
  IN_PLANE,
  reshowContourSegmentation,
} from './contourSeg'
import { getNiivueEntry } from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'
import {
  apply,
  invertAffine,
  type RasGrid,
  rasGrid,
  SLICE_AXIS,
} from './quantify'
import {
  newellNormal,
  type RtDisplaySet,
  type RtRoi,
  rasterizeContours,
  ringInside,
  roiContours,
  roiSegment,
} from './rtDrawing'
import type { PanelSegment } from './segPanel'

// A hydrated RTSTRUCT as editable contours (cornerstone's Contour
// representation): each ROI a segment, its closed planar contours shapes on
// the base's voxel planes, the inverse of contourRois.

// A contour this far (voxels) off a slice plane is not on one.
const ON_PLANE = 0.25

/**
 * One plane's rings as polygons, by rasterizeContours' rule: a ring inside an
 * odd number of others is a hole, the rest are unioned (`xor`: even-odd).
 * Each ring is normalised first, so a keyhole ring's bridge cuts its hole.
 */
export function planePolygons(
  rings: ReadonlyArray<AnnotationPoint[]>,
  xor: boolean,
): PolygonWithHoles[] {
  const one = (ring: AnnotationPoint[]) =>
    polygonBoolean('union', [{ outer: ring, holes: [] }], [])
  if (xor)
    return rings.reduce<PolygonWithHoles[]>(
      (acc, r) => polygonBoolean('xor', acc, one(r)),
      [],
    )
  // Whole-ring containment (rtDrawing's): an overlapping ring is not nested.
  const flat = rings.map((r) =>
    Float64Array.from(r.flatMap((p) => [p.x, p.y, 0])),
  )
  const depth = flat.map(
    (r, i) => flat.filter((o, j) => j !== i && ringInside(r, o, 0, 1)).length,
  )
  // Each outer ring less the holes inside it, then unioned: a hole does not
  // cut another outer ring overlapping it (the rasterizer's signed coverage).
  const isHole = (i: number) => (depth[i] as number) % 2 === 1
  return rings
    .map((outer, i) =>
      isHole(i)
        ? []
        : rings.reduce(
            (acc, hole, j) =>
              isHole(j) &&
              ringInside(flat[j] as Float64Array, flat[i] as Float64Array, 0, 1)
                ? polygonBoolean('difference', acc, one(hole))
                : acc,
            one(outer),
          ),
    )
    .reduce<PolygonWithHoles[]>((acc, p) => polygonBoolean('union', acc, p), [])
}

/**
 * The first 255 ROIs with closed contours as segments 1.. and their shapes
 * (one per ROI and slice) on `grid`. Null when a contour is off the grid's
 * slice planes (a tilted or other series' plane): the drawing shows those.
 */
export function rtContourShapes(
  grid: Pick<RasGrid, 'dims' | 'affine'>,
  rois: ReadonlyArray<RtRoi>,
  segmentationId: string,
): {
  segments: PanelSegment[]
  shapes: VectorAnnotation[]
  truncated: boolean
} | null {
  const mm2vox = invertAffine(grid.affine)
  // LPS in (the contours' frame): RAS x and y negated.
  const lps2vox = mm2vox.map((m, i) => (i % 4 < 2 ? -m : m))
  const group = contourGroup(segmentationId)
  const segments: PanelSegment[] = []
  const shapes: VectorAnnotation[] = []
  let truncated = false
  nextRoi: for (const roi of rois) {
    const { contours, xor } = roiContours(roi)
    if (!contours.length) continue
    const value = segments.length + 1
    // Rings by plane: slice type and voxel depth.
    const planes = new Map<
      string,
      { sliceType: number; anchor: number[]; rings: AnnotationPoint[][] }
    >()
    for (const lps of contours) {
      if (lps.length < 9) continue
      const mm: number[][] = []
      const vox = new Float64Array(lps.length)
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < lps.length; i += 3) {
        const p = [
          -(lps[i] as number),
          -(lps[i + 1] as number),
          lps[i + 2] as number,
        ]
        mm.push(p)
        for (let k = 0; k < 3; k++) {
          const v = apply(mm2vox, p, k)
          vox[i + k] = v
          lo[k] = Math.min(lo[k] as number, v)
          hi[k] = Math.max(hi[k] as number, v)
        }
      }
      // Wholly off the grid: no voxels, as the drawing (and no segment slot).
      if (
        [0, 1, 2].some(
          (k) =>
            (hi[k] as number) < -0.5 ||
            (lo[k] as number) > (grid.dims[k] as number) - 0.5,
        )
      )
        continue
      // The rasterizer's plane: the axis the ring faces most (its vector
      // area, so a ring narrower than a voxel keeps its plane), else the one
      // it varies least along.
      const spread = [0, 1, 2].map((k) => (hi[k] as number) - (lo[k] as number))
      const normal = newellNormal(vox).map(Math.abs)
      const facing = normal.some((x) => x > 0) ? normal : spread.map((x) => -x)
      const d = facing.indexOf(Math.max(...facing))
      // Flat and on a slice plane (not between two).
      const depth = ((lo[d] as number) + (hi[d] as number)) / 2
      if (
        (spread[d] as number) > ON_PLANE ||
        Math.abs(depth - Math.round(depth)) > ON_PLANE
      ) {
        // A ring the drawing shows nothing for (a line, or one with
        // decimal-string noise and no reliable plane) does not reject the set.
        if (!rasterizeContours(grid.dims, lps2vox, [lps], xor).count) continue
        // Past the last slot it is a dropped ROI, not a reason to reject the set.
        if (segments.length === 255) {
          truncated = true
          break nextRoi
        }
        return null
      }
      const sliceType = SLICE_AXIS.indexOf(d)
      const [i0, i1] = IN_PLANE[sliceType] as readonly [number, number]
      const key = `${sliceType}:${Math.round(depth)}`
      const plane = planes.get(key) ?? {
        sliceType,
        anchor: mm[0] as number[],
        rings: [],
      }
      plane.rings.push(
        mm.map((p) => ({ x: p[i0] as number, y: p[i1] as number })),
      )
      planes.set(key, plane)
    }
    const first = shapes.length
    for (const { sliceType, anchor, rings } of planes.values()) {
      const polygons = planePolygons(rings, xor)
      if (!polygons.length) continue
      shapes.push({
        id: crypto.randomUUID(),
        label: value,
        group,
        sliceType,
        slicePosition: anchor[SLICE_AXIS[sliceType] as number] as number,
        anchorMM: anchor as [number, number, number],
        polygons,
        // Restyled on attach.
        style: {
          fillColor: [0, 0, 0, 0],
          strokeColor: [0, 0, 0, 0],
          strokeWidth: 1,
        },
      })
    }
    // As the drawing: an ROI with nothing to show is not a segment.
    if (shapes.length === first) continue
    // Only a drawable ROI past the last slot is a dropped one.
    if (segments.length === 255) {
      shapes.length = first
      truncated = true
      break
    }
    segments.push(roiSegment(roi, value))
  }
  return { segments, shapes, truncated }
}

/**
 * Show hydrated `rt` on `viewportId` as a contour segmentation (id: the RT
 * display set's, as the labelmap path's). Once made, contourSeg owns it (park,
 * adopt, mirror, delete). A contour off the base's planes falls back to the
 * drawing (`fallback`, startRtDrawing). Returns the cleanup.
 */
export function startRtContours(
  viewportId: string,
  rt: OhifDisplaySet,
  managers: Pick<OhifExtensionParams, 'servicesManager' | 'extensionManager'>,
  options: {
    headers?: Record<string, string>
    setNote: (message: string) => void
    whenBase: Promise<boolean>
    fallback: () => () => void
  },
): () => void {
  let cancelled = false
  let stopFallback: (() => void) | undefined
  const ds = rt as RtDisplaySet
  const segmentationId = rt.displaySetInstanceUID
  const show = async () => {
    const [, hasBase] = await Promise.all([
      ds.load?.({ headers: options.headers, createSegmentation: false }),
      options.whenBase,
    ])
    if (cancelled || !hasBase || !segmentationId) return
    if (
      reshowContourSegmentation(
        segmentationId,
        viewportId,
        managers.extensionManager,
      )
    )
      return
    const entry = getNiivueEntry(viewportId)
    const base = entry?.nv.volumes[0]
    const grid = base && rasGrid(base)
    if (!entry || !grid) return
    const rois = ds.structureSet?.ROIContours ?? []
    const r = rtContourShapes(grid, rois, segmentationId)
    if (!r) {
      stopFallback = options.fallback()
      return
    }
    if (!r.segments.length) {
      options.setNote('The structure set has no closed contours to show.')
      return
    }
    if (r.truncated)
      options.setNote(
        `Showing the first 255 of ${rois.length} ROIs (the segment range).`,
      )
    addContourSegmentation(entry, managers, {
      segmentationId,
      label: rt.SeriesDescription ?? 'RTSTRUCT',
      segments: r.segments,
      shapes: r.shapes,
    })
  }
  show().catch((err) => {
    if (cancelled) return
    console.error('[nv-ohif] RTSTRUCT load failed', err)
    options.setNote(
      `Structure set failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  return () => {
    cancelled = true
    stopFallback?.()
  }
}
