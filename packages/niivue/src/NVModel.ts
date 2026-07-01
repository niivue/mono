import { mat4, vec2, vec3, vec4 } from 'gl-matrix'
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
  FocusBox,
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
import { loadVolumePrepared } from '@/volume/loadBridge'
import { extractVoxelFid, getVoxelValue, volumeTR } from '@/volume/utils'

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
  /** Zoom/pan view window over the signal graph x-axis (null = full extent). */
  signalViewWindow: [number, number] | null = null
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
  /** Transient world-space box outlined on 3D render tiles (e.g. focus region) */
  _focusBox: FocusBox | null = null
  /**
   * Transient world-space boxes outlined on 3D render tiles, drawn like
   * `_focusBox` but as a set — e.g. one per multi-resolution brick, colored by
   * LOD level, to visualize a heterogeneous chunk plan. Controller-owned.
   */
  _lodBoxes: FocusBox[] | null = null
  /**
   * Transient world-mm override for the 3D render's rotation/zoom pivot. When
   * set, the render orbits and zooms about this point (which projects to the
   * render centre) instead of the volume centre — e.g. to keep the crosshair
   * framed. Null = default (volume centre, `pivot3D`). Not serialized.
   */
  _renderPivotMM: vec3 | null = null
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
      renderPan: options.renderPan
        ? vec2.fromValues(...options.renderPan)
        : vec2.fromValues(0, 0),
      gamma: options.gamma ?? 1.0,
      backgroundColor: options.backgroundColor ?? [0, 0, 0, 1],
      clipPlaneColor: options.clipPlaneColor ?? [0.7, 0, 0.7, 0.4],
      isClipPlaneCutaway: options.isClipPlaneCutaway ?? false,
      clipPlaneOverlay: options.clipPlaneOverlay ?? false,
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
        options.graphIsRangeCalMinMax !== undefined ||
        options.graphShowVolumeTimecourse !== undefined ||
        options.graphLineWidth !== undefined ||
        options.graphLineAlpha !== undefined ||
        options.graphAutoResetView !== undefined) && {
        graph: {
          ...NVConstants.UI_DEFAULTS.graph,
          ...(options.graphNormalizeValues !== undefined && {
            normalizeValues: options.graphNormalizeValues,
          }),
          ...(options.graphIsRangeCalMinMax !== undefined && {
            isRangeCalMinMax: options.graphIsRangeCalMinMax,
          }),
          ...(options.graphShowVolumeTimecourse !== undefined && {
            showVolumeTimecourse: options.graphShowVolumeTimecourse,
          }),
          ...(options.graphLineWidth !== undefined && {
            lineWidth: options.graphLineWidth,
          }),
          ...(options.graphLineAlpha !== undefined && {
            lineAlpha: options.graphLineAlpha,
          }),
          ...(options.graphAutoResetView !== undefined && {
            autoResetView: options.graphAutoResetView,
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
      ...(options.volumeTransmittanceCutoff !== undefined && {
        transmittanceCutoff: options.volumeTransmittanceCutoff,
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
    this.signalViewWindow = null
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

  /**
   * Drop the associated-graph memo. Must be called whenever the signal or volume
   * set changes: the cached `GraphData` holds sampled BOLD arrays + references to
   * physio arrays, and its key is id-based (ids are derived from name/URL, so a
   * same-URL reload would otherwise reuse stale data).
   */
  invalidateGraphCache(): void {
    this._assocCache = null
  }

  /** Add a signal, ensuring its id is unique within the model. */
  addSignal(signal: NVSignal): void {
    let id = signal.id
    let n = 1
    while (this.signals.some((s) => s.id === id)) id = `${signal.id}-${n++}`
    signal.id = id
    this.signals.push(signal)
    this.invalidateGraphCache()
  }

  removeSignal(index: number): NVSignal | null {
    if (index < 0 || index >= this.signals.length) return null
    const [removed] = this.signals.splice(index, 1)
    // The cursor/zoom belonged to the previous signal set; clear them.
    this.signalCursorX = null
    this.signalViewWindow = null
    this.invalidateGraphCache()
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

  /**
   * True when no spatial view should render: either the scene has only signals
   * (nothing spatial to show) or the user chose `SLICE_TYPE.NONE` to hand the
   * whole canvas to the signal graph while keeping a volume loaded (e.g. a 4D
   * BOLD time-course). Both renderers skip the spatial pass and the signal graph
   * fills the instance area (`fullCanvas`). Single source of truth for that
   * decision so the renderers and graph-data builders stay in agreement.
   */
  isSpatialViewHidden(): boolean {
    return (
      this.isSignalOnlyScene() ||
      this.layout.sliceType === NVConstants.SLICE_TYPE.NONE
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
   * Derive a crosshair-following spectroscopy signal's plot by extracting the
   * complex FID at the current crosshair voxel of its attached MRSI volume and
   * running the spectroscopy transform with the signal's display state. Returns
   * null when the signal is not crosshair-following or the attachment cannot be
   * resolved to a complex MRSI volume. Not memoized (the crosshair changes
   * often and a single 1024-point FFT per frame is cheap), so the cursor stays
   * live without invalidating the display-keyed `_signalPlotCache`.
   */
  private crosshairSpectroscopyPlot(sig: NVSignal): SignalPlot | null {
    if (
      !sig.followsCrosshair ||
      sig.raw.kind !== 'spectroscopy' ||
      !sig.attachedToId
    ) {
      return null
    }
    const vol = this.volumes.find((v) => v.id === sig.attachedToId)
    if (!vol?.complexFID || !vol.mrsMeta) return null
    const mm = this.scene2mm(this.scene.crosshairPos)
    const rasVox = NVTransforms.mm2vox(vol, mm)
    const fid = extractVoxelFid(vol, rasVox[0], rasVox[1], rasVox[2])
    if (!fid) return null
    const m = vol.mrsMeta
    return deriveSeries(
      {
        kind: 'spectroscopy',
        fid,
        // extractVoxelFid now returns all transients (SVS layout); pass the real
        // count so deriveSeries averages them, matching integratePpmBandMap so the
        // crosshair spectrum agrees with generated metabolite maps.
        nPoints: m.nPoints,
        nTransients: m.nTransients,
        dwell: m.dwell,
        spectrometerFreq: m.spectrometerFreq,
        nucleus: m.nucleus,
      },
      sig.display,
    )
  }

  /**
   * Derived plot for a signal, or null when a crosshair-following spectrum
   * cannot currently resolve its source (no attached MRSI volume / crosshair
   * off the grid / NVD reload without the retained complex buffer). Returning
   * null — rather than the placeholder zero-FID — keeps an unresolved MRSI
   * signal OUT of the graph instead of drawing a misleading flat line.
   */
  private plotFor(sig: NVSignal): SignalPlot | null {
    if (sig.followsCrosshair) return this.crosshairSpectroscopyPlot(sig)
    return this.derivePlotCached(sig)
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
    // Resolve each signal's plot first, dropping crosshair-following signals
    // that cannot currently resolve their FID (MRSI volume removed / crosshair
    // off the grid / NVD reload without the complex buffer): an empty graph is
    // better than a fake flat placeholder spectrum.
    const resolved: { sig: NVSignal; plot: SignalPlot }[] = []
    for (const sig of this.signals) {
      const plot = this.plotFor(sig)
      if (plot) resolved.push({ sig, plot })
    }
    if (resolved.length === 0) return null
    // Choose the common axis from the first VISIBLE plot (>= 1 series), not the
    // first resolved one: a hidden first signal (`selectedColumns: []`) still
    // resolves to an empty-series plot carrying its axis, and adopting that axis
    // would reject a later visible signal on a different axis (e.g. a hidden ppm
    // spectrum suppressing a visible time-axis physio trace). Only signals whose
    // axis matches the lead's are merged, so a ppm spectrum and a time-axis
    // physio trace never share one (misleading) axis; incompatible signals are
    // skipped (use one instance each, or a future multi-panel layout).
    const lead = resolved.find((r) => r.plot.series.length > 0)
    if (!lead) return null
    const axis = { ...lead.plot.axis }
    const series: GraphData['series'] = []
    const annotations: GraphData['annotations'] = []
    const mins: number[] = []
    const maxs: number[] = []
    let merged = 0
    for (const { sig, plot } of resolved) {
      if (
        plot.axis.label !== axis.label ||
        plot.axis.reversed !== axis.reversed
      ) {
        continue
      }
      merged++
      for (const s of plot.series) {
        series.push({
          label: s.label,
          x: s.x,
          y: s.y,
          color: s.color,
          triggers: s.triggers,
        })
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
      showLegend: lead.sig.display.showLegend,
      // No spatial view (signal-only scene, or SLICE_TYPE.NONE) -> the plot fills
      // the whole instance area; otherwise it's a side strip beside the slices.
      fullCanvas: this.isSpatialViewHidden(),
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
    const showVol = this.ui.graph.showVolumeTimecourse !== false
    const nFrames = vol.nFrame4D ?? 1
    const tr = volumeTR(vol)
    const tMax = (nFrames - 1) * tr
    // The marker tracks the current frame's time, but the SERIES values do not
    // depend on the frame (only on the crosshair, and only when BOLD is shown).
    // So the cache key omits frame4D, and the crosshair when BOLD is hidden — a
    // frame step then reuses the cached series and just re-marks the cursor.
    const cursorX = (vol.frame4D ?? 0) * tr
    // `fullCanvas` depends on the spatial-hidden state, so it is part of the key:
    // toggling SLICE_TYPE.NONE must rebuild the graph (side strip <-> full canvas)
    // rather than return the stale cached layout.
    const key = `${vol.id}|${showVol}|${this.isSpatialViewHidden()}|${showVol ? `${cp[0]},${cp[1]},${cp[2]}` : ''}|${nFrames}|${tr}|${attached
      .map((s) => `${s.id}:${JSON.stringify(s.display)}`)
      .join(';')}`
    if (this._assocCache && this._assocCache.key === key) {
      const cached = this._assocCache.data
      cached.cursorX = cursorX
      return cached
    }
    const series: GraphData['series'] = []
    // 1) Volume time-course at the crosshair (optional via showVolumeTimecourse).
    //    Only sampled when shown — a hidden BOLD must not pay O(nFrames) sampling
    //    nor suppress a physio-only graph when the volume lacks `matRAS`.
    if (showVol) {
      const vy = this.sampleVolumeTimeCourse(vol)
      if (vy) {
        const vx = new Float32Array(nFrames)
        for (let j = 0; j < nFrames; j++) vx[j] = j * tr
        // Label the time-course with the volume's basename (this runs for ANY
        // attached 4D volume, not just BOLD fMRI); fall back to 'volume'. Strip
        // the directory and one trailing image extension (+ .gz) rather than
        // splitting on the first dot, so a dotted name like
        // `sub-01.task-rest.bold.nii.gz` keeps its context.
        const volLabel =
          ((vol.name ?? '').split(/[\\/]/).pop() ?? '')
            .replace(/\.gz$/i, '')
            .replace(/\.[^.]+$/, '') || 'volume'
        series.push({
          label: volLabel,
          x: vx,
          y: this.normalizeWindow(vx, vy, 0, tMax),
          rawY: vy,
        })
      }
    }
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
          triggers: ps.triggers,
        })
      }
    }
    // Nothing visible -> no association graph. (Previously required volume + >=1
    // physio; now any one visible series is enough, so the BOLD/physio traces can
    // be toggled independently.)
    if (series.length === 0) return null
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
      // Side strip beside the slices by default; full canvas when the user hides
      // the spatial view with SLICE_TYPE.NONE (the volume stays loaded for the
      // time-course).
      fullCanvas: this.isSpatialViewHidden(),
      // Marker at the current frame's time ties 4D scrubbing to the time axis.
      cursorX,
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
    if (associated) return this.applyGraphViewWindow(associated)
    const signalData = this.collectSignalGraphData()
    if (signalData) return this.applyGraphViewWindow(signalData)
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
      // SLICE_TYPE.NONE hides the spatial view -> the volume time-course plot fills
      // the whole canvas (matches the signal/associated graph builders, which set
      // this too). Without it, the plain 4D-volume graph stays a side strip on NONE.
      fullCanvas: this.isSpatialViewHidden(),
    }
  }

  /**
   * Apply the zoom/pan view window (if any) to a signal-mode GraphData. The
   * input's xAxis is always the FULL extent (the collector sets it and we never
   * mutate it), so the full domain is derived from it directly each call — no
   * once-captured persistence, and the cached GraphData is left untouched
   * (render/interaction state don't alias it). Stamps `fullXDomain` on the
   * returned copy so `graphZoom`/`graphPan` can re-derive the window/orientation
   * from a fresh collect, and rewrites `xAxis.min/max` to the window.
   */
  private applyGraphViewWindow(data: GraphData): GraphData {
    if (!data.series || !data.xAxis) return data
    const ax = data.xAxis
    // Only scan the data when the collector left an axis bound open.
    const [dMin, dMax] =
      ax.min == null || ax.max == null
        ? this.signalDataXExtent(data)
        : [ax.min, ax.max]
    const full: [number, number] = [ax.min ?? dMin, ax.max ?? dMax]
    const w = this.signalViewWindow
    const [lo, hi] = w ? this.clampSignalWindow(w, full) : full
    return { ...data, xAxis: { ...ax, min: lo, max: hi }, fullXDomain: full }
  }

  /**
   * Current signal-graph full x-domain + axis orientation, derived from a FRESH
   * `collectGraphData()` (signal mode only). This is the single source of truth
   * for `graphZoom`/`graphPan`/`panViewWindowTo` — they no longer depend on
   * render-time state, so they work immediately after `loadSignals()` (before the
   * first RAF) and are genuine no-ops when no signal graph is shown.
   */
  private currentGraphDomain(): {
    full: [number, number]
    reversed: boolean
    cursorX: number | null
  } | null {
    const data = this.collectGraphData()
    if (!data?.series || !data.fullXDomain) return null
    return {
      full: data.fullXDomain,
      reversed: data.xAxis?.reversed ?? false,
      cursorX: data.cursorX ?? null,
    }
  }

  /** Min/max x across all series (single pass); falls back to [0, 1] if empty. */
  private signalDataXExtent(data: GraphData): [number, number] {
    let mn = Number.POSITIVE_INFINITY
    let mx = Number.NEGATIVE_INFINITY
    for (const s of data.series ?? [])
      for (let i = 0; i < s.y.length; i++) {
        const xv = s.x ? s.x[i] : i
        if (xv < mn) mn = xv
        if (xv > mx) mx = xv
      }
    return [Number.isFinite(mn) ? mn : 0, Number.isFinite(mx) ? mx : 1]
  }

  /** Clamp a window to the full domain: inside bounds, width <= full width. */
  private clampSignalWindow(
    w: [number, number],
    full: [number, number],
  ): [number, number] {
    const fullW = full[1] - full[0]
    let width = Math.min(Math.max(w[1] - w[0], fullW / 1000), fullW)
    if (!(width > 0)) width = fullW
    let lo = w[0]
    let hi = lo + width
    if (lo < full[0]) {
      lo = full[0]
      hi = lo + width
    }
    if (hi > full[1]) {
      hi = full[1]
      lo = hi - width
    }
    return [Math.max(full[0], lo), Math.min(full[1], hi)]
  }

  /**
   * Zoom the signal graph x-window by `factor` (>1 in, <1 out), centred on the
   * VISIBLE marker (`GraphData.cursorX` — the current-frame time in associated
   * mode, which `signalCursorX` does not track) when it is in view, else the
   * window centre. Zooming out past the full extent resets to the full view.
   */
  graphZoom(factor: number): void {
    if (!(factor > 0)) return
    const domain = this.currentGraphDomain()
    if (!domain) return
    const full = domain.full
    const fullW = full[1] - full[0]
    const cur = this.signalViewWindow ?? full
    const newW = (cur[1] - cur[0]) / factor
    if (newW >= fullW) {
      this.signalViewWindow = null
      return
    }
    const cx = domain.cursorX ?? this.signalCursorX
    const center =
      cx !== null && cx !== undefined && cx >= cur[0] && cx <= cur[1]
        ? cx
        : (cur[0] + cur[1]) / 2
    this.signalViewWindow = this.clampSignalWindow(
      [center - newW / 2, center + newW / 2],
      full,
    )
  }

  /**
   * Pan the zoom window just enough to bring data value `x` inside it (used when
   * the wheel steps the marker past the visible edge). No-op when the full extent
   * is shown or `x` is already visible. Returns true if the window moved.
   */
  panViewWindowTo(x: number): boolean {
    if (!Number.isFinite(x)) return false
    const win = this.signalViewWindow
    const full = this.currentGraphDomain()?.full
    if (!win || !full) return false
    const [lo, hi] = win
    if (x >= lo && x <= hi) return false
    const width = hi - lo
    let nLo: number
    let nHi: number
    if (x < lo) {
      nLo = x
      nHi = x + width
    } else {
      nHi = x
      nLo = x - width
    }
    if (nLo < full[0]) {
      nLo = full[0]
      nHi = nLo + width
    }
    if (nHi > full[1]) {
      nHi = full[1]
      nLo = nHi - width
    }
    this.signalViewWindow = [nLo, nHi]
    return true
  }

  /**
   * Pan the signal graph x-window by `screenFrac` of its width in SCREEN space
   * (negative = visually left). Translated to data-x via the axis orientation so
   * the buttons move the view the same visual direction on a reversed (ppm) axis.
   */
  graphPan(screenFrac: number): void {
    const domain = this.currentGraphDomain()
    if (!domain) return
    const full = domain.full
    const cur = this.signalViewWindow
    if (!cur) return // full view: nothing to pan
    const width = cur[1] - cur[0]
    if (width >= full[1] - full[0]) return
    const d = screenFrac * width * (domain.reversed ? -1 : 1)
    this.signalViewWindow = this.clampSignalWindow(
      [cur[0] + d, cur[1] + d],
      full,
    )
  }

  /**
   * Set the zoom/pan window to an explicit data-unit range (order-insensitive),
   * clamped to the current full domain. `null` restores the full view. Used by a
   * host that drives the visible range reactively (e.g. ppm sliders bound to the
   * `graphRangeChange` event).
   */
  setGraphRange(range: [number, number] | null): void {
    if (range === null) {
      this.signalViewWindow = null
      return
    }
    const domain = this.currentGraphDomain()
    if (!domain) return
    const lo = Math.min(range[0], range[1])
    const hi = Math.max(range[0], range[1])
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return
    this.signalViewWindow = this.clampSignalWindow([lo, hi], domain.full)
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
    this.invalidateGraphCache()
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
    this.invalidateGraphCache()
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
    // Normalize the frame limit ONCE so the loader and the converter agree: a
    // finite limit floors to an integer >= 1 (a fractional or 0/negative limit is
    // otherwise handled differently by the gzip fast path vs nii2volume); anything
    // unset/non-finite means "no limit" (load all that fit).
    const frameLimit =
      limitFrames4D == null || !Number.isFinite(limitFrames4D)
        ? Infinity
        : Math.max(1, Math.floor(limitFrames4D))
    const urlString = typeof url === 'string' ? url : url.name
    const name = overrides.name ?? urlString
    const base = await loadVolumePrepared(
      url,
      urlImageData ?? null,
      frameLimit,
      name,
    )
    return {
      ...base,
      url: urlString,
      ...NVModel.volumeDefaults,
      ...overrides,
      // A dropped File has no URL to re-fetch; keep it so a deferred 4D reload can
      // re-open it. Runtime-only (the NVDocument serializer allowlists fields).
      ...(url instanceof File ? { _sourceFile: url } : {}),
      // Detached-header formats (AFNI .HEAD+.BRIK, NRRD .nhdr+.raw, MRtrix
      // detached .mif, MetaImage detached .mha) need the paired image bytes
      // on every (re-)load; without it the readers throw "pairedImgData not
      // set". prepareVolume destructures urlImageData out of opts, so without
      // this stash a deferred 4D reload would re-issue loadVolume with only
      // the header URL/File. Runtime-only, same allowlist contract as
      // _sourceFile above.
      ...(urlImageData != null ? { _urlImageData: urlImageData } : {}),
    }
  }

  async addVolume(volume: ImageFromUrlOptions | NVImage): Promise<void> {
    const prepared = await NVModel.prepareVolume(volume)
    this.volumes.push(prepared)
    this._setupPivot3D()
    this.invalidateGraphCache()
  }

  async loadVolume(volume: ImageFromUrlOptions): Promise<void> {
    await this.removeAllVolumes()
    await this.addVolume(volume)
  }
}
