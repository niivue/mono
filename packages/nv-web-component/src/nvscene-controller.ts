import type { NiiVueOptions, NVImage } from '@niivue/niivue'
import NiiVueGPU, { DRAG_MODE, SHOW_RENDER, SLICE_TYPE } from '@niivue/niivue'
import type { LayoutConfig } from './layouts'
import { defaultLayouts } from './layouts'
import type { ImageFromUrlOptions, NvSceneEventMap, ViewerState } from './types'

export { SLICE_TYPE }

export type NiivueCallback = (nv: NiiVueGPU, index: number) => void

export interface ViewerSlot {
  id: string
  niivue: NiiVueGPU
  canvasElement: HTMLCanvasElement
  containerDiv: HTMLDivElement
}

export interface NvSceneControllerSnapshot {
  currentLayout: string
  viewerCount: number
  slots: number
  isBroadcasting: boolean
  isLoading: boolean
  viewerStates: ViewerState[]
}

export interface BroadcastOptions {
  '2d': boolean
  '3d': boolean
}

export interface SliceLayoutTile {
  sliceType: number
  position: [number, number, number, number] // [left, top, width, height] normalized 0–1
  sliceMM?: number // optional fixed mm position for the slice
}

export interface SliceLayoutConfig {
  label: string
  layout: SliceLayoutTile[]
}

/**
 * Default slice layout: Axial as hero (80% height), coronal and sagittal below (20% height each, side by side)
 */
export const defaultSliceLayout: SliceLayoutTile[] = [
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 1.0, 0.8] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0, 0.8, 0.5, 0.2] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.5, 0.8, 0.5, 0.2] },
]

/**
 * Split view: sagittal left, coronal/axial stacked on the right.
 */
export const splitSliceLayout: SliceLayoutTile[] = [
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0, 0, 0.5, 1.0] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0.5, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.AXIAL, position: [0.5, 0.5, 0.5, 0.5] },
]

/**
 * Tri-fan: three equal horizontal panels.
 */
export const triSliceLayout: SliceLayoutTile[] = [
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 0.333, 1.0] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0.333, 0, 0.333, 1.0] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.666, 0, 0.334, 1.0] },
]

/**
 * Stacked: three equal vertical stacks.
 */
export const stackedSliceLayout: SliceLayoutTile[] = [
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 1.0, 0.333] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0, 0.333, 1.0, 0.333] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0, 0.666, 1.0, 0.334] },
]

/**
 * Quad: axial/coronal/sagittal with a render tile.
 */
export const quadSliceLayout: SliceLayoutTile[] = [
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0.5, 0, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0, 0.5, 0.5, 0.5] },
  { sliceType: SLICE_TYPE.RENDER, position: [0.5, 0.5, 0.5, 0.5] },
]

/**
 * Hero render with three small orthogonal slices below.
 */
export const heroRenderSliceLayout: SliceLayoutTile[] = [
  { sliceType: SLICE_TYPE.RENDER, position: [0, 0, 1.0, 0.7] },
  { sliceType: SLICE_TYPE.AXIAL, position: [0, 0.7, 0.333, 0.3] },
  { sliceType: SLICE_TYPE.CORONAL, position: [0.333, 0.7, 0.333, 0.3] },
  { sliceType: SLICE_TYPE.SAGITTAL, position: [0.666, 0.7, 0.334, 0.3] },
]

export const defaultSliceLayouts: Record<string, SliceLayoutConfig> = {
  'axial-hero': {
    label: 'Axial Hero',
    layout: defaultSliceLayout,
  },
  'sag-left': {
    label: 'Sag Left Split',
    layout: splitSliceLayout,
  },
  'tri-h': {
    label: 'Tri Horizontal',
    layout: triSliceLayout,
  },
  'tri-v': {
    label: 'Tri Stacked',
    layout: stackedSliceLayout,
  },
  'quad-render': {
    label: 'Quad Render',
    layout: quadSliceLayout,
  },
  'render-hero': {
    label: 'Render Hero',
    layout: heroRenderSliceLayout,
  },
}

type Listener = () => void

export const defaultViewerOptions: Partial<NiiVueOptions> = {
  crosshairGap: 5,
  primaryDragMode: DRAG_MODE.crosshair,
  secondaryDragMode: DRAG_MODE.pan,
}

/**
 * An NvSceneController is a declarative representation of what we want to render with Niivue.
 *
 * A scene can contain multiple Niivue instances. Each Niivue instance has its own
 * canvas element for the WebGL2 context. All canvas elements are wrapped in container
 * divs that are children of the main scene container element.
 *
 * Canvas elements are added/removed on-demand based on the scene definition.
 *
 * The scene layout controls the position of each canvas via layout functions that
 * return absolute positioning styles. The scene container is responsive and maintains
 * the requested layout proportionally.
 */
export class NvSceneController {
  containerElement: HTMLElement | null = null
  viewers: ViewerSlot[] = []
  currentLayout: string = '1x1'
  slots: number
  layouts: Record<string, LayoutConfig>
  onViewerCreated?: NiivueCallback

  private listeners = new Set<Listener>()
  private snapshotCache: NvSceneControllerSnapshot | null = null
  private nextId = 0
  private viewersById = new Map<string, ViewerSlot>()
  private broadcasting = false
  private broadcastOptions: BroadcastOptions = { '2d': true, '3d': true }
  private viewerSliceLayouts = new Map<string, SliceLayoutTile[] | null>()
  private viewerDefaults: Partial<NiiVueOptions>

  // Event system
  // biome-ignore lint/complexity/noBannedTypes: generic event callback storage
  private eventListeners = new Map<string, Set<Function>>()

  // Loading/error state
  private loadingCounts = new Map<string, number>()
  private viewerErrors = new Map<string, unknown[]>()

  constructor(
    layouts: Record<string, LayoutConfig> = defaultLayouts,
    viewerDefaults: Partial<NiiVueOptions> = {},
  ) {
    this.layouts = layouts
    this.slots = this.layouts[this.currentLayout]?.slots ?? 1
    this.viewerDefaults = viewerDefaults
  }

  // --- Event system ---

  on<E extends keyof NvSceneEventMap>(
    event: E,
    cb: NvSceneEventMap[E],
  ): () => void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)?.add(cb)
    return () => this.off(event, cb)
  }

  off<E extends keyof NvSceneEventMap>(event: E, cb: NvSceneEventMap[E]): void {
    this.eventListeners.get(event)?.delete(cb)
  }

  private emit<E extends keyof NvSceneEventMap>(
    event: E,
    ...args: Parameters<NvSceneEventMap[E]>
  ): void {
    const listeners = this.eventListeners.get(event)
    if (!listeners) return
    for (const cb of listeners) {
      ;(cb as (...a: unknown[]) => void)(...args)
    }
  }

  // --- Subscribe / snapshot ---

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): NvSceneControllerSnapshot => {
    if (!this.snapshotCache) {
      const viewerStates: ViewerState[] = this.viewers.map((v) => ({
        id: v.id,
        loading: this.loadingCounts.get(v.id) ?? 0,
        errors: this.viewerErrors.get(v.id) ?? [],
      }))
      this.snapshotCache = {
        currentLayout: this.currentLayout,
        viewerCount: this.viewers.length,
        slots: this.slots,
        isBroadcasting: this.broadcasting,
        isLoading: viewerStates.some((s) => s.loading > 0),
        viewerStates,
      }
    }
    return this.snapshotCache
  }

  private notify(): void {
    this.snapshotCache = null
    this.listeners.forEach((listener) => {
      listener()
    })
  }

  // --- Container & layout ---

  setContainerElement(element: HTMLElement | null): void {
    this.containerElement = element
    if (element) {
      this.updateLayout()
    }
  }

  setLayout(layoutName: string): void {
    const layoutConfig = this.layouts[layoutName]
    if (!layoutConfig) return

    this.currentLayout = layoutName
    this.slots = layoutConfig.slots

    // Remove excess viewers if new layout has fewer slots
    while (this.viewers.length > this.slots) {
      this.removeViewer(this.viewers.length - 1, false)
    }

    // Fill all available slots when a container is present
    if (this.containerElement) {
      while (this.viewers.length < this.slots) {
        this.addViewer()
      }
    }

    this.updateLayout()
    this.notify()
  }

  updateLayout(): void {
    if (!this.containerElement) return

    const layoutConfig = this.layouts[this.currentLayout]
    if (!layoutConfig) return

    this.viewers.forEach((viewer, index) => {
      const position = layoutConfig.layoutFunction(
        this.containerElement as HTMLElement,
        index,
        this.viewers.length,
      )
      Object.assign(viewer.containerDiv.style, {
        position: 'absolute',
        top: position.top,
        left: position.left,
        width: position.width,
        height: position.height,
      })
    })
  }

  canAddViewer(): boolean {
    return this.viewers.length < this.slots
  }

  getNiivue(index: number): NiiVueGPU | undefined {
    return this.viewers[index]?.niivue
  }

  getAllNiivue(): NiiVueGPU[] {
    return this.viewers.map((viewer) => viewer.niivue)
  }

  forEachNiivue(callback: NiivueCallback): void {
    this.viewers.forEach((viewer, i) => {
      callback(viewer.niivue, i)
    })
  }

  private hasSyncableContent(nv: NiiVueGPU): boolean {
    return nv.volumes.length > 0 || nv.meshes.length > 0
  }

  private safeBroadcastTo(index: number, targets: NiiVueGPU[]): void {
    const viewer = this.viewers[index]
    if (!viewer) return
    try {
      viewer.niivue.broadcastTo(targets, this.broadcastOptions)
    } catch (err) {
      this.addError(viewer.id, err)
      this.emit('error', index, err)
    }
  }

  private rewireBroadcasting(): void {
    if (!this.broadcasting) {
      this.viewers.forEach((_viewer, index) => {
        this.safeBroadcastTo(index, [])
      })
      return
    }

    const syncableViewers = this.viewers.filter((viewer) =>
      this.hasSyncableContent(viewer.niivue),
    )

    this.viewers.forEach((viewer, index) => {
      if (!this.hasSyncableContent(viewer.niivue)) {
        this.safeBroadcastTo(index, [])
        return
      }

      const others = syncableViewers
        .filter((v) => v.id !== viewer.id)
        .map((v) => v.niivue)
      this.safeBroadcastTo(index, others)
    })
  }

  setBroadcasting(enabled: boolean, options?: Partial<BroadcastOptions>): void {
    this.broadcasting = enabled
    if (options) {
      this.broadcastOptions = { ...this.broadcastOptions, ...options }
    }
    this.rewireBroadcasting()
    this.notify()
  }

  isBroadcasting(): boolean {
    return this.broadcasting
  }

  setViewerSliceLayout(index: number, layout: SliceLayoutTile[] | null): void {
    const viewer = this.viewers[index]
    if (!viewer) return
    this.viewerSliceLayouts.set(viewer.id, layout)
    this.applySliceLayout(viewer.niivue, layout)
    this.notify()
  }

  getViewerSliceLayout(index: number): SliceLayoutTile[] | null {
    const viewer = this.viewers[index]
    if (!viewer) return null
    return this.viewerSliceLayouts.get(viewer.id) ?? null
  }

  private applySliceLayout(
    nv: NiiVueGPU,
    layout: SliceLayoutTile[] | null,
  ): void {
    if (layout && layout.length > 0) {
      nv.customLayout = layout
    } else {
      nv.customLayout = null
      nv.sliceType = SLICE_TYPE.AXIAL
      nv.showRender = SHOW_RENDER.NEVER
    }
  }

  getNiivueById(id: string): NiiVueGPU | undefined {
    return this.viewersById.get(id)?.niivue
  }

  getViewerById(id: string): ViewerSlot | undefined {
    return this.viewersById.get(id)
  }

  // --- Volume management ---

  async loadVolume(index: number, opts: ImageFromUrlOptions): Promise<NVImage> {
    const viewer = this.viewers[index]
    if (!viewer) throw new Error(`No viewer at index ${index}`)

    this.incrementLoading(viewer.id)
    try {
      await viewer.niivue.addVolume(opts)
      const vols = viewer.niivue.volumes
      const image = vols[vols.length - 1]
      if (!image) throw new Error('Volume was not added')
      this.emit('volumeAdded', index, opts, image)
      if (this.broadcasting) {
        this.rewireBroadcasting()
      }
      return image
    } catch (err) {
      this.addError(viewer.id, err)
      this.emit('error', index, err)
      throw err
    } finally {
      this.decrementLoading(viewer.id)
    }
  }

  async loadVolumes(
    index: number,
    opts: ImageFromUrlOptions[],
  ): Promise<NVImage[]> {
    const results: NVImage[] = []
    for (const o of opts) {
      results.push(await this.loadVolume(index, o))
    }
    return results
  }

  async removeVolume(index: number, url: string): Promise<void> {
    const viewer = this.viewers[index]
    if (!viewer) return
    const nv = viewer.niivue
    const volIdx = nv.volumes.findIndex(
      (v: NVImage) => v.url === url || v.name === url,
    )
    if (volIdx >= 0) {
      nv.model.removeVolume(volIdx)
      await nv.updateGLVolume()
      this.emit('volumeRemoved', index, url)
      if (this.broadcasting) {
        this.rewireBroadcasting()
      }
      this.notify()
    }
  }

  // --- Colormap / intensity / opacity ---

  /**
   * Look up the Niivue instance and NVImage at the given viewer and volume indices.
   * Returns undefined if either index is out of bounds.
   */
  private findVolume(
    viewerIndex: number,
    volumeIndex: number,
  ): { nv: NiiVueGPU; vol: NVImage; volumeIndex: number } | undefined {
    const viewer = this.viewers[viewerIndex]
    if (!viewer) return undefined
    const nv = viewer.niivue
    const vol = nv.volumes[volumeIndex] as NVImage | undefined
    if (!vol) return undefined
    return { nv, vol, volumeIndex }
  }

  /** Set the colormap for a volume at the given viewer and volume index. */
  async setColormap(
    viewerIndex: number,
    volumeIndex: number,
    colormap: string,
  ): Promise<void> {
    const found = this.findVolume(viewerIndex, volumeIndex)
    if (!found) return
    await found.nv.setVolume(found.volumeIndex, { colormap })
    this.emit('colormapChanged', viewerIndex, volumeIndex, colormap)
    this.notify()
  }

  /** Set the intensity range (calMin / calMax) for a volume at the given viewer and volume index. */
  async setCalMinMax(
    viewerIndex: number,
    volumeIndex: number,
    calMin: number,
    calMax: number,
  ): Promise<void> {
    const found = this.findVolume(viewerIndex, volumeIndex)
    if (!found) return
    await found.nv.setVolume(found.volumeIndex, { calMin, calMax })
    this.emit('intensityChanged', viewerIndex, volumeIndex, calMin, calMax)
    this.notify()
  }

  /** Set the opacity for a volume at the given viewer and volume index. */
  async setOpacity(
    viewerIndex: number,
    volumeIndex: number,
    opacity: number,
  ): Promise<void> {
    const found = this.findVolume(viewerIndex, volumeIndex)
    if (!found) return
    await found.nv.setVolume(found.volumeIndex, { opacity })
    this.emit('opacityChanged', viewerIndex, volumeIndex, opacity)
    this.notify()
  }

  private incrementLoading(id: string): void {
    this.loadingCounts.set(id, (this.loadingCounts.get(id) ?? 0) + 1)
    this.notify()
  }

  private decrementLoading(id: string): void {
    const count = (this.loadingCounts.get(id) ?? 1) - 1
    this.loadingCounts.set(id, Math.max(0, count))
    this.notify()
  }

  private addError(id: string, error: unknown): void {
    const errors = this.viewerErrors.get(id) ?? []
    errors.push(error)
    this.viewerErrors.set(id, errors)
  }

  private getViewerIndex(viewer: ViewerSlot): number {
    return this.viewers.findIndex((candidate) => candidate.id === viewer.id)
  }

  // --- Viewer lifecycle ---

  addViewer(options?: Partial<NiiVueOptions>): Promise<ViewerSlot> {
    if (!this.containerElement) {
      throw new Error('Container element not set')
    }

    if (!this.canAddViewer()) {
      throw new Error(`Cannot add viewer: slot limit of ${this.slots} reached`)
    }

    const containerDiv = document.createElement('div')
    containerDiv.className = 'niivue-canvas-container'
    containerDiv.style.position = 'relative'
    containerDiv.style.overflow = 'hidden'

    const canvas = document.createElement('canvas')
    canvas.className = 'niivue-canvas'
    canvas.style.position = 'absolute'
    canvas.style.top = '0'
    canvas.style.left = '0'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    containerDiv.appendChild(canvas)

    this.containerElement.appendChild(containerDiv)

    const mergedOptions: Partial<NiiVueOptions> = {
      ...defaultViewerOptions,
      ...this.viewerDefaults,
      ...options,
    }

    const niivue = new NiiVueGPU(mergedOptions)

    const id = `nv-${this.nextId++}`
    this.viewerSliceLayouts.set(id, null)
    this.loadingCounts.set(id, 0)
    this.viewerErrors.set(id, [])

    const viewer: ViewerSlot = {
      id,
      niivue,
      canvasElement: canvas,
      containerDiv,
    }

    // Register the viewer synchronously so callers (e.g. setLayout) can
    // add multiple viewers in a loop without awaiting each one.
    this.viewers.push(viewer)
    this.viewersById.set(id, viewer)
    this.updateLayout()

    const index = this.viewers.length - 1

    // Wire NiiVueGPU event listeners (sync — before attachment)
    niivue.addEventListener('locationChange', (evt) => {
      const currentIndex = this.getViewerIndex(viewer)
      if (currentIndex >= 0) {
        this.emit('locationChange', currentIndex, evt.detail)
      }
    })
    niivue.addEventListener('volumeLoaded', (evt) => {
      const currentIndex = this.getViewerIndex(viewer)
      if (currentIndex >= 0) {
        this.emit('imageLoaded', currentIndex, evt.detail.volume)
      }
      if (this.broadcasting) {
        this.rewireBroadcasting()
      }
    })
    niivue.addEventListener('meshLoaded', () => {
      if (this.broadcasting) {
        this.rewireBroadcasting()
      }
    })

    // Notify synchronously — viewer slot is registered and usable
    this.onViewerCreated?.(niivue, index)
    this.emit('viewerCreated', niivue, index)
    this.notify()

    // Async canvas attachment — viewer is already registered
    const ready = niivue.attachToCanvas(canvas).then(() => {
      // Apply the current slice layout (default axial).
      this.applySliceLayout(niivue, null)

      // Update broadcasting to include new viewer
      if (this.broadcasting) {
        this.setBroadcasting(true)
      }

      this.notify()

      return viewer
    })

    return ready
  }

  removeViewer(index: number, shouldNotify = true): void {
    if (index < 0 || index >= this.viewers.length) return

    const viewer = this.viewers[index]
    if (!viewer) return

    // Remove from ID map
    this.viewersById.delete(viewer.id)
    this.viewerSliceLayouts.delete(viewer.id)
    this.loadingCounts.delete(viewer.id)
    this.viewerErrors.delete(viewer.id)

    // Properly dispose of WebGL context to free up resources
    this.disposeViewer(viewer)

    viewer.containerDiv.remove()
    this.viewers.splice(index, 1)
    this.updateLayout()

    // Update broadcasting for remaining viewers
    if (this.broadcasting && this.viewers.length > 0) {
      this.setBroadcasting(true)
    }

    this.emit('viewerRemoved', index)

    if (shouldNotify) {
      this.notify()
    }
  }

  private disposeViewer(viewer: ViewerSlot): void {
    viewer.niivue.destroy()
    viewer.canvasElement.width = 0
    viewer.canvasElement.height = 0
  }

  clearViewers(): void {
    this.broadcasting = false
    this.viewers.forEach((viewer) => {
      this.disposeViewer(viewer)
      viewer.containerDiv.remove()
    })
    this.viewers = []
    this.viewersById.clear()
    this.loadingCounts.clear()
    this.viewerErrors.clear()
    this.notify()
  }

  reset(): void {
    this.clearViewers()
    this.currentLayout = '1x1'
    this.slots = this.layouts[this.currentLayout]?.slots ?? 1
    this.notify()
  }
}
