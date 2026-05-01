import type {
  BackendType,
  CompletedAngle,
  CompletedMeasurement,
  DragReleaseInfo,
  MeshUpdate,
  NiiVueLocation,
  NVImage,
  NVMesh,
  VectorAnnotation,
  VolumeUpdate,
} from '@/NVTypes'

// ============================================================
// Event detail types
// ============================================================

export type FrameChangeDetail = { volume: NVImage; frame: number }
export type VolumeLoadedDetail = { volume: NVImage }
export type MeshLoadedDetail = { mesh: NVMesh }
export type VolumeRemovedDetail = { volume: NVImage; index: number }
export type MeshRemovedDetail = { mesh: NVMesh; index: number }
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
export type VolumeUpdatedDetail = {
  volumeIndex: number
  volume: NVImage
  changes: VolumeUpdate | { affine: number[][] }
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
