// Oriented hi-res microscopy overlay demo.
//
// A real anatomical base volume is loaded from the server, then a synthesized
// hi-res "microscopy" patch is placed inside it with an *oblique* affine (yaw +
// pitch). niivue's overlay path reslices the patch onto the base grid using its
// affine, so it renders in the correct position and orientation — the point of
// this demo. The yaw/pitch sliders rebuild the affine and re-aim it in place via
// `setVolumeAffine`, which recomputes the volume's oblique RAS transforms.
//
// The patch is synthetic (a textured ball) so the demo is self-contained; in
// practice it would be a registered high-resolution microscopy acquisition whose
// NIfTI/OME-Zarr affine places it within the macro volume.

import NiiVue from '@niivue/niivue'
import { getBackendFromUrl } from './backend'
import { buildLogicalVolume, type Shape3 } from './logical-volume'
import { installNav } from './nav'

installNav()

const BACKEND = getBackendFromUrl()
const PATCH_EDGE = 128
const DEFAULT_BASE = 'ds000228_sub-pixar001_T1w'

interface VolumeApiEntry {
  id: string
  format: string
  shape: Shape3
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  base: el<HTMLSelectElement>('base'),
  layout: el<HTMLSelectElement>('layout'),
  yaw: el<HTMLInputElement>('yaw'),
  pitch: el<HTMLInputElement>('pitch'),
  opacity: el<HTMLInputElement>('opacity'),
  reset: el<HTMLButtonElement>('reset'),
  mag: el<HTMLSpanElement>('mag'),
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  hud: el<HTMLDivElement>('hud'),
  fallback: el<HTMLDivElement>('fallback'),
}

let nv: NiiVue | null = null
let bases: VolumeApiEntry[] = []
let currentId = ''
// The base's mm box (read after it loads) and the patch's isotropic voxel size.
let centerMM: Shape3 = [0, 0, 0]
let patchVoxMM = 1

function showFallback(msg: string): void {
  els.fallback.textContent = msg
  els.fallback.style.display = 'flex'
}

// 3x3 = Ry(yaw) * Rx(pitch), row-major.
function rot3(pitchDeg: number, yawDeg: number): number[][] {
  const p = (pitchDeg * Math.PI) / 180
  const y = (yawDeg * Math.PI) / 180
  const cp = Math.cos(p)
  const sp = Math.sin(p)
  const cy = Math.cos(y)
  const sy = Math.sin(y)
  // Rx(p)
  const rx = [
    [1, 0, 0],
    [0, cp, -sp],
    [0, sp, cp],
  ]
  // Ry(y)
  const ry = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ]
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] =
        ry[i][0] * rx[0][j] + ry[i][1] * rx[1][j] + ry[i][2] * rx[2][j]
    }
  }
  return out
}

// Voxel->mm affine that scales the patch by `patchVoxMM`, rotates it by
// (pitch, yaw), and centers its middle voxel on the base centre.
function patchAffine(yawDeg: number, pitchDeg: number): number[][] {
  const r = rot3(pitchDeg, yawDeg)
  const m = r.map((row) => row.map((v) => v * patchVoxMM))
  const c = (PATCH_EDGE - 1) / 2
  const origin = [0, 1, 2].map(
    (i) => centerMM[i] - c * (m[i][0] + m[i][1] + m[i][2]),
  )
  return [
    [m[0][0], m[0][1], m[0][2], origin[0]],
    [m[1][0], m[1][1], m[1][2], origin[1]],
    [m[2][0], m[2][1], m[2][2], origin[2]],
    [0, 0, 0, 1],
  ]
}

// Textured ball: a cellular sin pattern inside a sphere, transparent outside.
function makePatchData(): Uint8Array {
  const n = PATCH_EDGE
  const img = new Uint8Array(n * n * n)
  const k = 26
  for (let z = 0; z < n; z++) {
    const fz = (z + 0.5) / n - 0.5
    for (let y = 0; y < n; y++) {
      const fy = (y + 0.5) / n - 0.5
      for (let x = 0; x < n; x++) {
        const fx = (x + 0.5) / n - 0.5
        if (fx * fx + fy * fy + fz * fz > 0.45 * 0.45) continue // outside sphere
        const t =
          Math.sin(fx * k) * Math.sin(fy * k) * Math.sin(fz * k) * 0.5 + 0.5
        img[x + y * n + z * n * n] = Math.round(40 + 215 * t)
      }
    }
  }
  return img
}

function renderHud(): void {
  els.hud.textContent =
    `base: ${currentId}\n` +
    `microscopy patch: ${PATCH_EDGE}³ @ ${patchVoxMM.toFixed(2)} mm/vox\n` +
    `orientation: yaw ${els.yaw.value}°, pitch ${els.pitch.value}°\n` +
    `opacity: ${els.opacity.value}`
}

async function applyOrientation(): Promise<void> {
  if (!nv || !nv.volumes[1]) return
  await nv.setVolumeAffine(
    1,
    patchAffine(Number(els.yaw.value), Number(els.pitch.value)),
  )
  renderHud()
}

async function loadBase(id: string): Promise<void> {
  if (!nv) return
  currentId = id
  els.mag.textContent = 'loading base + placing patch…'
  try {
    await nv.loadVolumes([
      {
        url: `/volumes/${encodeURIComponent(id)}/raw.nii.gz`,
        colormap: 'gray',
      },
    ])
  } catch (err) {
    showFallback(
      `base load failed: ${err instanceof Error ? err.message : err}`,
    )
    return
  }
  // Base mm box → centre + a patch sized to ~55% of the smallest extent.
  const v0 = nv.volumes[0] as unknown as {
    extentsMin: number[]
    extentsMax: number[]
  }
  const lo = v0.extentsMin
  const hi = v0.extentsMax
  centerMM = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]
  const sizeMM = Math.min(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  patchVoxMM = (0.55 * sizeMM) / PATCH_EDGE

  const patch = buildLogicalVolume({
    id: 'microscopy (synthetic)',
    url: 'micro://synthetic',
    shape: [PATCH_EDGE, PATCH_EDGE, PATCH_EDGE],
    spacing: [patchVoxMM, patchVoxMM, patchVoxMM],
    datatypeCode: 2, // DT_UINT8
    numBitsPerVoxel: 8,
    calMin: 30,
    calMax: 255,
    colormap: 'plasma',
    opacity: Number(els.opacity.value),
    isTransparentBelowCalMin: true,
    img: makePatchData(),
  })
  await nv.addVolume(patch)
  nv.sliceType = Number(els.layout.value)
  await applyOrientation()
  nv.drawScene()
  renderHud()
}

async function main(): Promise<void> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api ${res.status}`)
  const json = (await res.json()) as { volumes?: VolumeApiEntry[] }
  // Anatomical NIfTI bases load whole and carry a real affine — ideal for an
  // overlay-orientation demo (no streaming/chunked-overlay complexity).
  bases = (json.volumes ?? []).filter((v) => v.format === 'nifti')
  if (bases.length === 0) {
    showFallback('No NIfTI base volumes in /api.')
    return
  }
  els.base.replaceChildren()
  for (const v of bases) {
    const opt = document.createElement('option')
    opt.value = v.id
    opt.textContent = `${v.id} (${v.shape.join('×')})`
    els.base.appendChild(opt)
  }
  const initial = bases.find((v) => v.id === DEFAULT_BASE) ?? bases[0]
  els.base.value = initial.id

  nv = new NiiVue({
    backend: BACKEND,
    backgroundColor: [0.05, 0.05, 0.06, 1],
    isColorbarVisible: false,
  })
  await nv.attachToCanvas(els.canvas)

  els.base.addEventListener('change', () => {
    void loadBase(els.base.value)
  })
  els.layout.addEventListener('change', () => {
    if (!nv) return
    nv.sliceType = Number(els.layout.value)
    nv.drawScene()
  })
  for (const s of [els.yaw, els.pitch]) {
    s.addEventListener('input', () => {
      void applyOrientation()
    })
  }
  els.opacity.addEventListener('input', () => {
    if (nv && nv.volumes[1]) {
      void nv.setVolume(1, { opacity: Number(els.opacity.value) })
    }
    renderHud()
  })
  els.reset.addEventListener('click', () => {
    els.yaw.value = '35'
    els.pitch.value = '20'
    void applyOrientation()
  })

  await loadBase(initial.id)
}

main().catch((err: unknown) => {
  showFallback(err instanceof Error ? err.message : String(err))
})
