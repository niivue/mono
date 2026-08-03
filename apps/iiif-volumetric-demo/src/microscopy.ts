// Microscopy hub — every microscopy source the volumetric server exposes,
// in one page.
//
// The server registers ONE entry per channel of a multi-channel source, all
// sharing a `dataset` key (see registry.ts). That keeps the server's volume
// handles 3D/single-channel, and lets this page rebuild a dataset by grouping
// on `dataset` — string-munging the ids would not work, because a channel name
// may itself contain the separator.
//
// Sources too large to load whole (the FIB-SEM OME-Zarr, the WSI slide) are
// listed with a link to the page that streams them, so this page is still the
// index of the microscopy demos rather than a subset of them.

import NiiVue from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()

// 16 is the tagged-structure count of an Allen IMSC dataset, and the reference
// viewer at imsc.allencell.org shows all of them at once — so the cap is set to
// display a whole dataset, not a sample of it. It is a cost ceiling, not a
// legibility one: niivue blends stacked overlays additively (premultiplied
// color, max alpha), which is the right merge for sparse fluorescence channels
// and stays readable well past a handful. What does scale with channel count is
// one fetch and one oriented RGBA volume each. WebGPU combines them in a compute
// pass; WebGL2 still reads each one back and blends on the CPU, so a full
// 16-channel stack is noticeably slower there.
const MAX_CHANNELS = 16
const DEFAULT_CHANNELS = 2

// Whole-volume load budget. Bigger sources belong on the streaming pages, which
// fetch a level/region at a time instead of the entire array.
const MAX_WHOLE_VOLUME_VOXELS = 64_000_000

// Distinct hues so stacked channels stay separable, one per channel of a full
// 16-structure Allen dataset before the list repeats. Ordered so the common
// two- and three-channel picks land on the most separable pairs first.
const CHANNEL_COLORMAPS = [
  'green',
  'red',
  'blue',
  'violet',
  'gold',
  'electric_blue',
  'warm',
  'cool',
  'gray',
  'bluegrn',
  'copper',
  'green2cyan',
  'winter',
  'blue2magenta',
  'redyell',
  'bronze',
]

// The registry reports spacing in the source's own units and does not carry a
// unit field, so the unit is per format: the Allen sidecar is microns, NIfTI is
// millimetres by definition, OME-Zarr axes are usually metres.
const SPACING_UNIT: Record<string, string> = {
  'allen-atlas': 'um',
  nifti: 'mm',
  'ome-zarr': 'm',
}

// Where a source that can't be loaded whole is actually viewable.
const STREAMING_PAGES: Record<string, { href: string; label: string }> = {
  'ome-zarr': { href: '/omezarr.html', label: 'omezarr' },
  'dicom-wsi': { href: '/wsi.html', label: 'wsi' },
}

type Shape3 = [number, number, number]

interface ApiVolume {
  id: string
  format: string
  shape: Shape3
  dtype: string
  spacing: Shape3
  channel: number | null
  channelName: string | null
  dataset: string
  levels?: unknown[]
}

interface Dataset {
  key: string
  format: string
  shape: Shape3
  spacing: Shape3
  channels: ApiVolume[]
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  dataset: el<HTMLSelectElement>('dataset'),
  layout: el<HTMLSelectElement>('layout'),
  opacity: el<HTMLInputElement>('opacity'),
  load: el<HTMLButtonElement>('load'),
  clear: el<HTMLButtonElement>('clear'),
  status: el<HTMLSpanElement>('status'),
  channels: el<HTMLDivElement>('channels'),
  channelNote: el<HTMLParagraphElement>('channel-note'),
  pickAll: el<HTMLButtonElement>('pick-all'),
  pickNone: el<HTMLButtonElement>('pick-none'),
  streaming: el<HTMLDivElement>('streaming'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let datasets: Dataset[] = []
let current: Dataset | null = null
// Bumped per load so a superseded load (rapid dataset switching) drops its
// result instead of windowing the volumes of the newer one.
let loadToken = 0
let loaded: ApiVolume[] = []
// Set once the user drags the opacity slider, after which the channel-count
// default stops overriding their choice.
let opacityTouched = false

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

function voxels(shape: Shape3): number {
  return shape[0] * shape[1] * shape[2]
}

function unitFor(format: string): string {
  return SPACING_UNIT[format] ?? 'units'
}

function formatSpacing(d: Dataset): string {
  return `${d.spacing.map((s) => s.toPrecision(3)).join(' x ')} ${unitFor(d.format)}/voxel`
}

// One dataset per `dataset` key, channels in channel order.
function groupDatasets(volumes: ApiVolume[]): Dataset[] {
  const byKey = new Map<string, ApiVolume[]>()
  for (const v of volumes) {
    const list = byKey.get(v.dataset)
    if (list) list.push(v)
    else byKey.set(v.dataset, [v])
  }
  const out: Dataset[] = []
  for (const [key, entries] of byKey) {
    entries.sort((a, b) => (a.channel ?? 0) - (b.channel ?? 0))
    const first = entries[0]
    out.push({
      key,
      format: first.format,
      shape: first.shape,
      spacing: first.spacing,
      channels: entries,
    })
  }
  out.sort((a, b) => a.key.localeCompare(b.key))
  return out
}

// A multi-channel source is microscopy by construction here; a single-channel
// one qualifies only if it is small enough to fetch whole.
function isLoadableHere(d: Dataset): boolean {
  if (d.format === 'nifti') return false
  if (d.channels.length > 1) return true
  return voxels(d.shape) <= MAX_WHOLE_VOLUME_VOXELS
}

function channelBoxes(): HTMLInputElement[] {
  return [...els.channels.querySelectorAll<HTMLInputElement>('input')]
}

function selectedBoxes(): HTMLInputElement[] {
  return channelBoxes().filter((b) => b.checked)
}

// At the cap, block further selection rather than silently ignoring the extras
// at load time.
function refreshChannelLimit(): void {
  const n = selectedBoxes().length
  const atCap = n >= MAX_CHANNELS
  for (const box of channelBoxes()) {
    box.disabled = atCap && !box.checked
    box.parentElement?.classList.toggle('disabled', box.disabled)
  }
  els.channelNote.textContent = atCap
    ? `${n} of max ${MAX_CHANNELS} channels selected`
    : `${n} selected (max ${MAX_CHANNELS})`
}

// "all" fills up to the cap in list order. The registry lists a dataset's raw
// channels before its segmentations, so on a 16-structure Allen source this is
// exactly the raw stack the reference viewer shows.
function setAllChannels(checked: boolean): void {
  channelBoxes().forEach((box, index) => {
    box.checked = checked && index < MAX_CHANNELS
  })
  refreshChannelLimit()
}

function buildChannelList(d: Dataset): void {
  els.channels.replaceChildren()
  d.channels.forEach((entry, index) => {
    const row = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.value = entry.id
    box.checked = index < DEFAULT_CHANNELS
    box.addEventListener('change', refreshChannelLimit)
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = entry.channelName ?? entry.id
    name.title = entry.id
    const cmap = document.createElement('select')
    cmap.dataset.for = entry.id
    for (const c of CHANNEL_COLORMAPS) {
      const opt = document.createElement('option')
      opt.value = c
      opt.textContent = c
      cmap.appendChild(opt)
    }
    cmap.value = CHANNEL_COLORMAPS[index % CHANNEL_COLORMAPS.length]
    cmap.addEventListener('change', () => {
      applyColormap(entry.id, cmap.value)
    })
    row.append(box, name, cmap)
    els.channels.appendChild(row)
  })
  refreshChannelLimit()
}

function colormapFor(id: string): string {
  const sel = els.channels.querySelector<HTMLSelectElement>(
    `select[data-for="${CSS.escape(id)}"]`,
  )
  return sel?.value ?? 'gray'
}

function applyColormap(id: string, colormap: string): void {
  const index = loaded.findIndex((e) => e.id === id)
  if (!nv || index < 0) return
  nv.setVolume(index, { colormap })
  renderHud()
}

/**
 * Window each channel over its own full range and fade the overlays.
 *
 * Microscopy channels sit on a large per-channel background offset (the Allen
 * IMSC data floors at 126/82/72 rather than 0) and the whole cell body is above
 * that floor, so the robust auto-window saturates and each channel paints over
 * the one below it. Windowing floor-to-peak keeps the structure visible, and
 * the opacity is what lets stacked channels show through: niivue
 * alpha-composites overlays rather than accumulating them the way a dedicated
 * multi-channel microscopy viewer would.
 */
function applyDisplay(): void {
  if (!nv) return
  const overlayOpacity = Number(els.opacity.value)
  nv.volumes.forEach((volume, index) => {
    nv?.setVolume(index, {
      calMin: volume.globalMin,
      calMax: volume.globalMax,
      opacity: index === 0 ? 1 : overlayOpacity,
    })
  })
}

function renderHud(): void {
  if (!current) {
    els.hud.textContent = 'no dataset'
    return
  }
  const lines = [
    `dataset: ${current.key}`,
    `${current.channels.length} channel(s) · ${current.shape.join(' x ')} voxels`,
    formatSpacing(current),
  ]
  if (loaded.length === 0) {
    lines.push('no channels loaded')
  } else {
    lines.push('loaded:')
    for (const [i, entry] of loaded.entries()) {
      lines.push(
        `  ${entry.channelName ?? entry.id} — ${colormapFor(entry.id)}${i === 0 ? '' : ` @ ${els.opacity.value}`}`,
      )
    }
  }
  els.hud.textContent = lines.join('\n')
}

// Overlay opacity is a per-channel gain in an additive blend, so N channels at
// a fixed opacity sum toward white: at the 0.6 that suits a two-channel view, a
// full 16-channel stack blows out its dense core. Scale the default with the
// count (verified: 16 raw Allen channels are legible near 0.12, unreadable at
// 0.6). Anchored so the common 2-channel case still lands on 0.6. Once the user
// moves the slider it is theirs, and this stops overriding it.
function suggestedOpacity(count: number): number {
  if (count < 2) return 0.6
  return Math.min(0.6, Math.max(0.12, 1.2 / count))
}

async function loadSelected(): Promise<void> {
  if (!nv || !current) return
  const ids = selectedBoxes().map((b) => b.value)
  const entries = current.channels.filter((e) => ids.includes(e.id))
  if (!opacityTouched) {
    els.opacity.value = String(suggestedOpacity(entries.length))
  }
  const myToken = ++loadToken
  els.load.disabled = true
  els.status.textContent = entries.length
    ? `loading ${entries.length} channel(s)…`
    : 'clearing…'
  try {
    await nv.loadVolumes(
      entries.map((entry, index) => ({
        // Absolute: niivue's volume-load worker resolves the URL against the
        // worker scope, where a root-relative path fails to parse and forces a
        // main-thread fallback.
        url: new URL(
          `/volumes/${encodeURIComponent(entry.id)}/raw.nii.gz`,
          window.location.origin,
        ).href,
        colormap: colormapFor(entry.id),
        opacity: index === 0 ? 1 : Number(els.opacity.value),
      })),
    )
  } catch (err) {
    if (myToken !== loadToken) return
    els.status.textContent = `load failed: ${err instanceof Error ? err.message : err}`
    return
  } finally {
    if (myToken === loadToken) els.load.disabled = false
  }
  // A newer load superseded this one while these channels streamed.
  if (myToken !== loadToken) return
  loaded = entries
  applyDisplay()
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  els.status.textContent = ''
  renderHud()
}

// Split from the load so the sidebar can be built before the (slow) GPU init.
function showDataset(key: string): void {
  const next = datasets.find((d) => d.key === key)
  if (!next) return
  current = next
  loaded = []
  buildChannelList(next)
  renderHud()
}

function selectDataset(key: string): void {
  showDataset(key)
  void loadSelected()
}

// Sources this page can't load whole still belong in the microscopy index —
// list them with the page that streams them.
function buildStreamingList(all: Dataset[]): void {
  els.streaming.replaceChildren()
  const streamed = all.filter((d) => !isLoadableHere(d) && d.format !== 'nifti')
  if (streamed.length === 0) {
    const p = document.createElement('p')
    p.className = 'note'
    p.textContent = 'none'
    els.streaming.appendChild(p)
    return
  }
  const backend = getBackendFromUrl()
  for (const d of streamed) {
    const page = STREAMING_PAGES[d.format]
    const a = document.createElement('a')
    a.href = page
      ? backend === 'webgpu'
        ? `${page.href}?backend=webgpu`
        : page.href
      : '#'
    a.textContent = d.key
    const meta = document.createElement('span')
    meta.className = 'meta'
    meta.textContent = `${d.format} · ${d.shape.join(' x ')} · ${page ? `open in ${page.label}` : 'no viewer page'}`
    a.appendChild(meta)
    els.streaming.appendChild(a)
  }
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: ApiVolume[] }
  const all = groupDatasets(json.volumes ?? [])
  buildStreamingList(all)
  datasets = all.filter(isLoadableHere)
  if (datasets.length === 0) {
    showFallback(
      'No whole-volume microscopy sources in /api. Fetch one with:\n' +
        'bunx nx run iiif-volumetric-server:fetch-allen',
    )
    return
  }

  els.dataset.replaceChildren()
  for (const d of datasets) {
    const opt = document.createElement('option')
    opt.value = d.key
    opt.textContent = `${d.key} (${d.channels.length}ch, ${d.shape.join('x')})`
    els.dataset.appendChild(opt)
  }
  els.dataset.value = datasets[0].key
  showDataset(datasets[0].key)

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.05, 0.05, 0.06, 1],
    isColorbarVisible: false,
  })
  await nv.attachToCanvas(els.canvas)

  els.dataset.addEventListener('change', () => {
    selectDataset(els.dataset.value)
  })
  els.layout.addEventListener('change', () => {
    if (!nv) return
    nv.sliceType = Number(els.layout.value)
    nv.drawScene()
  })
  els.opacity.addEventListener('input', () => {
    opacityTouched = true
    if (nv && nv.volumes.length > 0) applyDisplay()
    renderHud()
  })
  els.pickAll.addEventListener('click', () => {
    setAllChannels(true)
  })
  els.pickNone.addEventListener('click', () => {
    setAllChannels(false)
  })
  els.load.addEventListener('click', () => {
    void loadSelected()
  })
  els.clear.addEventListener('click', () => {
    for (const box of channelBoxes()) box.checked = false
    refreshChannelLimit()
    void loadSelected()
  })

  selectDataset(datasets[0].key)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
