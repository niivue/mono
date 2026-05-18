// Demo viewer for the IIIF Volumetric Server.
//
// Modes:
//   1. "single"   — fetch the per-volume manifest, find its Scene's
//                   single Model annotation, load the raw NIfTI URL
//                   into niivue.
//   2. "exploded" — fetch the exploded manifest, read its `rendering`
//                   link to the composite NIfTI, load that. The
//                   manifest also lists one Annotation per cell so
//                   the user can introspect the structure.
//
// Slice panes always render the *single* manifest's Image API service
// — this is intentional, the IIIF Image API endpoint serves slices of
// the original volume, not the exploded composite.

import NiiVue from '@niivue/niivue/webgl2'

import { installNav } from './nav'

installNav()

type Axis = 'axial' | 'coronal' | 'sagittal'

interface VolumeLevel {
  level: number
  shape: [number, number, number]
}

interface VolumeApiEntry {
  id: string
  format: string
  shape: [number, number, number]
  dtype: string
  levels?: VolumeLevel[]
}

interface ApiResponse {
  volumes?: VolumeApiEntry[]
}

interface LanguageMap {
  en?: string[]
}

interface ManifestMetadataItem {
  label?: LanguageMap
  value?: LanguageMap
}

interface ManifestCanvas {
  type: string
  metadata?: ManifestMetadataItem[]
}

interface ManifestScene {
  type: 'Scene'
  items?: Array<{ items?: Array<{ body?: AnnotationBody }> }>
}

interface ChoiceItem {
  id: string
  type?: string
  'https://example.org/iiif/volumetric#'?: {
    shape?: [number, number, number]
    spacing?: [number, number, number]
  }
}

interface AnnotationBody {
  id?: string
  type: string
  items?: ChoiceItem[]
}

interface Manifest {
  items: Array<ManifestScene | ManifestCanvas>
}

interface ExplodedManifest {
  rendering?: Array<{ id: string; format: string }>
}

interface ExplodedPlan {
  cellCount: number
  cellShape: [number, number, number]
  compositeShape: [number, number, number]
}

interface LevelHint {
  url: string
  shape?: [number, number, number]
  spacing?: [number, number, number]
}

interface LoadVolumeOpts {
  url: string
  colormap: string
  levels: LevelHint[]
  calMin?: number
  calMax?: number
}

interface RenderDrag {
  id: number
  lastX: number
  lastY: number
}

interface ViewerState {
  baseUrl: string
  volumes: VolumeApiEntry[]
  current: VolumeApiEntry | null
  manifest: Manifest | null
  explodedManifest: ExplodedManifest | null
  axes: Axis[]
  nv: NiiVue | null
  mode: 'single' | 'exploded'
  renderDrag: RenderDrag | null
}

const state: ViewerState = {
  baseUrl: window.location.origin,
  volumes: [],
  current: null,
  manifest: null,
  explodedManifest: null,
  axes: ['axial', 'coronal', 'sagittal'],
  nv: null,
  mode: 'exploded',
  renderDrag: null,
}

;(window as unknown as { __viewerState: ViewerState }).__viewerState = state

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  vols: el<HTMLDivElement>('vols'),
  manifestUrl: el<HTMLInputElement>('manifestUrl'),
  colormap: el<HTMLSelectElement>('colormap'),
  windowInput: el<HTMLInputElement>('window'),
  resLevel: el<HTMLSelectElement>('resLevel'),
  apiPill: el<HTMLSpanElement>('apiPill'),
  niivuePill: el<HTMLSpanElement>('niivuePill'),
  renderPane: el<HTMLDivElement>('pane-3d'),
  fallback: el<HTMLDivElement>('nv-fallback'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  explodedToggle: el<HTMLInputElement>('explodedToggle'),
  explodeNx: el<HTMLInputElement>('explodeNx'),
  explodeNy: el<HTMLInputElement>('explodeNy'),
  explodeNz: el<HTMLInputElement>('explodeNz'),
  explodeEx: el<HTMLInputElement>('explodeEx'),
  explodeEy: el<HTMLInputElement>('explodeEy'),
  explodeEz: el<HTMLInputElement>('explodeEz'),
  explodePlan: el<HTMLDivElement>('explodePlan'),
}

const urlParams = new URLSearchParams(window.location.search)
const modeParam = urlParams.get('mode')
if (modeParam === 'exploded') {
  els.explodedToggle.checked = true
} else if (modeParam === 'single') {
  els.explodedToggle.checked = false
}

main().catch((err: unknown) => {
  console.error(err)
})

async function main(): Promise<void> {
  const res = await fetch('/api')
  const api = (await res.json()) as ApiResponse
  state.volumes = api.volumes ?? []
  els.apiPill.textContent = `API · ${state.volumes.length} volume(s)`
  els.apiPill.classList.add('green')
  renderVolList()
  if (state.volumes.length > 0) {
    const first = state.volumes[0]
    if (first) await selectVolume(first.id)
  }
  setupControls()
  setupRenderPaneEvents()
}

function renderVolList(): void {
  els.vols.innerHTML = ''
  if (state.volumes.length === 0) {
    els.vols.innerHTML =
      '<div class="empty">No volumes loaded.<br/>Drop a NIfTI file into <code>fixtures/</code> and restart.</div>'
    return
  }
  for (const v of state.volumes) {
    const div = document.createElement('div')
    div.className = 'vol-item'
    div.dataset.id = v.id
    div.innerHTML = `<strong>${v.id}</strong><small>${v.format} · ${v.shape.join('×')} · ${v.dtype}</small>`
    div.addEventListener('click', () => {
      void selectVolume(v.id)
    })
    els.vols.appendChild(div)
  }
}

async function selectVolume(id: string): Promise<void> {
  const found = state.volumes.find((v) => v.id === id)
  if (!found) return
  state.current = found
  for (const node of els.vols.querySelectorAll<HTMLElement>('.vol-item')) {
    node.classList.toggle('active', node.dataset.id === id)
  }

  els.resLevel.innerHTML = '<option value="0">Full (Native)</option>'
  if (found.levels && found.levels.length > 1) {
    for (const l of found.levels) {
      if (l.level === 0) continue
      const opt = document.createElement('option')
      opt.value = String(l.level)
      opt.textContent = `Level ${l.level} (${l.shape.join('×')})`
      els.resLevel.appendChild(opt)
    }
  }

  const singleManifestUrl = `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/manifest`
  const mres = await fetch(singleManifestUrl)
  state.manifest = (await mres.json()) as Manifest
  setupSliceUi()
  await refreshManifestForMode()
}

function isCanvas(
  item: ManifestScene | ManifestCanvas,
): item is ManifestCanvas {
  return item.type === 'Canvas'
}

function setupSliceUi(): void {
  const m = state.manifest
  if (!m) return
  for (const axis of state.axes) {
    const canvas = m.items.find(
      (it): it is ManifestCanvas =>
        isCanvas(it) &&
        Array.isArray(it.metadata) &&
        it.metadata.some(
          (md) =>
            md.label?.en?.[0] === 'Slice axis' && md.value?.en?.[0] === axis,
        ),
    )
    const sliceCount = canvas
      ? Number(
          canvas.metadata?.find((md) => md.label?.en?.[0] === 'Slice count')
            ?.value?.en?.[0],
        )
      : 0
    const range = el<HTMLInputElement>(`slice-${axis}`)
    range.max = String(Math.max(0, sliceCount - 1))
    range.value = String(Math.floor(sliceCount / 2))
    range.oninput = (): void => {
      updateSlice(axis)
    }
    updateSlice(axis)
  }
}

function updateSlice(axis: Axis): void {
  const range = el<HTMLInputElement>(`slice-${axis}`)
  const val = Number(range.value)
  el(`slice-${axis}-val`).textContent = String(val)
  const id = state.current?.id
  if (!id) return
  const url = `${state.baseUrl}/iiif/image/${encodeURIComponent(id)}/${axis}/${val}/full/max/0/default.png`
  el<HTMLImageElement>(`img-${axis}`).src = url
}

async function refreshManifestForMode(): Promise<void> {
  const id = state.current?.id
  if (!id) return
  const exploded = els.explodedToggle.checked
  state.mode = exploded ? 'exploded' : 'single'

  let url: string | undefined
  let displayedManifestUrl: string
  let summary = ''
  let levels: LevelHint[] = []
  if (exploded) {
    const level = Number(els.resLevel.value)
    const qs = new URLSearchParams({
      nx: els.explodeNx.value,
      ny: els.explodeNy.value,
      nz: els.explodeNz.value,
      ex: els.explodeEx.value,
      ey: els.explodeEy.value,
      ez: els.explodeEz.value,
    })
    if (level > 0) qs.set('level', String(level))
    displayedManifestUrl = `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/exploded/manifest?${qs.toString()}`
    // The /exploded/manifest defaults to a per-cell view with no composite
    // rendering link; this viewer composes the dense buffer, so opt in.
    const fetchQs = new URLSearchParams(qs)
    fetchQs.set('composite', '1')
    const emres = await fetch(
      `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/exploded/manifest?${fetchQs.toString()}`,
    )
    state.explodedManifest = (await emres.json()) as ExplodedManifest
    const composite = (state.explodedManifest.rendering ?? []).find(
      (r) => r.format === 'application/x.nifti',
    )
    if (!composite) {
      showFallback('Exploded manifest has no composite NIfTI rendering link.')
      return
    }
    url = composite.id
    const pres = await fetch(
      `${state.baseUrl}/volumes/${encodeURIComponent(id)}/exploded/plan?${qs.toString()}`,
    )
    const plan = (await pres.json()) as ExplodedPlan
    summary = `${plan.cellCount} cells · cell ${plan.cellShape.join(
      '×',
    )} · composite ${plan.compositeShape.join('×')}`
  } else {
    displayedManifestUrl = `${state.baseUrl}/iiif/presentation/${encodeURIComponent(id)}/manifest`
    const scene = state.manifest?.items.find(
      (it): it is ManifestScene => it.type === 'Scene',
    )
    if (!scene) {
      showFallback('Manifest has no Scene.')
      return
    }
    const ann = scene.items?.[0]?.items?.[0]
    let body: AnnotationBody | undefined = ann?.body
    if (!body) {
      showFallback('Manifest scene has no annotation body.')
      return
    }

    if (body.type === 'Choice' && body.items) {
      levels = body.items.map((it) => {
        const hints = it['https://example.org/iiif/volumetric#'] ?? {}
        return { url: it.id, shape: hints.shape, spacing: hints.spacing }
      })

      const level = Number(els.resLevel.value)
      const targetId = level === 0 ? '/raw' : `level=${level}`
      const match = body.items.find((it) => it.id.includes(targetId))
      const picked = match ?? body.items[0]
      body = picked
        ? { id: picked.id, type: picked.type ?? 'Model' }
        : undefined
    }

    if (!body || body.type !== 'Model' || !body.id) {
      showFallback('Manifest scene has no Model annotation body.')
      return
    }
    url = body.id
  }

  els.manifestUrl.value = displayedManifestUrl
  els.explodePlan.textContent = summary

  await ensureNiivue()
  if (!state.nv || !url) return

  try {
    const colormap = els.colormap.value || 'Gray'
    const win = parseWindow(els.windowInput.value)
    const opts: LoadVolumeOpts = { url, colormap, levels }
    if (win) {
      opts.calMin = win.min
      opts.calMax = win.max
    }
    await state.nv.loadVolumes([opts])
    state.nv.sliceType = 4
    showRenderCanvas()
  } catch (err) {
    console.error(err)
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(`niivue failed to load the volume: ${msg}`)
  }
}

async function ensureNiivue(): Promise<void> {
  if (state.nv) return
  try {
    state.nv = new NiiVue({
      backgroundColor: [0, 0, 0, 1],
      isColorbarVisible: true,
      isDragDropEnabled: false,
    })
    state.nv.opts.isDragDropEnabled = false
    await state.nv.attachToCanvas(els.canvas)
    els.niivuePill.textContent = 'niivue · ready'
    els.niivuePill.classList.add('green')
  } catch (err) {
    console.warn('niivue failed to load:', err)
    els.niivuePill.textContent = 'niivue · unavailable'
    els.niivuePill.classList.add('red')
    const msg = err instanceof Error ? err.message : String(err)
    showFallback(`niivue failed to initialise: ${msg}`)
  }
}

function showFallback(msg: string): void {
  els.fallback.hidden = false
  els.fallback.textContent = msg
  els.canvas.style.display = 'none'
  els.renderPane.classList.remove('render-ready', 'render-dragging')
}

function showRenderCanvas(): void {
  els.fallback.hidden = true
  els.fallback.textContent = ''
  els.canvas.style.display = 'block'
  els.renderPane.classList.add('render-ready')
}

function parseWindow(s: string): { min: number; max: number } | null {
  if (!s) return null
  const parts = s.split(',').map((n) => Number(n))
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null
  const [min, max] = parts as [number, number]
  return { min, max }
}

function setupControls(): void {
  const reload = (): void => {
    if (state.current) void refreshManifestForMode()
  }
  els.colormap.addEventListener('change', reload)
  els.windowInput.addEventListener('change', reload)
  els.resLevel.addEventListener('change', reload)
  els.explodedToggle.addEventListener('change', reload)

  for (const axis of ['Ex', 'Ey', 'Ez'] as const) {
    const inputEl = els[`explode${axis}`]
    const valEl = el(`val${axis}`)
    inputEl.addEventListener('input', () => {
      valEl.textContent = inputEl.value
    })
    inputEl.addEventListener('change', reload)
  }

  for (const inputEl of [els.explodeNx, els.explodeNy, els.explodeNz]) {
    inputEl.addEventListener('change', reload)
  }
}

function setupRenderPaneEvents(): void {
  els.canvas.addEventListener('pointerdown', onRenderPointerDown, true)
  els.canvas.addEventListener('pointermove', onRenderPointerMove, true)
  els.canvas.addEventListener('pointerup', onRenderPointerUp, true)
  els.canvas.addEventListener('pointercancel', onRenderPointerUp, true)
  els.canvas.addEventListener('wheel', onRenderWheel, {
    passive: false,
    capture: true,
  })
  els.canvas.addEventListener('contextmenu', consumeRenderEvent, true)
}

function onRenderPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !renderIsReady()) return
  consumeRenderEvent(event)
  els.canvas.focus({ preventScroll: true })
  els.canvas.setPointerCapture(event.pointerId)
  state.renderDrag = {
    id: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  }
  els.renderPane.classList.add('render-dragging')
}

function onRenderPointerMove(event: PointerEvent): void {
  if (!state.renderDrag || state.renderDrag.id !== event.pointerId) return
  consumeRenderEvent(event)
  const dx = event.clientX - state.renderDrag.lastX
  const dy = event.clientY - state.renderDrag.lastY
  state.renderDrag.lastX = event.clientX
  state.renderDrag.lastY = event.clientY
  rotateRenderVolume(dx, dy)
}

function onRenderPointerUp(event: PointerEvent): void {
  if (!state.renderDrag || state.renderDrag.id !== event.pointerId) return
  consumeRenderEvent(event)
  try {
    els.canvas.releasePointerCapture(event.pointerId)
  } catch (_) {
    // Pointer capture may already be released after browser cancellation.
  }
  state.renderDrag = null
  els.renderPane.classList.remove('render-dragging')
}

function onRenderWheel(event: WheelEvent): void {
  if (!renderIsReady()) return
  consumeRenderEvent(event)
  const nv = state.nv
  if (!nv) return
  const next = nv.scaleMultiplier * Math.exp(-event.deltaY * 0.0014)
  nv.scaleMultiplier = clamp(next, 0.05, 500)
  nv.drawScene()
}

function rotateRenderVolume(dx: number, dy: number): void {
  const nv = state.nv
  if (!nv) return
  const sensitivity = 0.5
  nv.azimuth = (nv.azimuth + dx * sensitivity + 360) % 360
  nv.elevation = clamp(nv.elevation + dy * sensitivity, -90, 90)
  nv.drawScene()
}

function renderIsReady(): boolean {
  return Boolean(state.nv && els.renderPane.classList.contains('render-ready'))
}

function consumeRenderEvent(event: Event): void {
  event.preventDefault()
  event.stopImmediatePropagation()
  event.stopPropagation()
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
