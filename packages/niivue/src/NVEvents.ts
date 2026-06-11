import type {
  AffineMatrix,
  BackendType,
  CompletedAngle,
  CompletedMeasurement,
  DragReleaseInfo,
  MeshUpdate,
  NiiVueLocation,
  NVImage,
  NVMesh,
  NVSignal,
  VectorAnnotation,
  VolumeUpdate,
} from '@/NVTypes'
import type { FrameReport } from '@/view/NVPerfMarks'

// ============================================================
// Event detail types
// ============================================================

export type FrameChangeDetail = { volume: NVImage; frame: number }
export type VolumeLoadedDetail = { volume: NVImage }
export type MeshLoadedDetail = { mesh: NVMesh }
export type VolumeRemovedDetail = { volume: NVImage; index: number }
export type MeshRemovedDetail = { mesh: NVMesh; index: number }
export type SignalLoadedDetail = { signal: NVSignal }
export type SignalRemovedDetail = { signal: NVSignal; index: number }
export type SignalLocationDetail = {
  /** selected x-axis value (ppm, Hz, time, or sample index) */
  xValue: number
  xLabel: string
  values: { label: string; value: number; color: number[] }[]
  /** preformatted status-bar string */
  string: string
}
/**
 * The signal graph's visible x-range changed (zoom, pan, reset, wheel-follow, or
 * the explicit-range auto-reset). Lets a host UI (e.g. ppm-range sliders) stay in
 * sync with the in-graph pan/zoom controls.
 */
export type GraphRangeChangeDetail = {
  /** visible window [min, max] in axis data units (ppm, Hz, time, sample index) */
  min: number
  max: number
  /** the full extent the window sits within ([min, max] when not zoomed) */
  full: [number, number]
  /** axis label (e.g. 'Chemical shift (ppm)', 'Time (s)') */
  axisLabel: string
  /** true when zoomed/panned (a strict sub-range of `full`), false at full view */
  isWindowed: boolean
}
export type AzimuthElevationChangeDetail = {
  azimuth: number
  elevation: number
}
export type ClipPlaneChangeDetail = { clipPlane: number[] }
export type SliceTypeChangeDetail = { sliceType: number }
export type PenValueChangedDetail = { penValue: number }
export type DrawingChangedDetail = {
  action: 'stroke' | 'create' | 'close' | 'undo'
}
export type DrawingEnabledDetail = { isEnabled: boolean }
export type PropertyChangeDetail = { property: string; value: unknown }
export type PointerUpDetail = { x: number; y: number; button: number }
export type VolumeUpdatedChanges = VolumeUpdate & {
  affine?: AffineMatrix
}
export type VolumeUpdatedDetail = {
  volumeIndex: number
  volume: NVImage
  changes: VolumeUpdatedChanges
}
export type MeshUpdatedDetail = {
  meshIndex: number
  mesh: NVMesh
  changes: MeshUpdate
}
export type ViewAttachedDetail = {
  canvas: HTMLCanvasElement
  backend: BackendType
}
export type CanvasResizeDetail = { width: number; height: number }
export type AnnotationAddedDetail = { annotation: VectorAnnotation }
export type AnnotationRemovedDetail = { id: string }
export type AnnotationChangedDetail = {
  action: 'draw' | 'erase' | 'move' | 'resize' | 'undo' | 'redo' | 'clear'
}
export type ColormapAddedDetail = { name: string }
export type VolumeOrderChangedDetail = { volumes: NVImage[] }

/**
 * Per-frame render performance report. Emitted after every render
 * while `nv.perf.enabled` is true. `tag` is the action source set via
 * `nv.perf.tagFrame(...)` (or by an interaction handler) before the
 * frame, or `null` for frames triggered by programmatic property
 * mutation.
 */
export type PerfFrameDetail = FrameReport

// ============================================================
// Event map: event name → detail type
// ============================================================

export interface NVEventMap {
  // User interaction
  locationChange: NiiVueLocation
  frameChange: FrameChangeDetail
  dragRelease: DragReleaseInfo
  pointerUp: PointerUpDetail
  measurementCompleted: CompletedMeasurement
  angleCompleted: CompletedAngle

  // Loading
  volumeLoaded: VolumeLoadedDetail
  meshLoaded: MeshLoadedDetail
  volumeRemoved: VolumeRemovedDetail
  meshRemoved: MeshRemovedDetail
  signalLoaded: SignalLoadedDetail
  signalRemoved: SignalRemovedDetail
  signalLocationChange: SignalLocationDetail
  graphRangeChange: GraphRangeChangeDetail
  documentLoaded: undefined

  // View lifecycle
  viewAttached: ViewAttachedDetail
  viewDestroyed: undefined
  canvasResize: CanvasResizeDetail

  // View control
  azimuthElevationChange: AzimuthElevationChangeDetail
  clipPlaneChange: ClipPlaneChangeDetail
  sliceTypeChange: SliceTypeChangeDetail

  // Data updates
  volumeUpdated: VolumeUpdatedDetail
  meshUpdated: MeshUpdatedDetail

  // Drawing
  penValueChanged: PenValueChangedDetail
  drawingChanged: DrawingChangedDetail
  drawingEnabled: DrawingEnabledDetail

  // Annotations
  annotationAdded: AnnotationAddedDetail
  annotationRemoved: AnnotationRemovedDetail
  annotationChanged: AnnotationChangedDetail

  // Volume ordering
  volumeOrderChanged: VolumeOrderChangedDetail

  // Asset registration
  colormapAdded: ColormapAddedDetail

  // Render performance (only fires while nv.perf.enabled)
  perfFrame: PerfFrameDetail

  // Generic property change
  change: PropertyChangeDetail
}

// ============================================================
// Typed addEventListener/removeEventListener
// ============================================================

export type NVEventListener<K extends keyof NVEventMap> =
  NVEventMap[K] extends undefined
    ? (evt: Event) => void
    : (evt: CustomEvent<NVEventMap[K]>) => void

export interface NVEventTarget extends EventTarget {
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
}
