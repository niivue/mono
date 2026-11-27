import { buildLine, type LineData } from '@niivue/uikit'
import { effectiveDevicePixelRatio } from '@/devicePixelRatio'
import { log } from '@/logger'
import type NVModel from '@/NVModel'
import type { ColorbarInfo, NVViewOptions } from '@/NVTypes'
import * as NVAnnotation from '@/view/NVAnnotation'
import {
  buildColorbarLabels,
  type ColorbarLayout,
  colorbarTotalHeight,
} from '@/view/NVColorbar'
import {
  type GlyphBatch,
  HEADER_BACK_COLOR,
  resolveHeaderLabel,
} from '@/view/NVFont'
import type { NVFontRenderer } from '@/view/NVFontRenderer'
import * as NVGraph from '@/view/NVGraph'
import * as NVLegend from '@/view/NVLegend'
import { buildPlaneOutlineLines } from '@/view/NVPlaneOutline'
import * as NVRuler from '@/view/NVRuler'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import { sceneUnit } from '@/volume/utils'

/** The colorbar renderer state both backends expose. */
export type ColorbarSource = {
  getColorbarInfos(): ColorbarInfo[]
  getLayout(): ColorbarLayout
}

/** Layout state the overlay pass publishes on the view for hit testing. */
export type OverlayLayoutTarget = {
  legendLayout: NVLegend.LegendLayout | null
  graphLayout: NVGraph.GraphLayout | null
}

/** Space reserved for colorbars, legend and graph, and the tiles fitted around them. */
export type FrameLayout = {
  ix: number
  iy: number
  iw: number
  ih: number
  cbHeight: number
  legendLayout: NVLegend.LegendLayout | null
  legendWidth: number
  graphData: NVGraph.GraphData | null
  graphWidth: number
  screenSlices: NVSliceLayout.SliceTile[]
}

/**
 * Reserve vertical space for colorbars and horizontal space for the legend and
 * graph inside the inset rect, then fit the tiles into what is left. In
 * multi-instance mode (global3d) `instanceSlices` are the tiles the controller
 * already placed via `updateTilesFromInstances`; the signal graph is unused there.
 */
export function layoutFrame(
  md: NVModel,
  font: NVFontRenderer,
  colorbar: ColorbarSource,
  ix: number,
  iy: number,
  iw: number,
  ih: number,
  instanceSlices: NVSliceLayout.SliceTile[] | null,
): FrameLayout {
  const cbHeight = md.ui.isColorbarVisible
    ? colorbarTotalHeight(colorbar.getColorbarInfos(), colorbar.getLayout())
    : 0
  const legendEntries = md.collectLegendEntries()
  const legendLayout =
    md.ui.isLegendVisible && legendEntries.length > 0
      ? NVLegend.computeLegendLayout(
          legendEntries,
          iw,
          ih,
          cbHeight,
          md.legendScrollRow(),
          {
            fontPx: font.fontPx,
            measure: (label, scale) => font.measureText(label, scale),
          },
        )
      : null
  if (legendLayout) legendLayout.y += iy
  const legendWidth = legendLayout?.width ?? 0
  const graphData = md.collectGraphData()
  const baseGraphWidth = graphData
    ? NVGraph.graphTotalWidth(graphData, iw, ih)
    : 0
  let graphWidth = baseGraphWidth
  let screenSlices = instanceSlices
  if (!screenSlices) {
    const fit = NVSliceLayout.fitSlicesFromModel(
      md,
      [iw - legendWidth - baseGraphWidth, ih - cbHeight],
      baseGraphWidth,
      [ix, iy],
    )
    graphWidth = fit.graphWidth
    screenSlices = fit.screenSlices
  }
  return {
    ix,
    iy,
    iw,
    ih,
    cbHeight,
    legendLayout,
    legendWidth,
    graphData,
    graphWidth,
    screenSlices,
  }
}

/**
 * Header, colorbar, legend, graph, ruler, annotation and drag-overlay labels
 * pushed onto `labels`, their lines onto `lines`. Returns the annotation fill
 * for the caller to draw before the labels. Call only when the font is ready.
 */
export function buildOverlayText(
  view: OverlayLayoutTarget,
  md: NVModel,
  font: NVFontRenderer,
  colorbar: ColorbarSource,
  frame: FrameLayout,
  labels: GlyphBatch[],
  lines: LineData[],
  backendName: string,
  dpr: number,
  forceDevicePixelRatio: number,
  isSlidePlane: boolean,
): NVAnnotation.AnnotationRenderData | null {
  const { ix, iy, iw, ih, cbHeight, legendLayout, graphData, graphWidth } =
    frame
  const buildText = font.buildText.bind(font)
  const hasContent =
    md.getMeshes().length > 0 ||
    md.getVolumes().length > 0 ||
    md.signals.length > 0
  const headerStr = resolveHeaderLabel(
    md.ui.placeholderText,
    hasContent,
    backendName,
    log.level === 'debug',
  )
  if (headerStr !== '') {
    labels.push(
      buildText(
        headerStr,
        ix + iw * 0.5,
        iy,
        1.5,
        [0, 0, 0, 1],
        0.5,
        -0.2,
        HEADER_BACK_COLOR,
      ),
    )
  }
  if (md.ui.isColorbarVisible) {
    labels.push(
      ...buildColorbarLabels(
        colorbar.getColorbarInfos(),
        buildText,
        colorbar.getLayout(),
      ),
    )
  }
  view.legendLayout = legendLayout
  if (legendLayout) {
    // Placed once the graph's width is known.
    legendLayout.x = ix + iw - frame.legendWidth - graphWidth
    labels.push(
      ...NVLegend.buildLegendLabels(
        legendLayout,
        buildText,
        md.scene.backgroundColor,
      ),
    )
  }
  // Graph of 4D frame intensity
  if (graphData && graphWidth > 0) {
    const graphLayout = NVGraph.computeGraphLayout(
      graphData,
      iw,
      ih,
      cbHeight,
      effectiveDevicePixelRatio(forceDevicePixelRatio),
      graphWidth,
    )
    view.graphLayout =
      graphLayout && NVGraph.translateGraphLayout(graphLayout, ix, iy)
    if (view.graphLayout) {
      const graphElements = NVGraph.buildGraphElements(
        graphData,
        view.graphLayout,
        buildText,
        buildLine,
        md.scene.backgroundColor,
      )
      labels.push(...graphElements.labels)
      // One segment per sample per series: too many for an argument spread.
      for (const l of graphElements.lines) lines.push(l)
    }
  } else {
    view.graphLayout = null
  }
  if (md.ui.isRulerVisible) {
    const rulerResult = NVRuler.buildRuler(
      frame.screenSlices,
      buildText,
      buildLine,
      md.ui.fontColor,
      md.scene.pan2Dxyzmm,
      sceneUnit(md).mm,
      isSlidePlane
        ? {
            furthestFromPivot: md.furthestFromPivot,
            scaleMultiplier: md.scene.scaleMultiplier,
          }
        : undefined,
      md.ui.rulerUnits,
    )
    if (rulerResult) {
      labels.push(...rulerResult.labels)
      lines.push(...rulerResult.lines)
    }
  }
  const annotationResult = NVAnnotation.buildAnnotationRenderData(
    md,
    frame.screenSlices,
    buildLine,
    buildText,
    dpr,
    font.fontPx * 0.5,
  )
  if (annotationResult) {
    lines.push(...annotationResult.strokeLines)
    labels.push(...annotationResult.labels)
  }
  // Drag overlay: the selection box as a panel rectangle
  const overlay = md._dragOverlay
  if (overlay?.rect) {
    labels.push({
      data: new Float32Array(0),
      count: 0,
      backColor: overlay.rect.color,
      backRect: [...overlay.rect.ltwh],
      backRadius: 0,
    })
  }
  return annotationResult
}

/** Cross-lines, plane outlines and the sub-canvas bounds border, appended to `lines`. */
export function appendFrameLines(
  lines: LineData[],
  crossLines: LineData[],
  md: NVModel,
  screenSlices: NVSliceLayout.SliceTile[],
  options: NVViewOptions,
  isSubCanvas: boolean,
  width: number,
  height: number,
): void {
  for (const l of crossLines) lines.push(l)
  lines.push(
    ...buildPlaneOutlineLines(
      md.planeOutlines,
      screenSlices,
      buildLine,
      md.ui.crosshairColor,
      NVAnnotation.computeTolerance(md),
    ),
  )
  if (isSubCanvas && options.showBoundsBorder) {
    const bc = (options.boundsBorderColor as number[]) ?? [1, 1, 1, 1]
    const bt = (options.boundsBorderThickness as number) ?? 2
    lines.push(buildLine(0, 0, width, 0, bt, bc))
    lines.push(buildLine(0, height, width, height, bt, bc))
    lines.push(buildLine(0, 0, 0, height, bt, bc))
    lines.push(buildLine(width, 0, width, height, bt, bc))
  }
}
