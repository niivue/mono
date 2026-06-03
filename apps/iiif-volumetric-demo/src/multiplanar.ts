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
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()
const baseUrl = window.location.origin

// niivue tiles a streaming volume into chunks of this edge and streams only the
// visible ones; cap how much brick data stays resident.
const CHUNK_EDGE = 256
const RESIDENCY_BYTES = 1_500_000_000
const DEFAULT_ID = 'pawpawsaurus.ome.zarr'

type Shape3 = [number, number, number]
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

function niftiDatatype(dtype: string): {
  code: number
  bits: number
  displayMin: number
  displayMax: number
} {
  switch (dtype) {
    case 'uint8':
      return { code: 2, bits: 8, displayMin: 0, displayMax: 255 }
    case 'int8':
      return { code: 256, bits: 8, displayMin: -128, displayMax: 127 }
    case 'uint16':
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
    case 'int16':
      return { code: 4, bits: 16, displayMin: -32768, displayMax: 32767 }
    case 'float32':
      return { code: 16, bits: 32, displayMin: 0, displayMax: 1 }
    default:
      return { code: 512, bits: 16, displayMin: 0, displayMax: 65535 }
  }
}

// Pick the finest level whose longest edge still fits niivue's 256-brick cap so
// the whole level streams (> ~4M bricks would exceed it). For these fixtures L0
// is comfortably under the cap, so this is just a safety net.
function streamLevel(v: VolumeApiEntry): VolumeLevel {
  const levels =
    v.levels && v.levels.length > 0
      ? v.levels
      : [{ level: 0, shape: v.shape, spacing: v.spacing, bytes: null }]
  const usable = CHUNK_EDGE - 6 // halo margin
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

// Build a fully-streamed logical volume for one pyramid level: dims/transforms
// describe the level, `img` is null, and a `chunkSource` fetches bricks on
// demand. niivue auto-tiles it at CHUNK_EDGE (no chunkPlan) and streams the
// visible bricks. Modelled on the omezarr.ts streaming volume.
function createStreamingVolume(v: VolumeApiEntry, lvl: VolumeLevel): NVImage {
  const shape = lvl.shape
  const spacing = lvl.spacing
  const dt = niftiDatatype(v.dtype)
  const dims = [3, shape[0], shape[1], shape[2], 1, 1, 1, 1]
  const pixDims = [1, spacing[0], spacing[1], spacing[2], 1, 1, 1, 1]
  const affine = [
    [spacing[0], 0, 0, 0],
    [0, spacing[1], 0, 0],
    [0, 0, spacing[2], 0],
    [0, 0, 0, 1],
  ]
  const dimsMM: Shape3 = [
    shape[0] * spacing[0],
    shape[1] * spacing[1],
    shape[2] * spacing[2],
  ]
  const longest = Math.max(dimsMM[0], dimsMM[1], dimsMM[2])
  const matRAS = new Float32Array([
    spacing[0],
    0,
    0,
    0,
    0,
    spacing[1],
    0,
    0,
    0,
    0,
    spacing[2],
    0,
    0,
    0,
    0,
    1,
  ])
  const frac2mm = new Float32Array([
    dimsMM[0],
    0,
    0,
    0,
    0,
    dimsMM[1],
    0,
    0,
    0,
    0,
    dimsMM[2],
    0,
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
    1,
  ])
  const identity = new Float32Array([
    1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
  ])
  const minMM: Shape3 = [
    -0.5 * spacing[0],
    -0.5 * spacing[1],
    -0.5 * spacing[2],
  ]
  const maxMM: Shape3 = [
    (shape[0] - 0.5) * spacing[0],
    (shape[1] - 0.5) * spacing[1],
    (shape[2] - 0.5) * spacing[2],
  ]
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
  const name = `${v.id} L${lvl.level} streamed`
  return {
    name,
    id: name,
    url: `mpr-stream://${encodeURIComponent(v.id)}/L${lvl.level}`,
    img: null,
    hdr: {
      littleEndian: true,
      dim_info: 0,
      dims,
      pixDims,
      intent_p1: 0,
      intent_p2: 0,
      intent_p3: 0,
      intent_code: 0,
      datatypeCode: dt.code,
      numBitsPerVoxel: dt.bits,
      slice_start: 0,
      vox_offset: 352,
      scl_slope: 1,
      scl_inter: 0,
      slice_end: 0,
      slice_code: 0,
      xyzt_units: 10,
      cal_max: dt.displayMax,
      cal_min: dt.displayMin,
      slice_duration: 0,
      toffset: 0,
      description: 'OME-Zarr streamed level',
      aux_file: '',
      qform_code: 0,
      sform_code: 1,
      quatern_b: 0,
      quatern_c: 0,
      quatern_d: 0,
      qoffset_x: 0,
      qoffset_y: 0,
      qoffset_z: 0,
      affine,
      intent_name: '',
      magic: 'n+1',
    },
    originalAffine: affine.map((row) => [...row]),
    dims: dims.slice(0, 4),
    nVox3D: shape[0] * shape[1] * shape[2],
    extentsMin: minMM,
    extentsMax: maxMM,
    calMin: dt.displayMin,
    calMax: dt.displayMax,
    robustMin: dt.displayMin,
    robustMax: dt.displayMax,
    globalMin: dt.displayMin,
    globalMax: dt.displayMax,
    pixDimsRAS: pixDims.slice(0, 4),
    dimsRAS: dims.slice(0, 4),
    permRAS: [1, 2, 3],
    matRAS,
    obliqueRAS: identity,
    frac2mm,
    frac2mmOrtho: frac2mm,
    extentsMinOrtho: minMM,
    extentsMaxOrtho: maxMM,
    mm2ortho: identity,
    img2RASstep: [1, shape[0], shape[0] * shape[1]],
    img2RASstart: [0, 0, 0],
    toRAS: identity,
    toRASvox: identity,
    mm000: minMM,
    mm100: [maxMM[0], minMM[1], minMM[2]],
    mm010: [minMM[0], maxMM[1], minMM[2]],
    mm001: [minMM[0], minMM[1], maxMM[2]],
    oblique_angle: 0,
    maxShearDeg: 0,
    volScale: [dimsMM[0] / longest, dimsMM[1] / longest, dimsMM[2] / longest],
    frame4D: 0,
    nFrame4D: 1,
    nTotalFrame4D: 1,
    colormap: 'gray',
    isTransparentBelowCalMin: true,
    opacity: 1,
    modulateAlpha: 0,
    isColorbarVisible: false,
    isLegendVisible: false,
    colormapLabel: null,
    chunkSource,
  } as unknown as NVImage
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
