// Overlay-on-a-large-volume demo.
//
// A large OME-Zarr volume is loaded as a chunked *streaming* background, and a
// co-registered scalar overlay is layered on top via `nv.loadVolumes([bg, ov])`.
// niivue reslices the overlay onto each background brick as it streams in (the
// chunked-overlay path: `overlay2TextureChunked`), so the overlay rides the same
// visibility-driven working set as the background — only the visible bricks
// carry overlay texels.
//
// The overlay here is synthesized client-side (a few smooth blobs) sized to the
// background's mm box so the two register, which keeps the demo self-contained;
// in practice the overlay would be a segmentation / activation / heatmap volume
// served alongside the background.

import NiiVue, { type NVImage, type VolumeChunkSource } from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import {
  buildLogicalVolume,
  niftiDatatype,
  type Shape3,
} from './logical-volume'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()
const baseUrl = window.location.origin

const CHUNK_EDGE = 256
const RESIDENCY_BYTES = 1_500_000_000
const DEFAULT_ID = 'pawpawsaurus.ome.zarr'
// The synthetic overlay is a modest grid resampled onto the background; it only
// needs to be smooth, not high-res (niivue interpolates it per brick).
const OVERLAY_EDGE = 96

type Bbox6 = [number, number, number, number, number, number]

interface VolumeLevel {
  level: number
  shape: Shape3
  spacing: Shape3
  bytes: number | null
}
interface VolumeApiEntry {
  id: string
  format: string
  shape: Shape3
  spacing: Shape3
  dtype: string
  levels?: VolumeLevel[]
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  volume: el<HTMLSelectElement>('volume'),
  layout: el<HTMLSelectElement>('layout'),
  cmap: el<HTMLSelectElement>('cmap'),
  opacity: el<HTMLInputElement>('opacity'),
  overlayOn: el<HTMLInputElement>('overlayOn'),
  mag: el<HTMLSpanElement>('mag'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let current: VolumeApiEntry | null = null
let fetched = new Set<number>()

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

function streamLevel(v: VolumeApiEntry): VolumeLevel {
  const levels =
    v.levels && v.levels.length > 0
      ? v.levels
      : [{ level: 0, shape: v.shape, spacing: v.spacing, bytes: null }]
  const usable = CHUNK_EDGE - 6
  for (const l of [...levels].sort((a, b) => a.level - b.level)) {
    const grid =
      Math.ceil(l.shape[0] / usable) *
      Math.ceil(l.shape[1] / usable) *
      Math.ceil(l.shape[2] / usable)
    if (grid <= 256) return l
  }
  return levels[levels.length - 1]
}

function fetchRawChunk(
  id: string,
  level: number,
  desc: { texOrigin: readonly number[]; texDims: readonly number[] },
  bpv: number,
): Promise<Uint8Array> {
  const bbox: Bbox6 = [
    desc.texOrigin[0],
    desc.texOrigin[1],
    desc.texOrigin[2],
    desc.texOrigin[0] + desc.texDims[0],
    desc.texOrigin[1] + desc.texDims[1],
    desc.texOrigin[2] + desc.texDims[2],
  ]
  const url = `${baseUrl}/volumes/${encodeURIComponent(id)}/raw.bin?level=${level}&bbox=${bbox.join(',')}`
  return fetch(url).then(async (res) => {
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    const expected = desc.texDims[0] * desc.texDims[1] * desc.texDims[2] * bpv
    if (buf.byteLength !== expected) {
      throw new Error(
        `chunk ${bbox} got ${buf.byteLength}B, expected ${expected}`,
      )
    }
    return buf
  })
}

function createBackground(v: VolumeApiEntry, lvl: VolumeLevel): NVImage {
  const dt = niftiDatatype(v.dtype)
  const cache = new Map<number, Promise<Uint8Array>>()
  const chunkSource: VolumeChunkSource = (request) => {
    const hit = cache.get(request.chunkIndex)
    if (hit) return hit
    fetched.add(request.chunkIndex)
    const next = fetchRawChunk(
      v.id,
      lvl.level,
      request.desc,
      request.bytesPerVoxel,
    ).then((buf) => {
      renderHud()
      return buf
    })
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
  return buildLogicalVolume({
    id: `${v.id} L${lvl.level} background`,
    url: `ov-bg://${encodeURIComponent(v.id)}/L${lvl.level}`,
    shape: lvl.shape,
    spacing: lvl.spacing,
    datatypeCode: dt.code,
    numBitsPerVoxel: dt.bits,
    calMin: dt.displayMin,
    calMax: dt.displayMax,
    colormap: 'gray',
    chunkSource,
  })
}

// Smooth scalar field (sum of Gaussian blobs) on an OVERLAY_EDGE grid, sized in
// mm to cover the same box as the background level so the two register.
function createOverlay(v: VolumeApiEntry, lvl: VolumeLevel): NVImage {
  const n = OVERLAY_EDGE
  const dimsMM: Shape3 = [
    lvl.shape[0] * lvl.spacing[0],
    lvl.shape[1] * lvl.spacing[1],
    lvl.shape[2] * lvl.spacing[2],
  ]
  const spacing: Shape3 = [dimsMM[0] / n, dimsMM[1] / n, dimsMM[2] / n]
  const blobs: Array<{ c: Shape3; r: number }> = [
    { c: [0.5, 0.5, 0.5], r: 0.16 },
    { c: [0.34, 0.6, 0.46], r: 0.1 },
    { c: [0.66, 0.4, 0.56], r: 0.09 },
  ]
  const img = new Float32Array(n * n * n)
  for (let z = 0; z < n; z++) {
    const fz = (z + 0.5) / n
    for (let y = 0; y < n; y++) {
      const fy = (y + 0.5) / n
      for (let x = 0; x < n; x++) {
        const fx = (x + 0.5) / n
        let val = 0
        for (const b of blobs) {
          const dx = fx - b.c[0]
          const dy = fy - b.c[1]
          const dz = fz - b.c[2]
          val += Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * b.r * b.r))
        }
        img[x + y * n + z * n * n] = Math.min(1, val)
      }
    }
  }
  return buildLogicalVolume({
    id: 'overlay (synthetic)',
    url: 'ov-overlay://synthetic',
    shape: [n, n, n],
    spacing,
    datatypeCode: 16, // DT_FLOAT32
    numBitsPerVoxel: 32,
    calMin: 0.25,
    calMax: 1.0,
    colormap: els.cmap.value || 'warm',
    opacity: Number(els.opacity.value),
    isTransparentBelowCalMin: true,
    img,
  })
}

function renderHud(): void {
  if (!current) return
  const lvl = streamLevel(current)
  els.hud.textContent =
    `background: ${current.id}\n` +
    `level ${lvl.level} · ${lvl.shape.join('×')} · ${current.dtype}\n` +
    `bricks fetched: ${fetched.size}\n` +
    `overlay: ${els.overlayOn.checked ? `${els.cmap.value}, opacity ${els.opacity.value}` : 'off'}`
}

async function loadAll(v: VolumeApiEntry): Promise<void> {
  if (!nv) return
  current = v
  fetched = new Set()
  const lvl = streamLevel(v)
  els.mag.textContent = `streaming L${lvl.level} at ${CHUNK_EDGE}³ bricks`
  const list = els.overlayOn.checked
    ? [createBackground(v, lvl), createOverlay(v, lvl)]
    : [createBackground(v, lvl)]
  try {
    await nv.loadVolumes(list)
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  nv.sliceType = Number(els.layout.value)
  nv.drawScene()
  renderHud()
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: VolumeApiEntry[] }
  volumes = (json.volumes ?? []).filter(
    (v) => v.format === 'ome-zarr' && Math.min(...v.shape) > 1,
  )
  if (volumes.length === 0) {
    showFallback(
      'No 3D OME-Zarr volumes in /api. Run `nx run iiif-volumetric-server:fetch-omezarr` and restart the server.',
    )
    return
  }
  els.volume.replaceChildren()
  for (const v of volumes) {
    const opt = document.createElement('option')
    opt.value = v.id
    opt.textContent = `${v.id} (${v.shape.join('×')}, ${v.dtype})`
    els.volume.appendChild(opt)
  }
  const initial = volumes.find((v) => v.id === DEFAULT_ID) ?? volumes[0]
  els.volume.value = initial.id

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.05, 0.05, 0.06, 1],
    isColorbarVisible: false,
    maxTextureDimension3D: CHUNK_EDGE,
    maxChunkResidencyBytes: RESIDENCY_BYTES,
  })
  await nv.attachToCanvas(els.canvas)

  els.volume.addEventListener('change', () => {
    const v = volumes.find((x) => x.id === els.volume.value)
    if (v) void loadAll(v)
  })
  els.layout.addEventListener('change', () => {
    if (!nv) return
    nv.sliceType = Number(els.layout.value)
    nv.drawScene()
  })
  els.overlayOn.addEventListener('change', () => {
    if (current) void loadAll(current)
  })
  els.cmap.addEventListener('change', () => {
    if (nv && nv.volumes[1]) void nv.setVolume(1, { colormap: els.cmap.value })
    renderHud()
  })
  els.opacity.addEventListener('input', () => {
    if (nv && nv.volumes[1]) {
      void nv.setVolume(1, { opacity: Number(els.opacity.value) })
    }
    renderHud()
  })

  await loadAll(initial)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
