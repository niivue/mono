import { mat4, vec3, vec4 } from 'gl-matrix'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVMesh from '@/mesh/NVMesh'
import * as NVConstants from '@/NVConstants'
import { COLORMAP_TYPE } from '@/NVConstants'
import type {
  AnnotationConfig,
  ColorbarInfo,
  CompletedAngle,
  CompletedMeasurement,
  DragOverlay,
  DrawConfig,
  ImageFromUrlOptions,
  InteractionConfig,
  LayoutConfig,
  MeshFromUrlOptions,
  MeshRenderConfig,
  NiiVueOptions,
  NVImage,
  NVMesh as NVMeshType,
  NVSignal,
  SceneConfig,
  UIConfig,
  VectorAnnotation,
  VolumeRenderConfig,
} from '@/NVTypes'
import { deriveSeries, type SignalPlot } from '@/signal/processing'
import type { GraphData } from '@/view/NVGraph'
import * as NVLegend from '@/view/NVLegend'
import { resolveNegativeRange } from '@/view/NVUILayout'
import * as NVVolume from '@/volume/NVVolume'
import { getVoxelValue, volumeTR } from '@/volume/utils'

export default class NVModel {
  // --- Config groups ---
  scene: SceneConfig
  layout: LayoutConfig
  ui: UIConfig
  volume: VolumeRenderConfig
  mesh: MeshRenderConfig
  draw: DrawConfig
  interaction: InteractionConfig
  annotation: AnnotationConfig

  // --- Data ---
  meshes: NVMeshType[]
  volumes: NVImage[]
  signals: NVSignal[]
  /** x-axis value of the signal graph cursor (null = no selection) */
  signalCursorX: number | null
  /** per-signal derived-plot memo, keyed by display state (transient cache) */
  private _signalPlotCache = new WeakMap<
    NVSignal,
    { key: string; plot: SignalPlot }
  >()
  /** associated volume+physio graph memo, keyed by crosshair/frame/signals */
  private _assocCache: { key: string; data: GraphData } | null = null
  clipPlanes: number[]
  annotations: VectorAnnotation[]

  // --- Drawing volume (internal) ---
  drawingVolume: NVImage | null

  // --- Computed geometry ---
  furthestFromPivot: number
  pivot3D: vec3
  extentsMin: vec3
  extentsMax: vec3
  tex2mm: mat4 | null
  mm2tex: mat4 | null

  // --- Transient state ---
  /** Transient drag overlay for view rendering (controller-owned, not serialized) */
  _dragOverlay: DragOverlay | null = null
  /** Transient annotation preview for live rendering during brush strokes */
  _annotationPreview: VectorAnnotation | null = null
  /** Transient eraser preview: overrides persisted annotations during erase drag */
  _annotationErasePreview: VectorAnnotation[] | null = null
  /** Transient brush cursor for brush size preview circle */
  _annotationCursor: {
    mm: [number, number, number]
    sliceType: number
    slicePosition: number
  } | null = null
  /** Transient selection state for shape annotation resize handles */
  _annotationSelection:
    | import('@/annotation/selection').AnnotationSelection
    | null = null
  completedMeasurements: CompletedMeasurement[] = []
  completedAngles: CompletedAngle[] = []

  constructor(options: NiiVueOptions = {}) {
    // Scene — flat options mapped to scene group
    this.scene = {
      azimuth: options.azimuth ?? 110,
      elevation: options.elevation ?? 10,
      crosshairPos: options.crosshairPos
        ? vec3.fromValues(...options.crosshairPos)
        : vec3.fromValues(0.5, 0.5, 0.5),
      pan2Dxyzmm: options.pan2Dxyzmm
        ? vec4.fromValues(...options.pan2Dxyzmm)
        : vec4.fromValues(0, 0, 0, 1),
      scaleMultiplier: options.scaleMultiplier ?? 1.0,
      gamma: options.gamma ?? 1.0,
      backgroundColor: options.backgroundColor ?? [0, 0, 0, 1],
      clipPlaneColor: options.clipPlaneColor ?? [0.7, 0, 0.7, 0.4],
      isClipPlaneCutaway: options.isClipPlaneCutaway ?? false,
    }
    // Layout — flat options mapped to layout group
    this.layout = {
      ...NVConstants.LAYOUT_DEFAULTS,
      ...(options.sliceType !== undefined && { sliceType: options.sliceType }),
      ...(options.mosaicString !== undefined && {
        mosaicString: options.mosaicString,
      }),
      ...(options.showRender !== undefined && {
        showRender: options.showRender,
      }),
      ...(options.multiplanarType !== undefined && {
        multiplanarType: options.multiplanarType,
      }),
      ...(options.heroFraction !== undefined && {
        heroFraction: options.heroFraction,
      }),
      ...(options.heroSliceType !== undefined && {
        heroSliceType: options.heroSliceType,
      }),
      ...(options.isEqualSize !== undefined && {
        isEqualSize: options.isEqualSize,
      }),
      ...(options.isMosaicCentered !== undefined && {
        isMosaicCentered: options.isMosaicCentered,
      }),
      ...(options.tileMargin !== undefined && { margin: options.tileMargin }),
      ...(options.isRadiological !== undefined && {
        isRadiological: options.isRadiological,
      }),
      ...(options.customLayout !== undefined && {
        customLayout: options.customLayout ?? null,
      }),
    }
    // UI — flat options mapped to ui group
    this.ui = {
      ...NVConstants.UI_DEFAULTS,
      ...(options.isColorbarVisible !== undefined && {
        isColorbarVisible: options.isColorbarVisible,
      }),
      ...(options.isOrientCubeVisible !== undefined && {
        isOrientCubeVisible: options.isOrientCubeVisible,
      }),
      ...(options.isOrientationTextVisible !== undefined && {
        isOrientationTextVisible: options.isOrientationTextVisible,
      }),
      ...(options.is3DCrosshairVisible !== undefined && {
        is3DCrosshairVisible: options.is3DCrosshairVisible,
      }),
      ...(options.isGraphVisible !== undefined && {
        isGraphVisible: options.isGraphVisible,
      }),
      ...(options.isRulerVisible !== undefined && {
        isRulerVisible: options.isRulerVisible,
      }),
      ...(options.isCrossLinesVisible !== undefined && {
        isCrossLinesVisible: options.isCrossLinesVisible,
      }),
      ...(options.isLegendVisible !== undefined && {
        isLegendVisible: options.isLegendVisible,
      }),
      ...(options.isPositionInMM !== undefined && {
        isPositionInMM: options.isPositionInMM,
      }),
      ...(options.isMeasureUnitsVisible !== undefined && {
        isMeasureUnitsVisible: options.isMeasureUnitsVisible,
      }),
      ...(options.isThumbnailVisible !== undefined && {
        isThumbnailVisible: options.isThumbnailVisible,
      }),
      ...(options.thumbnailUrl !== undefined && {
        thumbnailUrl: options.thumbnailUrl,
      }),
      ...(options.placeholderText !== undefined && {
        placeholderText: options.placeholderText,
      }),
      ...(options.crosshairColor !== undefined && {
        crosshairColor: options.crosshairColor,
      }),
      ...(options.crosshairGap !== undefined && {
        crosshairGap: options.crosshairGap,
      }),
      ...(options.crosshairWidth !== undefined && {
        crosshairWidth: options.crosshairWidth,
      }),
      ...(options.fontColor !== undefined && { fontColor: options.fontColor }),
      ...(options.fontScale !== undefined && { fontScale: options.fontScale }),
      ...(options.fontMinSize !== undefined && {
        fontMinSize: options.fontMinSize,
      }),
      ...(options.selectionBoxColor !== undefined && {
        selectionBoxColor: options.selectionBoxColor,
      }),
      ...(options.measureLineColor !== undefined && {
        measureLineColor: options.measureLineColor,
      }),
      ...(options.measureTextColor !== undefined && {
        measureTextColor: options.measureTextColor,
      }),
      ...(options.rulerWidth !== undefined && {
        rulerWidth: options.rulerWidth,
      }),
      ...((options.graphNormalizeValues !== undefined ||
        options.graphIsRangeCalMinMax !== undefined) && {
        graph: {
          ...NVConstants.UI_DEFAULTS.graph,
          ...(options.graphNormalizeValues !== undefined && {
            normalizeValues: options.graphNormalizeValues,
          }),
          ...(options.graphIsRangeCalMinMax !== undefined && {
            isRangeCalMinMax: options.graphIsRangeCalMinMax,
          }),
        },
      }),
    }
    // Volume — flat options mapped to volume group
    this.volume = {
      ...NVConstants.VOLUME_DEFAULTS,
      ...(options.volumeIllumination !== undefined && {
        illumination: options.volumeIllumination,
      }),
      ...(options.volumeOutlineWidth !== undefined && {
        outlineWidth: options.volumeOutlineWidth,
      }),
      ...(options.volumeAlphaShader !== undefined && {
        alphaShader: options.volumeAlphaShader,
      }),
      ...(options.volumeIsBackgroundMasking !== undefined && {
        isBackgroundMasking: options.volumeIsBackgroundMasking,
      }),
      ...(options.volumeIsAlphaClipDark !== undefined && {
        isAlphaClipDark: options.volumeIsAlphaClipDark,
      }),
      ...(options.volumeIsNearestInterpolation !== undefined && {
        isNearestInterpolation: options.volumeIsNearestInterpolation,
      }),
      ...(options.volumeIsV1SliceShader !== undefined && {
        isV1SliceShader: options.volumeIsV1SliceShader,
      }),
      ...(options.volumeMatcap !== undefined && {
        matcap: options.volumeMatcap,
      }),
      ...(options.volumePaqdUniforms !== undefined && {
        paqdUniforms: options.volumePaqdUniforms,
      }),
    }
    // Mesh — flat options mapped to mesh group
    this.mesh = {
      ...NVConstants.MESH_DEFAULTS,
      ...(options.meshXRay !== undefined && { xRay: options.meshXRay }),
      ...(options.meshThicknessOn2D !== undefined && {
        thicknessOn2D: options.meshThicknessOn2D,
      }),
    }
    // Draw — flat options mapped to draw group
    this.draw = {
      ...NVConstants.DRAW_DEFAULTS,
      ...(options.drawIsEnabled !== undefined && {
        isEnabled: options.drawIsEnabled,
      }),
      ...(options.drawPenValue !== undefined && {
        penValue: options.drawPenValue,
      }),
      ...(options.drawPenSize !== undefined && {
        penSize: options.drawPenSize,
      }),
      ...(options.drawIsFillOverwriting !== undefined && {
        isFillOverwriting: options.drawIsFillOverwriting,
      }),
      ...(options.drawOpacity !== undefined && {
        opacity: options.drawOpacity,
      }),
      ...(options.drawRimOpacity !== undefined && {
        rimOpacity: options.drawRimOpacity,
      }),
      ...(options.drawColormap !== undefined && {
        colormap: options.drawColormap,
      }),
    }
    // Interaction — flat options mapped to interaction group
    this.interaction = {
      ...NVConstants.INTERACTION_DEFAULTS,
      ...(options.primaryDragMode !== undefined && {
        primaryDragMode: options.primaryDragMode,
      }),
      ...(options.secondaryDragMode !== undefined && {
        secondaryDragMode: options.secondaryDragMode,
      }),
      ...(options.isSnapToVoxelCenters !== undefined && {
        isSnapToVoxelCenters: options.isSnapToVoxelCenters,
      }),
      ...(options.isYoked3DTo2DZoom !== undefined && {
        isYoked3DTo2DZoom: options.isYoked3DTo2DZoom,
      }),
      ...(options.isDragDropEnabled !== undefined && {
        isDragDropEnabled: options.isDragDropEnabled,
      }),
    }
    // Annotation — flat options mapped to annotation group
    this.annotation = {
      ...NVConstants.ANNOTATION_DEFAULTS,
      ...(options.annotationIsEnabled !== undefined && {
        isEnabled: options.annotationIsEnabled,
      }),
      ...(options.annotationActiveLabel !== undefined && {
        activeLabel: options.annotationActiveLabel,
      }),
      ...(options.annotationActiveGroup !== undefined && {
        activeGroup: options.annotationActiveGroup,
      }),
      ...(options.annotationBrushRadius !== undefined && {
        brushRadius: options.annotationBrushRadius,
      }),
      ...(options.annotationIsErasing !== undefined && {
        isErasing: options.annotationIsErasing,
      }),
      ...(options.annotationTool !== undefined && {
        tool: options.annotationTool,
      }),
      ...(options.annotationStyle !== undefined && {
        style: options.annotationStyle,
      }),
      ...(options.annotationIsVisibleIn3D !== undefined && {
        isVisibleIn3D: options.annotationIsVisibleIn3D,
      }),
    }
    this.drawingVolume = null
    this.annotations = []
    this.meshes = []
    this.volumes = []
    this.signals = []
    this.signalCursorX = null
    this.clipPlanes = Array(NVConstants.NUM_CLIP_PLANE)
      .fill(null)
      .flatMap(() => [...NVConstants.DEFAULT_CLIP_PLANE])
    this.furthestFromPivot = 1.0
    this.pivot3D = vec3.create()
    this.extentsMin = vec3.create()
    this.extentsMax = vec3.create()
    this.tex2mm = null
    this.mm2tex = null
    this._setupPivot3D()
  }

  getMeshes(): NVMeshType[] {
    return this.meshes
  }

  getVolumes(): NVImage[] {
    return this.volumes
  }

  getSignals(): NVSignal[] {
    return this.signals
  }

  getSignal(id: string): NVSignal | undefined {
    return this.signals.find((s) => s.id === id)
  }

  /** Add a signal, ensuring its id is unique within the model. */
  addSignal(signal: NVSignal): void {
    let id = signal.id
    let n = 1
    while (this.signals.some((s) => s.id === id)) id = `${signal.id}-${n++}`
    signal.id = id
    this.signals.push(signal)
  }

  removeSignal(index: number): NVSignal | null {
    if (index < 0 || index >= this.signals.length) return null
    const [removed] = this.signals.splice(index, 1)
    // The cursor belonged to the previous signal set; clear it.
    this.signalCursorX = null
    return removed
  }

  /** True when a signal is loaded but no spatial data (volume/mesh) is. */
  isSignalOnlyScene(): boolean {
    return (
      this.signals.length > 0 &&
      this.volumes.length === 0 &&
      this.meshes.length === 0
    )
  }

  getClipPlaneDepthAziElev(clipPlaneIndex = 0): [number, number, number] {
    if (clipPlaneIndex < 0 || clipPlaneIndex >= NVConstants.NUM_CLIP_PLANE) {
      clipPlaneIndex = 0
    }
    const offset = clipPlaneIndex * 4
    const x = this.clipPlanes[offset + 0]
    const y = this.clipPlanes[offset + 1]
    const z = this.clipPlanes[offset + 2]
    const depth = this.clipPlanes[offset + 3]
    const ret = NVTransforms.cart2sphDeg(x, y, z)
    return [-depth, ret[0], ret[1]]
  }

  scene2mm(inPos: ArrayLike<number>): vec3 {
    const outPos = vec3.create()
    for (let i = 0; i < 3; i++) {
      outPos[i] =
        this.extentsMin[i] +
        inPos[i] * (this.extentsMax[i] - this.extentsMin[i])
    }
    return outPos
  }

  scene2vox(frac: ArrayLike<number>): number[] {
    if (this.volumes.length === 0) return [0, 0, 0]
    const mm = this.scene2mm(frac)
    const vox = NVTransforms.mm2vox(this.volumes[0], mm)
    return [vox[0], vox[1], vox[2]]
  }

  mm2scene(inPos: ArrayLike<number>): vec3 {
    const outPos = vec3.create()
    for (let i = 0; i < 3; i++) {
      const denom = this.extentsMax[i] - this.extentsMin[i]
      outPos[i] = denom !== 0 ? (inPos[i] - this.extentsMin[i]) / denom : 0
    }
    return outPos
  }

  /**
   * Convert scene fraction crosshairPos to volume texture fraction for the
   * given slice dimension. For axis-aligned volumes this returns the same value;
   * for sheared/oblique volumes the scene AABB fraction differs from the
   * volume's texture coordinate, and this method corrects for that.
   */
  getSliceTexFrac(sliceDim: number): number {
    const sceneFrac = this.scene.crosshairPos[sliceDim]
    if (!this.mm2tex) return sceneFrac
    const mm = this.scene2mm(this.scene.crosshairPos)
    const tmp = vec4.create()
    vec4.transformMat4(
      tmp,
      vec4.fromValues(mm[0], mm[1], mm[2], 1),
      this.mm2tex,
    )
    return tmp[sliceDim]
  }

  getSliceTexFracAtMM(sliceDim: number, mm: number): number {
    if (!this.mm2tex) {
      const denom = this.extentsMax[sliceDim] - this.extentsMin[sliceDim]
      return denom !== 0 ? (mm - this.extentsMin[sliceDim]) / denom : 0
    }
    const crossMM = this.scene2mm(this.scene.crosshairPos)
    crossMM[sliceDim] = mm
    const tmp = vec4.create()
    vec4.transformMat4(
      tmp,
      vec4.fromValues(crossMM[0], crossMM[1], crossMM[2], 1),
      this.mm2tex,
    )
    return tmp[sliceDim]
  }

  sceneExtentsMinMax(): [vec3, vec3, vec3] {
    const range = vec3.create()
    vec3.subtract(range, this.extentsMax, this.extentsMin)
    return [this.extentsMin, this.extentsMax, range]
  }

  setClipPlaneDepthAziElev(
    depth: number,
    azimuth: number,
    elevation: number,
    clipPlaneIndex = 0,
  ): void {
    if (clipPlaneIndex < 0 || clipPlaneIndex >= NVConstants.NUM_CLIP_PLANE) {
      clipPlaneIndex = 0
    }
    const clip = NVTransforms.depthAziElevToClipPlane(depth, azimuth, elevation)
    const offset = clipPlaneIndex * 4
    this.clipPlanes[offset + 0] = clip[0]
    this.clipPlanes[offset + 1] = clip[1]
    this.clipPlanes[offset + 2] = clip[2]
    this.clipPlanes[offset + 3] = clip[3]
  }

  _setupPivot3D(): void {
    let extentsMin = vec3.fromValues(Infinity, Infinity, Infinity)
    let extentsMax = vec3.fromValues(-Infinity, -Infinity, -Infinity)
    for (const v of this.volumes) {
      vec3.min(extentsMin, extentsMin, v.extentsMin)
      vec3.max(extentsMax, extentsMax, v.extentsMax)
    }
    for (const m of this.meshes) {
      vec3.min(extentsMin, extentsMin, m.extentsMin)
      vec3.max(extentsMax, extentsMax, m.extentsMax)
    }
    const isInvalid =
      extentsMin[0] > extentsMax[0] ||
      extentsMin[1] > extentsMax[1] ||
      extentsMin[2] > extentsMax[2]
    if (isInvalid) {
      if (this.meshes.length > 0 || this.volumes.length > 0) {
        log.warn(`spatial dimensions not defined correctly`)
      }
      extentsMin = vec3.fromValues(100, 100, 100)
      extentsMax = vec3.fromValues(-100, -100, -100)
    }
    const pivot3D = vec3.create()
    vec3.add(pivot3D, extentsMin, extentsMax)
    vec3.scale(pivot3D, pivot3D, 0.5)
    this.furthestFromPivot = vec3.distance(pivot3D, extentsMax)
    this.pivot3D = pivot3D
    this.extentsMin = extentsMin
    this.extentsMax = extentsMax
    this.tex2mm = this.volumes[0]?.frac2mm
      ? mat4.clone(this.volumes[0].frac2mm as mat4)
      : null
    if (this.tex2mm) {
      const inv = mat4.create()
      if (mat4.invert(inv, this.tex2mm)) {
        this.mm2tex = inv
      } else {
        this.mm2tex = null
      }
    } else {
      this.mm2tex = null
    }
  }

  _releaseGPU(obj: Record<string, unknown>): void {
    const gpu = (obj as { gpu?: Record<string, unknown> | null }).gpu
    if (gpu) {
      for (const [, resource] of Object.entries(gpu)) {
        if (
          resource &&
          typeof (resource as { destroy?: () => void }).destroy === 'function'
        ) {
          ;(resource as { destroy: () => void }).destroy()
        }
      }
      delete (obj as { gpu?: Record<string, unknown> }).gpu // Clean reference
    }
  }

  clearAllGPUResources(): void {
    for (const mesh of this.meshes) {
      this._releaseGPU(mesh)
    }
    for (const vol of this.volumes) {
      this._releaseGPU(vol)
      vol.isDirty = true
    }
  }

  collectColorbars(): ColorbarInfo[] {
    const bars: ColorbarInfo[] = []
    for (const v of this.volumes) {
      if (v.isColorbarVisible === false) continue
      if (v.colormapLabel) continue // Label volumes don't show colorbars
      const ct = v.colormapType ?? COLORMAP_TYPE.MIN_TO_MAX
      const isZeroBased = ct !== COLORMAP_TYPE.MIN_TO_MAX
      bars.push({
        colormapName: v.colormap ?? 'Gray',
        min: isZeroBased ? 0 : v.calMin,
        max: v.calMax,
        thresholdMin: isZeroBased ? v.calMin : undefined,
      })
      if (v.colormapNegative) {
        const [negThresh, negMaxColor] = resolveNegativeRange(
          v.calMin,
          v.calMax,
          v.calMinNeg as number,
          v.calMaxNeg as number,
        )
        bars.push({
          colormapName: v.colormapNegative,
          min: isZeroBased ? 0 : negThresh,
          max: negMaxColor,
          thresholdMin: isZeroBased ? negThresh : undefined,
          isNegative: true,
        })
      }
    }
    for (const m of this.meshes) {
      // Connectome colorbars: node and edge colormaps
      if (
        m.kind === 'connectome' &&
        m.connectomeOptions &&
        m.isColorbarVisible !== false
      ) {
        const co = m.connectomeOptions
        bars.push({
          colormapName: co.nodeColormap,
          min: co.nodeMinColor,
          max: co.nodeMaxColor,
        })
        if (m.jcon && m.jcon.edges.length > 0) {
          bars.push({
            colormapName: co.edgeColormap,
            min: co.edgeMin,
            max: co.edgeMax,
          })
        }
        continue
      }
      // Tract colorbars: scalar colormap when colorBy is set
      if (
        m.kind === 'tract' &&
        m.tractOptions &&
        m.isColorbarVisible !== false &&
        m.tractOptions.colorBy
      ) {
        const to = m.tractOptions
        bars.push({
          colormapName: to.colormap,
          min: to.calMin,
          max: to.calMax,
        })
        continue
      }
      if (!m.layers) continue
      for (const layer of m.layers) {
        if (!layer.isColorbarVisible || layer.opacity <= 0) continue
        if (layer.colormapLabel) continue
        const ct =
          layer.colormapType ?? COLORMAP_TYPE.ZERO_TO_MAX_TRANSPARENT_BELOW_MIN
        const isZeroBased = ct !== COLORMAP_TYPE.MIN_TO_MAX
        bars.push({
          colormapName: layer.colormap,
          min: isZeroBased ? 0 : layer.calMin,
          max: layer.calMax,
          thresholdMin: isZeroBased ? layer.calMin : undefined,
        })
        if (layer.colormapNegative) {
          const [negThresh, negMaxColor] = resolveNegativeRange(
            layer.calMin,
            layer.calMax,
            layer.calMinNeg,
            layer.calMaxNeg,
          )
          bars.push({
            colormapName: layer.colormapNegative,
            min: isZeroBased ? 0 : negThresh,
            max: negMaxColor,
            thresholdMin: isZeroBased ? negThresh : undefined,
            isNegative: true,
          })
        }
      }
    }
    return bars
  }

  collectLegendEntries(): NVLegend.LegendEntry[] {
    if (!this.ui.isLegendVisible) return []
    return NVLegend.collectLegendEntries(this.meshes, this.volumes)
  }

  /** Returns the maximum nFrame4D across all volumes, or 0 if none. */
  getMaxVols(): number {
    let maxVols = 0
    for (const v of this.volumes) {
      maxVols = Math.max(maxVols, v.nFrame4D ?? 1)
    }
    return maxVols
  }

  /**
   * Derive (and memoize) a signal's plot. Cached by the signal's display state
   * so repeated graph collections during interaction skip the FFT/averaging
   * work; the cache is keyed per-signal and drops with the signal (WeakMap).
   */
  private derivePlotCached(sig: NVSignal): SignalPlot {
    const key = JSON.stringify(sig.display)
    const cached = this._signalPlotCache.get(sig)
    if (cached && cached.key === key) return cached.plot
    const plot = deriveSeries(sig.raw, sig.display)
    this._signalPlotCache.set(sig, { key, plot })
    return plot
  }

  /**
   * Build multi-series graph data by merging the traces of every loaded signal
   * onto a shared axis, or null when no signal is loaded. Series are derived on
   * demand (memoized by display state) from the raw data and current display
   * state (FFT/averaging/windowing for spectroscopy, time-axis selection for
   * physio). Merging supports showing multiple physiological recordings (e.g.
   * cardiac + respiratory at different sampling rates) on one time axis,
   * distinguished by the legend.
   */
  collectSignalGraphData(): GraphData | null {
    if (this.signals.length === 0) return null
    // Only signals whose axis matches the first signal's are merged, so a
    // ppm spectrum and a time-axis physio trace never share one (misleading)
    // axis. Incompatible signals are skipped (use one instance each, or a
    // future multi-panel layout).
    const axis = { ...this.derivePlotCached(this.signals[0]).axis }
    const series: GraphData['series'] = []
    const annotations: GraphData['annotations'] = []
    const mins: number[] = []
    const maxs: number[] = []
    let merged = 0
    for (const sig of this.signals) {
      const plot = this.derivePlotCached(sig)
      if (
        plot.axis.label !== axis.label ||
        plot.axis.reversed !== axis.reversed
      ) {
        continue
      }
      merged++
      for (const s of plot.series) {
        series.push({ label: s.label, x: s.x, y: s.y, color: s.color })
      }
      // Annotations live in the signal's axis units, so only merge those whose
      // signal shares the common axis (skipped above for incompatible signals).
      for (const a of sig.annotations ?? []) {
        annotations.push({ text: a.text, x: a.x, y: a.y, color: a.color })
      }
      if (plot.axis.min !== null) mins.push(plot.axis.min)
      if (plot.axis.max !== null) maxs.push(plot.axis.max)
    }
    if (series.length === 0) return null
    // Use an explicit window only when every merged signal supplied one;
    // otherwise autoscale across the merged data.
    axis.min = mins.length === merged ? Math.min(...mins) : null
    axis.max = maxs.length === merged ? Math.max(...maxs) : null
    return {
      lines: [],
      selectedColumn: -1,
      calMin: 0,
      calMax: 0,
      nTotalFrame4D: 0,
      graphConfig: this.ui.graph,
      series,
      xAxis: axis,
      showLegend: this.signals[0].display.showLegend,
      // With no spatial data, let the plot fill the whole instance area.
      fullCanvas: this.isSignalOnlyScene(),
      cursorX: this.signalCursorX,
      annotations: annotations.length > 0 ? annotations : undefined,
    }
  }

  /** Min-max normalize a series to [0,1] over the samples inside [lo,hi]. */
  private normalizeWindow(
    x: Float32Array,
    y: Float32Array,
    lo: number,
    hi: number,
  ): Float32Array {
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    for (let i = 0; i < y.length; i++) {
      if (x[i] < lo || x[i] > hi || !Number.isFinite(y[i])) continue
      if (y[i] < mn) mn = y[i]
      if (y[i] > mx) mx = y[i]
    }
    const out = new Float32Array(y.length)
    if (!(mx > mn)) return out
    const r = mx - mn
    for (let i = 0; i < y.length; i++) out[i] = (y[i] - mn) / r
    return out
  }

  /** The 4D volume a loaded physio signal is attached to, if any. */
  getAssociatedVolume(): NVImage | null {
    if (this.signals.length === 0 || this.volumes.length === 0) return null
    for (const s of this.signals) {
      if (!s.attachedToId) continue
      const v = this.volumes.find((vv) => vv.id === s.attachedToId)
      if (v && (v.nFrame4D ?? 1) > 1) return v
    }
    return null
  }

  /**
   * Sample a 4D volume's voxel time-course at the current crosshair. Returns one
   * value per frame, or null if the volume lacks the RAS transform needed to map
   * the crosshair to a voxel.
   */
  private sampleVolumeTimeCourse(vol: NVImage): Float32Array | null {
    if (!vol.matRAS) return null
    const nFrames = vol.nFrame4D ?? 1
    const mm = this.scene2mm(this.scene.crosshairPos)
    const rasVox = NVTransforms.mm2vox(vol, mm)
    const y = new Float32Array(nFrames)
    for (let j = 0; j < nFrames; j++) {
      y[j] = getVoxelValue(vol, rasVox[0], rasVox[1], rasVox[2], j)
    }
    return y
  }

  /**
   * When a physio signal is associated with a loaded 4D volume (via
   * `attachedToId`), build a combined time-axis graph: the volume's crosshair
   * time-course (frame i at i*TR seconds, t=0 = first volume) plus each attached
   * physio trace at its native sampling rate (no resampling). The window is
   * clamped to the imaging period [0, (nFrames-1)*TR], so physio samples logged
   * before/after the scan are ignored. Each series is min-max normalized to
   * [0,1] so the very different magnitudes (BOLD intensity vs cardiac/respiratory
   * counts) are all visible; `rawY` carries the un-normalized values for the
   * cursor readout. A cursor marks the current frame's time. Returns null when
   * no such association exists.
   */
  /** True if any finite sample of (x,y) falls inside [lo,hi]. */
  private hasWindowSamples(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    lo: number,
    hi: number,
  ): boolean {
    for (let i = 0; i < y.length; i++) {
      if (x[i] >= lo && x[i] <= hi && Number.isFinite(y[i])) return true
    }
    return false
  }

  collectAssociatedTimeGraphData(): GraphData | null {
    const vol = this.getAssociatedVolume()
    if (!vol) return null
    // Memoize: this is rebuilt on every crosshair/frame change (and again by the
    // renderer in the same frame). Key on the inputs so repeated calls with no
    // change return the cached graph instead of resampling/normalizing again.
    const cp = this.scene.crosshairPos
    const attached = this.signals.filter((s) => s.attachedToId === vol.id)
    const key = `${vol.id}|${vol.frame4D ?? 0}|${cp[0]},${cp[1]},${cp[2]}|${attached
      .map((s) => `${s.id}:${JSON.stringify(s.display)}`)
      .join(';')}`
    if (this._assocCache && this._assocCache.key === key) {
      return this._assocCache.data
    }
    const vy = this.sampleVolumeTimeCourse(vol)
    if (!vy) return null
    const nFrames = vol.nFrame4D ?? 1
    const tr = volumeTR(vol)
    const tMax = (nFrames - 1) * tr
    const series: GraphData['series'] = []
    // 1) Volume time-course at the crosshair.
    const vx = new Float32Array(nFrames)
    for (let j = 0; j < nFrames; j++) vx[j] = j * tr
    series.push({
      label: 'BOLD',
      x: vx,
      y: this.normalizeWindow(vx, vy, 0, tMax),
      rawY: vy,
    })
    // 2) Each attached physio trace at its native rate, clamped + normalized.
    //    Skip traces with no samples inside the imaging window (they would not
    //    draw and could otherwise feed an out-of-window readout).
    for (const s of attached) {
      const plot = this.derivePlotCached(s)
      if (plot.axis.label !== 'Time (s)') continue
      for (const ps of plot.series) {
        if (!ps.x || !this.hasWindowSamples(ps.x, ps.y, 0, tMax)) continue
        series.push({
          label: ps.label,
          x: ps.x,
          y: this.normalizeWindow(ps.x, ps.y, 0, tMax),
          rawY: ps.y,
        })
      }
    }
    if (series.length < 2) return null // need the volume plus >=1 physio trace
    const data: GraphData = {
      lines: [],
      selectedColumn: -1,
      calMin: 0,
      calMax: 0,
      nTotalFrame4D: 0,
      graphConfig: this.ui.graph,
      series,
      xAxis: { label: 'Time (s)', reversed: false, min: 0, max: tMax },
      showLegend: true,
      fullCanvas: false,
      // Marker at the current frame's time ties 4D scrubbing to the time axis.
      cursorX: (vol.frame4D ?? 0) * tr,
    }
    this._assocCache = { key, data }
    return data
  }

  /**
   * Collect graph data. Prefers an associated volume+physio time view, then a
   * signal-only (multi-series) graph, otherwise per-frame voxel intensities at
   * the current crosshair for the first 4D volume. Returns null if the graph is
   * disabled or there is nothing to plot.
   */
  collectGraphData(): GraphData | null {
    if (!this.ui.isGraphVisible) return null
    const associated = this.collectAssociatedTimeGraphData()
    if (associated) return associated
    const signalData = this.collectSignalGraphData()
    if (signalData) return signalData
    if (this.getMaxVols() < 2) return null
    const vol = this.volumes[0]
    if (!vol) return null
    const nFrames = vol.nFrame4D ?? 1
    if (nFrames < 2) return null
    const sampled = this.sampleVolumeTimeCourse(vol)
    if (!sampled) return null
    const line = Array.from(sampled)
    return {
      lines: [line],
      selectedColumn: vol.frame4D ?? 0,
      calMin: vol.calMin,
      calMax: vol.calMax,
      nTotalFrame4D: vol.nTotalFrame4D ?? nFrames,
      graphConfig: this.ui.graph,
    }
  }

  removeMesh(index: number): void {
    if (index < 0 || index >= this.meshes.length) return
    this._releaseGPU(this.meshes[index])
    this.meshes.splice(index, 1)
    this._setupPivot3D()
  }

  removeAllMeshes(): void {
    for (const m of this.meshes) {
      this._releaseGPU(m)
    }
    this.meshes = []
    this._setupPivot3D()
  }

  async addMesh(mesh: MeshFromUrlOptions | NVMeshType): Promise<void> {
    // Check if this is already a fully-formed NVMesh (has positions property)
    if ('positions' in mesh && mesh.positions) {
      this.meshes.push(mesh as NVMeshType)
      this._setupPivot3D()
      return
    }

    // Otherwise treat as MeshFromUrlOptions and load from URL
    try {
      const msh = await NVMesh.loadMesh(mesh as MeshFromUrlOptions)
      this.meshes.push(msh)
    } catch (e) {
      const opts = mesh as MeshFromUrlOptions
      const urlString = typeof opts.url === 'string' ? opts.url : opts.url.name
      log.error(`Failed to load mesh: ${urlString}`, e)
    }
    this._setupPivot3D()
  }

  removeVolume(index: number): void {
    if (index < 0 || index >= this.volumes.length) return
    this._releaseGPU(this.volumes[index])
    this.volumes.splice(index, 1)
    this._setupPivot3D()
  }

  /**
   * Move a volume from one index to another.
   * Returns true if the order changed, false if the move was a no-op.
   */
  moveVolume(fromIndex: number, toIndex: number): boolean {
    if (fromIndex < 0 || fromIndex >= this.volumes.length) return false
    // Clamp target to valid range
    toIndex = Math.max(0, Math.min(toIndex, this.volumes.length - 1))
    if (fromIndex === toIndex) return false
    const [vol] = this.volumes.splice(fromIndex, 1)
    this.volumes.splice(toIndex, 0, vol)
    this._setupPivot3D()
    return true
  }

  async removeAllVolumes(): Promise<void> {
    if (this.volumes.length === 0) return
    for (const vol of this.volumes) {
      vol.img = null
      this._releaseGPU(vol)
    }
    this.volumes = []
    this._setupPivot3D()
  }

  static readonly volumeDefaults = {
    opacity: 1.0,
    colormap: 'Gray',
    colormapNegative: '',
    calMinNeg: NaN,
    calMaxNeg: NaN,
    colormapType: 0,
    isTransparentBelowCalMin: true,
    modulateAlpha: 0,
    isDirty: true,
    isColorbarVisible: true,
  }

  /** Fetch and prepare an NVImage without adding it to the model. */
  static async prepareVolume(
    volume: ImageFromUrlOptions | NVImage,
  ): Promise<NVImage> {
    if ('hdr' in volume && volume.hdr) {
      return { ...NVModel.volumeDefaults, ...volume }
    }
    const opts = volume as ImageFromUrlOptions
    const { url, urlImageData, limitFrames4D, ...overrides } = opts
    if (!url) {
      throw new Error('prepareVolume requires a url or an NVImage object')
    }
    const nii = await NVVolume.loadVolume(url, urlImageData ?? null)
    const urlString = typeof url === 'string' ? url : url.name
    const name = overrides.name ?? urlString
    const base = NVVolume.nii2volume(nii.hdr, nii.img, name, limitFrames4D)
    return { ...base, url: urlString, ...NVModel.volumeDefaults, ...overrides }
  }

  async addVolume(volume: ImageFromUrlOptions | NVImage): Promise<void> {
    const prepared = await NVModel.prepareVolume(volume)
    this.volumes.push(prepared)
    this._setupPivot3D()
  }

  async loadVolume(volume: ImageFromUrlOptions): Promise<void> {
    await this.removeAllVolumes()
    await this.addVolume(volume)
  }
}
