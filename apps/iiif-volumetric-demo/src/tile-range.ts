// Whole-slide-image tile viewer demo, built on the niivue core NVSlide class.
//
// NVSlide owns the manifest/levels/tiles model, viewport (pan/zoom), HTTP
// Range-request tile streaming, the ImageBitmap cache and the request stats.
// The demo just wires DOM controls to it and draws it with a backend-selected
// renderer (SlideRenderer for WebGL2, SlideRendererGPU for WebGPU). The point
// of the demo is that a multi-GB whole-slide pyramid streams one tile's worth
// of bytes at a time over HTTP 206 range requests.

import {
  NVSlide,
  type NVSlideManifest,
  type NVSlideScreen,
  SlideRenderer,
  SlideRendererGPU,
} from '@niivue/niivue'
import { getBackendFromUrl, isWebGpuAvailable } from './backend'
import { installNav } from './nav'

installNav()

const SYNTHETIC_MANIFEST_PATH = 'tile-range-poc/tiles.json'
const DEFAULT_DICOM_WSI_ID = 'cptac-brca_dicom'
const MAX_CACHE_BYTES = 96 * 1024 * 1024
const TARGET_SCREEN_PIXELS_PER_TILE_PIXEL = 0.75
const RANGE_LOG_LENGTH = 24

type TileSourceKind = 'synthetic' | 'dicom-wsi'

type SlideView =
  | { kind: 'gl'; gl: WebGL2RenderingContext; renderer: SlideRenderer }
  | { kind: 'gpu'; renderer: SlideRendererGPU }

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  source: el<HTMLSelectElement>('source'),
  levelMode: el<HTMLSelectElement>('levelMode'),
  zoomOut: el<HTMLButtonElement>('zoomOut'),
  zoomIn: el<HTMLButtonElement>('zoomIn'),
  fit: el<HTMLButtonElement>('fit'),
  showGrid: el<HTMLInputElement>('showGrid'),
  canvas: el<HTMLCanvasElement>('tileCanvas'),
  hud: el<HTMLDivElement>('hud'),
  rangeLog: el<HTMLDivElement>('rangeLog'),
  fallback: el<HTMLDivElement>('fallback'),
}

let view: SlideView | null = null
let slide: NVSlide | null = null
let animationFrame = 0
let hasFit = false
let drag: { pointerId: number; lastX: number; lastY: number } | null = null

function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  const normalizedBase = base.endsWith('/') ? base : `${base}/`
  return new URL(
    `${normalizedBase}${path.replace(/^\//, '')}`,
    window.location.href,
  ).toString()
}

function sourceFromUrl(): TileSourceKind {
  const params = new URLSearchParams(window.location.search)
  return params.get('source') === 'dicom-wsi' ? 'dicom-wsi' : 'synthetic'
}

function currentSourceKind(): TileSourceKind {
  return els.source.value === 'dicom-wsi' ? 'dicom-wsi' : 'synthetic'
}

function manifestUrlForSource(source: TileSourceKind): string {
  if (source === 'dicom-wsi') {
    const params = new URLSearchParams(window.location.search)
    const id = params.get('id') || DEFAULT_DICOM_WSI_ID
    return new URL(
      `/dicom-wsi/${encodeURIComponent(id)}/manifest.json`,
      window.location.href,
    ).toString()
  }
  return assetUrl(SYNTHETIC_MANIFEST_PATH)
}

function syncSourceUrl(source: TileSourceKind): void {
  const url = new URL(window.location.href)
  if (source === 'dicom-wsi') {
    url.searchParams.set('source', source)
    if (!url.searchParams.has('id')) {
      url.searchParams.set('id', DEFAULT_DICOM_WSI_ID)
    }
  } else {
    url.searchParams.delete('source')
    url.searchParams.delete('id')
  }
  window.history.replaceState(null, '', url)
}

function html(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function screenForCanvas(): NVSlideScreen {
  const rect = els.canvas.getBoundingClientRect()
  return {
    widthCss: rect.width,
    heightCss: rect.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

function resizeCanvas(screen: NVSlideScreen): void {
  const dpr = screen.devicePixelRatio ?? 1
  const width = Math.max(1, Math.floor(screen.widthCss * dpr))
  const height = Math.max(1, Math.floor(screen.heightCss * dpr))
  if (els.canvas.width !== width || els.canvas.height !== height) {
    els.canvas.width = width
    els.canvas.height = height
  }
}

async function createView(): Promise<SlideView> {
  const backend = getBackendFromUrl()
  if (backend === 'webgpu' && isWebGpuAvailable()) {
    const renderer = await SlideRendererGPU.create(els.canvas)
    if (renderer) return { kind: 'gpu', renderer }
    console.warn('WebGPU unavailable; falling back to WebGL2')
  }
  const gl = els.canvas.getContext('webgl2', { alpha: false, antialias: false })
  if (!gl) throw new Error('WebGL2 is not available')
  const renderer = new SlideRenderer()
  renderer.init(gl)
  return { kind: 'gl', gl, renderer }
}

function drawView(screen: NVSlideScreen): void {
  if (!view || !slide) return
  const slides = [slide]
  if (view.kind === 'gpu') {
    view.renderer.render(slides, screen)
  } else {
    view.renderer.draw(view.gl, slides, screen)
  }
}

function requestRender(): void {
  if (animationFrame !== 0) return
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0
    render()
  })
}

function render(): void {
  const screen = screenForCanvas()
  resizeCanvas(screen)
  if (slide && !hasFit) {
    slide.fitToScreen(screen)
    hasFit = true
  }
  if (slide) slide.clampViewport(screen)
  drawView(screen)
  updateHud(screen)
  updateRangeLog()
}

function updateHud(screen: NVSlideScreen): void {
  if (!slide) {
    els.hud.innerHTML = '<div class="title">Loading tile manifest</div>'
    return
  }
  const manifest: NVSlideManifest = slide.manifest
  const level = slide.selectLevel()
  if (!level) {
    els.hud.innerHTML = '<div class="title">Loading tile manifest</div>'
    return
  }
  const s = slide.stats
  const mode = slide.levelChoice === 'auto' ? 'auto' : 'fixed'
  const scale = slide.viewport.scale
  const zoom =
    scale >= 1 ? `${scale.toFixed(2)}x` : `1:${(1 / scale).toFixed(1)}`
  const visible = slide.visibleTiles(screen).tiles.length
  const codec = level.codec ?? 'raw-rgba'
  const backendLabel = view?.kind === 'gpu' ? 'WebGPU' : 'WebGL2'
  els.hud.innerHTML = `
    <div class="title">${html(manifest.name)}</div>
    <div class="row"><span class="key">backend</span><span>${backendLabel}</span></div>
    <div class="row"><span class="key">source</span><span>${html(slide.sourceLabelForLevel(level))}</span></div>
    <div class="row"><span class="key">codec</span><span>${html(codec)}</span></div>
    <div class="row"><span class="key">level</span><span>L${level.index} ${mode} ${level.width}x${level.height}</span></div>
    <div class="row"><span class="key">zoom</span><span>${zoom}</span></div>
    <div class="row"><span class="key">tiles</span><span>${visible} visible, ${slide.pendingCount} pending</span></div>
    <div class="row"><span class="key">requests</span><span>${s.completed}/${s.requested} done</span></div>
    <div class="row"><span class="key">range</span><span class="ok">${s.rangeHits} HTTP 206</span></div>
    <div class="row"><span class="key">fallback</span><span class="${s.fullFileFallbacks > 0 ? 'warn' : ''}">${s.fullFileFallbacks} HTTP 200</span></div>
    <div class="row"><span class="key">wire</span><span>${formatBytes(s.wireBytes)}</span></div>
    <div class="row"><span class="key">cache</span><span>${formatBytes(s.cacheBytes)} / ${s.cacheHits} hits</span></div>
    <div class="row"><span class="key">failures</span><span class="${s.failures > 0 ? 'bad' : ''}">${s.failures}</span></div>
  `
}

function updateRangeLog(): void {
  const events = slide?.stats.lastRequests ?? []
  const emptySlots = RANGE_LOG_LENGTH - events.length
  const spans: HTMLSpanElement[] = []
  for (let i = 0; i < emptySlots; i++) {
    spans.push(document.createElement('span'))
  }
  for (const event of events) {
    const span = document.createElement('span')
    span.className = event.status === 'hit' ? 'hit' : event.status
    span.title = event.label
    spans.push(span)
  }
  els.rangeLog.replaceChildren(...spans)
}

function populateLevels(manifest: NVSlideManifest): void {
  els.levelMode.replaceChildren()
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = 'auto lod'
  els.levelMode.appendChild(auto)
  for (const level of manifest.levels) {
    const option = document.createElement('option')
    option.value = String(level.index)
    option.textContent = `L${level.index} ${level.width}x${level.height}`
    els.levelMode.appendChild(option)
  }
  els.levelMode.value = 'auto'
}

function showFallback(message: string): void {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function hideFallback(): void {
  els.fallback.textContent = ''
  els.fallback.setAttribute('aria-hidden', 'true')
}

async function loadManifestForCurrentSource(): Promise<void> {
  hideFallback()
  slide?.dispose()
  slide = null
  hasFit = false
  requestRender()
  const source = currentSourceKind()
  syncSourceUrl(source)
  const next = await NVSlide.fromManifestUrl(manifestUrlForSource(source), {
    maxCacheBytes: MAX_CACHE_BYTES,
    targetScreenPixelsPerTilePixel: TARGET_SCREEN_PIXELS_PER_TILE_PIXEL,
    showTileGrid: els.showGrid.checked,
  })
  slide = next
  slide.addEventListener('change', requestRender)
  populateLevels(slide.manifest)
  hasFit = false
  requestRender()
}

function reloadSource(): void {
  loadManifestForCurrentSource().catch((err: unknown) => {
    console.error(err)
    showFallback(err instanceof Error ? err.message : String(err))
  })
}

els.canvas.addEventListener('pointerdown', (event) => {
  els.canvas.setPointerCapture(event.pointerId)
  drag = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  }
})

els.canvas.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId || !slide) return
  const dx = event.clientX - drag.lastX
  const dy = event.clientY - drag.lastY
  drag.lastX = event.clientX
  drag.lastY = event.clientY
  slide.panByScreenDelta(dx, dy, screenForCanvas())
})

els.canvas.addEventListener('pointerup', (event) => {
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener('pointercancel', (event) => {
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    if (!slide) return
    const rect = els.canvas.getBoundingClientRect()
    slide.zoomBy(
      Math.exp(-event.deltaY * 0.0013),
      event.clientX - rect.left,
      event.clientY - rect.top,
      screenForCanvas(),
    )
  },
  { passive: false },
)

els.levelMode.addEventListener('change', () => {
  slide?.setLevelChoice(
    els.levelMode.value === 'auto' ? 'auto' : Number(els.levelMode.value),
  )
})
els.source.addEventListener('change', reloadSource)
els.showGrid.addEventListener('change', () => {
  slide?.setTileGridVisible(els.showGrid.checked)
})
els.fit.addEventListener('click', () => slide?.fitToScreen(screenForCanvas()))
els.zoomIn.addEventListener('click', () => zoomCentered(1.45))
els.zoomOut.addEventListener('click', () => zoomCentered(1 / 1.45))
window.addEventListener('resize', requestRender)

function zoomCentered(factor: number): void {
  if (!slide) return
  const screen = screenForCanvas()
  slide.zoomBy(factor, screen.widthCss / 2, screen.heightCss / 2, screen)
}

async function main(): Promise<void> {
  els.source.value = sourceFromUrl()
  view = await createView()
  await loadManifestForCurrentSource()
  requestRender()
}

main().catch((err: unknown) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})
