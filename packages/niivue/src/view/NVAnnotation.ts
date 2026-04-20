import { type vec3, vec4 } from "gl-matrix";
import {
  isOnSlice,
  slice2DToMM,
  slice2DToMMOnPlane,
} from "@/annotation/sliceProjection";
import { triangulatePolygon } from "@/annotation/triangulate";
import { slicePlaneEquation } from "@/math/NVTransforms";
import { SLICE_TYPE, sliceTypeDim } from "@/NVConstants";
import type NVModel from "@/NVModel";
import type {
  AnnotationPoint,
  AnnotationStats,
  VectorAnnotation,
} from "@/NVTypes";
import type { BuildTextFn, GlyphBatch } from "@/view/NVFont";
import { projectMMToCanvas } from "@/view/sliceUtils";
import type { BuildLineFn, LineData } from "./NVLine";
import type { SliceTile } from "./NVSliceLayout";

export type AnnotationRenderData = {
  fillVertices: Float32Array;
  fillIndices: Uint32Array;
  strokeLines: LineData[];
  labels: GlyphBatch[];
};

/**
 * Get the anchor mm point for an annotation, used for isOnSlice checks.
 * Prefers the stored anchorMM (correct for sheared volumes), falls back
 * to slice2DToMM reconstruction (correct only for axis-aligned volumes).
 */
function getAnchorMM(ann: VectorAnnotation): [number, number, number] | null {
  if (ann.anchorMM) return ann.anchorMM;
  const pt = ann.polygons[0]?.outer[0];
  if (!pt) return null;
  return slice2DToMM(pt, ann.slicePosition, ann.sliceType);
}

export function computeTolerance(model: NVModel): number {
  const vol = model.getVolumes()[0];
  if (!vol?.pixDimsRAS) return 0.5;
  const pd = vol.pixDimsRAS;
  return Math.max(pd[1], pd[2], pd[3]) * 0.5;
}

const CURSOR_SEGMENTS = 32;

function buildBrushCursor(
  model: NVModel,
  screenSlices: SliceTile[],
  buildLine: BuildLineFn,
  strokeLines: LineData[],
  tolerance: number,
): void {
  const cursor = model._annotationCursor;
  if (!cursor) return;
  const cfg = model.annotation;
  if (!cfg.isEnabled) return;
  if (cfg.tool !== "freehand") return;
  const radius = cfg.brushRadius;
  if (radius <= 0) return;

  const { mm, sliceType } = cursor;
  const [sr, sg, sb, sa] = cfg.isErasing
    ? ([1, 0.3, 0.3, 0.8] as const)
    : cfg.style.strokeColor;
  const strokeW = cfg.style.strokeWidth;

  for (const tile of screenSlices) {
    if (tile.axCorSag === SLICE_TYPE.RENDER) continue;
    if (tile.axCorSag !== sliceType) continue;
    if (
      !tile.mvpMatrix ||
      !tile.planeNormal ||
      !tile.planePoint ||
      !tile.leftTopWidthHeight
    )
      continue;
    if (!isOnSlice(mm, tile.planeNormal, tile.planePoint, tolerance)) continue;

    const mvp = tile.mvpMatrix;
    const ltwh = tile.leftTopWidthHeight;

    // Generate circle points in mm-space on the slice plane
    const circleCanvas: [number, number][] = [];
    for (let i = 0; i < CURSOR_SEGMENTS; i++) {
      const angle = (i / CURSOR_SEGMENTS) * Math.PI * 2;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius;
      // Offset in the two in-plane axes
      const ptMM: [number, number, number] = [mm[0], mm[1], mm[2]];
      if (sliceType === SLICE_TYPE.AXIAL) {
        ptMM[0] += dx;
        ptMM[1] += dy;
      } else if (sliceType === SLICE_TYPE.CORONAL) {
        ptMM[0] += dx;
        ptMM[2] += dy;
      } else {
        ptMM[1] += dx;
        ptMM[2] += dy;
      } // SAGITTAL
      circleCanvas.push(projectMMToCanvas(ptMM, mvp, ltwh));
    }

    for (let i = 0; i < CURSOR_SEGMENTS; i++) {
      const a = circleCanvas[i]!;
      const b = circleCanvas[(i + 1) % CURSOR_SEGMENTS]!;
      strokeLines.push(
        buildLine(a[0], a[1], b[0], b[1], strokeW, [sr, sg, sb, sa]),
      );
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
): number {
  const sel = model._annotationSelection;
  if (!sel) return startOffset;
  const ann = model.annotations.find((a) => a.id === sel.annotationId);
  if (!ann?.shape) return startOffset;
  const handleSize = 4; // pixels
  let offset = startOffset;
  const anchor = getAnchorMM(ann);
  if (!anchor) return startOffset;

  for (const tile of screenSlices) {
    if (tile.axCorSag === SLICE_TYPE.RENDER) continue;
    if (tile.axCorSag !== ann.sliceType) continue;
    if (
      !tile.mvpMatrix ||
      !tile.planeNormal ||
      !tile.planePoint ||
      !tile.leftTopWidthHeight
    )
      continue;
    if (!isOnSlice(anchor, tile.planeNormal, tile.planePoint, tolerance))
      continue;

    const mvp = tile.mvpMatrix;
    const ltwh = tile.leftTopWidthHeight;
    const pn = tile.planeNormal;
    const pp = tile.planePoint;

    // Project control points to canvas using plane-aware depth
    const cpCanvas: [number, number][] = sel.controlPoints.map((cp) => {
      const mm = slice2DToMMOnPlane(cp, ann.sliceType, pn, pp);
      return projectMMToCanvas(mm, mvp, ltwh);
    });

    // Draw filled squares at each control point
    for (const [cx, cy] of cpCanvas) {
      const hs = handleSize;
      fillVerts.push(cx - hs, cy - hs, 1, 1, 1, 0.9);
      fillVerts.push(cx + hs, cy - hs, 1, 1, 1, 0.9);
      fillVerts.push(cx + hs, cy + hs, 1, 1, 1, 0.9);
      fillVerts.push(cx - hs, cy + hs, 1, 1, 1, 0.9);
      fillIndices.push(offset, offset + 1, offset + 2);
      fillIndices.push(offset, offset + 2, offset + 3);
      offset += 4;

      strokeLines.push(
        buildLine(cx - hs, cy - hs, cx + hs, cy - hs, 1, [0.2, 0.2, 0.2, 1]),
      );
      strokeLines.push(
        buildLine(cx + hs, cy - hs, cx + hs, cy + hs, 1, [0.2, 0.2, 0.2, 1]),
      );
      strokeLines.push(
        buildLine(cx + hs, cy + hs, cx - hs, cy + hs, 1, [0.2, 0.2, 0.2, 1]),
      );
      strokeLines.push(
        buildLine(cx - hs, cy + hs, cx - hs, cy - hs, 1, [0.2, 0.2, 0.2, 1]),
      );
    }
  }
  return offset;
}

function resolveAnnotations(model: NVModel) {
  const base = model._annotationErasePreview ?? model.annotations;
  return model._annotationPreview ? [...base, model._annotationPreview] : base;
}

export type Annotation3DRenderData = {
  vertices: Float32Array; // (x_mm, y_mm, z_mm, r, g, b, a) per vertex = 28 bytes
  indices: Uint32Array;
};

const _anchorSrc = vec4.fromValues(0, 0, 0, 1);
const _anchorTmp = vec4.create();

export function buildAnnotation3DRenderData(
  model: NVModel,
): Annotation3DRenderData | null {
  const annotations = resolveAnnotations(model);

  if (annotations.length === 0) return null;
  const frac2mm = model.tex2mm;
  const mm2tex = model.mm2tex;

  const allVerts: number[] = [];
  const allIndices: number[] = [];
  let vertexOffset = 0;

  for (const ann of annotations) {
    const [fr, fg, fb, fa] = ann.style.fillColor;

    // Compute plane equation for this annotation's slice to get correct depth
    let planeNormal: vec3 | null = null;
    let planePoint: vec3 | null = null;
    if (frac2mm && mm2tex && ann.anchorMM) {
      _anchorSrc[0] = ann.anchorMM[0];
      _anchorSrc[1] = ann.anchorMM[1];
      _anchorSrc[2] = ann.anchorMM[2];
      vec4.transformMat4(_anchorTmp, _anchorSrc, mm2tex);
      const depthDim = sliceTypeDim(ann.sliceType);
      const plane = slicePlaneEquation(
        frac2mm,
        ann.sliceType,
        _anchorTmp[depthDim],
      );
      if (plane) {
        planeNormal = plane.normal;
        planePoint = plane.point;
      }
    }

    for (const poly of ann.polygons) {
      const { vertices, indices } = triangulatePolygon(poly.outer, poly.holes);
      const nVerts = vertices.length / 2;
      for (let i = 0; i < nVerts; i++) {
        const pt: AnnotationPoint = {
          x: vertices[i * 2]!,
          y: vertices[i * 2 + 1]!,
        };
        const mm =
          planeNormal && planePoint
            ? slice2DToMMOnPlane(pt, ann.sliceType, planeNormal, planePoint)
            : slice2DToMM(pt, ann.slicePosition, ann.sliceType);
        allVerts.push(mm[0], mm[1], mm[2], fr, fg, fb, fa);
      }
      for (let i = 0; i < indices.length; i++) {
        allIndices.push(indices[i]! + vertexOffset);
      }
      vertexOffset += nVerts;
    }
  }

  if (allVerts.length === 0) return null;

  return {
    vertices: new Float32Array(allVerts),
    indices: new Uint32Array(allIndices),
  };
}

function formatAnnotationStats(stats: AnnotationStats): string[] {
  if (stats.length !== undefined) {
    return [`${stats.length.toFixed(1)} mm`];
  }
  return [
    `Area: ${stats.area.toFixed(1)} mm²`,
    `Min: ${stats.min.toFixed(1)}  Max: ${stats.max.toFixed(1)}`,
    `Mean: ${stats.mean.toFixed(1)}  SD: ${stats.stdDev.toFixed(1)}`,
  ];
}

export function buildAnnotationRenderData(
  model: NVModel,
  screenSlices: SliceTile[],
  buildLine: BuildLineFn,
  buildText?: BuildTextFn,
): AnnotationRenderData | null {
  const annotations = resolveAnnotations(model);

  const tolerance = computeTolerance(model);
  const allFillVerts: number[] = [];
  const allFillIndices: number[] = [];
  const strokeLines: LineData[] = [];
  const labels: GlyphBatch[] = [];
  let vertexOffset = 0;

  // Pre-compute anchors to avoid redundant work across tiles
  const anchors = annotations.map(getAnchorMM);

  for (const tile of screenSlices) {
    if (tile.axCorSag === SLICE_TYPE.RENDER) continue;
    if (
      !tile.mvpMatrix ||
      !tile.planeNormal ||
      !tile.planePoint ||
      !tile.leftTopWidthHeight
    )
      continue;

    const mvp = tile.mvpMatrix;
    const ltwh = tile.leftTopWidthHeight;

    for (let annIdx = 0; annIdx < annotations.length; annIdx++) {
      const ann = annotations[annIdx]!;
      if (ann.sliceType !== tile.axCorSag) continue;
      const anchor = anchors[annIdx];
      if (!anchor) continue;
      if (!isOnSlice(anchor, tile.planeNormal, tile.planePoint, tolerance))
        continue;

      const [fr, fg, fb, fa] = ann.style.fillColor;
      const [sr, sg, sb, sa] = ann.style.strokeColor;
      const strokeW = ann.style.strokeWidth;

      for (let polyIdx = 0; polyIdx < ann.polygons.length; polyIdx++) {
        const poly = ann.polygons[polyIdx]!;
        // Project outer + holes to canvas coords using plane-aware depth
        const outerCanvas: AnnotationPoint[] = [];
        for (const pt of poly.outer) {
          const mm = slice2DToMMOnPlane(
            pt,
            ann.sliceType,
            tile.planeNormal,
            tile.planePoint,
          );
          const [cx, cy] = projectMMToCanvas(mm, mvp, ltwh);
          outerCanvas.push({ x: cx, y: cy });
        }

        const holesCanvas: AnnotationPoint[][] = [];
        for (const hole of poly.holes) {
          const holeCanvas: AnnotationPoint[] = [];
          for (const pt of hole) {
            const mm = slice2DToMMOnPlane(
              pt,
              ann.sliceType,
              tile.planeNormal,
              tile.planePoint,
            );
            const [cx, cy] = projectMMToCanvas(mm, mvp, ltwh);
            holeCanvas.push({ x: cx, y: cy });
          }
          holesCanvas.push(holeCanvas);
        }

        // Triangulate for fill
        const { vertices, indices } = triangulatePolygon(
          outerCanvas,
          holesCanvas,
        );
        const nVerts = vertices.length / 2;
        for (let i = 0; i < nVerts; i++) {
          allFillVerts.push(
            vertices[i * 2],
            vertices[i * 2 + 1],
            fr,
            fg,
            fb,
            fa,
          );
        }
        for (let i = 0; i < indices.length; i++) {
          allFillIndices.push(indices[i] + vertexOffset);
        }
        vertexOffset += nVerts;

        // Stroke lines for outer
        for (let i = 0; i < outerCanvas.length; i++) {
          const a = outerCanvas[i]!;
          const b = outerCanvas[(i + 1) % outerCanvas.length]!;
          strokeLines.push(
            buildLine(a.x, a.y, b.x, b.y, strokeW, [sr, sg, sb, sa]),
          );
        }

        // Stroke lines for holes
        for (const holeCanvas of holesCanvas) {
          for (let i = 0; i < holeCanvas.length; i++) {
            const a = holeCanvas[i]!;
            const b = holeCanvas[(i + 1) % holeCanvas.length]!;
            strokeLines.push(
              buildLine(a.x, a.y, b.x, b.y, strokeW, [sr, sg, sb, sa]),
            );
          }
        }
      }

      // Stats text labels for measurement annotations
      if (buildText && ann.stats && ann.shape) {
        const textLines = formatAnnotationStats(ann.stats);
        const textStr = textLines.join("\n");
        const textColor = [sr, sg, sb, 1];
        const textBack = [0, 0, 0, 0.6];
        const pn = tile.planeNormal;
        const pp = tile.planePoint;

        if (
          ann.stats.length !== undefined &&
          ann.shape.type === "measureLine"
        ) {
          const midPt: AnnotationPoint = {
            x: (ann.shape.start.x + ann.shape.end.x) / 2,
            y: (ann.shape.start.y + ann.shape.end.y) / 2,
          };
          const midMM = slice2DToMMOnPlane(midPt, ann.sliceType, pn, pp);
          const [midCx, midCy] = projectMMToCanvas(midMM, mvp, ltwh);
          labels.push(
            buildText(
              textStr,
              midCx,
              midCy - 8,
              0.7,
              textColor,
              0.5,
              1,
              textBack,
            ),
          );
        } else {
          const rightX = Math.max(ann.shape.start.x, ann.shape.end.x);
          const centerY = (ann.shape.start.y + ann.shape.end.y) / 2;
          const rightPt: AnnotationPoint = { x: rightX, y: centerY };
          const rightMM = slice2DToMMOnPlane(rightPt, ann.sliceType, pn, pp);
          const [rcx, rcy] = projectMMToCanvas(rightMM, mvp, ltwh);
          labels.push(
            buildText(textStr, rcx + 6, rcy, 0.7, textColor, 0, 0.5, textBack),
          );
        }
      }
    }
  }

  // Brush cursor circle
  buildBrushCursor(model, screenSlices, buildLine, strokeLines, tolerance);

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
  );

  if (
    allFillVerts.length === 0 &&
    strokeLines.length === 0 &&
    labels.length === 0
  )
    return null;

  return {
    fillVertices: new Float32Array(allFillVerts),
    fillIndices: new Uint32Array(allFillIndices),
    strokeLines,
    labels,
  };
}
