// OSD NIfTI Desktop: a deep-zoomable 2D canvas of NIfTI tile previews fed
// from an IIIF VolumeDesktop manifest, plus an embedded NiiVue volume pane
// that loads the selected item at the appropriate LOD.

import NiiVue from '@niivue/niivue/webgl2'

const PREVIEW_LIMIT = 320
const PREVIEW_CONCURRENCY = 8
const FOCUS_LOAD_DELAY_MS = 180
const VOLUME_LOAD_TIMEOUT_MS = 45000
const MIN_ZOOM = 0.03
const MAX_ZOOM = 24

interface WorldRect {
  x: number
  y: number
  width: number
  height: number
}

interface LevelEntry {
  level: number
  shape: [number, number, number]
  spacing?: [number, number, number]
  ready?: boolean
  bytes?: number | null
  raw?: string
}

interface PreviewSpec {
  axis: string
  slice: number
  service: string
  image: string
}

interface DesktopItem {
  id: string
  type: string
  label: string
  index: number
  bounds: WorldRect
  format: string
  shape: [number, number, number]
  spacing: [number, number, number]
  dtype: string
  manifest: string
  metadata: string
  preview: PreviewSpec
  levels: LevelEntry[]
  brickTemplate?: string
  sliceServices?: Record<string, string>
  raw?: string
}

interface DesktopWorld {
  width: number
  height: number
  units: string
  columns: number
  rows: number
}

interface DesktopManifest {
  type: 'VolumeDesktop'
  id: string
  label: string
  profile: string
  tileSize: number
  gap: number
  world: DesktopWorld
  itemCount: number
  items: DesktopItem[]
}

interface PresentationLangMap {
  en?: string[]
}

interface PresentationMetadataEntry {
  label?: PresentationLangMap
  value?: PresentationLangMap
}

interface PresentationBody {
  id: string
  type: string
  service?: { id: string }[]
  items?: PresentationBody[]
  [hint: string]:
    | string
    | number
    | boolean
    | undefined
    | { id: string }[]
    | PresentationBody[]
    | {
        shape?: [number, number, number]
        spacing?: [number, number, number]
        dtype?: string
      }
}

interface PresentationAnnotation {
  body?: PresentationBody
}

interface PresentationAnnotationPage {
  items?: PresentationAnnotation[]
}

interface PresentationItem {
  type: string
  metadata?: PresentationMetadataEntry[]
  items?: (PresentationItem | PresentationAnnotationPage)[]
}

interface PresentationManifest {
  type?: string
  '@type'?: string
  id?: string
  label?: PresentationLangMap
  items?: PresentationItem[]
  metadata?: PresentationMetadataEntry[]
}

interface ViewportState {
  centerX: number
  centerY: number
  zoom: number
}

interface PreviewCacheEntry {
  bitmap: ImageBitmap | HTMLImageElement
  lastUsed: number
}

interface PreviewJob {
  controller: AbortController
}

interface DragState {
  id: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  moved: number
}

interface VolumeDragState {
  id: number
  lastX: number
  lastY: number
}

interface VolumeRendererState {
  // Typed as `unknown`-friendly union of method probes. NiiVue is heavy so
  // we use a structural alias rather than the full default export type.
  nv: NiiVueLike | null
  rendererTried: boolean
  rendererError: Error | null
  currentKey: string
  loadingKey: string
  requestId: number
}

interface NiiVueLike {
  canvas: HTMLCanvasElement
  opts: { isInteractionEnabled: boolean; isDragDropEnabled: boolean }
  sliceType: number
  azimuth: number
  elevation: number
  scaleMultiplier: number
  attachToCanvas(canvas: HTMLCanvasElement): Promise<unknown>
  loadVolumes(
    volumes: { url: string; name: string; colormap: string }[],
  ): Promise<unknown>
  drawScene(): void
  resize?: () => void
  addEventListener(type: string, handler: (event: Event) => void): void
}

interface AppState {
  manifest: DesktopManifest | null
  items: DesktopItem[]
  selected: DesktopItem | null
  hover: DesktopItem | null
  viewport: ViewportState
  previewCache: Map<string, PreviewCacheEntry>
  previewJobs: Map<string, PreviewJob>
  failedPreviews: Set<string>
  visibleItems: DesktopItem[]
  drawPending: boolean
  didFit: boolean
  drag: DragState | null
  focusTimer: ReturnType<typeof setTimeout> | null
  volume: VolumeRendererState
  volumeDrag: VolumeDragState | null
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  canvas: el<HTMLCanvasElement>('desktop-canvas'),
  volumeCanvas: el<HTMLCanvasElement>('volume-canvas'),
  volumePane: document.querySelector<HTMLDivElement>('.volume-pane'),
  volumeFallback: el<HTMLDivElement>('volume-fallback'),
  volumeList: el<HTMLDivElement>('volume-list'),
  volumeFilter: el<HTMLInputElement>('volume-filter'),
  volumeCount: el<HTMLSpanElement>('volume-count'),
  subtitle: el<HTMLParagraphElement>('desktop-subtitle'),
  hudZoom: el<HTMLSpanElement>('hud-zoom'),
  hudVisible: el<HTMLSpanElement>('hud-visible'),
  hudQueue: el<HTMLSpanElement>('hud-queue'),
  hudCache: el<HTMLSpanElement>('hud-cache'),
  minimapViewport: el<HTMLDivElement>('minimap-viewport'),
  focusLod: el<HTMLSpanElement>('focus-lod'),
  focusTitle: el<HTMLHeadingElement>('focus-title'),
  focusShape: el<HTMLElement>('focus-shape'),
  focusSpacing: el<HTMLElement>('focus-spacing'),
  focusDtype: el<HTMLElement>('focus-dtype'),
  focusLevel: el<HTMLElement>('focus-level'),
  levelStrip: el<HTMLDivElement>('level-strip'),
  manifestLink: el<HTMLAnchorElement>('manifest-link'),
  rawLink: el<HTMLAnchorElement>('raw-link'),
  sliceSlider: el<HTMLInputElement>('slice-slider'),
  slicePreview: el<HTMLImageElement>('slice-preview'),
  zoomOut: el<HTMLButtonElement>('zoom-out'),
  zoomIn: el<HTMLButtonElement>('zoom-in'),
  fitWorld: el<HTMLButtonElement>('fit-world'),
  zoomFocus: el<HTMLButtonElement>('zoom-focus'),
  colormap: el<HTMLSelectElement>('colormap'),
}

const state: AppState = {
  manifest: null,
  items: [],
  selected: null,
  hover: null,
  viewport: { centerX: 0, centerY: 0, zoom: 1 },
  previewCache: new Map(),
  previewJobs: new Map(),
  failedPreviews: new Set(),
  visibleItems: [],
  drawPending: false,
  didFit: false,
  drag: null,
  focusTimer: null,
  volume: {
    nv: null,
    rendererTried: false,
    rendererError: null,
    currentKey: '',
    loadingKey: '',
    requestId: 0,
  },
  volumeDrag: null,
}

const boundVolumeCanvases = new WeakSet<HTMLCanvasElement>()

main().catch((err: unknown) => {
  console.error(err)
  showFatal(err)
})

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const manifestUrl = params.get('manifest') || '/iiif/desktop/neuro/manifest'
  state.manifest = await loadDesktopManifest(manifestUrl)
  state.items = state.manifest.items || []

  els.subtitle.textContent = `${state.items.length} NIfTI volumes`
  els.volumeCount.textContent = String(state.items.length)
  els.manifestLink.href = state.manifest.id || manifestUrl

  renderVolumeList()
  setupEvents()
  resizeCanvas()
  fitWorld()
  requestDraw()

  const initialId = params.get('volume')
  if (initialId) {
    const item = state.items.find((v) => v.id === initialId)
    if (item) selectItem(item, { zoom: true, loadVolume: true })
  }
}

async function loadDesktopManifest(url: string): Promise<DesktopManifest> {
  const document = (await fetchJson(url)) as
    | DesktopManifest
    | PresentationManifest
  if (isDesktopManifest(document)) return document

  const converted = convertPresentationManifest(
    document as PresentationManifest,
    url,
  )
  if (converted) return converted

  const presentation = document as PresentationManifest
  const actual =
    presentation?.type ?? presentation?.['@type'] ?? typeof document
  throw new Error(
    `Expected a VolumeDesktop manifest at ${url}, got ${actual}. Open /osd-volume-desktop.html without a manifest parameter, or pass /iiif/desktop/neuro/manifest.`,
  )
}

function isDesktopManifest(
  doc: DesktopManifest | PresentationManifest,
): doc is DesktopManifest {
  const d = doc as Partial<DesktopManifest>
  return (
    d?.type === 'VolumeDesktop' &&
    Boolean(d?.world) &&
    Array.isArray(d?.items) &&
    (d?.items ?? []).every((item) => Boolean(item.bounds))
  )
}

function convertPresentationManifest(
  manifest: PresentationManifest,
  sourceUrl: string,
): DesktopManifest | null {
  if (manifest?.type !== 'Manifest') return null

  const scene = (manifest.items || []).find((item) => item.type === 'Scene')
  const sceneItems =
    (scene?.items as PresentationAnnotationPage[] | undefined) ?? []
  const annotation = sceneItems[0]?.items?.[0]
  const bodies = modelBodies(annotation?.body)
  if (bodies.length === 0) return null

  const first = bodies[0]
  if (!first) return null
  const hintsRaw = first['https://example.org/iiif/volumetric#']
  const hints = (
    typeof hintsRaw === 'object' &&
    hintsRaw !== null &&
    !Array.isArray(hintsRaw)
      ? (hintsRaw as {
          shape?: [number, number, number]
          spacing?: [number, number, number]
          dtype?: string
        })
      : {}
  ) as {
    shape?: [number, number, number]
    spacing?: [number, number, number]
    dtype?: string
  }
  const shape = hints.shape ?? metadataValue(manifest, 'Shape', [1, 1, 1])
  const spacing =
    hints.spacing ?? metadataValue(manifest, 'Voxel spacing', [1, 1, 1])
  const dtype = hints.dtype ?? metadataText(manifest, 'Data type') ?? 'unknown'
  const itemId = volumeIdFromManifest(sourceUrl, manifest.id || sourceUrl)
  const preview = previewFromPresentation(manifest, itemId)

  const label = manifest.label?.en?.[0] ?? `Volume ${itemId}`

  return {
    type: 'VolumeDesktop',
    id: `${window.location.origin}/iiif/desktop/from-presentation`,
    label,
    profile: 'https://example.org/iiif/volumetric/osd-desktop/v1',
    tileSize: 1024,
    gap: 96,
    world: {
      width: 1024,
      height: 1024,
      units: 'desktop-px',
      columns: 1,
      rows: 1,
    },
    itemCount: 1,
    items: [
      {
        id: itemId,
        type: 'NiftiVolumeItem',
        label,
        index: 0,
        bounds: { x: 0, y: 0, width: 1024, height: 1024 },
        format: 'nifti',
        shape,
        spacing,
        dtype,
        manifest: manifest.id || sourceUrl,
        metadata: '',
        preview,
        levels: bodies.map((body) => {
          const bodyHintsRaw = body['https://example.org/iiif/volumetric#']
          const bodyHints = (
            typeof bodyHintsRaw === 'object' &&
            bodyHintsRaw !== null &&
            !Array.isArray(bodyHintsRaw)
              ? (bodyHintsRaw as {
                  shape?: [number, number, number]
                  spacing?: [number, number, number]
                })
              : {}
          ) as {
            shape?: [number, number, number]
            spacing?: [number, number, number]
          }
          const level = levelFromUrl(body.id)
          return {
            level,
            shape: bodyHints.shape ?? shape,
            spacing: bodyHints.spacing ?? spacing,
            ready: true,
            bytes: null,
            raw: body.id,
          }
        }),
        brickTemplate: `${first.id}?level={level}&bbox={bbox}`,
        sliceServices: {},
      },
    ],
  }
}

function modelBodies(body: PresentationBody | undefined): PresentationBody[] {
  if (!body) return []
  if (body.type === 'Choice') {
    return ((body.items as PresentationBody[] | undefined) ?? []).filter(
      (item) => item.type === 'Model',
    )
  }
  return body.type === 'Model' ? [body] : []
}

function previewFromPresentation(
  manifest: PresentationManifest,
  itemId: string,
): PreviewSpec {
  const items = manifest.items ?? []
  const axial = items.find(
    (item) =>
      item.type === 'Canvas' &&
      item.metadata?.some(
        (md) =>
          md.label?.en?.[0] === 'Slice axis' && md.value?.en?.[0] === 'axial',
      ),
  )
  const canvas = axial || items.find((item) => item.type === 'Canvas')
  const annotationPages =
    (canvas?.items as PresentationAnnotationPage[] | undefined) ?? []
  const body = annotationPages[0]?.items?.[0]?.body
  const service = body?.service?.[0]?.id
  const sliceMatch = service?.match(/\/([^/]+)\/axial\/(\d+)$/)
  return {
    axis: 'axial',
    slice: Number(sliceMatch?.[2] ?? 0),
    service: service ?? `/iiif/image/${encodeURIComponent(itemId)}/axial/0`,
    image: body?.id ?? `${service}/full/384,/0/default.png`,
  }
}

function levelFromUrl(url: string): number {
  try {
    return Number(
      new URL(url, window.location.href).searchParams.get('level') ?? 0,
    )
  } catch (_err) {
    return 0
  }
}

function volumeIdFromManifest(sourceUrl: string, manifestId: string): string {
  const fromUrl = String(manifestId || sourceUrl).match(
    /\/iiif\/presentation\/([^/]+)\/manifest/,
  )
  if (fromUrl?.[1]) return decodeURIComponent(fromUrl[1])
  return 'volume'
}

function metadataText(manifest: PresentationManifest, label: string): string {
  const entry = (manifest.metadata ?? []).find(
    (md) => md.label?.en?.[0] === label,
  )
  return entry?.value?.en?.[0] ?? ''
}

function metadataValue(
  manifest: PresentationManifest,
  label: string,
  fallback: [number, number, number],
): [number, number, number] {
  const text = metadataText(manifest, label)
  const nums = text
    .split(/[×x, ]+/)
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n))
  if (nums.length >= 3) {
    const [a, b, c] = nums
    return [a ?? fallback[0], b ?? fallback[1], c ?? fallback[2]]
  }
  return fallback
}

function showFatal(err: unknown): void {
  const message = err instanceof Error ? err.message : 'Desktop failed to load'
  els.subtitle.textContent = message
  els.volumeFallback.hidden = false
  els.volumeFallback.textContent = message
  const ctx = els.canvas.getContext('2d')
  if (ctx) {
    resizeCanvas()
    const dpr = Math.max(1, window.devicePixelRatio || 1)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#090a08'
    ctx.fillRect(0, 0, els.canvas.clientWidth, els.canvas.clientHeight)
    ctx.fillStyle = '#e26d5a'
    ctx.font = '16px Avenir Next, Gill Sans, sans-serif'
    ctx.fillText('Manifest load failed', 24, 36)
    ctx.fillStyle = '#f0eee2'
    ctx.font = '13px Avenir Next, Gill Sans, sans-serif'
    wrapText(
      ctx,
      message,
      24,
      64,
      Math.max(260, els.canvas.clientWidth - 48),
      20,
    )
  }
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = String(text).split(/\s+/)
  let line = ''
  let cursorY = y
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, cursorY)
      line = word
      cursorY += lineHeight
    } else {
      line = test
    }
  }
  if (line) ctx.fillText(line, x, cursorY)
}

function setupEvents(): void {
  window.addEventListener('resize', () => {
    resizeCanvas()
    requestDraw()
  })

  els.volumeFilter.addEventListener('input', renderVolumeList)
  els.volumeList.addEventListener('click', (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const button = target.closest<HTMLButtonElement>('button[data-id]')
    if (!button) return
    const item = state.items.find((v) => v.id === button.dataset.id)
    if (item) selectItem(item, { zoom: true, loadVolume: true })
  })

  els.canvas.addEventListener('pointerdown', onPointerDown)
  els.canvas.addEventListener('pointermove', onPointerMove)
  els.canvas.addEventListener('pointerup', onPointerUp)
  els.canvas.addEventListener('pointercancel', onPointerUp)
  els.canvas.addEventListener('dblclick', onDoubleClick)
  els.canvas.addEventListener('wheel', onWheel, { passive: false })
  setupVolumePaneEvents()

  els.zoomOut.addEventListener('click', () => zoomAtCenter(0.78))
  els.zoomIn.addEventListener('click', () => zoomAtCenter(1.28))
  els.fitWorld.addEventListener('click', fitWorld)
  els.zoomFocus.addEventListener('click', () => {
    if (state.selected) zoomToItem(state.selected)
  })
  els.colormap.addEventListener('change', () => queueFocusVolumeLoad(true))
  els.sliceSlider.addEventListener('input', updateSlicePreview)
}

function setupVolumePaneEvents(
  canvas: HTMLCanvasElement = els.volumeCanvas,
): void {
  if (!canvas || boundVolumeCanvases.has(canvas)) return
  canvas.addEventListener('pointerdown', onVolumePointerDown, true)
  canvas.addEventListener('pointermove', onVolumePointerMove, true)
  canvas.addEventListener('pointerup', onVolumePointerUp, true)
  canvas.addEventListener('pointercancel', onVolumePointerUp, true)
  canvas.addEventListener('wheel', onVolumeWheel, {
    passive: false,
    capture: true,
  })
  canvas.addEventListener('dblclick', consumeVolumeEvent, true)
  canvas.addEventListener('contextmenu', consumeVolumeEvent, true)
  boundVolumeCanvases.add(canvas)
}

function onVolumePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !volumeIsReady()) return
  consumeVolumeEvent(event)
  els.volumeCanvas.focus({ preventScroll: true })
  els.volumeCanvas.setPointerCapture(event.pointerId)
  state.volumeDrag = {
    id: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  }
  els.volumePane?.classList.add('interacting')
}

function onVolumePointerMove(event: PointerEvent): void {
  if (!state.volumeDrag || state.volumeDrag.id !== event.pointerId) return
  consumeVolumeEvent(event)
  const dx = event.clientX - state.volumeDrag.lastX
  const dy = event.clientY - state.volumeDrag.lastY
  state.volumeDrag.lastX = event.clientX
  state.volumeDrag.lastY = event.clientY
  rotateVolume(dx, dy)
}

function onVolumePointerUp(event: PointerEvent): void {
  if (!state.volumeDrag || state.volumeDrag.id !== event.pointerId) return
  consumeVolumeEvent(event)
  try {
    els.volumeCanvas.releasePointerCapture(event.pointerId)
  } catch (_err) {
    // Pointer capture may already be gone if the browser cancelled the gesture.
  }
  state.volumeDrag = null
  els.volumePane?.classList.remove('interacting')
}

function onVolumeWheel(event: WheelEvent): void {
  if (!volumeIsReady()) return
  consumeVolumeEvent(event)
  const nv = state.volume.nv
  if (!nv) return
  const factor = Math.exp(-event.deltaY * 0.0014)
  nv.scaleMultiplier = clamp(nv.scaleMultiplier * factor, 0.05, 500)
  nv.drawScene()
}

function rotateVolume(dx: number, dy: number): void {
  const nv = state.volume.nv
  if (!nv) return
  const sensitivity = 0.5
  nv.azimuth = (nv.azimuth + dx * sensitivity + 360) % 360
  nv.elevation = clamp(nv.elevation + dy * sensitivity, -90, 90)
  nv.drawScene()
}

function consumeVolumeEvent(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
  event.stopPropagation()
}

function syncVolumeCanvasReference(
  nv: NiiVueLike | null = state.volume.nv,
): void {
  if (!nv?.canvas || nv.canvas === els.volumeCanvas) return
  els.volumeCanvas = nv.canvas
  els.volumeCanvas.tabIndex = 0
  els.volumeCanvas.setAttribute('aria-label', 'Interactive NIfTI volume render')
  setupVolumePaneEvents(els.volumeCanvas)
}

function volumeIsReady(): boolean {
  syncVolumeCanvasReference()
  return Boolean(state.volume.nv && els.volumeFallback.hidden)
}

function resizeCanvas(): void {
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  let volumeCanvasChanged = false
  for (const canvas of [els.canvas, els.volumeCanvas]) {
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, Math.round(rect.width * dpr))
    const height = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      if (canvas === els.volumeCanvas) volumeCanvasChanged = true
    }
  }
  if (volumeCanvasChanged && state.volume.nv) {
    resizeVolumeRenderer()
  }
}

function fitWorld(): void {
  const world = state.manifest?.world
  if (!world) return
  const rect = els.canvas.getBoundingClientRect()
  const zoom = Math.min(
    rect.width / Math.max(1, world.width),
    rect.height / Math.max(1, world.height),
  )
  state.viewport = {
    centerX: world.width / 2,
    centerY: world.height / 2,
    zoom: clamp(zoom * 0.92, MIN_ZOOM, MAX_ZOOM),
  }
  state.didFit = true
  onViewportChanged()
}

function requestDraw(): void {
  if (state.drawPending) return
  state.drawPending = true
  requestAnimationFrame(draw)
}

function draw(): void {
  state.drawPending = false
  resizeCanvas()

  const canvas = els.canvas
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const rect = canvas.getBoundingClientRect()
  const width = rect.width
  const height = rect.height

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#090a08'
  ctx.fillRect(0, 0, width, height)
  drawWorldGrid(ctx, width, height)

  const visible = getVisibleItems(0.18)
  state.visibleItems = visible
  schedulePreviewLoads(visible)

  for (const item of visible) drawItem(ctx, item)
  if (state.hover && visible.includes(state.hover))
    drawOutline(ctx, state.hover, '#8ea8ff', 1.2)
  if (state.selected) drawOutline(ctx, state.selected, '#d7a642', 2)

  updateHud()
  updateMinimap()
}

function drawWorldGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  const spacing = Math.max(80, state.viewport.zoom * 512)
  const origin = worldToScreen({ x: 0, y: 0 })
  ctx.strokeStyle = 'rgba(215, 166, 66, 0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = origin.x % spacing; x < width; x += spacing) {
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
  }
  for (let y = origin.y % spacing; y < height; y += spacing) {
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
  }
  ctx.stroke()
}

function drawItem(ctx: CanvasRenderingContext2D, item: DesktopItem): void {
  const r = worldRectToScreen(item.bounds)
  if (r.width < 1 || r.height < 1) return

  ctx.save()
  ctx.beginPath()
  ctx.rect(r.x, r.y, r.width, r.height)
  ctx.clip()

  ctx.fillStyle = '#151710'
  ctx.fillRect(r.x, r.y, r.width, r.height)

  const cached = state.previewCache.get(item.id)
  if (cached?.bitmap) {
    cached.lastUsed = performance.now()
    drawImageContain(ctx, cached.bitmap, r.x, r.y, r.width, r.height)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.22)'
    ctx.fillRect(r.x, r.y, r.width, r.height)
  } else {
    drawPlaceholder(ctx, r)
  }

  if (r.width > 74 && r.height > 50) {
    ctx.fillStyle = 'rgba(5, 6, 4, 0.72)'
    ctx.fillRect(r.x, r.y + r.height - 28, r.width, 28)
    ctx.fillStyle = '#f0eee2'
    ctx.font = '12px Avenir Next, Gill Sans, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      item.label,
      r.x + 9,
      r.y + r.height - 14,
      Math.max(24, r.width - 18),
    )
  }

  ctx.restore()
  ctx.strokeStyle = 'rgba(240, 238, 226, 0.13)'
  ctx.lineWidth = 1
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width - 1, r.height - 1)
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, r: WorldRect): void {
  ctx.fillStyle = '#151710'
  ctx.fillRect(r.x, r.y, r.width, r.height)
  ctx.strokeStyle = 'rgba(115, 198, 155, 0.16)'
  ctx.lineWidth = 1
  const step = Math.max(10, Math.min(r.width, r.height) / 5)
  ctx.beginPath()
  for (let x = r.x; x < r.x + r.width; x += step) {
    ctx.moveTo(x, r.y)
    ctx.lineTo(x + r.height, r.y + r.height)
  }
  ctx.stroke()
}

function drawOutline(
  ctx: CanvasRenderingContext2D,
  item: DesktopItem,
  color: string,
  width: number,
): void {
  const r = worldRectToScreen(item.bounds)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.strokeRect(
    r.x + width / 2,
    r.y + width / 2,
    r.width - width,
    r.height - width,
  )
}

function drawImageContain(
  ctx: CanvasRenderingContext2D,
  image: ImageBitmap | HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const imageAspect = image.width / image.height
  const rectAspect = w / h
  let drawW = w
  let drawH = h
  if (imageAspect > rectAspect) {
    drawH = w / imageAspect
  } else {
    drawW = h * imageAspect
  }
  const dx = x + (w - drawW) / 2
  const dy = y + (h - drawH) / 2
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, dx, dy, drawW, drawH)
}

function getVisibleItems(marginRatio = 0): DesktopItem[] {
  const bounds = getViewportWorldBounds(marginRatio)
  return state.items
    .filter((item) => rectsIntersect(bounds, item.bounds))
    .sort((a, b) => priorityScore(a) - priorityScore(b))
}

function schedulePreviewLoads(visible: DesktopItem[]): void {
  const wanted = new Set(visible.slice(0, PREVIEW_LIMIT).map((item) => item.id))
  for (const [id, job] of state.previewJobs) {
    if (!wanted.has(id)) {
      job.controller.abort()
      state.previewJobs.delete(id)
    }
  }

  const openSlots = PREVIEW_CONCURRENCY - state.previewJobs.size
  if (openSlots <= 0) return

  const candidates = visible.filter(
    (item) =>
      wanted.has(item.id) &&
      !state.previewCache.has(item.id) &&
      !state.previewJobs.has(item.id) &&
      !state.failedPreviews.has(item.id),
  )

  for (const item of candidates.slice(0, openSlots)) {
    void loadPreview(item)
  }
  prunePreviewCache(wanted)
}

async function loadPreview(item: DesktopItem): Promise<void> {
  const controller = new AbortController()
  state.previewJobs.set(item.id, { controller })
  try {
    const response = await fetch(item.preview.image, {
      signal: controller.signal,
    })
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText}`)
    const blob = await response.blob()
    const bitmap = await makeBitmap(blob)
    state.previewCache.set(item.id, { bitmap, lastUsed: performance.now() })
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      console.warn(`Preview failed for ${item.id}:`, err)
      state.failedPreviews.add(item.id)
    }
  } finally {
    state.previewJobs.delete(item.id)
    requestDraw()
  }
}

function prunePreviewCache(wanted: Set<string>): void {
  if (state.previewCache.size <= PREVIEW_LIMIT) return
  const entries = [...state.previewCache.entries()]
    .filter(([id]) => id !== state.selected?.id && !wanted.has(id))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  while (state.previewCache.size > PREVIEW_LIMIT && entries.length > 0) {
    const entry = entries.shift()
    if (!entry) break
    const [id, value] = entry
    if (value.bitmap instanceof ImageBitmap) value.bitmap.close()
    state.previewCache.delete(id)
  }
}

async function makeBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) return createImageBitmap(blob)
  const image = new Image()
  image.decoding = 'async'
  image.src = URL.createObjectURL(blob)
  await image.decode()
  return image
}

function onPointerDown(event: PointerEvent): void {
  els.canvas.setPointerCapture(event.pointerId)
  els.canvas.classList.add('dragging')
  state.drag = {
    id: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
    moved: 0,
  }
}

function onPointerMove(event: PointerEvent): void {
  const point = eventPoint(event)
  const hover = hitTest(point)
  if (hover !== state.hover) {
    state.hover = hover
    requestDraw()
  }

  if (!state.drag || state.drag.id !== event.pointerId) return
  const dx = event.clientX - state.drag.lastX
  const dy = event.clientY - state.drag.lastY
  state.drag.lastX = event.clientX
  state.drag.lastY = event.clientY
  state.drag.moved += Math.abs(dx) + Math.abs(dy)
  state.viewport.centerX -= dx / state.viewport.zoom
  state.viewport.centerY -= dy / state.viewport.zoom
  onViewportChanged()
}

function onPointerUp(event: PointerEvent): void {
  if (!state.drag || state.drag.id !== event.pointerId) return
  els.canvas.classList.remove('dragging')
  const moved = state.drag.moved
  state.drag = null
  if (moved < 5) {
    const item = hitTest(eventPoint(event))
    if (item) selectItem(item, { loadVolume: true })
  }
}

function onDoubleClick(event: MouseEvent): void {
  const item = hitTest(eventPoint(event))
  if (item) selectItem(item, { zoom: true, loadVolume: true })
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  const point = eventPoint(event)
  const before = screenToWorld(point)
  const factor = Math.exp(-event.deltaY * 0.0014)
  state.viewport.zoom = clamp(state.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  state.viewport.centerX =
    before.x - (point.x - els.canvas.clientWidth / 2) / state.viewport.zoom
  state.viewport.centerY =
    before.y - (point.y - els.canvas.clientHeight / 2) / state.viewport.zoom
  onViewportChanged()
}

function zoomAtCenter(factor: number): void {
  state.viewport.zoom = clamp(state.viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM)
  onViewportChanged()
}

function onViewportChanged(): void {
  updateSelectedLod()
  queueFocusVolumeLoad(false)
  requestDraw()
}

function selectItem(
  item: DesktopItem,
  options: { zoom?: boolean; loadVolume?: boolean } = {},
): void {
  state.selected = item
  if (options.zoom) zoomToItem(item)
  updateInspector()
  renderVolumeList()
  requestDraw()
  if (options.loadVolume) queueFocusVolumeLoad(true)
}

function zoomToItem(item: DesktopItem): void {
  const rect = els.canvas.getBoundingClientRect()
  const targetZoom =
    Math.min(rect.width / item.bounds.width, rect.height / item.bounds.height) *
    0.82
  state.viewport.centerX = item.bounds.x + item.bounds.width / 2
  state.viewport.centerY = item.bounds.y + item.bounds.height / 2
  state.viewport.zoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)
  onViewportChanged()
}

function updateInspector(): void {
  const item = state.selected
  if (!item) return
  els.focusTitle.textContent = item.label
  els.focusShape.textContent = (item.shape ?? []).join(' x ')
  els.focusSpacing.textContent = (item.spacing ?? [])
    .map(formatNumber)
    .join(' x ')
  els.focusDtype.textContent = item.dtype ?? '-'
  els.manifestLink.href = item.manifest
  els.rawLink.href = item.levels?.[0]?.raw ?? item.metadata
  renderLevelStrip()

  const maxSlice = Math.max(0, (item.shape?.[2] ?? 1) - 1)
  els.sliceSlider.max = String(maxSlice)
  els.sliceSlider.value = String(Math.min(item.preview.slice ?? 0, maxSlice))
  updateSlicePreview()
  updateSelectedLod()
}

function renderLevelStrip(): void {
  els.levelStrip.textContent = ''
  const chosen = state.selected ? chooseVolumeLevel(state.selected) : null
  for (const level of state.selected?.levels ?? []) {
    const pill = document.createElement('span')
    pill.className = 'level-pill'
    if (chosen?.level === level.level) pill.classList.add('active')
    pill.textContent = `L${level.level} ${level.shape?.join('x') ?? ''}`
    els.levelStrip.appendChild(pill)
  }
}

function updateSlicePreview(): void {
  const item = state.selected
  if (!item) return
  const slice = Number(els.sliceSlider.value)
  const encoded = encodeURIComponent(item.id)
  els.slicePreview.src = `/iiif/image/${encoded}/axial/${slice}/full/320,/0/default.png`
}

function updateSelectedLod(): void {
  if (!state.selected) return
  const level = chooseVolumeLevel(state.selected)
  const screen = worldRectToScreen(state.selected.bounds)
  els.focusLod.textContent = `L${level.level}`
  els.focusLevel.textContent = `${level.level} (${Math.round(screen.width)} px)`
  renderLevelStrip()
}

function chooseVolumeLevel(item: DesktopItem): LevelEntry {
  const levels = (item.levels ?? []).filter((level) => level.ready !== false)
  if (levels.length === 0) {
    return {
      level: 0,
      shape: item.shape,
      raw: item.raw,
    }
  }

  const nativeWidth = Math.max(1, item.shape?.[0] ?? 1)
  const nativePixels = (item.bounds.width * state.viewport.zoom) / nativeWidth
  const coarseToFine = levels.slice().sort((a, b) => b.level - a.level)
  for (const level of coarseToFine) {
    const factor = 2 ** level.level
    if (nativePixels * factor <= 1.35) return level
  }
  const zeroLevel = levels.find((level) => level.level === 0)
  return zeroLevel ?? (levels[0] as LevelEntry)
}

function queueFocusVolumeLoad(force: boolean): void {
  if (!state.selected) return
  const level = chooseVolumeLevel(state.selected)
  const key = `${state.selected.id}:L${level.level}:${els.colormap.value}`
  if (
    !force &&
    (state.volume.currentKey === key || state.volume.loadingKey === key)
  )
    return
  if (state.focusTimer !== null) clearTimeout(state.focusTimer)
  state.focusTimer = setTimeout(() => {
    void loadFocusVolume(level, key)
  }, FOCUS_LOAD_DELAY_MS)
}

async function loadFocusVolume(level: LevelEntry, key: string): Promise<void> {
  if (!state.selected || !level?.raw) return
  const requestId = ++state.volume.requestId
  const hadRenderedVolume = Boolean(state.volume.currentKey && state.volume.nv)
  state.volume.loadingKey = key
  setFocusLoadingStatus(
    `Loading ${state.selected.id} L${level.level}`,
    hadRenderedVolume,
  )
  try {
    const nv = await ensureVolumeRenderer()
    if (!nv) {
      state.volume.loadingKey = ''
      clearFocusLoadingStatus()
      return
    }
    if (requestId !== state.volume.requestId) return
    const hasCanvasSize = await waitForVolumeCanvasSize()
    if (!hasCanvasSize) {
      throw new Error(
        'Volume canvas has no visible size. Widen the window or open the inspector pane.',
      )
    }
    nv.sliceType = 4
    setFocusLoadingStatus(
      `Fetching ${state.selected.id} L${level.level}`,
      hadRenderedVolume,
    )
    await withTimeout(
      nv.loadVolumes([
        {
          url: level.raw,
          name: key,
          colormap: els.colormap.value || 'Gray',
        },
      ]),
      VOLUME_LOAD_TIMEOUT_MS,
      `Timed out loading ${state.selected.id} L${level.level}`,
    )
    if (requestId !== state.volume.requestId) return
    resizeVolumeRenderer()
    state.volume.currentKey = key
    state.volume.loadingKey = ''
    clearFocusLoadingStatus()
    els.volumePane?.classList.add('volume-ready')
    els.volumeFallback.hidden = true
    updateSelectedLod()
  } catch (err) {
    if (requestId !== state.volume.requestId) return
    console.error(err)
    state.volume.loadingKey = ''
    clearFocusLoadingStatus()
    const message = err instanceof Error ? err.message : 'Volume load failed'
    if (hadRenderedVolume) {
      els.volumePane?.classList.add('volume-ready')
      els.volumeFallback.hidden = true
      els.focusLod.textContent = 'load failed'
    } else {
      els.volumePane?.classList.remove('volume-ready')
      els.volumeFallback.hidden = false
      els.volumeFallback.textContent = message
    }
  }
}

function setFocusLoadingStatus(
  message: string,
  keepCurrentRender: boolean,
): void {
  if (keepCurrentRender) {
    els.volumePane?.classList.add('volume-loading')
    if (els.volumePane) els.volumePane.dataset.status = message
    els.volumeFallback.hidden = true
    els.focusLod.textContent = 'streaming'
    return
  }
  els.volumePane?.classList.remove('volume-ready')
  els.volumeFallback.hidden = false
  setVolumeStatus(message)
}

function clearFocusLoadingStatus(): void {
  els.volumePane?.classList.remove('volume-loading')
  if (els.volumePane) delete els.volumePane.dataset.status
}

async function ensureVolumeRenderer(): Promise<NiiVueLike | null> {
  if (state.volume.nv) return state.volume.nv
  if (state.volume.rendererTried && state.volume.rendererError) {
    els.volumeFallback.hidden = false
    els.volumeFallback.textContent = `niivue unavailable: ${state.volume.rendererError.message}`
    return null
  }
  state.volume.rendererTried = true
  try {
    const nv = new NiiVue({
      backgroundColor: [0, 0, 0, 1],
      isColorbarVisible: false,
      isDragDropEnabled: false,
      isInteractionEnabled: true,
      is3DCrosshairVisible: false,
      showBoundsBorder: false,
      sliceType: 4,
      azimuth: 120,
      elevation: 20,
    }) as unknown as NiiVueLike
    // mono niivue's constructor copies isInteractionEnabled into opts. Set
    // explicitly anyway so the value can't be invalidated later if a future
    // refactor toggles the field.
    nv.opts.isInteractionEnabled = true
    nv.opts.isDragDropEnabled = false
    nv.addEventListener('volumeLoaded', () => {
      if (state.volume.loadingKey) {
        setVolumeStatus('Decoded volume; uploading texture')
      }
    })
    await waitForVolumeCanvasSize()
    await nv.attachToCanvas(els.volumeCanvas)
    syncVolumeCanvasReference(nv)
    resizeVolumeRenderer(nv)
    state.volume.nv = nv
    return nv
  } catch (err) {
    state.volume.rendererError =
      err instanceof Error ? err : new Error(String(err))
    els.volumeFallback.hidden = false
    els.volumeFallback.textContent = `niivue unavailable: ${state.volume.rendererError.message}`
    return null
  }
}

function setVolumeStatus(message: string): void {
  els.volumeFallback.hidden = false
  els.volumeFallback.textContent = message
}

function resizeVolumeRenderer(nv: NiiVueLike | null = state.volume.nv): void {
  if (!nv) return
  syncVolumeCanvasReference(nv)
  nv.resize?.()
  nv.drawScene()
}

async function waitForVolumeCanvasSize(): Promise<boolean> {
  for (let i = 0; i < 8; i++) {
    const rect = els.volumeCanvas.getBoundingClientRect()
    if (rect.width >= 16 && rect.height >= 16) {
      resizeCanvas()
      return true
    }
    await nextFrame()
  }
  return false
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve())
  })
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId)
  })
}

function renderVolumeList(): void {
  const q = els.volumeFilter.value.trim().toLowerCase()
  const matches = state.items.filter((item) =>
    item.id.toLowerCase().includes(q),
  )
  els.volumeList.textContent = ''
  const frag = document.createDocumentFragment()
  for (const item of matches.slice(0, 400)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'volume-row'
    if (item.id === state.selected?.id) button.classList.add('active')
    button.dataset.id = item.id

    const label = document.createElement('span')
    const strong = document.createElement('strong')
    strong.textContent = item.label
    const small = document.createElement('small')
    small.textContent = `${item.shape?.join(' x ') ?? ''} - ${item.dtype}`
    label.append(strong, small)

    const level = document.createElement('em')
    level.textContent = `${item.levels?.length ?? 1} LOD`
    button.append(label, level)
    frag.appendChild(button)
  }
  els.volumeList.appendChild(frag)
}

function updateHud(): void {
  els.hudZoom.textContent = `zoom ${state.viewport.zoom.toFixed(2)}x`
  els.hudVisible.textContent = `${state.visibleItems.length} visible`
  els.hudQueue.textContent = `${state.previewJobs.size} loading`
  els.hudCache.textContent = `${state.previewCache.size} cached`
}

function updateMinimap(): void {
  const world = state.manifest?.world
  if (!world) return
  const bounds = getViewportWorldBounds(0)
  const left = clamp((bounds.x / world.width) * 100, 0, 100)
  const top = clamp((bounds.y / world.height) * 100, 0, 100)
  const width = clamp((bounds.width / world.width) * 100, 2, 100)
  const height = clamp((bounds.height / world.height) * 100, 2, 100)
  els.minimapViewport.style.left = `${left}%`
  els.minimapViewport.style.top = `${top}%`
  els.minimapViewport.style.width = `${width}%`
  els.minimapViewport.style.height = `${height}%`
}

function priorityScore(item: DesktopItem): number {
  const screen = worldRectToScreen(item.bounds)
  const cx = screen.x + screen.width / 2
  const cy = screen.y + screen.height / 2
  const dx = cx - els.canvas.clientWidth / 2
  const dy = cy - els.canvas.clientHeight / 2
  const selectedBoost = item.id === state.selected?.id ? -1_000_000 : 0
  return (
    selectedBoost + Math.hypot(dx, dy) - screen.width * screen.height * 0.0001
  )
}

function hitTest(point: { x: number; y: number }): DesktopItem | null {
  const world = screenToWorld(point)
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i]
    if (!item) continue
    const b = item.bounds
    if (
      world.x >= b.x &&
      world.x <= b.x + b.width &&
      world.y >= b.y &&
      world.y <= b.y + b.height
    ) {
      return item
    }
  }
  return null
}

function eventPoint(event: MouseEvent): { x: number; y: number } {
  const rect = els.canvas.getBoundingClientRect()
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }
}

function screenToWorld(point: { x: number; y: number }): {
  x: number
  y: number
} {
  return {
    x:
      state.viewport.centerX +
      (point.x - els.canvas.clientWidth / 2) / state.viewport.zoom,
    y:
      state.viewport.centerY +
      (point.y - els.canvas.clientHeight / 2) / state.viewport.zoom,
  }
}

function worldToScreen(point: { x: number; y: number }): {
  x: number
  y: number
} {
  return {
    x:
      (point.x - state.viewport.centerX) * state.viewport.zoom +
      els.canvas.clientWidth / 2,
    y:
      (point.y - state.viewport.centerY) * state.viewport.zoom +
      els.canvas.clientHeight / 2,
  }
}

function worldRectToScreen(rect: WorldRect): WorldRect {
  const p = worldToScreen({ x: rect.x, y: rect.y })
  return {
    x: p.x,
    y: p.y,
    width: rect.width * state.viewport.zoom,
    height: rect.height * state.viewport.zoom,
  }
}

function getViewportWorldBounds(marginRatio: number): WorldRect {
  const marginX = (els.canvas.clientWidth / state.viewport.zoom) * marginRatio
  const marginY = (els.canvas.clientHeight / state.viewport.zoom) * marginRatio
  return {
    x:
      state.viewport.centerX -
      els.canvas.clientWidth / (2 * state.viewport.zoom) -
      marginX,
    y:
      state.viewport.centerY -
      els.canvas.clientHeight / (2 * state.viewport.zoom) -
      marginY,
    width: els.canvas.clientWidth / state.viewport.zoom + marginX * 2,
    height: els.canvas.clientHeight / state.viewport.zoom + marginY * 2,
  }
}

function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json, application/ld+json' },
  })
  if (!response.ok) {
    throw new Error(
      `Could not load manifest ${url}: HTTP ${response.status} ${response.statusText}`,
    )
  }
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse manifest ${url} as JSON: ${message}`)
  }
}

function formatNumber(n: number): string {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(2) : String(n)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
