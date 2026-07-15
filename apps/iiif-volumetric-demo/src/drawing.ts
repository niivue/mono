// Drawing-on-a-chunked-volume demo (large-volume drawing, Phase 1).
//
// A volume is loaded with a small `maxTextureDimension3D` so niivue tiles it
// into chunks (the same path a too-large-for-one-texture volume takes). Voxel
// drawing then runs on the chunked drawing layer: each pen stroke records a
// dirty voxel box, and the renderer re-uploads only the drawing chunks that box
// touches (halo-inclusive) instead of the whole volume — so painting stays cheap
// as the volume grows.
//
// (Phase 2 — never materialising the full drawing bitmap — is future work; here
// the bitmap is whole but the GPU upload per stroke is incremental.)

import NiiVue, { SLICE_TYPE, PEN_SHAPE } from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()
// Small on purpose: forces niivue to tile even a modest volume into chunks so
// the chunked drawing path is exercised on a bounded (demo-friendly) volume.
const CHUNK_EDGE = 96
const DEFAULT_ID = 'ds000228_sub-pixar001_T1w'

interface VolumeApiEntry {
  id: string
  format: string
  shape: [number, number, number]
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  volume: el<HTMLSelectElement>('volume'),
  pen: el<HTMLSelectElement>('pen'),
  penShape: el<HTMLSelectElement>('penShape'),
  size: el<HTMLInputElement>('size'),
  drawOn: el<HTMLInputElement>('drawOn'),
  explode: el<HTMLInputElement>('explode'),
  clear: el<HTMLButtonElement>('clear'),
  undo: el<HTMLButtonElement>('undo'),
  mag: el<HTMLSpanElement>('mag'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let volumes: VolumeApiEntry[] = []
let currentId = ''

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

function applyPen(): void {
  if (!nv) return
  nv.drawPenValue = Number(els.pen.value)
  nv.drawPenShape = Number(els.penShape.value) as PEN_SHAPE
  nv.drawPenSize = Number(els.size.value)
  nv.drawIsEnabled = els.drawOn.checked
  renderHud()
}

// Explode separates the chunked volume into floating blocks in the 3D render;
// with drawing on, clicking a block paints directly on it (the F path). Off,
// the volume is whole and we draw on 2D slices.
function applyExplode(): void {
  if (!nv) return
  const vol = nv.volumes[0]
  if (vol) {
    vol.chunkExplode = els.explode.checked
      ? { enabled: true, scale: [1.6, 1.6, 1.6] }
      : undefined
  }
  nv.sliceType = els.explode.checked
    ? SLICE_TYPE.RENDER
    : SLICE_TYPE.MULTIPLANAR
  nv.drawScene()
  renderHud()
}

function renderHud(): void {
  const v = volumes.find((x) => x.id === currentId)
  const chunked =
    v && Math.max(...v.shape) > CHUNK_EDGE ? 'yes' : 'no (fits one texture)'
  els.hud.textContent =
    `${currentId}\n` +
    `${v ? v.shape.join('×') : '?'} · tiled at ${CHUNK_EDGE}³: ${chunked}\n` +
    `pen: ${els.pen.value} · shape: ${els.penShape.options[els.penShape.selectedIndex].text} · size ${els.size.value} · ${els.drawOn.checked ? 'drawing on' : 'off'}`
}

async function loadVolume(id: string): Promise<void> {
  if (!nv) return
  currentId = id
  els.mag.textContent = `tiling at ${CHUNK_EDGE}³…`
  try {
    await nv.loadVolumes([
      {
        url: `/volumes/${encodeURIComponent(id)}/raw.nii.gz`,
        colormap: 'gray',
      },
    ])
  } catch (err) {
    showFallback(`load failed: ${err instanceof Error ? err.message : err}`)
    return
  }
  nv.createEmptyDrawing()
  applyPen()
  applyExplode()
  renderHud()
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: VolumeApiEntry[] }
  volumes = (json.volumes ?? []).filter((v) => v.format === 'nifti')
  if (volumes.length === 0) {
    showFallback('No NIfTI volumes in /api.')
    return
  }
  els.volume.replaceChildren()
  for (const v of volumes) {
    const opt = document.createElement('option')
    opt.value = v.id
    opt.textContent = `${v.id} (${v.shape.join('×')})`
    els.volume.appendChild(opt)
  }
  const initial = volumes.find((v) => v.id === DEFAULT_ID) ?? volumes[0]
  els.volume.value = initial.id

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.05, 0.05, 0.06, 1],
    isColorbarVisible: false,
    maxTextureDimension3D: CHUNK_EDGE,
  })
  await nv.attachToCanvas(els.canvas)

  els.volume.addEventListener('change', () => {
    void loadVolume(els.volume.value)
  })
  for (const c of [els.pen, els.penShape, els.size, els.drawOn]) {
    c.addEventListener('input', applyPen)
  }
  els.explode.addEventListener('change', applyExplode)
  els.clear.addEventListener('click', () => {
    if (nv) {
      nv.createEmptyDrawing()
      nv.drawScene()
    }
  })
  els.undo.addEventListener('click', () => {
    if (nv) nv.drawUndo()
  })

  await loadVolume(initial.id)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
