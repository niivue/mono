// Multiplanar streaming demo.
//
// Loads a large OME-Zarr volume as a chunked *streaming* volume (`img` is null,
// a `chunkSource` fetches bricks from `/volumes/{id}/raw.bin?level=N&bbox=...`)
// and renders it in niivue's multiplanar layout (axial/coronal/sagittal slices
// + a 3D render tile). niivue unions the chunk working set across all four
// tiles, so only the bricks each slice crosses and the 3D frustum sees are
// streamed — never the whole level.
//
// The clip-plane controls double as a live demo of the streaming clip cull
// (packages/niivue/src/volume/ChunkVisibility.ts `chunksNotClippedOut`): turning
// the clip plane on drops the bricks it hides from the 3D tile's fetch set, so
// the "bricks fetched" counter climbs more slowly. The counter is measured
// demo-side by counting the unique chunk indices the `chunkSource` is asked for.

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

// niivue tiles a streaming volume into chunks of this edge and streams only the
// visible ones; cap how much brick data stays resident.
const CHUNK_EDGE = 256
const RESIDENCY_BYTES = 2_000_000_000
const DEFAULT_ID = 'pawpawsaurus.ome.zarr'
// Resident GPU bytes per level-voxel (RGBA8 + gradient, ~8, times a halo factor).
// The 3D render tile needs every chunk resident at once, so we stream the finest
// level whose whole footprint fits the budget — otherwise the LRU thrashes and
// the view crawls.
const RESIDENT_BYTES_PER_VOXEL = 12

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
  reset: el<HTMLButtonElement>('reset'),
  mag: el<HTMLSpanElement>('mag'),
  clipOn: el<HTMLInputElement>('clipOn'),
  clipDepth: el<HTMLInputElement>('clipDepth'),
  clipAzi: el<HTMLInputElement>('clipAzi'),
  clipElev: el<HTMLInputElement>('clipElev'),
  clipCutaway: el<HTMLInputElement>('clipCutaway'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let current: VolumeApiEntry | null = null
// Unique chunk indices the active volume's chunkSource has been asked for.
let fetched = new Set<number>()
let fetchedBytes = 0

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

// Pick the finest level whose longest edge still fits niivue's 256-brick cap so
// the whole level streams (> ~4M bricks would exceed it). For these fixtures L0
// is comfortably under the cap, so this is just a safety net.
function streamLevel(v: VolumeApiEntry): VolumeLevel {
  const levels =
    v.levels && v.levels.length > 0
      ? v.levels
      : [{ level: 0, shape: v.shape, spacing: v.spacing, bytes: null }]
  const sorted = [...levels].sort((a, b) => a.level - b.level) // finest first
  for (const l of sorted) {
    const voxels = l.shape[0] * l.shape[1] * l.shape[2]
    if (voxels * RESIDENT_BYTES_PER_VOXEL <= RESIDENCY_BYTES) return l
  }
  return sorted[sorted.length - 1] // coarsest as a last resort
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

// Build a fully-streamed logical volume for one pyramid level: `img` is null and
// a `chunkSource` fetches bricks on demand, which the shared factory wraps with
// the level's geometry. niivue auto-tiles it at CHUNK_EDGE and streams only the
// visible bricks. The chunkSource also records the unique brick indices fetched
// for the HUD.
function createStreamingVolume(v: VolumeApiEntry, lvl: VolumeLevel): NVImage {
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
      fetchedBytes += buf.byteLength
      renderHud()
      return buf
    })
    cache.set(request.chunkIndex, next)
    renderHud()
    return next
  }
  return buildLogicalVolume({
    id: `${v.id} L${lvl.level} streamed`,
    url: `mpr-stream://${encodeURIComponent(v.id)}/L${lvl.level}`,
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

function renderHud(): void {
  if (!current) return
  const lvl = streamLevel(current)
  const mb = (fetchedBytes / (1024 * 1024)).toFixed(1)
  const clip = els.clipOn.checked
    ? `on (depth ${els.clipDepth.value}, azim ${els.clipAzi.value}, elev ${els.clipElev.value}${els.clipCutaway.checked ? ', cutaway' : ''})`
    : 'off'
  els.hud.textContent =
    `${current.id}\n` +
    `level ${lvl.level} · ${lvl.shape.join('×')} · ${current.dtype}\n` +
    `bricks fetched: ${fetched.size} (${mb} MB)\n` +
    `clip plane: ${clip}`
}

function applyClip(): void {
  if (!nv) return
  if (els.clipOn.checked) {
    nv.setClipPlane([
      Number(els.clipDepth.value),
      Number(els.clipAzi.value),
      Number(els.clipElev.value),
    ])
  } else {
    // depth > 1 is niivue's "no clip" sentinel.
    nv.setClipPlane([2, 0, 0])
  }
  nv.isClipPlaneCutaway = els.clipCutaway.checked
  renderHud()
}

async function loadVolume(v: VolumeApiEntry): Promise<void> {
  if (!nv) return
  current = v
  fetched = new Set()
  fetchedBytes = 0
  const lvl = streamLevel(v)
  els.mag.textContent = `streaming L${lvl.level} at ${CHUNK_EDGE}³ bricks`
  try {
    await nv.loadVolumes([createStreamingVolume(v, lvl)])
  } catch (err) {
    showFallback(
      `niivue failed to load: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  nv.sliceType = Number(els.layout.value)
  applyClip()
  nv.drawScene()
  renderHud()
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: VolumeApiEntry[] }
  // 3D OME-Zarr only (depth-1 WSI slabs make no sense in multiplanar).
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
    if (v) void loadVolume(v)
  })
  els.layout.addEventListener('change', () => {
    if (!nv) return
    nv.sliceType = Number(els.layout.value)
    nv.drawScene()
  })
  els.reset.addEventListener('click', () => {
    if (current) void loadVolume(current)
  })
  for (const input of [
    els.clipOn,
    els.clipDepth,
    els.clipAzi,
    els.clipElev,
    els.clipCutaway,
  ]) {
    input.addEventListener('input', applyClip)
  }

  await loadVolume(initial)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
