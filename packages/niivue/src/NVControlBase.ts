import { type vec3, vec4 } from "gl-matrix"
import { getControlPoints } from "@/annotation/selection"
import { AnnotationUndoStack } from "@/annotation/undoRedo"
import { ubuntu } from "@/assets/fonts"
import { cortex } from "@/assets/matcaps"
import * as NVCmaps from "@/cmap/NVCmaps"
import { removeInteractionListeners } from "@/control/interactions"
import { buildLocationMessage } from "@/control/locationTracking"
import type {
  ReinitializeOptions,
  ViewLifecycle,
} from "@/control/viewLifecycle"
import * as Drawing from "@/drawing"
import { NVExtensionContext } from "@/extension/context"
import { type LogLevel, log } from "@/logger"
import * as NVTransforms from "@/math/NVTransforms"
import * as NVMeshLayers from "@/mesh/layers"
import * as NVMesh from "@/mesh/NVMesh"
import type { WriteOptions } from "@/mesh/writers"
import { DRAG_MODE, NUM_CLIP_PLANE } from "@/NVConstants"
import * as NVDocument from "@/NVDocument"
import type { NVEventListener, NVEventMap } from "@/NVEvents"
import * as NVLoader from "@/NVLoader"
import NVModel from "@/NVModel"
import type {
  AnnotationPoint,
  AnnotationStyle,
  AnnotationTool,
  BackendType,
  ColorMap,
  CustomLayoutTile,
  ImageFromUrlOptions,
  LUT,
  MeshFromUrlOptions,
  MeshLayerFromUrlOptions,
  MeshUpdate,
  NiiVueOptions,
  NVBounds,
  NVConnectomeOptions,
  NVFontData,
  NVImage,
  NVMeshLayer,
  NVMesh as NVMeshType,
  NVTractOptions,
  SaveVolumeOptions,
  SyncOpts,
  VectorAnnotation,
  ViewHitTest,
  VolumeUpdate,
} from "@/NVTypes"
import { buildDrawingLut, drawingBitmapToRGBA } from "@/view/NVDrawingTexture"
import { getFontMetrics } from "@/view/NVFont"
import type { GraphLayout } from "@/view/NVGraph"
import type { LegendLayout } from "@/view/NVLegend"
import type { SliceTile } from "@/view/NVSliceLayout"
import { validateCustomLayout } from "@/view/NVSliceLayout"
import { computeModulationData } from "@/volume/modulation"
import * as NVVolume from "@/volume/NVVolume"
import * as NVTensorProcessing from "@/volume/TensorProcessing"
import type {
  TransformInfo,
  TransformOptions,
  VolumeTransform,
} from "@/volume/transforms"
import * as NVVolumeTransforms from "@/volume/transforms"
import {
  calMinMaxFrame,
  computeVolumeLabelCentroids,
  reorientDrawingToNative,
} from "@/volume/utils"

type ViewBackend = {
  init: () => Promise<void>
  resize: () => void
  render: () => void
  updateBindGroups: () => Promise<void>
  hitTest: (x: number, y: number) => ViewHitTest | null
  depthPick: (x: number, y: number) => Promise<[number, number, number] | null>
  loadThumbnail: (url: string) => Promise<void>
  screenSlices: SliceTile[]
  legendLayout: LegendLayout | null
  graphLayout: GraphLayout | null
  getAvailableShaders: () => string[]
  refreshDrawing: (rgba: Uint8Array, dims: number[]) => void
  clearDrawing: () => void
  destroy: () => void
  forceDevicePixelRatio: number
}

export type { NiiVueOptions }
export type DistributionBackend = "both" | "webgpu" | "webgl2"

type InfrastructureOpts = {
  backend?: BackendType
  isAntiAlias?: boolean
  isDragDropEnabled?: boolean
  forceDevicePixelRatio?: number
  logLevel?: LogLevel
  thumbnail?: string
  font?: NVFontData
  matcaps?: Record<string, string>
  bounds?: NVBounds
  showBoundsBorder?: boolean
  boundsBorderColor?: [number, number, number, number]
  boundsBorderThickness?: number
}
const DEFAULT_MATCAPS: Record<string, string> = { cortex }

type EventHandler = ((e: Event) => void) | ((e: Event) => Promise<void>)

export default class NiiVueGPU extends EventTarget {
  activeClipPlaneIndex: number
  currentClipPlaneIndex: number
  canvas: HTMLCanvasElement | null = null
  opts: InfrastructureOpts
  isDragging: boolean
  lastPointerX: number
  lastPointerY: number
  framePending: boolean
  activeTileHit: ViewHitTest | null
  activeButton?: number
  model: NVModel
  view: ViewBackend | null = null
  resizeObserver: ResizeObserver | null
  _eventListeners: Record<string, EventHandler | null>
  private _updating = false
  private _pendingUpdate = false
  private _deferredVolumes: ImageFromUrlOptions[] | null = null
  private _deferredMeshes: MeshFromUrlOptions[] | null = null
  private _viewLifecycle: ViewLifecycle
  private _distributionBackend: DistributionBackend
  // Drawing transient state (controller-owned, not serialized)
  _drawPenLocation: number[] = [NaN, NaN, NaN]
  _drawPenAxCorSag = -1
  _drawPenFillPts: number[][] = []
  _drawLut: LUT | null = null
  _drawingDirty = false
  drawPenAutoClose = false
  drawPenFilled = false
  // Undo state (controller-owned — not persisted in documents)
  drawUndoBitmaps: Uint8Array[] = []
  currentDrawUndoBitmap = -1
  maxDrawUndoBitmaps = 8
  // Drag mode state (controller-owned, not serialized)
  dragStartXY: [number, number] = [0, 0]
  dragEndXY: [number, number] = [0, 0]
  _activeDragMode: number = DRAG_MODE.none
  _angleState: "none" | "drawing_first_line" | "drawing_second_line" = "none"
  _angleFirstLine: number[] = [0, 0, 0, 0]
  _pan2DxyzmmAtDragStart: [number, number, number, number] | null = null
  // Annotation transient state (controller-owned, not serialized)
  _annotationUndoStack = new AnnotationUndoStack()
  _annotationBrushPath: AnnotationPoint[] = []
  _frozenLoopPoints: AnnotationPoint[] | null = null
  _annotationSliceType = 0
  _annotationSlicePosition = 0
  _annotationAnchorMM: [number, number, number] = [0, 0, 0]
  _annotationShapeStart: AnnotationPoint | null = null
  _resizingControlPoint = -1
  _resizeOriginalShape: {
    start: AnnotationPoint
    end: AnnotationPoint
    width?: number
  } | null = null
  _resizingAnnotation: VectorAnnotation | null = null
  // Sync/broadcast state
  private _syncTargets: NiiVueGPU[] = []
  private _syncOpts: SyncOpts = {}
  private _syncDirty = false
  private _rafId: number | null = null

  constructor(
    options: NiiVueOptions = {},
    viewLifecycle: ViewLifecycle,
    distributionBackend: DistributionBackend = "both",
  ) {
    super()
    // Set log level early, before any other initialization that might log
    log.setLogLevel(options.logLevel ?? "info")
    this.activeClipPlaneIndex = 0
    this.currentClipPlaneIndex = 0
    this.opts = {
      backend: options.backend ?? "webgpu",
      isAntiAlias: options.isAntiAlias ?? true,
      isDragDropEnabled: options.isDragDropEnabled ?? true,
      forceDevicePixelRatio: options.devicePixelRatio ?? -1,
      logLevel: options.logLevel ?? "info",
      thumbnail: options.thumbnail,
      font: options.font ?? ubuntu,
      matcaps: options.matcaps ?? DEFAULT_MATCAPS,
      bounds: options.bounds ?? [
        [0, 0],
        [1, 1],
      ],
      showBoundsBorder: options.showBoundsBorder ?? false,
      boundsBorderColor: options.boundsBorderColor ?? [1, 1, 1, 1],
      boundsBorderThickness: options.boundsBorderThickness ?? 2,
    }
    // Public properties (controller-level)
    this.isDragging = false
    this.lastPointerX = 0
    this.lastPointerY = 0
    this.framePending = false
    this.activeTileHit = null // Track which tile the mouse was pressed on
    // Event listener references for cleanup
    this._eventListeners = {
      contextmenu: null,
      pointerdown: null,
      pointerup: null,
      pointermove: null,
      wheel: null,
      keydown: null,
      dragover: null,
      drop: null,
    }
    this._viewLifecycle = viewLifecycle
    this._distributionBackend = distributionBackend
    // Instances
    this.model = new NVModel(options)
    // Auto-apply first matcap URL if matcaps provided
    if (this.opts.matcaps) {
      const firstUrl = Object.values(this.opts.matcaps)[0]
      if (firstUrl) this.model.volume.matcap = firstUrl
    }
    this.resizeObserver = null
  }

  // Typed addEventListener/removeEventListener overloads
  addEventListener<K extends keyof NVEventMap>(
    type: K,
    listener: NVEventListener<K>,
    options?: boolean | AddEventListenerOptions,
  ): void
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void
  addEventListener(
    type: string,
    listener:
      | EventListenerOrEventListenerObject
      | NVEventListener<keyof NVEventMap>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(
      type,
      listener as EventListenerOrEventListenerObject,
      options,
    )
  }

  removeEventListener<K extends keyof NVEventMap>(
    type: K,
    listener: NVEventListener<K>,
    options?: boolean | EventListenerOptions,
  ): void
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void
  removeEventListener(
    type: string,
    listener:
      | EventListenerOrEventListenerObject
      | NVEventListener<keyof NVEventMap>,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(
      type,
      listener as EventListenerOrEventListenerObject,
      options,
    )
  }

  /** Emit a typed event. Uses CustomEvent with detail for events that carry data. */
  emit<K extends keyof NVEventMap>(
    type: K,
    ...args: NVEventMap[K] extends undefined ? [] : [detail: NVEventMap[K]]
  ): void {
    if (args.length === 0) this.dispatchEvent(new Event(type))
    else this.dispatchEvent(new CustomEvent(type, { detail: args[0] }))
  }

  // --- Scene Properties ---

  get azimuth(): number {
    return this.model.scene.azimuth
  }
  set azimuth(v: number) {
    this.model.scene.azimuth = v
    this.emit("azimuthElevationChange", {
      azimuth: v,
      elevation: this.model.scene.elevation,
    })
    this.emit("change", { property: "azimuth", value: v })
    this.drawScene()
  }

  get elevation(): number {
    return this.model.scene.elevation
  }
  set elevation(v: number) {
    this.model.scene.elevation = v
    this.emit("azimuthElevationChange", {
      azimuth: this.model.scene.azimuth,
      elevation: v,
    })
    this.emit("change", { property: "elevation", value: v })
    this.drawScene()
  }

  get crosshairPos(): vec3 {
    return this.model.scene.crosshairPos
  }
  set crosshairPos(v: vec3) {
    this.model.scene.crosshairPos = v
    this.emit("change", { property: "crosshairPos", value: v })
    this.drawScene()
  }

  get pan2Dxyzmm(): vec4 {
    return this.model.scene.pan2Dxyzmm
  }
  set pan2Dxyzmm(v: vec4) {
    this.model.scene.pan2Dxyzmm = v
    this.emit("change", { property: "pan2Dxyzmm", value: v })
    this.drawScene()
  }

  get scaleMultiplier(): number {
    return this.model.scene.scaleMultiplier
  }
  set scaleMultiplier(v: number) {
    this.model.scene.scaleMultiplier = v
    this.emit("change", { property: "scaleMultiplier", value: v })
    this.drawScene()
  }

  get gamma(): number {
    return this.model.scene.gamma
  }
  set gamma(v: number) {
    this.model.scene.gamma = v
    this.emit("change", { property: "gamma", value: v })
    this.drawScene()
  }

  get backgroundColor(): [number, number, number, number] {
    return this.model.scene.backgroundColor
  }
  set backgroundColor(v: [number, number, number, number]) {
    this.model.scene.backgroundColor = v
    this.emit("change", { property: "backgroundColor", value: v })
    this.drawScene()
  }

  get clipPlaneColor(): number[] {
    return this.model.scene.clipPlaneColor
  }
  set clipPlaneColor(v: number[]) {
    this.model.scene.clipPlaneColor = v
    this.emit("change", { property: "clipPlaneColor", value: v })
    this.drawScene()
  }

  get isClipPlaneCutaway(): boolean {
    return this.model.scene.isClipPlaneCutaway
  }
  set isClipPlaneCutaway(v: boolean) {
    this.model.scene.isClipPlaneCutaway = v
    this.emit("change", { property: "isClipPlaneCutaway", value: v })
    this.drawScene()
  }

  // --- Layout Properties ---

  get sliceType(): number {
    return this.model.layout.sliceType
  }
  set sliceType(v: number) {
    this.model.layout.sliceType = v
    this.emit("sliceTypeChange", { sliceType: v })
    this.emit("change", { property: "sliceType", value: v })
    this.drawScene()
  }

  get mosaicString(): string {
    return this.model.layout.mosaicString
  }
  set mosaicString(v: string) {
    this.model.layout.mosaicString = v
    this.emit("change", { property: "mosaicString", value: v })
    this.drawScene()
  }

  get showRender(): number {
    return this.model.layout.showRender
  }
  set showRender(v: number) {
    this.model.layout.showRender = v
    this.emit("change", { property: "showRender", value: v })
    this.drawScene()
  }

  get multiplanarType(): number {
    return this.model.layout.multiplanarType
  }
  set multiplanarType(v: number) {
    this.model.layout.multiplanarType = v
    this.emit("change", { property: "multiplanarType", value: v })
    this.drawScene()
  }

  get heroFraction(): number {
    return this.model.layout.heroFraction
  }
  set heroFraction(v: number) {
    this.model.layout.heroFraction = v
    this.emit("change", { property: "heroFraction", value: v })
    this.drawScene()
  }

  get heroSliceType(): number {
    return this.model.layout.heroSliceType
  }
  set heroSliceType(v: number) {
    this.model.layout.heroSliceType = v
    this.emit("change", { property: "heroSliceType", value: v })
    this.drawScene()
  }

  get isEqualSize(): boolean {
    return this.model.layout.isEqualSize
  }
  set isEqualSize(v: boolean) {
    this.model.layout.isEqualSize = v
    this.emit("change", { property: "isEqualSize", value: v })
    this.drawScene()
  }

  get isMosaicCentered(): boolean {
    return this.model.layout.isMosaicCentered
  }
  set isMosaicCentered(v: boolean) {
    this.model.layout.isMosaicCentered = v
    this.emit("change", { property: "isMosaicCentered", value: v })
    this.drawScene()
  }

  get tileMargin(): number {
    return this.model.layout.margin
  }
  set tileMargin(v: number) {
    this.model.layout.margin = v
    this.emit("change", { property: "tileMargin", value: v })
    this.drawScene()
  }

  get isRadiological(): boolean {
    return this.model.layout.isRadiological
  }
  set isRadiological(v: boolean) {
    this.model.layout.isRadiological = v
    this.emit("change", { property: "isRadiological", value: v })
    this.drawScene()
  }

  /**
   * Get or set a custom tile layout. When set to a non-empty array this
   * overrides all built-in layout modes (multiplanar, mosaic, hero).
   * Each tile specifies a slice type and a normalized [left, top, width, height]
   * position within the canvas (0–1).
   *
   * Set to `null` to revert to built-in layouts.
   *
   * @example
   * // Left half: sagittal, top-right: coronal, bottom-right: axial
   * nv.customLayout = [
   *   { sliceType: 2, position: [0, 0, 0.5, 1.0] },
   *   { sliceType: 1, position: [0.5, 0, 0.5, 0.5] },
   *   { sliceType: 0, position: [0.5, 0.5, 0.5, 0.5] },
   * ];
   */
  get customLayout(): CustomLayoutTile[] | null {
    return this.model.layout.customLayout
  }
  set customLayout(v: CustomLayoutTile[] | null) {
    if (v && v.length > 0) {
      const result = validateCustomLayout(v)
      if (!result.valid) throw new Error(result.error!)
    }
    this.model.layout.customLayout = v
    this.emit("change", { property: "customLayout", value: v })
    this.drawScene()
  }

  /** Clear any custom layout and revert to built-in layout modes. */
  clearCustomLayout(): void {
    this.customLayout = null
  }

  // --- UI Properties ---

  get isColorbarVisible(): boolean {
    return this.model.ui.isColorbarVisible
  }
  set isColorbarVisible(v: boolean) {
    this.model.ui.isColorbarVisible = v
    this.emit("change", { property: "isColorbarVisible", value: v })
    this.drawScene()
  }

  get isOrientCubeVisible(): boolean {
    return this.model.ui.isOrientCubeVisible
  }
  set isOrientCubeVisible(v: boolean) {
    this.model.ui.isOrientCubeVisible = v
    this.emit("change", { property: "isOrientCubeVisible", value: v })
    this.drawScene()
  }

  get isOrientationTextVisible(): boolean {
    return this.model.ui.isOrientationTextVisible
  }
  set isOrientationTextVisible(v: boolean) {
    this.model.ui.isOrientationTextVisible = v
    this.emit("change", { property: "isOrientationTextVisible", value: v })
    this.drawScene()
  }

  get is3DCrosshairVisible(): boolean {
    return this.model.ui.is3DCrosshairVisible
  }
  set is3DCrosshairVisible(v: boolean) {
    this.model.ui.is3DCrosshairVisible = v
    this.emit("change", { property: "is3DCrosshairVisible", value: v })
    this.drawScene()
  }

  get isGraphVisible(): boolean {
    return this.model.ui.isGraphVisible
  }
  set isGraphVisible(v: boolean) {
    this.model.ui.isGraphVisible = v
    this.emit("change", { property: "isGraphVisible", value: v })
    this.drawScene()
  }

  get isRulerVisible(): boolean {
    return this.model.ui.isRulerVisible
  }
  set isRulerVisible(v: boolean) {
    this.model.ui.isRulerVisible = v
    this.emit("change", { property: "isRulerVisible", value: v })
    this.drawScene()
  }

  get isCrossLinesVisible(): boolean {
    return this.model.ui.isCrossLinesVisible
  }
  set isCrossLinesVisible(v: boolean) {
    this.model.ui.isCrossLinesVisible = v
    this.emit("change", { property: "isCrossLinesVisible", value: v })
    this.drawScene()
  }

  get isLegendVisible(): boolean {
    return this.model.ui.isLegendVisible
  }
  set isLegendVisible(v: boolean) {
    this.model.ui.isLegendVisible = v
    this.emit("change", { property: "isLegendVisible", value: v })
    this.drawScene()
  }

  get isPositionInMM(): boolean {
    return this.model.ui.isPositionInMM
  }
  set isPositionInMM(v: boolean) {
    this.model.ui.isPositionInMM = v
    this.emit("change", { property: "isPositionInMM", value: v })
    this.drawScene()
  }

  get isMeasureUnitsVisible(): boolean {
    return this.model.ui.isMeasureUnitsVisible
  }
  set isMeasureUnitsVisible(v: boolean) {
    this.model.ui.isMeasureUnitsVisible = v
    this.emit("change", { property: "isMeasureUnitsVisible", value: v })
    this.drawScene()
  }

  get isThumbnailVisible(): boolean {
    return this.model.ui.isThumbnailVisible
  }
  set isThumbnailVisible(v: boolean) {
    const wasVisible = this.model.ui.isThumbnailVisible
    this.model.ui.isThumbnailVisible = v
    this.emit("change", { property: "isThumbnailVisible", value: v })
    if (wasVisible && !v) {
      this._loadDeferredData()
    } else {
      this.drawScene()
    }
  }

  get thumbnailUrl(): string {
    return this.model.ui.thumbnailUrl
  }
  set thumbnailUrl(v: string) {
    this.model.ui.thumbnailUrl = v
    this.emit("change", { property: "thumbnailUrl", value: v })
    this.drawScene()
  }

  get placeholderText(): string {
    return this.model.ui.placeholderText
  }
  set placeholderText(v: string) {
    this.model.ui.placeholderText = v
    this.emit("change", { property: "placeholderText", value: v })
    this.drawScene()
  }

  get crosshairColor(): number[] {
    return this.model.ui.crosshairColor
  }
  set crosshairColor(v: number[]) {
    this.model.ui.crosshairColor = v
    this.emit("change", { property: "crosshairColor", value: v })
    this.drawScene()
  }

  get crosshairGap(): number {
    return this.model.ui.crosshairGap
  }
  set crosshairGap(v: number) {
    this.model.ui.crosshairGap = v
    this.emit("change", { property: "crosshairGap", value: v })
    this.drawScene()
  }

  get crosshairWidth(): number {
    return this.model.ui.crosshairWidth
  }
  set crosshairWidth(v: number) {
    this.model.ui.crosshairWidth = v
    this.emit("change", { property: "crosshairWidth", value: v })
    this.drawScene()
  }

  get fontColor(): number[] {
    return this.model.ui.fontColor
  }
  set fontColor(v: number[]) {
    this.model.ui.fontColor = v
    this.emit("change", { property: "fontColor", value: v })
    this.drawScene()
  }

  get fontScale(): number {
    return this.model.ui.fontScale
  }
  set fontScale(v: number) {
    this.model.ui.fontScale = v
    this.emit("change", { property: "fontScale", value: v })
    this.drawScene()
  }

  get fontMinSize(): number {
    return this.model.ui.fontMinSize
  }
  set fontMinSize(v: number) {
    this.model.ui.fontMinSize = v
    this.emit("change", { property: "fontMinSize", value: v })
    this.drawScene()
  }

  get selectionBoxColor(): number[] {
    return this.model.ui.selectionBoxColor
  }
  set selectionBoxColor(v: number[]) {
    this.model.ui.selectionBoxColor = v
    this.emit("change", { property: "selectionBoxColor", value: v })
    this.drawScene()
  }

  get measureLineColor(): number[] {
    return this.model.ui.measureLineColor
  }
  set measureLineColor(v: number[]) {
    this.model.ui.measureLineColor = v
    this.emit("change", { property: "measureLineColor", value: v })
    this.drawScene()
  }

  get measureTextColor(): number[] {
    return this.model.ui.measureTextColor
  }
  set measureTextColor(v: number[]) {
    this.model.ui.measureTextColor = v
    this.emit("change", { property: "measureTextColor", value: v })
    this.drawScene()
  }

  get rulerWidth(): number {
    return this.model.ui.rulerWidth
  }
  set rulerWidth(v: number) {
    this.model.ui.rulerWidth = v
    this.emit("change", { property: "rulerWidth", value: v })
    this.drawScene()
  }

  get graphNormalizeValues(): boolean {
    return this.model.ui.graph.normalizeValues
  }
  set graphNormalizeValues(v: boolean) {
    this.model.ui.graph.normalizeValues = v
    this.emit("change", { property: "graphNormalizeValues", value: v })
    this.drawScene()
  }

  get graphIsRangeCalMinMax(): boolean {
    return this.model.ui.graph.isRangeCalMinMax
  }
  set graphIsRangeCalMinMax(v: boolean) {
    this.model.ui.graph.isRangeCalMinMax = v
    this.emit("change", { property: "graphIsRangeCalMinMax", value: v })
    this.drawScene()
  }

  // --- Volume Properties ---

  get volumeIllumination(): number {
    return this.model.volume.illumination
  }
  set volumeIllumination(v: number) {
    this.model.volume.illumination = v
    this.emit("change", { property: "volumeIllumination", value: v })
    this.drawScene()
  }

  get volumeOutlineWidth(): number {
    return this.model.volume.outlineWidth
  }
  set volumeOutlineWidth(v: number) {
    this.model.volume.outlineWidth = v
    this.emit("change", { property: "volumeOutlineWidth", value: v })
    this.drawScene()
  }

  get volumeAlphaShader(): number {
    return this.model.volume.alphaShader
  }
  set volumeAlphaShader(v: number) {
    this.model.volume.alphaShader = v
    this.emit("change", { property: "volumeAlphaShader", value: v })
    this.drawScene()
  }

  get volumeIsBackgroundMasking(): boolean {
    return this.model.volume.isBackgroundMasking
  }
  set volumeIsBackgroundMasking(v: boolean) {
    this.model.volume.isBackgroundMasking = v
    this.emit("change", { property: "volumeIsBackgroundMasking", value: v })
    this.drawScene()
  }

  get volumeIsAlphaClipDark(): boolean {
    return this.model.volume.isAlphaClipDark
  }
  set volumeIsAlphaClipDark(v: boolean) {
    this.model.volume.isAlphaClipDark = v
    this.emit("change", { property: "volumeIsAlphaClipDark", value: v })
    this.drawScene()
  }

  get volumeIsNearestInterpolation(): boolean {
    return this.model.volume.isNearestInterpolation
  }
  set volumeIsNearestInterpolation(v: boolean) {
    this.model.volume.isNearestInterpolation = v
    this.emit("change", { property: "volumeIsNearestInterpolation", value: v })
    this.drawScene()
  }

  get volumeIsV1SliceShader(): boolean {
    return this.model.volume.isV1SliceShader
  }
  set volumeIsV1SliceShader(v: boolean) {
    this.model.volume.isV1SliceShader = v
    this.emit("change", { property: "volumeIsV1SliceShader", value: v })
    this.drawScene()
  }

  get volumeMatcap(): string {
    return this.model.volume.matcap
  }
  set volumeMatcap(v: string) {
    this.model.volume.matcap = v
    this.emit("change", { property: "volumeMatcap", value: v })
    this.drawScene()
  }

  get volumePaqdUniforms(): [number, number, number, number] {
    return this.model.volume.paqdUniforms
  }
  set volumePaqdUniforms(v: [number, number, number, number]) {
    this.model.volume.paqdUniforms = v
    this.emit("change", { property: "volumePaqdUniforms", value: v })
    this.drawScene()
  }

  // --- Mesh Properties ---

  get meshXRay(): number {
    return this.model.mesh.xRay
  }
  set meshXRay(v: number) {
    const clamped = Math.max(0, Math.min(1, v))
    this.model.mesh.xRay = clamped
    this.emit("change", { property: "meshXRay", value: clamped })
    this.drawScene()
  }

  get meshThicknessOn2D(): number {
    return this.model.mesh.thicknessOn2D
  }
  set meshThicknessOn2D(v: number) {
    const val = v <= 0 ? Infinity : v
    this.model.mesh.thicknessOn2D = val
    this.emit("change", { property: "meshThicknessOn2D", value: val })
    this.drawScene()
  }

  // --- Draw Properties ---

  get drawIsEnabled(): boolean {
    return this.model.draw.isEnabled
  }
  set drawIsEnabled(v: boolean) {
    this.model.draw.isEnabled = v
    this.emit("drawingEnabled", { isEnabled: v })
    this.emit("change", { property: "drawIsEnabled", value: v })
  }

  get drawPenValue(): number {
    return this.model.draw.penValue
  }
  set drawPenValue(v: number) {
    this.model.draw.penValue = v
    this.emit("penValueChanged", { penValue: v })
    this.emit("change", { property: "drawPenValue", value: v })
  }

  get drawPenSize(): number {
    return this.model.draw.penSize
  }
  set drawPenSize(v: number) {
    const val = Math.max(1, Math.round(v))
    this.model.draw.penSize = val
    this.emit("change", { property: "drawPenSize", value: val })
  }

  get drawIsFillOverwriting(): boolean {
    return this.model.draw.isFillOverwriting
  }
  set drawIsFillOverwriting(v: boolean) {
    this.model.draw.isFillOverwriting = v
    this.emit("change", { property: "drawIsFillOverwriting", value: v })
  }

  get drawOpacity(): number {
    return this.model.draw.opacity
  }
  set drawOpacity(v: number) {
    const val = Math.max(0, Math.min(1, v))
    this.model.draw.opacity = val
    this.emit("change", { property: "drawOpacity", value: val })
    if (this.model.drawingVolume) this.refreshDrawing()
  }

  get drawRimOpacity(): number {
    return this.model.draw.rimOpacity
  }
  set drawRimOpacity(v: number) {
    this.model.draw.rimOpacity = v
    this.emit("change", { property: "drawRimOpacity", value: v })
    this.drawScene()
  }

  get drawColormap(): string {
    return this.model.draw.colormap
  }
  set drawColormap(v: string) {
    this.model.draw.colormap = v
    this._drawLut = null
    this.emit("change", { property: "drawColormap", value: v })
    if (this.model.drawingVolume) this.refreshDrawing()
  }

  get drawingVolume(): NVImage | null {
    return this.model.drawingVolume
  }

  set drawingVolume(vol: NVImage | null) {
    if (vol === null) {
      this.closeDrawing()
      return
    }
    const volumes = this.model.getVolumes()
    if (volumes.length === 0) {
      log.warn("drawingVolume: no background volume loaded")
      return
    }
    const back = volumes[0]
    if (!back.dimsRAS) {
      log.warn("drawingVolume: background volume has no dimsRAS")
      return
    }
    if (!vol.dimsRAS) NVTransforms.calculateRAS(vol)
    if (!Drawing.validateDrawingDimensions(vol.dimsRAS!, back.dimsRAS)) {
      log.warn("drawingVolume dims do not match background volume")
      return
    }
    if (!(vol.img instanceof Uint8Array)) {
      log.warn("drawingVolume: img must be a Uint8Array")
      return
    }
    const expectedVoxels = back.dimsRAS[1] * back.dimsRAS[2] * back.dimsRAS[3]
    if (vol.img.length !== expectedVoxels) {
      log.warn(
        `drawingVolume: img length ${vol.img.length} does not match expected ${expectedVoxels}`,
      )
      return
    }
    this.model.drawingVolume = vol
    this.model.draw.isEnabled = true
    const cleared = Drawing.clearAllUndoBitmaps(
      this.drawUndoBitmaps,
      this.maxDrawUndoBitmaps,
    )
    this.drawUndoBitmaps = cleared.drawUndoBitmaps
    this.currentDrawUndoBitmap = cleared.currentDrawUndoBitmap
    this._drawLut = null
    this.refreshDrawing()
  }

  // --- Interaction Properties ---

  get primaryDragMode(): number {
    return this.model.interaction.primaryDragMode
  }
  set primaryDragMode(v: number) {
    this.model.interaction.primaryDragMode = v
    this.emit("change", { property: "primaryDragMode", value: v })
  }

  get secondaryDragMode(): number {
    return this.model.interaction.secondaryDragMode
  }
  set secondaryDragMode(v: number) {
    this.model.interaction.secondaryDragMode = v
    this.emit("change", { property: "secondaryDragMode", value: v })
  }

  get isSnapToVoxelCenters(): boolean {
    return this.model.interaction.isSnapToVoxelCenters
  }
  set isSnapToVoxelCenters(v: boolean) {
    this.model.interaction.isSnapToVoxelCenters = v
    this.emit("change", { property: "isSnapToVoxelCenters", value: v })
  }

  get isYoked3DTo2DZoom(): boolean {
    return this.model.interaction.isYoked3DTo2DZoom
  }
  set isYoked3DTo2DZoom(v: boolean) {
    this.model.interaction.isYoked3DTo2DZoom = v
    this.emit("change", { property: "isYoked3DTo2DZoom", value: v })
  }

  // --- Annotation Properties ---

  get annotationIsEnabled(): boolean {
    return this.model.annotation.isEnabled
  }
  set annotationIsEnabled(v: boolean) {
    this.model.annotation.isEnabled = v
    this.emit("change", { property: "annotationIsEnabled", value: v })
    this.drawScene()
  }

  get annotationActiveLabel(): number {
    return this.model.annotation.activeLabel
  }
  set annotationActiveLabel(v: number) {
    this.model.annotation.activeLabel = v
    this.emit("change", { property: "annotationActiveLabel", value: v })
  }

  get annotationActiveGroup(): string {
    return this.model.annotation.activeGroup
  }
  set annotationActiveGroup(v: string) {
    this.model.annotation.activeGroup = v
    this.emit("change", { property: "annotationActiveGroup", value: v })
  }

  get annotationBrushRadius(): number {
    return this.model.annotation.brushRadius
  }
  set annotationBrushRadius(v: number) {
    this.model.annotation.brushRadius = v
    this.emit("change", { property: "annotationBrushRadius", value: v })
  }

  get annotationIsErasing(): boolean {
    return this.model.annotation.isErasing
  }
  set annotationIsErasing(v: boolean) {
    this.model.annotation.isErasing = v
    this.emit("change", { property: "annotationIsErasing", value: v })
  }

  get annotationIsVisibleIn3D(): boolean {
    return this.model.annotation.isVisibleIn3D
  }
  set annotationIsVisibleIn3D(v: boolean) {
    this.model.annotation.isVisibleIn3D = v
    this.emit("change", { property: "annotationIsVisibleIn3D", value: v })
    this.drawScene()
  }

  get annotationStyle(): AnnotationStyle {
    return this.model.annotation.style
  }
  set annotationStyle(v: AnnotationStyle) {
    this.model.annotation.style = v
    this.emit("change", { property: "annotationStyle", value: v })
    this.drawScene()
  }

  get annotationTool(): AnnotationTool {
    return this.model.annotation.tool
  }
  set annotationTool(v: AnnotationTool) {
    this.model.annotation.tool = v
    this.model._annotationSelection = null
    this.emit("change", { property: "annotationTool", value: v })
    this.drawScene()
  }

  get selectedAnnotation(): string | null {
    return this.model._annotationSelection?.annotationId ?? null
  }

  selectAnnotation(id: string | null): void {
    if (id === null) {
      this.model._annotationSelection = null
    } else {
      const ann = this.model.annotations.find((a) => a.id === id)
      if (ann?.shape) {
        this.model._annotationSelection = {
          annotationId: id,
          controlPoints: getControlPoints(ann.shape),
        }
      }
    }
    this.drawScene()
  }

  get annotations(): readonly VectorAnnotation[] {
    return this.model.annotations
  }

  addAnnotation(annotation: VectorAnnotation): void {
    this.model.annotations.push(annotation)
    this.emit("annotationAdded", { annotation })
    this.drawScene()
  }

  removeAnnotation(id: string): void {
    const idx = this.model.annotations.findIndex((a) => a.id === id)
    if (idx >= 0) {
      this.model.annotations.splice(idx, 1)
      this.emit("annotationRemoved", { id })
      this.drawScene()
    }
  }

  clearAnnotations(): void {
    this.model.annotations.length = 0
    this._annotationUndoStack.clear()
    this.emit("annotationChanged", { action: "clear" })
    this.drawScene()
  }

  annotationUndo(): void {
    const restored = this._annotationUndoStack.undo(this.model.annotations)
    if (restored) {
      this.model.annotations = restored
      this.emit("annotationChanged", { action: "undo" })
      this.drawScene()
    }
  }

  annotationRedo(): void {
    const restored = this._annotationUndoStack.redo(this.model.annotations)
    if (restored) {
      this.model.annotations = restored
      this.emit("annotationChanged", { action: "redo" })
      this.drawScene()
    }
  }

  getAnnotationsJSON(): string {
    return JSON.stringify(this.model.annotations)
  }

  loadAnnotationsJSON(json: string): void {
    this.model.annotations = JSON.parse(json) as VectorAnnotation[]
    this._annotationUndoStack.clear()
    this.drawScene()
  }

  protected enforceBackendAvailability(): void {
    if (this._distributionBackend === "both") {
      if (this.opts.backend === "webgpu" && !navigator.gpu) {
        log.warn("WebGPU not available, falling back to WebGL2")
        this.opts.backend = "webgl2"
      }
      return
    }
    if (this.opts.backend === "webgpu" && !navigator.gpu) {
      throw new Error(
        "This niivuegpu WebGPU-only distribution requires browser WebGPU support.",
      )
    }
    if (this._distributionBackend === "webgpu") {
      if (this.opts.backend === "webgl2") {
        throw new Error(
          "This niivuegpu distribution includes only WebGPU. Requested backend 'webgl2' is unavailable.",
        )
      }
      this.opts.backend = "webgpu"
      return
    }
    if (this.opts.backend === "webgpu") {
      throw new Error(
        "This niivuegpu distribution includes only WebGL2. Requested backend 'webgpu' is unavailable.",
      )
    }
    this.opts.backend = "webgl2"
  }

  /**
   * Register an external format loader.
   * The converter function receives raw file bytes and returns bytes in a known format.
   * @param converter - function that converts from the source format to the target format
   * @param fromExt - source file extension without dot (e.g. 'vox', 'glb')
   * @param toExt - target format extension without dot: 'nii' for volumes, 'mz3' for meshes
   */
  useLoader(
    converter: (
      buffer: ArrayBuffer,
    ) => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>,
    fromExt: string,
    toExt: string,
  ): void {
    const to = toExt.toUpperCase()
    const volumeExts = NVVolume.volumeExtensions()
    const meshExts = NVMesh.meshExtensions()
    if (volumeExts.includes(to)) {
      NVVolume.registerExternalReader(fromExt, toExt, converter)
    } else if (meshExts.includes(to)) {
      NVMesh.registerExternalReader(fromExt, toExt, converter)
    } else {
      throw new Error(
        `Unsupported target format "${toExt}". Use a known volume format (e.g. "nii") or mesh format (e.g. "mz3").`,
      )
    }
  }

  private _checkBounds<T>(array: T[], index: number, name: string): boolean {
    if (index < 0 || index >= array.length) {
      log.warn(`${name} index ${index} out of bounds (${array.length} loaded).`)
      return false
    }
    return true
  }

  async attachTo(id: string, isAntiAlias = null): Promise<this> {
    await this._viewLifecycle.attachTo(this, id, isAntiAlias)
    return this
  }

  async attachToCanvas(
    canvas: HTMLCanvasElement,
    isAntiAlias: boolean | null = null,
  ): Promise<this> {
    await this._viewLifecycle.attachToCanvas(this, canvas, isAntiAlias)
    return this
  }

  async updateGLVolume() {
    if (this._updating) {
      this._pendingUpdate = true
      return
    }
    this._updating = true
    try {
      this._computeModulationData()
      if (!this.view) return
      await this.view.updateBindGroups()
      this.drawScene()
    } finally {
      this._updating = false
      if (this._pendingUpdate) {
        this._pendingUpdate = false
        await this.updateGLVolume()
      }
    }
  }

  /**
   * Set a modulation image for a target volume.
   * The modulator's intensity scales the target volume's brightness and opacity.
   * @param targetId - ID of the volume to modulate
   * @param modulatorId - ID of the volume providing modulation (empty string to clear)
   */
  async setModulationImage(
    targetId: string,
    modulatorId: string,
  ): Promise<void> {
    const target = this.volumes.find((v) => v.id === targetId)
    if (!target) {
      log.warn(`setModulationImage: target volume "${targetId}" not found`)
      return
    }
    target.modulationImage = modulatorId || undefined
    target._modulationData = null
    target.isDirty = true
    await this.updateGLVolume()
  }

  /**
   * Convert a float32 3-frame volume to V1 (eigenvector) RGBA representation.
   * For formats like AFNI that lack NIfTI intent codes, this provides explicit
   * conversion of vector field data (dim4=3, float32) to sign-encoded RGBA.
   * @param volumeIndex - Index of the volume to convert
   * @param isFlipX - Flip X component (default: false)
   * @param isFlipY - Flip Y component (default: false)
   * @param isFlipZ - Flip Z component (default: false)
   */
  async loadImgV1(
    volumeIndex: number,
    isFlipX = false,
    isFlipY = false,
    isFlipZ = false,
  ): Promise<boolean> {
    const vol = this.volumes[volumeIndex]
    if (!vol) {
      log.warn(`loadImgV1: volume index ${volumeIndex} not found`)
      return false
    }
    const ok = NVTensorProcessing.loadImgV1(vol, isFlipX, isFlipY, isFlipZ)
    if (ok) {
      vol.isDirty = true
      await this.updateGLVolume()
    }
    return ok
  }

  /** Compute modulation data for all volumes that have modulationImage set. */
  private _computeModulationData(): void {
    computeModulationData(this.volumes)
  }

  get backend(): BackendType | undefined {
    return this.opts.backend
  }

  get isAntiAlias(): boolean {
    return this.opts.isAntiAlias ?? false
  }

  get isDragDropEnabled(): boolean {
    return this.opts.isDragDropEnabled ?? true
  }

  set isDragDropEnabled(enabled: boolean) {
    this.opts.isDragDropEnabled = enabled
  }

  get devicePixelRatio(): number {
    return this.opts.forceDevicePixelRatio ?? -1
  }

  /** @deprecated Use devicePixelRatio */
  get forceDevicePixelRatio(): number {
    return this.devicePixelRatio
  }

  set devicePixelRatio(dpr: number) {
    if (!this.view) return
    this.view.forceDevicePixelRatio = dpr
    this.view.resize()
  }

  /** @deprecated Use devicePixelRatio */
  set forceDevicePixelRatio(dpr: number) {
    this.devicePixelRatio = dpr
  }

  getClipPlaneDepthAziElev(clipPlaneIndex = 0): [number, number, number] {
    return this.model.getClipPlaneDepthAziElev(clipPlaneIndex)
  }

  setClipPlaneDepthAziElev(
    depth: number,
    azimuth: number,
    elevation: number,
    clipPlaneIndex = 0,
  ): void {
    this.model.setClipPlaneDepthAziElev(
      depth,
      azimuth,
      elevation,
      clipPlaneIndex,
    )
    this.emit("clipPlaneChange", { clipPlane: [depth, azimuth, elevation] })
    this.drawScene()
  }

  setClipPlane(depthAzimuthElevation: number[]): void {
    const dae = depthAzimuthElevation
    this.model.setClipPlaneDepthAziElev(
      dae[0],
      dae[1],
      dae[2],
      this.activeClipPlaneIndex,
    )
    this.emit("clipPlaneChange", { clipPlane: [...dae] })
    this.drawScene()
  }

  setClipPlanes(depthAziElevs: number[][]): void {
    for (let i = 0; i < NUM_CLIP_PLANE; i++) {
      if (i < depthAziElevs.length) {
        const [depth, azimuth, elevation] = depthAziElevs[i]
        this.model.setClipPlaneDepthAziElev(depth, azimuth, elevation, i)
      } else {
        this.model.setClipPlaneDepthAziElev(2.0, 0, 0, i)
      }
    }
    this.drawScene()
  }

  private async _loadDeferredData(): Promise<void> {
    const vols = this._deferredVolumes
    const meshes = this._deferredMeshes
    this._deferredVolumes = null
    this._deferredMeshes = null
    if (vols) await this.loadVolumes(vols)
    if (meshes) await this.loadMeshes(meshes)
    if (!vols && !meshes) this.drawScene()
  }

  get volumes() {
    return this.model.volumes
  }

  get meshes() {
    return this.model.meshes
  }

  async loadMatcap(matcapName: string): Promise<void> {
    const matcaps = this.opts.matcaps
    const url = matcaps?.[matcapName] ?? matcapName
    this.model.volume.matcap = url
    await this.updateGLVolume()
  }

  async addVolume(volume: ImageFromUrlOptions | NVImage): Promise<this> {
    await this.model.addVolume(volume)
    const vols = this.model.getVolumes()
    this.emit("volumeLoaded", { volume: vols[vols.length - 1] })
    await this.updateGLVolume()
    return this
  }

  async loadVolumes(
    volumes: ImageFromUrlOptions | ImageFromUrlOptions[],
  ): Promise<this> {
    if (!Array.isArray(volumes)) volumes = [volumes]
    if (this.model.ui.isThumbnailVisible) {
      this._deferredVolumes = volumes
      return this
    }
    await this.removeAllVolumes()
    // Fetch all volumes in parallel, then add in original order
    const loaded = await Promise.all(
      volumes.map((v) => NVModel.prepareVolume(v)),
    )
    for (const vol of loaded) {
      await this.model.addVolume(vol)
      const vols = this.model.getVolumes()
      this.emit("volumeLoaded", { volume: vols[vols.length - 1] })
    }
    await this.updateGLVolume()
    return this
  }

  async addMesh(mesh: MeshFromUrlOptions | NVMeshType): Promise<this> {
    await this.model.addMesh(mesh)
    const meshes = this.model.getMeshes()
    this.emit("meshLoaded", { mesh: meshes[meshes.length - 1] })
    await this.updateGLVolume()
    return this
  }

  async loadMeshes(
    meshes: MeshFromUrlOptions | MeshFromUrlOptions[],
  ): Promise<this> {
    if (!Array.isArray(meshes)) meshes = [meshes]
    if (this.model.ui.isThumbnailVisible) {
      this._deferredMeshes = meshes
      return this
    }
    await this.removeAllMeshes()
    // Load all meshes in parallel, then add in original order
    const loaded = await Promise.all(meshes.map((m) => NVMesh.loadMesh(m)))
    for (const m of loaded) {
      await this.model.addMesh(m)
      const allMeshes = this.model.getMeshes()
      this.emit("meshLoaded", { mesh: allMeshes[allMeshes.length - 1] })
    }
    await this.updateGLVolume()
    return this
  }

  async addImage(
    pathOrFile: string | File,
    options: Record<string, unknown> = {},
  ): Promise<void> {
    const ext = NVLoader.getFileExt(
      typeof pathOrFile === "string" ? pathOrFile : pathOrFile.name,
    )
    const meshExts = NVMesh.meshExtensions()
    if (meshExts.includes(ext)) {
      await this.addMesh({ url: pathOrFile, ...options } as MeshFromUrlOptions)
    } else {
      await this.addVolume({
        url: pathOrFile,
        ...options,
      } as ImageFromUrlOptions)
    }
  }

  async loadImage(
    pathOrFile: string | File,
    options: Record<string, unknown> = {},
  ): Promise<void> {
    const ext = NVLoader.getFileExt(
      typeof pathOrFile === "string" ? pathOrFile : pathOrFile.name,
    )
    const meshExts = NVMesh.meshExtensions()
    if (meshExts.includes(ext)) {
      await this.loadMeshes([
        { url: pathOrFile, ...options } as MeshFromUrlOptions,
      ])
    } else {
      await this.loadVolumes([
        { url: pathOrFile, ...options } as ImageFromUrlOptions,
      ])
    }
  }

  async removeMesh(meshIndex: number): Promise<void> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    const mesh = meshes[meshIndex]
    this.emit("meshRemoved", { mesh, index: meshIndex })
    this.model.removeMesh(meshIndex)
    await this.updateGLVolume()
  }

  async removeAllVolumes(): Promise<void> {
    const vols = this.model.getVolumes()
    for (let i = vols.length - 1; i >= 0; i--) {
      this.emit("volumeRemoved", { volume: vols[i], index: i })
    }
    await this.model.removeAllVolumes()
    await this.updateGLVolume()
  }

  async removeAllMeshes(): Promise<void> {
    const meshes = this.model.getMeshes()
    for (let i = meshes.length - 1; i >= 0; i--) {
      this.emit("meshRemoved", { mesh: meshes[i], index: i })
    }
    this.model.removeAllMeshes()
    await this.updateGLVolume()
  }

  /**
   * Move a volume up one index position in the stack of loaded volumes (toward the top layer).
   * @param volumeIndex - Index of the volume to move
   * @example
   * await nv1.moveVolumeUp(0) // move the background image up one position
   */
  async moveVolumeUp(volumeIndex: number): Promise<void> {
    if (!this._checkBounds(this.model.volumes, volumeIndex, "Volume")) return
    const changed = this.model.moveVolume(volumeIndex, volumeIndex + 1)
    if (!changed) return
    this.emit("volumeOrderChanged", { volumes: this.model.volumes })
    await this.updateGLVolume()
  }

  /**
   * Move a volume down one index position in the stack of loaded volumes (toward the background).
   * @param volumeIndex - Index of the volume to move
   * @example
   * await nv1.moveVolumeDown(1) // move the second image down to the background position
   */
  async moveVolumeDown(volumeIndex: number): Promise<void> {
    if (!this._checkBounds(this.model.volumes, volumeIndex, "Volume")) return
    const changed = this.model.moveVolume(volumeIndex, volumeIndex - 1)
    if (!changed) return
    this.emit("volumeOrderChanged", { volumes: this.model.volumes })
    await this.updateGLVolume()
  }

  /**
   * Move a volume to the top position in the stack of loaded volumes (last index, top layer).
   * @param volumeIndex - Index of the volume to move
   * @example
   * await nv1.moveVolumeToTop(0) // move the background image to the top layer
   */
  async moveVolumeToTop(volumeIndex: number): Promise<void> {
    if (!this._checkBounds(this.model.volumes, volumeIndex, "Volume")) return
    const changed = this.model.moveVolume(
      volumeIndex,
      this.model.volumes.length - 1,
    )
    if (!changed) return
    this.emit("volumeOrderChanged", { volumes: this.model.volumes })
    await this.updateGLVolume()
  }

  /**
   * Move a volume to the bottom position in the stack of loaded volumes (index 0, background).
   * @param volumeIndex - Index of the volume to move
   * @example
   * await nv1.moveVolumeToBottom(3) // move the 4th volume to the background position
   */
  async moveVolumeToBottom(volumeIndex: number): Promise<void> {
    if (!this._checkBounds(this.model.volumes, volumeIndex, "Volume")) return
    const changed = this.model.moveVolume(volumeIndex, 0)
    if (!changed) return
    this.emit("volumeOrderChanged", { volumes: this.model.volumes })
    await this.updateGLVolume()
  }

  /**
   * Set a label colormap on a volume (e.g., atlas/parcellation).
   * Converts the ColorMap definition to an LUT and attaches it to the volume.
   * When set, the orient shader uses nearest-neighbor label lookup instead of
   * continuous colormap interpolation, and locationChange events include label names.
   *
   * @param volumeIndex - Index of the volume to apply the label colormap to
   * @param cmap - ColorMap definition with R,G,B arrays and optional labels/I arrays,
   *               or null to remove the label colormap
   */
  async setColormapLabel(
    volumeIndex: number,
    cmap: ColorMap | null,
  ): Promise<void> {
    const volumes = this.model.getVolumes()
    if (!this._checkBounds(volumes, volumeIndex, "Volume")) return
    if (cmap === null) {
      volumes[volumeIndex].colormapLabel = null
    } else {
      volumes[volumeIndex].colormapLabel = NVCmaps.makeLabelLut(cmap)
      volumes[volumeIndex].colormapLabel.centroids =
        computeVolumeLabelCentroids(volumes[volumeIndex])
    }
    volumes[volumeIndex].isDirty = true
    await this.updateGLVolume()
  }

  /**
   * Fetch a label colormap JSON from a URL or File and apply it to a volume.
   * The JSON should contain R, G, B arrays and optional labels/I arrays.
   *
   * @param volumeIndex - Index of the volume to apply the label colormap to
   * @param url - URL string or File object pointing to a colormap JSON
   */
  async setColormapLabelFromUrl(
    volumeIndex: number,
    url: string | File,
  ): Promise<void> {
    const { cmap } = await this._fetchColormapJson(url)
    await this.setColormapLabel(volumeIndex, cmap)
  }

  getMeshShader(meshIndex: number): string | undefined {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    return meshes[meshIndex].shaderType
  }

  /**
   * Update display properties of a loaded volume.
   * Accepts any subset of volume display options (colormap, opacity, cal_min, etc.)
   * and triggers a single GPU update.
   *
   * @example
   * await nv1.setVolume(0, { colormap: 'hot', opacity: 0.8 })
   * await nv1.setVolume(1, { cal_min: 10, cal_max: 200, cal_minNeg: -200, cal_maxNeg: -10 })
   */
  async setVolume(volumeIndex: number, options: VolumeUpdate): Promise<void> {
    const volumes = this.model.getVolumes()
    if (!this._checkBounds(volumes, volumeIndex, "Volume")) return
    // Clamp frame4D to valid range
    if (options.frame4D !== undefined) {
      const maxFrame = (volumes[volumeIndex].nFrame4D ?? 1) - 1
      options.frame4D = Math.max(0, Math.min(options.frame4D, maxFrame))
    }
    Object.assign(volumes[volumeIndex], options)
    this.emit("volumeUpdated", {
      volumeIndex,
      volume: volumes[volumeIndex],
      changes: options,
    })
    await this.updateGLVolume()
  }

  /**
   * Update display properties of a loaded mesh.
   * Accepts any subset of mesh display options (opacity, shaderType, color, etc.)
   * and triggers a single GPU update.
   *
   * @example
   * await nv1.setMesh(0, { shaderType: 'toon', opacity: 0.5 })
   * await nv1.setMesh(1, { color: [1, 0, 0, 1], colorbarVisible: false })
   */
  async setMesh(meshIndex: number, options: MeshUpdate): Promise<void> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    if (options.rgba255) {
      options.color = [
        options.rgba255[0] / 255,
        options.rgba255[1] / 255,
        options.rgba255[2] / 255,
        options.rgba255[3] / 255,
      ]
      delete options.rgba255
    }
    if (options.shaderType) {
      options.shaderType = options.shaderType.toLowerCase()
      const validShaders = this.view?.getAvailableShaders() ?? []
      if (!validShaders.includes(options.shaderType)) {
        log.warn(
          `Invalid shader type: ${options.shaderType}. Expected one of: ${validShaders.join(", ")}`,
        )
        return
      }
    }
    // If color changed on a mesh without per-vertex file colors, recomposite
    if (options.color && !meshes[meshIndex].perVertexColors) {
      const m = meshes[meshIndex]
      if (m.layers.length > 0) {
        NVMeshLayers.compositeLayers(null, options.color, m.layers, m.colors)
      } else {
        const [r, g, b, a] = options.color
        const packed =
          (Math.round(a * 255) << 24) |
          (Math.round(b * 255) << 16) |
          (Math.round(g * 255) << 8) |
          Math.round(r * 255)
        m.colors.fill(packed)
      }
    }
    Object.assign(meshes[meshIndex], options)
    this.emit("meshUpdated", {
      meshIndex,
      mesh: meshes[meshIndex],
      changes: options,
    })
    await this.updateGLVolume()
  }

  /**
   * Add a scalar overlay layer to a mesh.
   *
   * @example
   * await nv1.addMeshLayer(0, { url: 'brain.curv', colormap: 'gray', cal_min: 0.3, cal_max: 0.5 })
   */
  async addMeshLayer(
    meshIndex: number,
    layerOpts: MeshLayerFromUrlOptions,
  ): Promise<this> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return this
    const m = meshes[meshIndex]
    const nVert = m.positions.length / 3
    const result = await NVMeshLayers.loadLayerFromUrl(layerOpts.url, nVert)
    const urlString =
      typeof layerOpts.url === "string" ? layerOpts.url : layerOpts.url.name
    const newLayer = NVMeshLayers.createLayer(result.values, nVert, {
      nFrame4D: result.nFrame4D,
      colormapLabel: result.colormapLabel ?? null,
      colormapType: layerOpts.colormapType ?? result.colormapType,
      isTransparentBelowCalMin:
        layerOpts.isTransparentBelowCalMin ?? result.isTransparentBelowCalMin,
      colormap: layerOpts.colormap,
      colormapNegative: layerOpts.colormapNegative,
      calMin: layerOpts.calMin,
      calMax: layerOpts.calMax,
      calMinNeg: layerOpts.calMinNeg,
      calMaxNeg: layerOpts.calMaxNeg,
      opacity: layerOpts.opacity,
      isColorbarVisible: layerOpts.isColorbarVisible,
      isColormapInverted: layerOpts.isColormapInverted,
      isAdditiveBlend: layerOpts.isAdditiveBlend,
      outlineWidth: layerOpts.outlineWidth,
      url: urlString,
      name: layerOpts.name ?? urlString,
    })
    if (newLayer.colormapLabel) {
      newLayer.colormapLabel.centroids = NVMeshLayers.computeMeshLabelCentroids(
        m.positions,
        newLayer,
      )
    }
    m.layers.push(newLayer)
    NVMeshLayers.compositeLayers(m.perVertexColors, m.color, m.layers, m.colors)
    await this.updateGLVolume()
    return this
  }

  /**
   * Remove a scalar overlay layer from a mesh.
   */
  async removeMeshLayer(meshIndex: number, layerIndex: number): Promise<this> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return this
    const m = meshes[meshIndex]
    if (!this._checkBounds(m.layers, layerIndex, "Layer")) return this
    m.layers.splice(layerIndex, 1)
    NVMeshLayers.compositeLayers(m.perVertexColors, m.color, m.layers, m.colors)
    await this.updateGLVolume()
    return this
  }

  /**
   * Update properties of a mesh layer (colormap, cal_min, cal_max, opacity, etc.).
   * Triggers recompositing and GPU update.
   *
   * @example
   * await nv1.setMeshLayerProperty(0, 0, { colormap: 'hot', opacity: 0.8 })
   */
  async setMeshLayerProperty(
    meshIndex: number,
    layerIndex: number,
    options: Partial<NVMeshLayer>,
  ): Promise<void> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    const m = meshes[meshIndex]
    if (!this._checkBounds(m.layers, layerIndex, "Layer")) return
    Object.assign(m.layers[layerIndex], options)
    NVMeshLayers.compositeLayers(m.perVertexColors, m.color, m.layers, m.colors)
    await this.updateGLVolume()
  }

  /**
   * Set the current 4D frame for a mesh layer.
   */
  async setMeshLayerFrame4D(
    meshIndex: number,
    layerIndex: number,
    frame: number,
  ): Promise<void> {
    await this.setMeshLayerProperty(meshIndex, layerIndex, { frame4D: frame })
  }

  /**
   * Update tract tessellation/display options and re-tessellate.
   *
   * @example
   * await nv1.setTractOptions(0, { fiberRadius: 0.8, fiberSides: 12 })
   */
  async setTractOptions(
    meshIndex: number,
    options: Partial<NVTractOptions>,
  ): Promise<void> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    const m = meshes[meshIndex]
    if (m.kind !== "tract" || !m.tractOptions) {
      log.warn(`setTractOptions: mesh ${meshIndex} is not a tract`)
      return
    }
    // When colorBy changes, reset cal_min/cal_max to 0 so auto-compute picks up
    // the new scalar's range (each overlay has a different data range)
    if ("colorBy" in options && options.colorBy !== m.tractOptions.colorBy) {
      if (!("calMin" in options)) options.calMin = 0
      if (!("calMax" in options)) options.calMax = 0
    }
    Object.assign(m.tractOptions, options)
    // Auto-toggle colorbar visibility based on scalar coloring mode
    if ("colorBy" in options) {
      const cb = m.tractOptions.colorBy
      m.isColorbarVisible = cb.startsWith("dpv:") || cb.startsWith("dps:")
    }
    NVMesh.retessellateTract(m)
    await this.updateGLVolume()
  }

  /**
   * Get the group names for a tract mesh.
   * Returns an empty array if the mesh is not a tract or has no groups.
   */
  getTractGroups(meshIndex: number): string[] {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return []
    const m = meshes[meshIndex]
    if (m.kind !== "tract" || !m.trx) return []
    return Object.keys(m.trx.groups)
  }

  /**
   * Update connectome extrusion/display options and re-extrude.
   *
   * @example
   * await nv1.setConnectomeOptions(0, { nodeScale: 5, edgeMin: 3 })
   */
  async setConnectomeOptions(
    meshIndex: number,
    options: Partial<NVConnectomeOptions>,
  ): Promise<void> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    const m = meshes[meshIndex]
    if (m.kind !== "connectome" || !m.connectomeOptions) {
      log.warn(`setConnectomeOptions: mesh ${meshIndex} is not a connectome`)
      return
    }
    Object.assign(m.connectomeOptions, options)
    NVMesh.reextrudeConnectome(m)
    await this.updateGLVolume()
  }

  /**
   * Get the current 4D frame index for a volume.
   * @param id - Volume ID (typically the URL or name)
   * @returns Current frame index (0-based), or 0 if volume not found
   */
  getFrame4D(id: string): number {
    const vol = this.volumes.find((v) => v.id === id)
    return vol?.frame4D ?? 0
  }

  /**
   * Set the current 4D frame for a volume.
   * @param id - Volume ID (typically the URL or name)
   * @param frame - Frame index (0-based, clamped to valid range)
   */
  async setFrame4D(id: string, frame: number): Promise<void> {
    const vol = this.volumes.find((v) => v.id === id)
    if (!vol) {
      log.warn(`setFrame4D: volume with id "${id}" not found`)
      return
    }
    const maxFrame = (vol.nFrame4D ?? 1) - 1
    const clamped = Math.max(0, Math.min(frame, maxFrame))
    if (clamped === vol.frame4D) return
    vol.frame4D = clamped
    this.emit("frameChange", { volume: vol, frame: clamped })
    await this.updateGLVolume()
    this.createOnLocationChange()
  }

  /**
   * Recalculate robust cal_min/cal_max for a specific 4D frame (or the current frame).
   * Updates the volume's calibration range and triggers a GPU update.
   */
  async recalculateCalMinMax(
    volumeIndex: number,
    frame?: number,
  ): Promise<void> {
    const vol = this.volumes[volumeIndex]
    if (!vol) {
      log.warn(
        `recalculateCalMinMax: volume index ${volumeIndex} out of bounds`,
      )
      return
    }
    const f = frame ?? vol.frame4D ?? 0
    const [pct2, pct98, mnScale, mxScale] = calMinMaxFrame(vol, f)
    vol.calMin = pct2
    vol.calMax = pct98
    vol.robustMin = pct2
    vol.robustMax = pct98
    vol.globalMin = mnScale
    vol.globalMax = mxScale
    await this.updateGLVolume()
  }

  /**
   * Load all remaining frames for a 4D volume that was opened with limitFrames4D.
   * Re-fetches the complete file and replaces the truncated image data.
   * @param id - Volume ID (typically the URL or name)
   */
  async loadDeferred4DVolumes(id: string): Promise<void> {
    const vol = this.volumes.find((v) => v.id === id)
    if (!vol) {
      log.warn(`loadDeferred4DVolumes: volume with id "${id}" not found`)
      return
    }
    if ((vol.nTotalFrame4D ?? 1) <= (vol.nFrame4D ?? 1)) {
      return // Already fully loaded
    }
    if (!vol.url) {
      log.warn("loadDeferred4DVolumes: volume has no url for re-fetch")
      return
    }
    const nii = await NVVolume.loadVolume(vol.url)
    vol.img = nii.img instanceof ArrayBuffer ? null : nii.img
    vol.nFrame4D = vol.nTotalFrame4D
    await this.updateGLVolume()
  }

  /**
   * Convert RAS voxel coordinates to scene fraction [0,1].
   * Uses the background volume's matRAS for the vox→mm conversion.
   */
  vox2frac(vox: [number, number, number]): [number, number, number] {
    if (this.volumes.length === 0) return [0.5, 0.5, 0.5]
    const vol = this.volumes[0]
    if (!vol.matRAS) return [0.5, 0.5, 0.5]
    const mm = NVTransforms.vox2mm(null, vox, vol.matRAS)
    const frac = this.model.mm2scene(mm)
    return [frac[0], frac[1], frac[2]]
  }

  getCrosshairPos(): [number, number, number] {
    const pos = this.model.scene2mm(this.model.scene.crosshairPos)
    return [pos[0], pos[1], pos[2]]
  }

  setCrosshairPos(pos: [number, number, number]): void {
    let mm: [number, number, number] = pos
    // Snap to voxel centers if enabled and volumes are loaded
    if (
      this.model.interaction.isSnapToVoxelCenters &&
      this.volumes.length > 0
    ) {
      const vol = this.volumes[0]
      if (vol.matRAS && vol.dimsRAS) {
        const vox = NVTransforms.mm2vox(vol, mm)
        const snapped = NVTransforms.vox2mm(
          null,
          [vox[0], vox[1], vox[2]],
          vol.matRAS,
        )
        mm = [snapped[0], snapped[1], snapped[2]]
      }
    }
    const frac = this.model.mm2scene(mm)
    for (let i = 0; i < 3; i++) {
      frac[i] = Math.max(0, Math.min(1, frac[i]))
    }
    this.model.scene.crosshairPos = frac
    this.createOnLocationChange()
    this.drawScene()
  }

  moveCrosshairInVox(di: number, dj: number, dk: number): void {
    const volumes = this.model.getVolumes()
    if (volumes.length === 0) return
    const vol = volumes[0]
    if (!vol.matRAS || !vol.dimsRAS) return
    const mm = this.model.scene2mm(this.model.scene.crosshairPos)
    const vox = NVTransforms.mm2vox(vol, mm)
    const ni = Math.max(0, Math.min(vol.dimsRAS[1] - 1, vox[0] + di))
    const nj = Math.max(0, Math.min(vol.dimsRAS[2] - 1, vox[1] + dj))
    const nk = Math.max(0, Math.min(vol.dimsRAS[3] - 1, vox[2] + dk))
    const newMM = NVTransforms.vox2mm(null, [ni, nj, nk], vol.matRAS)
    this.setCrosshairPos([newMM[0], newMM[1], newMM[2]])
  }

  createOnLocationChange(axCorSag = NaN): void {
    const msg = buildLocationMessage(this, axCorSag)
    if (msg) this.emit("locationChange", msg)
  }

  /**
   * Update the drawing bounds for this Niivue instance.
   * Coordinates use y=0 at bottom, y=1 at top (GL convention).
   *
   * @param bounds - [x1, y1, x2, y2] in normalized (0-1) coordinates.
   *
   * Example:
   *   nv.setBounds([0,0,0.5,0.5])   // bottom-left quarter
   *   nv.setBounds([0.5,0.5,1,1])   // top-right quarter
   */
  setBounds(bounds: [number, number, number, number]): void {
    if (!Array.isArray(bounds) || bounds.length !== 4) {
      throw new Error("setBounds: expected [x1,y1,x2,y2] array")
    }
    this.opts.bounds = [
      [bounds[0], bounds[1]],
      [bounds[2], bounds[3]],
    ]
    if (this.view) {
      this.view.resize()
      this.drawScene()
    }
  }

  drawScene(needsSync = true): void {
    if (needsSync) this._syncDirty = true
    if (!this.framePending) {
      this.framePending = true
      this._rafId = requestAnimationFrame(() => {
        this._rafId = null
        this.framePending = false
        if (this._drawingDirty) {
          this._drawingDirty = false
          this._flushDrawing()
        }
        this._sync()
        if (this.view) this.view.render()
      })
    }
  }

  get colormaps(): string[] {
    return NVCmaps.colormapNames()
  }

  /**
   * Case-insensitive existence check for a registered colormap. Accepts
   * whatever casing the caller has on hand (e.g. a lowercased `<select>`
   * value) and compares against the canonical stored name. Prefer this
   * over `nv1.colormaps.includes(...)` — it handles the first-letter
   * canonicalization that `addColormap` and the filesystem auto-loader
   * apply internally.
   */
  hasColormap(name: string): boolean {
    if (!name) return false
    const canonical = name.charAt(0).toUpperCase() + name.slice(1)
    return NVCmaps.lookupColorMap(canonical) !== null
  }

  get meshExtensions(): string[] {
    return NVMesh.meshExtensions()
  }

  get meshWriteExtensions(): string[] {
    return NVMesh.meshWriteExtensions()
  }

  async saveMesh(
    meshIndex: number,
    filename = "mesh.mz3",
    options?: WriteOptions,
  ): Promise<void> {
    const meshes = this.model.getMeshes()
    if (!this._checkBounds(meshes, meshIndex, "Mesh")) return
    const ext = NVLoader.getFileExt(filename)
    const mesh = meshes[meshIndex]
    const buffer = await NVMesh.writeMesh(
      ext,
      mesh.positions,
      mesh.indices,
      options,
    )
    NVDocument.downloadBlob(
      new Blob([buffer], { type: "application/octet-stream" }),
      filename,
    )
  }

  async saveBitmap(
    filename = "myBitmap.png",
    quality = 0.92,
  ): Promise<boolean> {
    if (!this.canvas) {
      log.warn("saveBitmap: no canvas attached")
      return false
    }

    if (this._drawingDirty) {
      this._drawingDirty = false
      this._flushDrawing()
    }
    if (this.view) this.view.render()

    const sourceCanvas = this.canvas
    const bounds = this.opts.bounds
    let sx = 0
    let sy = 0
    let sw = sourceCanvas.width
    let sh = sourceCanvas.height

    if (
      bounds &&
      !(
        bounds[0][0] === 0 &&
        bounds[0][1] === 0 &&
        bounds[1][0] === 1 &&
        bounds[1][1] === 1
      )
    ) {
      const x1 = Math.max(0, Math.min(1, Math.min(bounds[0][0], bounds[1][0])))
      const y1 = Math.max(0, Math.min(1, Math.min(bounds[0][1], bounds[1][1])))
      const x2 = Math.max(0, Math.min(1, Math.max(bounds[0][0], bounds[1][0])))
      const y2 = Math.max(0, Math.min(1, Math.max(bounds[0][1], bounds[1][1])))
      const left = Math.round(x1 * sourceCanvas.width)
      const right = Math.round(x2 * sourceCanvas.width)
      const top = Math.round((1 - y2) * sourceCanvas.height)
      const bottom = Math.round((1 - y1) * sourceCanvas.height)
      sx = left
      sy = top
      sw = Math.max(1, right - left)
      sh = Math.max(1, bottom - top)
    }

    const exportCanvas = document.createElement("canvas")
    exportCanvas.width = sw
    exportCanvas.height = sh
    const context = exportCanvas.getContext("2d")
    if (!context) {
      log.warn("saveBitmap: failed to create 2D export context")
      return false
    }
    context.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh)

    let outputName = filename.trim() || "myBitmap.png"
    const lowerName = outputName.toLowerCase()
    let mimeType = "image/png"
    if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) {
      mimeType = "image/jpeg"
    } else if (!lowerName.endsWith(".png")) {
      outputName += ".png"
    }

    const jpgQuality = Math.max(0, Math.min(1, quality))
    const blob = await new Promise<Blob | null>((resolve) => {
      exportCanvas.toBlob(
        resolve,
        mimeType,
        mimeType === "image/jpeg" ? jpgQuality : undefined,
      )
    })

    if (!blob) {
      log.warn("saveBitmap: failed to generate image blob")
      return false
    }

    NVDocument.downloadBlob(blob, outputName)
    return true
  }

  get volumeWriteExtensions(): string[] {
    return NVVolume.volumeWriteExtensions()
  }

  /**
   * Save voxel-based image to disk.
   *
   * @param options - configuration object with the following fields:
   *   - `filename`: name of the NIfTI image to create. If empty, returns data only.
   *   - `isSaveDrawing`: whether to save the drawing layer or the background image
   *   - `volumeByIndex`: which image layer to save (0 for background)
   * @returns `true` if successful when writing to disk, or a `Uint8Array` if exported as binary data
   *
   * @example
   * niivue.saveVolume({ filename: "myimage.nii.gz", isSaveDrawing: true });
   * niivue.saveVolume({ filename: "myimage.nii" });
   */
  async saveVolume(
    options: SaveVolumeOptions = {},
  ): Promise<boolean | Uint8Array> {
    const { filename = "", isSaveDrawing = false, volumeByIndex = 0 } = options
    const volumes = this.model.getVolumes()
    if (volumes.length === 0) {
      log.debug("No voxelwise image open")
      return false
    }
    if (!this._checkBounds(volumes, volumeByIndex, "Volume")) return false
    const volume = volumes[volumeByIndex]
    let hdr = volume.hdr
    let imgBuffer: ArrayBuffer
    if (isSaveDrawing) {
      if (!this.model.drawingVolume) {
        log.debug("No drawing open")
        return false
      }
      // Use the drawing volume's own header
      hdr = JSON.parse(JSON.stringify(this.model.drawingVolume.hdr))
      hdr.datatypeCode = 2 // DT_UINT8
      hdr.numBitsPerVoxel = 8
      hdr.scl_slope = 1.0
      hdr.scl_inter = 0.0
      hdr.cal_max = 0
      hdr.cal_min = 0
      // Reorient drawing from RAS to native voxel order
      const nativeDrawing = reorientDrawingToNative(
        volume,
        Drawing.getDrawingBitmap(this.model.drawingVolume),
      )
      imgBuffer = nativeDrawing.buffer as ArrayBuffer
    } else {
      if (!volume.img) {
        log.debug("Volume has no image data")
        return false
      }
      // Convert TypedArray to ArrayBuffer (slice to avoid including header bytes)
      imgBuffer = (volume.img.buffer as ArrayBuffer).slice(
        volume.img.byteOffset,
        volume.img.byteOffset + volume.img.byteLength,
      )
    }
    const buffer = await NVVolume.writeVolume(
      filename || "image.nii",
      hdr,
      imgBuffer,
    )
    const outBytes = new Uint8Array(buffer)
    if (!filename) {
      return outBytes
    }
    NVDocument.downloadBlob(
      new Blob([buffer], { type: "application/octet-stream" }),
      filename,
    )
    return true
  }

  get volumeExtensions(): string[] {
    return NVVolume.volumeExtensions()
  }

  get meshShaders() {
    if (!this.view || typeof this.view.getAvailableShaders !== "function") {
      return []
    }
    return this.view.getAvailableShaders()
  }

  /**
   * Get list of available volume transform names.
   */
  get volumeTransforms(): string[] {
    return NVVolumeTransforms.transformNames()
  }

  /**
   * Namespace for volume transform operations.
   * Each transform takes an NVImage and returns a new NVImage.
   * Transforms are auto-discovered plugins — no hardcoded knowledge of specific transforms.
   */
  get volumeTransform(): Record<
    string,
    (volume: NVImage, options?: TransformOptions) => Promise<NVImage>
  > {
    const result: Record<
      string,
      (volume: NVImage, options?: TransformOptions) => Promise<NVImage>
    > = {}
    for (const name of NVVolumeTransforms.transformNames()) {
      result[name] = async (
        volume: NVImage,
        options?: TransformOptions,
      ): Promise<NVImage> => {
        if (!volume.hdr || !volume.img) {
          throw new Error("Volume must have hdr and img data")
        }
        const { hdr, img } = await NVVolumeTransforms.applyTransform(
          name,
          volume.hdr,
          volume.img,
          options,
        )
        return NVVolume.nii2volume(
          hdr,
          img,
          volume.name ? `${volume.name}_${name}` : name,
        )
      }
    }
    return result
  }

  /**
   * Get metadata for a specific volume transform (options, description, resultDefaults).
   */
  getVolumeTransformInfo(name: string): TransformInfo | undefined {
    return NVVolumeTransforms.getTransformInfo(name)
  }

  /**
   * Register an external volume transform at runtime.
   * External transforms manage their own Web Worker execution internally.
   */
  registerVolumeTransform(transform: VolumeTransform): void {
    NVVolumeTransforms.registerTransform(transform)
  }

  /**
   * Create an extension context for interacting with this NiiVue instance.
   *
   * The context provides a stable API surface for extensions: live data
   * accessors, event subscriptions (including high-level slice pointer events),
   * safe write-back actions, and coordinate transform utilities.
   *
   * Call `context.dispose()` when the extension is deactivated to remove all
   * event listeners registered through the context.
   *
   * Multiple contexts can coexist — each tracks its own subscriptions.
   */
  createExtensionContext(): NVExtensionContext {
    return new NVExtensionContext(this)
  }

  setDragMode(mode: string | number): void {
    if (typeof mode === "string") {
      const map: Record<string, number> = {
        none: DRAG_MODE.none,
        contrast: DRAG_MODE.contrast,
        measurement: DRAG_MODE.measurement,
        pan: DRAG_MODE.pan,
        slicer3D: DRAG_MODE.slicer3D,
        callbackOnly: DRAG_MODE.callbackOnly,
        roiSelection: DRAG_MODE.roiSelection,
        angle: DRAG_MODE.angle,
        crosshair: DRAG_MODE.crosshair,
        windowing: DRAG_MODE.windowing,
      }
      const val = map[mode]
      if (val !== undefined) this.model.interaction.secondaryDragMode = val
      else log.warn(`Unknown drag mode: ${mode}`)
    } else {
      this.model.interaction.secondaryDragMode = mode
    }
  }

  clearMeasurements(): void {
    this.model.completedMeasurements = []
    this.model.completedAngles = []
    this.drawScene()
  }

  // --- Broadcast / Sync API ---

  /**
   * Sync the scene controls (orientation, crosshair location, etc.) from one NiiVue instance to others.
   * @param targets - the other NiiVue instance(s) to broadcast to, or omit to clear sync
   * @param opts - which properties to sync (default: { '2d': true, '3d': true })
   * @example
   * nv1.broadcastTo(nv2)
   * nv1.broadcastTo([nv2, nv3])
   * nv1.broadcastTo() // clear sync
   */
  broadcastTo(
    targets?: NiiVueGPU | NiiVueGPU[],
    opts: SyncOpts = { "2d": true, "3d": true, clipPlane: true },
  ): void {
    if (!targets) {
      this._syncTargets = []
      this._syncOpts = {}
      this._syncDirty = false
      return
    }
    this._syncTargets = Array.isArray(targets) ? targets : [targets]
    this._syncOpts = opts
    this._syncDirty = false
  }

  private _sync(): void {
    if (!this._syncDirty || this._syncTargets.length === 0) return
    this._syncDirty = false
    const opts = this._syncOpts
    const src = this.model.scene
    for (const target of this._syncTargets) {
      if (target === this) continue
      const dst = target.model.scene
      let changed = false
      if (opts["3d"]) {
        if (
          dst.azimuth !== src.azimuth ||
          dst.elevation !== src.elevation ||
          dst.scaleMultiplier !== src.scaleMultiplier
        ) {
          dst.azimuth = src.azimuth
          dst.elevation = src.elevation
          dst.scaleMultiplier = src.scaleMultiplier
          changed = true
        }
      }
      if (opts["2d"] || opts.crosshair) {
        const mm = this.model.scene2mm(src.crosshairPos)
        const frac = target.model.mm2scene(mm)
        if (
          dst.crosshairPos[0] !== frac[0] ||
          dst.crosshairPos[1] !== frac[1] ||
          dst.crosshairPos[2] !== frac[2]
        ) {
          dst.crosshairPos = frac
          changed = true
        }
        if (opts["2d"]) {
          const sp = src.pan2Dxyzmm
          const dp = dst.pan2Dxyzmm
          if (
            dp[0] !== sp[0] ||
            dp[1] !== sp[1] ||
            dp[2] !== sp[2] ||
            dp[3] !== sp[3]
          ) {
            dst.pan2Dxyzmm = vec4.clone(sp)
            changed = true
          }
        }
      }
      if (opts.clipPlane) {
        const srcClips = this.model.clipPlanes
        const dstClips = target.model.clipPlanes
        for (let i = 0; i < srcClips.length; i++) {
          if (srcClips[i] !== dstClips[i]) {
            for (let j = 0; j < srcClips.length; j++) {
              dstClips[j] = srcClips[j]
            }
            changed = true
            break
          }
        }
      }
      if (
        opts.sliceType &&
        target.model.layout.sliceType !== this.model.layout.sliceType
      ) {
        target.model.layout.sliceType = this.model.layout.sliceType
        changed = true
      }
      if (opts.calMin && this.volumes.length > 0 && target.volumes.length > 0) {
        if (this.volumes[0].calMin !== target.volumes[0].calMin) {
          target.volumes[0].calMin = this.volumes[0].calMin
          target.updateGLVolume()
          changed = true
        }
      }
      if (opts.calMax && this.volumes.length > 0 && target.volumes.length > 0) {
        if (this.volumes[0].calMax !== target.volumes[0].calMax) {
          target.volumes[0].calMax = this.volumes[0].calMax
          target.updateGLVolume()
          changed = true
        }
      }
      if (changed) {
        target.drawScene(false)
        target.createOnLocationChange()
      }
    }
  }

  // --- Drawing API ---

  get drawingColormaps(): string[] {
    return NVCmaps.drawingColormapNames()
  }

  createEmptyDrawing(): void {
    const volumes = this.model.getVolumes()
    if (volumes.length === 0) {
      log.warn("createEmptyDrawing: no background volume loaded")
      return
    }
    if (!volumes[0].dimsRAS) {
      log.warn("createEmptyDrawing: background volume has no dimsRAS")
      return
    }
    this.model.drawingVolume = Drawing.createDrawingVolume(volumes[0])
    const cleared = Drawing.clearAllUndoBitmaps(
      this.drawUndoBitmaps,
      this.maxDrawUndoBitmaps,
    )
    this.drawUndoBitmaps = cleared.drawUndoBitmaps
    this.currentDrawUndoBitmap = cleared.currentDrawUndoBitmap
    this.model.draw.isEnabled = true
    this._drawLut = null
    this.emit("drawingChanged", { action: "create" })
    this.refreshDrawing()
  }

  closeDrawing(): void {
    this.model.drawingVolume = null
    this.model.draw.isEnabled = false
    this.drawUndoBitmaps = []
    this.currentDrawUndoBitmap = -1
    this._drawPenLocation = [NaN, NaN, NaN]
    this._drawPenAxCorSag = -1
    this._drawPenFillPts = []
    this._drawLut = null
    this.view?.clearDrawing()
    this.emit("drawingChanged", { action: "close" })
    this.drawScene()
  }

  drawUndo(): void {
    if (!this.model.drawingVolume) return
    const result = Drawing.drawUndo({
      drawUndoBitmaps: this.drawUndoBitmaps,
      currentDrawUndoBitmap: this.currentDrawUndoBitmap,
      drawBitmap: Drawing.getDrawingBitmap(this.model.drawingVolume),
    })
    if (result) {
      this.model.drawingVolume.img = result.drawBitmap
      this.currentDrawUndoBitmap = result.currentDrawUndoBitmap
      this.emit("drawingChanged", { action: "undo" })
      this.refreshDrawing()
    }
  }

  /**
   * Mark the drawing texture as dirty and schedule a redraw.
   * The expensive bitmap→RGBA conversion and GPU upload are deferred to
   * the next animation frame, so rapid pointermove events only pay the
   * cost once per frame.
   */
  refreshDrawing(): void {
    if (!this.model.drawingVolume || !this.view) return
    this._drawingDirty = true
    this.drawScene()
  }

  /** Perform the actual bitmap→RGBA conversion and GPU texture upload. Called from drawScene RAF. */
  private _flushDrawing(): void {
    if (!this.model.drawingVolume || !this.view) return
    const dims = this.model.drawingVolume.dimsRAS
    if (!dims) return
    // Build or reuse cached label LUT
    if (!this._drawLut) {
      const cm = NVCmaps.lookupColorMap(this.model.draw.colormap)
      if (!cm) {
        log.warn(`Drawing colormap "${this.model.draw.colormap}" not found`)
        return
      }
      this._drawLut = buildDrawingLut(cm)
    }
    const rgba = drawingBitmapToRGBA(
      Drawing.getDrawingBitmap(this.model.drawingVolume),
      this._drawLut.lut,
      this._drawLut.min ?? 0,
      this.model.draw.opacity,
    )
    this.view.refreshDrawing(rgba, [dims[1], dims[2], dims[3]])
  }

  async saveDrawing(filename = "drawing.nii"): Promise<boolean | Uint8Array> {
    return this.saveVolume({ filename, isSaveDrawing: true })
  }

  async loadDrawing(
    source: string | File | ImageFromUrlOptions,
  ): Promise<boolean> {
    const volumes = this.model.getVolumes()
    if (volumes.length === 0) {
      log.warn("loadDrawing: no background volume loaded")
      return false
    }
    const back = volumes[0]
    if (!back.dimsRAS || !back.permRAS) {
      log.warn("loadDrawing: background volume has no dimsRAS/permRAS")
      return false
    }
    try {
      const url =
        typeof source === "string" || source instanceof File
          ? source
          : source.url
      const nii = await NVVolume.loadVolume(url)
      // Validate datatype is uint8
      if (nii.hdr.datatypeCode !== 2) {
        log.warn(
          `loadDrawing: expected DT_UINT8 (2), got ${nii.hdr.datatypeCode}`,
        )
        return false
      }
      // Transform from native voxel order to RAS to match background volume
      const transform = Drawing.calculateLoadDrawingTransform({
        permRAS: back.permRAS,
        dims: back.dimsRAS,
      })
      const img = nii.img
      if (img instanceof ArrayBuffer) {
        throw new Error("loadDrawing: expected typed array, got ArrayBuffer")
      }
      const buf = img.buffer as ArrayBuffer
      const offset = img.byteOffset
      const length = img.byteLength
      const imgData = new Uint8Array(buf, offset, length)
      const transformedBitmap = Drawing.transformBitmap({
        inputData: imgData,
        dims: back.dimsRAS,
        xlut: transform.xlut,
        ylut: transform.ylut,
        zlut: transform.zlut,
      })
      const dv = Drawing.createDrawingVolume(back)
      dv.img = transformedBitmap
      this.model.drawingVolume = dv
      // Initialize undo
      const cleared = Drawing.clearAllUndoBitmaps(
        this.drawUndoBitmaps,
        this.maxDrawUndoBitmaps,
      )
      this.drawUndoBitmaps = cleared.drawUndoBitmaps
      this.currentDrawUndoBitmap = cleared.currentDrawUndoBitmap
      this.model.draw.isEnabled = true
      this._drawLut = null
      this.refreshDrawing()
      return true
    } catch (err) {
      log.warn("loadDrawing failed:", err)
      return false
    }
  }

  resize(): void {
    if (!this.view) return
    this.view.resize()
  }

  destroy(): void {
    this.emit("viewDestroyed")
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId)
      this._rafId = null
      this.framePending = false
    }
    removeInteractionListeners(this)
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    if (this.view) this.view.destroy()
    this._viewLifecycle.unregister?.(this)
  }

  async _recreateView(): Promise<void> {
    await this._viewLifecycle.recreateView(this)
  }

  async reinitializeView(options: ReinitializeOptions = {}): Promise<boolean> {
    return this._viewLifecycle.reinitializeView(this, options)
  }

  /**
   * Swap the active font atlas. The font is infrastructure-level configuration
   * (GPU-owned atlas texture + metrics map), so switching requires a full view
   * rebuild — use this method instead of mutating `opts.font` directly.
   */
  async setFont(font: NVFontData): Promise<boolean> {
    this.opts.font = font
    this.emit("change", { property: "font", value: font })
    return this.reinitializeView({})
  }

  /**
   * Fetch an MSDF font atlas (PNG + JSON metrics pair) from URLs and swap
   * it in as the active font. Useful for loading fonts that are not bundled
   * with the library (e.g. the community atlases at
   * https://github.com/niivue/fonts). The PNG URL is stored verbatim and
   * used as the GPU atlas texture source.
   *
   * On failure (metrics fetch, view rebuild, or atlas texture upload)
   * the previous font is restored so the view isn't left half-initialized.
   * The original error is re-thrown after recovery.
   *
   * @example
   * await nv1.setFontFromUrl({ atlas: '…/ubuntu.png', metrics: '…/ubuntu.json' })
   */
  async setFontFromUrl(urls: {
    atlas: string
    metrics: string
  }): Promise<boolean> {
    const previous = this.opts.font
    try {
      const metrics = await getFontMetrics(urls.metrics)
      return await this.setFont({ metrics, atlasUrl: urls.atlas })
    } catch (err) {
      log.warn(
        `setFontFromUrl failed for atlas=${urls.atlas}; restoring previous font`,
        err,
      )
      if (previous) {
        // Best-effort recovery. If the restore also fails, surface the
        // original error — the secondary failure is a symptom, not the cause.
        try {
          await this.setFont(previous)
        } catch {
          /* ignore */
        }
      }
      throw err
    }
  }

  /**
   * Register a colormap by name so it becomes available to
   * `setVolume({ colormap: name })`, `nv1.colormaps`, colorbars, mesh
   * layers, and so on. Use this to add user-defined LUTs at runtime.
   * Re-registering an existing name replaces the entry. Does not trigger a
   * redraw — the colormap is inert until a volume references it.
   *
   * Label colormaps (for atlas volumes with per-index labels) have their
   * own registration path: `setColormapLabel()` / `setColormapLabelFromUrl()`.
   *
   * @returns The canonical name under which the colormap was stored
   *   (first letter upper-cased), which is the form visible in `nv1.colormaps`
   *   and the `colormapAdded` event detail.
   * @throws If `R`/`G`/`B` are empty, a single stop, or caller-supplied
   *   `A`/`I` arrays disagree in length.
   *
   * @example
   * const canonical = nv1.addColormap('myCmap', { R: [0, 255], G: [0, 128], B: [0, 0] })
   * await nv1.setVolume(0, { colormap: canonical })
   */
  addColormap(
    name: string,
    cmap: Pick<ColorMap, "R" | "G" | "B"> & Partial<Pick<ColorMap, "A" | "I">>,
  ): string {
    const canonical = NVCmaps.addColormap(name, cmap)
    this.emit("colormapAdded", { name: canonical })
    return canonical
  }

  /**
   * Fetch a colormap JSON (`{ R, G, B, A?, I? }`) from a URL or `File` and
   * register it under `name`. When `name` is omitted, it is derived from
   * the source filename; callers passing an un-nameable source (e.g.
   * `?query-only`) should supply `name` explicitly — an empty derived
   * name throws.
   */
  async addColormapFromUrl(url: string | File, name?: string): Promise<void> {
    const { cmap, defaultName } = await this._fetchColormapJson(url)
    const resolved = name ?? defaultName
    if (!resolved) {
      throw new Error(
        `addColormapFromUrl: cannot derive a name from "${typeof url === "string" ? url : url.name}" — pass an explicit name.`,
      )
    }
    this.addColormap(resolved, cmap)
  }

  /**
   * Shared fetch + parse helper for colormap JSON payloads. Returns the
   * parsed `ColorMap` plus a default name derived from the source filename
   * (extension stripped, including compound `.json.gz` / `.gz`).
   */
  private async _fetchColormapJson(
    url: string | File,
  ): Promise<{ cmap: ColorMap; defaultName: string }> {
    let json: string
    let sourceName: string
    if (typeof url === "string") {
      const resp = await fetch(url)
      if (!resp.ok)
        throw new Error(
          `Failed to fetch ${url}: ${resp.status} ${resp.statusText}`,
        )
      json = await resp.text()
      const clean = url.split("?")[0].split("#")[0]
      sourceName = clean.split("/").pop() ?? ""
    } else {
      json = await url.text()
      sourceName = url.name
    }
    const cmap = JSON.parse(json) as ColorMap
    const defaultName = sourceName.replace(/\.(json\.gz|gz|json)$/i, "")
    return { cmap, defaultName }
  }

  /** Return the current scene serialized as an NVD document (CBOR-encoded Uint8Array). */
  serializeDocument(): Uint8Array {
    return NVDocument.serialize(this.model)
  }

  saveDocument(filename = "scene.nvd"): void {
    const data = this.serializeDocument()
    NVDocument.triggerDownload(data, filename)
  }

  async loadDocument(source: string | File): Promise<void> {
    // Fetch the document file
    const buffer = await NVLoader.fetchFile(source)
    const data = new Uint8Array(buffer)

    // Parse the document
    const doc = NVDocument.deserialize(data)

    // Clear existing data (releases GPU resources)
    this.closeDrawing()
    await this.removeAllVolumes()
    await this.removeAllMeshes()

    // Apply non-data state (scene, config, display settings)
    NVDocument.applyDocumentToModel(this.model, doc)

    // Restore thumbnail if present in document
    if (this.model.ui.thumbnailUrl) {
      this.opts.thumbnail = this.model.ui.thumbnailUrl
      this.model.ui.isThumbnailVisible = true
      if (this.view) await this.view.loadThumbnail(this.model.ui.thumbnailUrl)
    }

    // Reconstruct volumes and meshes from document entries (parallel)
    const volumePromises = doc.volumes.map((v) =>
      NVDocument.reconstructVolume(this.model, v),
    )
    const meshPromises = doc.meshes.map((m) =>
      NVDocument.reconstructMesh(this.model, m),
    )
    await Promise.all([...volumePromises, ...meshPromises])

    // Update GPU resources and render
    await this.updateGLVolume()

    // Restore drawing from RLE-encoded bitmap in document
    if (doc.drawingBitmapRLE && doc.drawingBitmapLength) {
      const back = this.model.getVolumes()[0]
      if (back) {
        const dv = Drawing.createDrawingVolume(back)
        const decoded = Drawing.decodeRLE(
          doc.drawingBitmapRLE,
          doc.drawingBitmapLength,
        )
        if (decoded.length !== dv.nVox3D) {
          log.warn(
            `loadDocument: decoded drawing length ${decoded.length} does not match volume ${dv.nVox3D}`,
          )
        } else {
          dv.img = decoded
        }
        this.model.drawingVolume = dv
        this.model.draw.isEnabled = true
        this._drawLut = null
        this.refreshDrawing()
      }
    }
    this.emit("documentLoaded")
  }
}
