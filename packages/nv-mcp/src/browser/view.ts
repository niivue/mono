/**
 * The part of a NiiVue instance the tools drive.
 *
 * Nothing here imports NiiVue: `View` names the members the handlers
 * touch, by NiiVue's own names and signatures, so the app passes its
 * instance and a test passes a fake. What the first tools needed is
 * required; everything after is optional, and a handler whose member is
 * missing refuses in words rather than failing, so a page whose NiiVue
 * lacks a feature still answers every other tool. NiiVue 1.0 has all
 * of them.
 */

import type { RegionSummary } from '../protocol'

/** Three numbers by index: a plain array, a typed array, or gl-matrix's vec3. */
export type Triple = { [index: number]: number; readonly length: number }

/**
 * A label table as NiiVue reads one: a colour per label, each for the
 * value in `I` at the same place, and the labels' names. `fetchLabelTable`
 * fills `I` and `A` in as NiiVue would when a table leaves them out.
 */
export interface LabelTable {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  labels?: string[]
}

/** A volume as `View.loadVolumes` and `View.addVolume` take it: NiiVue's `ImageFromUrlOptions`, in part. */
export interface VolumeToLoad {
  url: string
  name?: string
  colormap?: string
  opacity?: number
}

/** What `View.setVolume` can change about a volume: NiiVue's `VolumeUpdate`. */
export interface VolumeUpdate {
  colormap?: string
  colormapNegative?: string
  opacity?: number
  calMin?: number
  calMax?: number
  calMinNeg?: number
  calMaxNeg?: number
  colormapType?: number
  isTransparentBelowCalMin?: boolean
  frame4D?: number
  isColormapInverted?: boolean
  isColorbarVisible?: boolean
  isNearestInterpolation?: boolean
  atlasOutline?: number
  modulateAlpha?: number
}

/** A volume as NiiVue keeps it once loaded, in the part the tools read. */
export interface ShownVolume {
  name: string
  /** NiiVue's id for it, which `setModulationImage` and the 4D loaders take. */
  id?: string
  /** Where it was fetched from; absent for a file the person dropped in. */
  url?: string
  colormap?: string
  colormapNegative?: string
  opacity?: number
  /** The display window: the intensities drawn as the darkest and brightest colours. */
  calMin?: number
  calMax?: number
  calMinNeg?: number
  calMaxNeg?: number
  /** The intensities the volume actually spans. */
  globalMin?: number
  globalMax?: number
  /** For a 4D volume, the frame shown and how many there are, and how many the file holds. */
  frame4D?: number
  nFrame4D?: number
  nTotalFrame4D?: number
  isColormapInverted?: boolean
  colormapType?: number
  isTransparentBelowCalMin?: boolean
  isColorbarVisible?: boolean
  isNearestInterpolation?: boolean
  atlasOutline?: number
  modulateAlpha?: number
  /** The label table it is drawn with, when it is a label map. */
  colormapLabel?: unknown
  /** The voxel grid, NIfTI style: [ndim, nx, ny, nz, nt, ...]. */
  dims?: ArrayLike<number>
}

/** A mesh's overlay layer as NiiVue keeps it: `NVMeshLayer`, in the part the tools read. */
export interface ShownMeshLayer {
  name?: string
  url?: string
  colormap?: string
  colormapNegative?: string
  opacity?: number
  calMin?: number
  calMax?: number
  calMinNeg?: number
  calMaxNeg?: number
  globalMin?: number
  globalMax?: number
  isColormapInverted?: boolean
  frame4D?: number
  nFrame4D?: number
  isColorbarVisible?: boolean
}

/** A mesh as NiiVue keeps it once loaded: `NVMesh`, in the part the tools read. */
export interface ShownMesh {
  name?: string
  url?: string
  kind?: 'mesh' | 'tract' | 'connectome'
  opacity?: number
  color?: ArrayLike<number>
  shaderType?: string
  sliceShaderType?: string
  visible?: boolean
  isColorbarVisible?: boolean
  isLegendVisible?: boolean
  layers?: ReadonlyArray<ShownMeshLayer>
  tractOptions?: Record<string, unknown> | null
  connectomeOptions?: Record<string, unknown> | null
}

/** A mesh as `View.addMesh` takes it: NiiVue's `MeshFromUrlOptions`, in part. */
export interface MeshToLoad {
  url: string
  name?: string
  opacity?: number
  color?: [number, number, number, number]
  shaderType?: string
  sliceShaderType?: string
  visible?: boolean
  isColorbarVisible?: boolean
  isLegendVisible?: boolean
  layers?: MeshLayerToLoad[]
}

/** What `View.setMesh` can change: NiiVue's `MeshUpdate`, in part. */
export type MeshUpdate = Omit<MeshToLoad, 'url' | 'layers'>

/** A layer as `View.addMeshLayer` takes it: NiiVue's `MeshLayerFromUrlOptions`, in part. */
export interface MeshLayerToLoad {
  url: string
  name?: string
  colormap?: string
  colormapNegative?: string
  calMin?: number
  calMax?: number
  calMinNeg?: number
  calMaxNeg?: number
  opacity?: number
  isColorbarVisible?: boolean
  isColormapInverted?: boolean
  colormapType?: number
  isTransparentBelowCalMin?: boolean
  isAdditiveBlend?: boolean
  outlineWidth?: number
}

/** What `View.setMeshLayerProperty` can change: NiiVue's `NVMeshLayer`, in part. */
export type MeshLayerUpdate = Omit<MeshLayerToLoad, 'url' | 'name'>

/** A completed distance measurement: NiiVue's `CompletedMeasurement`. */
export interface Measurement {
  startMM: [number, number, number]
  endMM: [number, number, number]
  distance: number
  sliceIndex: number
  sliceType: number
  slicePosition: number
}

/** What `View.addMeasurement` takes beside the two ends. */
export interface MeasurementOptions {
  sliceIndex?: number
  sliceType?: number
  slicePosition?: number
}

/** A vector annotation as NiiVue keeps it: `VectorAnnotation`. Passed through as JSON. */
export interface Annotation {
  id: string
  label: number
  group: string
  sliceType: number
  slicePosition: number
  anchorMM?: [number, number, number]
  polygons: unknown[]
  style: Record<string, unknown>
  stats?: Record<string, unknown>
  text?: string
  shape?: Record<string, unknown>
}

/** A tile of a custom layout: NiiVue's `CustomLayoutTile`. */
export interface LayoutTile {
  sliceType: number
  position: [number, number, number, number]
  sliceMM?: number
  fill?: boolean
}

/** Statistics over a volume's voxels: NiiVue's `DescriptiveStats`. */
export interface Descriptives {
  nVox: number
  mean: number
  stdev: number
  min: number
  max: number
  nVoxNot0: number
  meanNot0: number
  stdevNot0: number
  minNot0: number
  maxNot0: number
  volumeMM3: number
  volumeML: number
}

/** A named volume transform, as NiiVue describes it: `TransformInfo`. */
export interface TransformInfo {
  name: string
  description: string
  options: Array<{
    name: string
    label: string
    type: 'checkbox' | 'select'
    default: unknown
    options?: unknown[]
  }>
}

/** A translation, rotation and scale to apply to a volume: NiiVue's `AffineTransform`. */
export interface AffineTransform {
  translation: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

/** The render camera when it is placed rather than turned: NiiVue's `NVGlobalCamera`. */
export interface GlobalCamera {
  position: [number, number, number]
  yaw?: number
  pitch?: number
  fov?: number
  near?: number
  far?: number
}

/** A volume a named transform made: NiiVue's `NVImage`, which `addVolume` takes as it is. */
/** A transform of a loaded volume into a new one, as `View.volumeTransform` keeps them. */
export type VolumeTransform = {
  transform(
    volume: ShownVolume,
    options?: Record<string, unknown>,
  ): Promise<TransformedVolume>
}['transform']

export interface TransformedVolume {
  name?: string
  hdr?: unknown
  img?: unknown
}

/** A colormap as `View.addColormap` takes it. */
export interface ColormapToAdd {
  R: number[]
  G: number[]
  B: number[]
  A?: number[]
  I?: number[]
  labels?: string[]
}

export interface View {
  canvas: HTMLCanvasElement | null
  /** The volumes on show, the base first. NiiVue keeps how each was loaded on it. */
  volumes: ReadonlyArray<ShownVolume>
  azimuth: number
  elevation: number
  /**
   * The crosshair as fractions of the volume. Read live; moved by assigning
   * three numbers, which NiiVue's setter turns into its events (`change`,
   * `locationChange`) and its pan-follows-crosshair, as a click would.
   */
  crosshairPos: Triple
  /** The crosshair in world millimetres. */
  getCrosshairPos(): Triple
  getClipPlaneDepthAziElev(index: number): [number, number, number]
  setClipPlane(plane: number[]): void
  /** Replaces every volume on show with these. */
  loadVolumes(volumes: VolumeToLoad[]): Promise<unknown>
  /** Adds one volume over those on show, keeping them: one to fetch, or one a transform made. */
  addVolume(volume: VolumeToLoad | TransformedVolume): Promise<unknown>
  /** Draws a volume as labels from a lookup table, by name (`freesurfer`) or as a table. */
  setColormapLabel?(
    volumeIndex: number,
    cmap: string | LabelTable,
  ): Promise<unknown> | unknown
  /** Changes how a loaded volume is drawn, keeping the rest as it is. */
  setVolume?(
    volumeIndex: number,
    update: VolumeUpdate,
  ): Promise<unknown> | unknown
  /**
   * The view layout, by NiiVue's numbers (`views.ts` names them). Each is
   * read live and set by assignment, which NiiVue 1.0 turns into its
   * `change` event and a redraw. A page whose NiiVue has none of them
   * cannot answer `set_view`.
   */
  sliceType?: number
  multiplanarType?: number
  mosaicString?: string
  showRender?: number
  isRadiological?: boolean
  isColorbarVisible?: boolean
  /** Schedules a frame. NiiVue 1.0 draws it on the next animation frame, not now. */
  drawScene(): unknown
  /** Fits the canvas's drawing buffer to its box; NiiVue 1.0 has it. */
  resize?(): void
  /** NiiVue 1.0's render backend, whose `render()` draws a frame now. */
  view?: { render(): void } | null
  model: {
    mm2scene(mm: number[]): Triple
    scene2mm(frac: number[]): Triple
  }

  // Volumes beyond the first tools.
  removeVolume?(index: number): Promise<unknown>
  removeAllVolumes?(): Promise<unknown>
  moveVolumeUp?(index: number): Promise<unknown>
  moveVolumeDown?(index: number): Promise<unknown>
  moveVolumeToTop?(index: number): Promise<unknown>
  moveVolumeToBottom?(index: number): Promise<unknown>
  getDescriptives?(options: {
    volumeIndex?: number
    masks?: number[]
    isDrawingMask?: boolean
    drawPenValues?: number[]
  }): Descriptives | null
  recalculateCalMinMax?(volumeIndex: number, frame?: number): Promise<unknown>
  loadDeferred4DVolumes?(id: string): Promise<unknown>
  setModulationImage?(
    targetId: string,
    modulatorId: string,
    modulateAlpha?: number,
  ): Promise<unknown>
  setAtlasOutline?(outline: number, volumeIndex?: number): unknown
  getVolumeAffine?(index: number): number[][]
  setVolumeAffine?(index: number, affine: number[][]): Promise<unknown>
  resetVolumeAffine?(index: number): Promise<unknown>
  applyVolumeTransform?(
    index: number,
    transform: AffineTransform,
  ): Promise<unknown>
  volumeTransforms?: readonly string[]
  getVolumeTransformInfo?(name: string): TransformInfo | undefined
  /**
   * Each named transform as a function of a loaded volume, giving a new
   * one. A method signature, so a NiiVue whose transforms take its own
   * volume class fits: the handler only ever passes a volume of this view.
   */
  volumeTransform?: Record<string, VolumeTransform>
  vox2frac?(vox: [number, number, number]): [number, number, number]
  moveCrosshairInVox?(di: number, dj: number, dk: number): unknown

  // Meshes.
  meshes?: ReadonlyArray<ShownMesh>
  meshShaders?: readonly string[]
  addMesh?(mesh: MeshToLoad): Promise<unknown>
  removeMesh?(index: number): Promise<unknown>
  removeAllMeshes?(): Promise<unknown>
  setMesh?(index: number, update: MeshUpdate): Promise<unknown>
  addMeshLayer?(index: number, layer: MeshLayerToLoad): Promise<unknown>
  removeMeshLayer?(index: number, layer: number): Promise<unknown>
  setMeshLayerProperty?(
    index: number,
    layer: number,
    update: MeshLayerUpdate,
  ): Promise<unknown>
  setMeshLayerFrame4D?(
    index: number,
    layer: number,
    frame: number,
  ): Promise<unknown> | unknown
  setTractOptions?(
    index: number,
    options: Record<string, unknown>,
  ): Promise<unknown>
  setConnectomeOptions?(
    index: number,
    options: Record<string, unknown>,
  ): Promise<unknown>
  getTractGroups?(index: number): string[]

  // The clip planes and the camera beyond the first plane.
  setClipPlanes?(planes: number[][]): unknown
  setClipPlaneDepthAziElev?(
    depth: number,
    azimuth: number,
    elevation: number,
    index?: number,
  ): unknown
  setGlobalCamera?(camera: GlobalCamera): unknown
  centerRenderOnMM?(mm: [number, number, number]): boolean
  pan2Dxyzmm?: ArrayLike<number>
  renderPan?: ArrayLike<number>
  renderPivotMM?: ArrayLike<number> | null
  customLayout?: LayoutTile[] | null
  clearCustomLayout?(): unknown

  // Colormaps and fonts.
  colormaps?: readonly string[]
  drawingColormaps?: readonly string[]
  hasColormap?(name: string): boolean
  addColormap?(name: string, colormap: ColormapToAdd): string
  addColormapFromUrl?(url: string, name?: string): Promise<unknown>
  setFontFromUrl?(urls: { atlas: string; metrics: string }): Promise<boolean>

  // The drawing.
  createEmptyDrawing?(): unknown
  drawUndo?(): unknown
  closeDrawing?(): unknown
  loadDrawing?(url: string): Promise<boolean>
  saveDrawing?(filename?: string): Promise<unknown>
  drawingToSVG?(sliceType?: number, sliceIndex?: number): string | null

  // Vector annotations.
  annotations?: ReadonlyArray<Annotation>
  selectedAnnotation?: string | null
  addAnnotation?(annotation: Annotation): unknown
  removeAnnotation?(id: string): unknown
  clearAnnotations?(): unknown
  selectAnnotation?(id: string | null): unknown
  setAnnotationText?(id: string, text: string): unknown
  annotationUndo?(): unknown
  annotationRedo?(): unknown
  getAnnotationsJSON?(): string
  loadAnnotationsJSON?(json: string): unknown
  annotationsToSVG?(sliceType?: number, slicePosition?: number): string | null

  // Measurements.
  getMeasurements?(): readonly Measurement[]
  addMeasurement?(
    start: [number, number, number],
    end: [number, number, number],
    options?: MeasurementOptions,
  ): number
  removeMeasurement?(index: number): unknown
  clearMeasurements?(): unknown
  clearAngles?(): unknown
  clearDistanceMeasurements?(): unknown

  // What the page's NiiVue is.
  backend?: string
  volumeExtensions?: readonly string[]
  meshExtensions?: readonly string[]
  volumeWriteExtensions?: readonly string[]
  meshWriteExtensions?: readonly string[]
}

/** A region as an atlas keeps it: what `list_regions` reports plus its voxel value. */
export interface AtlasRegion extends RegionSummary {
  value: number
}

/** What the core needs of an atlas: four questions over millimetre coordinates. */
export interface AtlasLike {
  regions(): readonly AtlasRegion[]
  regionAt(mm: readonly number[]): string | null
  valueAt(mm: readonly number[]): number
  nearestIn(
    value: number,
    mm: readonly number[],
  ): [number, number, number] | null
}

export interface LoadedVolume {
  url: string
  name: string
  /** Whether the volume is taken to be in MNI space. */
  mni: boolean
}

/** A NiiVue instance and the hooks an app fills in. Every hook is optional. */
export interface NiiVueHost {
  view: View
  /** The atlas, fetched if it has not been. Throws in words when it cannot be. */
  atlas?(): Promise<AtlasLike>
  /** Whether the atlas applies to the loaded volume. Taken as yes when absent. */
  atlasApplies?(): boolean
  /** Called before any answer is read off the scene: a page that sizes its canvas lazily does so here. */
  beforeAnswer?(): void
  /** Called with the new position after the core moves the crosshair. */
  moved?(frac: readonly number[]): void
  /** The place in words, as the app would say it to a person. May look something up first. */
  describe?(): string | Promise<string>
  /** Tells the person something changed that they did not do. */
  announce?(text: string): void
  /** Called after `load_volume` has loaded one. */
  loaded?(volume: LoadedVolume): void
  /** State of the app's own the server should watch between calls. */
  extraState?(): Record<string, unknown>
  /** The name of the plane cut now, when the app has its own names. */
  planeName?(): string
}

export type Handler = (params: Record<string, unknown>) => unknown
export type Handlers = Record<string, Handler>
