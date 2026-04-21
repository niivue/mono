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
  GraphConfig,
  ImageFromUrlOptions,
  InteractionConfig,
  LayoutConfig,
  MeshFromUrlOptions,
  MeshRenderConfig,
  NiiVueOptions,
  NVImage,
  NVMesh as NVMeshType,
  SceneConfig,
  UIConfig,
  VectorAnnotation,
  VolumeRenderConfig,
} from '@/NVTypes'
import * as NVLegend from '@/view/NVLegend'
import { resolveNegativeRange } from '@/view/NVUILayout'
import * as NVVolume from '@/volume/NVVolume'
import { getVoxelValue } from '@/volume/utils'

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
   * Collect per-frame voxel intensities at the current crosshair for the first 4D volume.
   * Returns null if graph is disabled, or there is no 4D volume.
   */
  collectGraphData(): {
    lines: number[][]
    selectedColumn: number
    calMin: number
    calMax: number
    nTotalFrame4D: number
    graphConfig: GraphConfig
  } | null {
    if (!this.ui.isGraphVisible) return null
    if (this.getMaxVols() < 2) return null
    const vol = this.volumes[0]
    if (!vol) return null
    const nFrames = vol.nFrame4D ?? 1
    if (nFrames < 2) return null
    const mm = this.scene2mm(this.scene.crosshairPos)
    const rasVox = NVTransforms.mm2vox(vol, mm)
    const line: number[] = []
    for (let j = 0; j < nFrames; j++) {
      line.push(getVoxelValue(vol, rasVox[0], rasVox[1], rasVox[2], j))
    }
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
