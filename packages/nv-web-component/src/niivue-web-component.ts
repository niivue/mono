import type { NiiVueOptions, NVImage } from '@niivue/niivue'
import NiiVueGPU, { DRAG_MODE, SLICE_TYPE } from '@niivue/niivue'
import { css, html, LitElement, type PropertyValues } from 'lit'
import { defaultLayouts } from './layouts'
import {
  defaultSliceLayouts,
  defaultViewerOptions,
  NvSceneController,
  type NvSceneControllerSnapshot,
  type SliceLayoutTile,
} from './nvscene-controller'
import type { ImageFromUrlOptions } from './types'

export const defaultElementName = 'niivue-viewer'
export const defaultSceneElementName = 'niivue-scene'

export type NiivueWebComponentOptions = {
  elementName?: string
  sceneElementName?: string
}

type VolumeVisualProps = {
  colormap?: string
  calMin?: number
  calMax?: number
  opacity?: number
}

export const volumeKey = (opts: ImageFromUrlOptions): string =>
  typeof opts.url === 'string' ? opts.url : opts.url.name

export const volumeIdentity = (volume: Pick<NVImage, 'url' | 'name'>): string =>
  volume.url || volume.name

export const extractVisualProps = (
  opts: ImageFromUrlOptions,
): VolumeVisualProps => ({
  colormap: opts.colormap,
  calMin: opts.calMin,
  calMax: opts.calMax,
  opacity: opts.opacity,
})

export const volumeVisualUpdates = (
  next: VolumeVisualProps,
  prev: VolumeVisualProps,
): Partial<VolumeVisualProps> => {
  const updates: Partial<VolumeVisualProps> = {}
  if (next.colormap !== undefined && next.colormap !== prev.colormap) {
    updates.colormap = next.colormap
  }
  if (next.calMin !== undefined && next.calMin !== prev.calMin) {
    updates.calMin = next.calMin
  }
  if (next.calMax !== undefined && next.calMax !== prev.calMax) {
    updates.calMax = next.calMax
  }
  if (next.opacity !== undefined && next.opacity !== prev.opacity) {
    updates.opacity = next.opacity
  }
  return updates
}

const dispatchNiivueEvent = (
  element: HTMLElement,
  name: string,
  detail: unknown,
): void => {
  element.dispatchEvent(
    new CustomEvent(name, { detail, bubbles: true, composed: true }),
  )
}

export class NiivueViewerElement extends LitElement {
  static override properties = {
    volumes: { attribute: false },
    options: { attribute: false },
    sliceType: { type: Number, attribute: 'slice-type' },
  }

  static override styles = css`
    :host {
      display: block;
      position: relative;
      min-height: 1px;
    }

    #container {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: inherit;
    }

    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
  `

  volumes: ImageFromUrlOptions[] = []
  options: Partial<NiiVueOptions> = {}
  sliceType = SLICE_TYPE.AXIAL

  private niivue: NiiVueGPU | null = null
  private resizeObserver: ResizeObserver | null = null
  private loadedVolumes = new Map<string, VolumeVisualProps>()

  get nv(): NiiVueGPU | null {
    return this.niivue
  }

  override render() {
    return html`<div id="container"><canvas class="niivue-canvas"></canvas></div>`
  }

  override firstUpdated(): void {
    const canvas = this.renderRoot.querySelector('canvas')
    const container = this.renderRoot.querySelector('#container')
    if (
      !(canvas instanceof HTMLCanvasElement) ||
      !(container instanceof HTMLElement)
    ) {
      return
    }

    const nv = new NiiVueGPU({ ...defaultViewerOptions, ...this.options })
    nv.addEventListener('locationChange', (evt) => {
      dispatchNiivueEvent(this, 'location-change', evt.detail)
    })
    nv.addEventListener('volumeLoaded', (evt) => {
      dispatchNiivueEvent(this, 'image-loaded', evt.detail.volume)
    })

    this.niivue = nv
    this.resizeObserver = new ResizeObserver(() => nv.resize())
    this.resizeObserver.observe(container)

    nv.attachToCanvas(canvas)
      .then(() => {
        nv.sliceType = this.sliceType
        return this.syncVolumes()
      })
      .catch((error: unknown) => this.emitError(error))
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('sliceType') && this.niivue) {
      this.niivue.sliceType = this.sliceType
    }
    if (changed.has('volumes')) {
      this.syncVolumes().catch((error: unknown) => this.emitError(error))
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.niivue?.destroy()
    this.niivue = null
    this.loadedVolumes.clear()
  }

  private emitError(error: unknown): void {
    dispatchNiivueEvent(this, 'niivue-error', error)
  }

  async setColormap(volumeIndex: number, colormap: string): Promise<void> {
    if (this.niivue?.volumes[volumeIndex]) {
      await this.niivue.setVolume(volumeIndex, { colormap })
    }
  }

  async setOpacity(volumeIndex: number, opacity: number): Promise<void> {
    if (this.niivue?.volumes[volumeIndex]) {
      await this.niivue.setVolume(volumeIndex, { opacity })
    }
  }

  async setCalMinMax(
    volumeIndex: number,
    calMin: number,
    calMax: number,
  ): Promise<void> {
    if (this.niivue?.volumes[volumeIndex]) {
      await this.niivue.setVolume(volumeIndex, { calMin, calMax })
    }
  }

  setColorbarVisible(visible: boolean): void {
    if (this.niivue) {
      this.niivue.isColorbarVisible = visible
    }
  }

  setCrosshairVisible(visible: boolean): void {
    if (this.niivue) {
      this.niivue.isCrossLinesVisible = visible
      this.niivue.is3DCrosshairVisible = visible
    }
  }

  setPrimaryDragMode(mode: number): void {
    if (this.niivue) {
      this.niivue.primaryDragMode = mode
    }
  }

  setSecondaryDragMode(mode: number): void {
    if (this.niivue) {
      this.niivue.secondaryDragMode = mode
    }
  }

  private async syncVolumes(): Promise<void> {
    const nv = this.niivue
    if (!nv) return

    const desiredUrls = new Set(this.volumes.map(volumeKey))

    for (const url of this.loadedVolumes.keys()) {
      if (!desiredUrls.has(url)) {
        const volIdx = nv.volumes.findIndex(
          (volume: NVImage) => volume.url === url || volume.name === url,
        )
        if (volIdx >= 0) {
          nv.model.removeVolume(volIdx)
          await nv.updateGLVolume()
        }
        this.loadedVolumes.delete(url)
      }
    }

    for (const opts of this.volumes) {
      const urlKey = volumeKey(opts)
      const next = extractVisualProps(opts)
      const prev = this.loadedVolumes.get(urlKey)

      if (!prev) {
        this.loadedVolumes.set(urlKey, next)
        try {
          await nv.addVolume(opts)
        } catch (error) {
          this.loadedVolumes.delete(urlKey)
          this.emitError(error)
        }
        continue
      }

      const volIdx = nv.volumes.findIndex(
        (volume: NVImage) => volume.url === urlKey || volume.name === urlKey,
      )
      if (volIdx < 0) continue

      const updates = volumeVisualUpdates(next, prev)
      if (Object.keys(updates).length > 0) {
        await nv.setVolume(volIdx, updates)
      }
      this.loadedVolumes.set(urlKey, next)
    }
  }
}

export class NiivueSceneElement extends LitElement {
  static override properties = {
    layout: { type: String },
    broadcasting: { type: Boolean, reflect: true },
    snapshot: { attribute: false },
  }

  static override styles = css`
    :host {
      display: block;
      position: relative;
      min-height: 1px;
    }

    #scene {
      position: relative;
      width: 100%;
      height: 100%;
      min-height: inherit;
      overflow: hidden;
    }
  `

  layout = '1x1'
  broadcasting = false
  snapshot: NvSceneControllerSnapshot
  readonly scene = new NvSceneController(defaultLayouts)

  private unsubscribe: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null

  constructor() {
    super()
    this.snapshot = this.scene.getSnapshot()
    this.forwardSceneEvents()
  }

  override render() {
    return html`<div id="scene"></div>`
  }

  override firstUpdated(): void {
    const container = this.renderRoot.querySelector('#scene')
    if (!(container instanceof HTMLElement)) return

    this.unsubscribe = this.scene.subscribe(() => {
      this.snapshot = this.scene.getSnapshot()
      dispatchNiivueEvent(this, 'scene-change', this.snapshot)
    })
    this.scene.setContainerElement(container)
    this.scene.setLayout(this.layout)
    this.scene.setBroadcasting(this.broadcasting)
    this.resizeObserver = new ResizeObserver(() => this.scene.updateLayout())
    this.resizeObserver.observe(container)
  }

  override updated(changed: PropertyValues<this>): void {
    if (changed.has('layout')) {
      this.scene.setLayout(this.layout)
    }
    if (changed.has('broadcasting')) {
      this.scene.setBroadcasting(this.broadcasting)
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.scene.clearViewers()
    this.scene.setContainerElement(null)
  }

  addViewer(options?: Partial<NiiVueOptions>) {
    return this.scene.addViewer(options)
  }

  removeViewer(index: number): void {
    this.scene.removeViewer(index)
  }

  canAddViewer(): boolean {
    return this.scene.canAddViewer()
  }

  setViewerSliceLayout(index: number, layout: SliceLayoutTile[] | null): void {
    this.scene.setViewerSliceLayout(index, layout)
  }

  loadVolume(index: number, opts: ImageFromUrlOptions): Promise<NVImage> {
    return this.scene.loadVolume(index, opts)
  }

  loadVolumes(index: number, opts: ImageFromUrlOptions[]): Promise<NVImage[]> {
    return this.scene.loadVolumes(index, opts)
  }

  removeVolume(index: number, url: string): Promise<void> {
    return this.scene.removeVolume(index, url)
  }

  async setColormap(
    viewerIndex: number,
    volumeIndex: number,
    colormap: string,
  ): Promise<void> {
    await this.scene.setColormap(viewerIndex, volumeIndex, colormap)
  }

  async setOpacity(
    viewerIndex: number,
    volumeIndex: number,
    opacity: number,
  ): Promise<void> {
    await this.scene.setOpacity(viewerIndex, volumeIndex, opacity)
  }

  async setCalMinMax(
    viewerIndex: number,
    volumeIndex: number,
    calMin: number,
    calMax: number,
  ): Promise<void> {
    await this.scene.setCalMinMax(viewerIndex, volumeIndex, calMin, calMax)
  }

  setColorbarVisible(visible: boolean, viewerIndex?: number): void {
    this.forEachTargetViewer(viewerIndex, (niivue) => {
      niivue.isColorbarVisible = visible
    })
  }

  setCrosshairVisible(visible: boolean, viewerIndex?: number): void {
    this.forEachTargetViewer(viewerIndex, (niivue) => {
      niivue.isCrossLinesVisible = visible
      niivue.is3DCrosshairVisible = visible
    })
  }

  setPrimaryDragMode(mode: number, viewerIndex?: number): void {
    this.forEachTargetViewer(viewerIndex, (niivue) => {
      niivue.primaryDragMode = mode
    })
  }

  setSecondaryDragMode(mode: number, viewerIndex?: number): void {
    this.forEachTargetViewer(viewerIndex, (niivue) => {
      niivue.secondaryDragMode = mode
    })
  }

  private forEachTargetViewer(
    viewerIndex: number | undefined,
    callback: (niivue: NiiVueGPU) => void,
  ): void {
    if (viewerIndex === undefined) {
      this.scene.forEachNiivue(callback)
      return
    }
    const niivue = this.scene.getNiivue(viewerIndex)
    if (niivue) {
      callback(niivue)
    }
  }

  private forwardSceneEvents(): void {
    this.scene.on('viewerCreated', (niivue, index) => {
      dispatchNiivueEvent(this, 'viewer-created', { niivue, index })
    })
    this.scene.on('viewerRemoved', (index) => {
      dispatchNiivueEvent(this, 'viewer-removed', { index })
    })
    this.scene.on('locationChange', (viewerIndex, data) => {
      dispatchNiivueEvent(this, 'location-change', { viewerIndex, data })
    })
    this.scene.on('imageLoaded', (viewerIndex, volume) => {
      dispatchNiivueEvent(this, 'image-loaded', { viewerIndex, volume })
    })
    this.scene.on('error', (viewerIndex, error) => {
      dispatchNiivueEvent(this, 'niivue-error', { viewerIndex, error })
    })
    this.scene.on('volumeAdded', (viewerIndex, imageOptions, image) => {
      dispatchNiivueEvent(this, 'volume-added', {
        viewerIndex,
        imageOptions,
        image,
      })
    })
    this.scene.on('volumeRemoved', (viewerIndex, url) => {
      dispatchNiivueEvent(this, 'volume-removed', { viewerIndex, url })
    })
  }
}

export function defineNiivueWebComponents(
  options: NiivueWebComponentOptions = {},
): void {
  if (typeof customElements === 'undefined') return

  const viewerName = options.elementName ?? defaultElementName
  const sceneName = options.sceneElementName ?? defaultSceneElementName
  if (!customElements.get(viewerName)) {
    customElements.define(viewerName, NiivueViewerElement)
  }
  if (!customElements.get(sceneName)) {
    customElements.define(sceneName, NiivueSceneElement)
  }
}

export type { ImageFromUrlOptions, NiiVueOptions, NVImage }
export {
  DRAG_MODE,
  defaultLayouts,
  defaultSliceLayouts,
  defaultViewerOptions,
  NvSceneController,
  SLICE_TYPE,
}

defineNiivueWebComponents()
