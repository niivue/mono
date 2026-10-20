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

/** A volume as `View.loadVolumes` and `View.addVolume` take it: NiiVue's `ImageFromUrlOptions`, in part. */
export interface VolumeToLoad {
  url: string
  name?: string
  colormap?: string
  opacity?: number
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

/** The render camera when it is placed rather than turned: NiiVue's `NVGlobalCamera`. */
export interface GlobalCamera {
  position: [number, number, number]
  yaw?: number
  pitch?: number
  fov?: number
  near?: number
  far?: number
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

  vox2frac?(vox: [number, number, number]): [number, number, number]

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
