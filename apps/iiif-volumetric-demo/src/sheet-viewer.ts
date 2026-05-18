// 3x3 sheet of independent volume+mesh viewports on a single shared canvas.
//
// Each cell is its own NiiVue instance with its own model (own volumes,
// own meshes). All instances share one <canvas> via normalized bounds
// (y=0 bottom, GL convention). A single NVCanvasViewportController drives
// the canvas viewport pan/zoom — every sibling re-derives its pixel rect
// from (bounds * viewport) and redraws together.
//
// Volumes come from the IIIF Volumetric Server (/api -> /volumes/{id}/raw).
// Mesh fixtures come from @niivue/dev-images (served at /meshes/*).

import { NVCanvasViewportController } from '@niivue/niivue/viewport'
import type {
  CanvasViewport,
  MeshFromUrlOptions,
  NiiVueOptions,
  NVImage,
  NVMesh,
} from '@niivue/niivue/webgl2'
import NiiVue from '@niivue/niivue/webgl2'

import { installNav } from './nav'

installNav()

type VolumeApiEntry = {
  id: string
  format: string
  shape: [number, number, number]
  dtype: string
}

type ApiResponse = {
  volumes?: VolumeApiEntry[]
}

const GRID = 3
const CELL_COUNT = GRID * GRID
const CLEAR_COLOR: [number, number, number, number] = [0.04, 0.05, 0.07, 1]
const PALETTE = [
  'gray',
  'hot',
  'cool',
  'plasma',
  'viridis',
  'turbo',
  'winter',
  'warm',
  'bone',
]
const MESH_COLOR_BY_INDEX: Array<[number, number, number, number]> = [
  [0.85, 0.45, 0.5, 1],
  [0.5, 0.85, 0.7, 1],
  [0.5, 0.6, 0.9, 1],
  [0.85, 0.75, 0.4, 1],
  [0.75, 0.5, 0.85, 1],
  [0.4, 0.85, 0.85, 1],
  [0.85, 0.55, 0.35, 1],
  [0.6, 0.85, 0.4, 1],
  [0.45, 0.65, 0.85, 1],
]

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

const els = {
  canvas: el<HTMLCanvasElement>('nv-canvas'),
  statusPill: el<HTMLSpanElement>('statusPill'),
  sliceType: el<HTMLSelectElement>('sliceType'),
  meshSelect: el<HTMLSelectElement>('meshSelect'),
  zoomIn: el<HTMLButtonElement>('zoomIn'),
  zoomOut: el<HTMLButtonElement>('zoomOut'),
  zoomFit: el<HTMLButtonElement>('zoomFit'),
  hud: el<HTMLDivElement>('hud'),
  minimap: el<HTMLDivElement>('minimap'),
  minimapGrid: el<HTMLDivElement>('minimapGrid'),
  minimapView: el<HTMLDivElement>('minimapView'),
  labels: el<HTMLDivElement>('labels'),
}

type Cell = {
  nv: InstanceType<typeof NiiVue>
  volumeId: string | null
  row: number
  col: number
  labelEl: HTMLDivElement
  nameEl: HTMLDivElement
  metaAEl: HTMLDivElement
  metaBEl: HTMLDivElement
}

// LOD: gutter and label strip grow with zoom. Below LOD_START the layout is
// flush (tiny gutter, no label); above LOD_END the label strip is fully open.
// The gutter and label height are in WORLD units (canvas-normalized) so they
// scale with zoom in screen-space — gutters look proportional whether the
// sheet is fit-to-screen or panned in close.
const LOD_START = 1.6
const LOD_END = 3.2
const BASE_GUTTER = 0.004
const MAX_GUTTER = 0.022
const MAX_LABEL_HEIGHT = 0.07
const LABEL_REVEAL = 0.35 // fraction of LOD at which labels start fading in

const cells: Cell[] = []
let controller: NVCanvasViewportController | null = null
let gl: WebGL2RenderingContext | null = null
let lastLod = -1

main().catch((err: unknown) => {
  console.error(err)
  setStatus(`error: ${errMsg(err)}`)
})

async function main(): Promise<void> {
  resizeCanvasToDisplay()
  window.addEventListener('resize', () => {
    resizeCanvasToDisplay()
    redrawAll()
    syncFromViewport()
  })

  setStatus('loading volumes…')
  const volumeIds = await fetchVolumeIds()
  if (volumeIds.length === 0) {
    setStatus('no volumes — start the IIIF server and run fetch-fixtures')
    return
  }

  await createCells(volumeIds)
  // After the first instance attached, the canvas owns a webgl2 context.
  // Re-requesting returns the same one — we use it to clear the full
  // backbuffer before each viewport-driven redraw, otherwise zoom-out
  // leaves stale pixels outside the union of bound rects.
  gl = els.canvas.getContext('webgl2') as WebGL2RenderingContext | null
  attachController()
  buildMinimapGrid()
  wireMinimap()
  await loadAllCells(volumeIds)
  wireControls()
  syncFromViewport()
  setStatus(`${cells.length} cells · mesh: ${els.meshSelect.value || 'none'}`)
}

async function fetchVolumeIds(): Promise<string[]> {
  const res = await fetch('/api')
  if (!res.ok) throw new Error(`/api -> ${res.status}`)
  const json = (await res.json()) as ApiResponse
  const list = json.volumes ?? []
  const ids: string[] = []
  for (let i = 0; ids.length < CELL_COUNT && i < list.length * 4; i++) {
    const entry = list[i % list.length]
    if (entry) ids.push(entry.id)
  }
  return ids
}

async function createCells(volumeIds: string[]): Promise<void> {
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const idx = row * GRID + col
      const volumeId = volumeIds[idx] ?? null
      const rect = cellBoundsWorld(row, col, 0)
      const opts: NiiVueOptions = {
        backgroundColor: CLEAR_COLOR,
        bounds: [
          [rect.x1, rect.tileY1],
          [rect.x2, rect.y2],
        ],
        showBoundsBorder: true,
        boundsBorderColor: [0.18, 0.2, 0.24, 1],
        boundsBorderThickness: 1,
        isColorbarVisible: false,
        isOrientCubeVisible: false,
        isDragDropEnabled: false,
        sliceType: Number(els.sliceType.value),
      }
      const nv = new NiiVue(opts)
      await nv.attachToCanvas(els.canvas)
      const { labelEl, nameEl, metaAEl, metaBEl } = createLabelEl(idx, volumeId)
      els.labels.appendChild(labelEl)
      cells.push({ nv, volumeId, row, col, labelEl, nameEl, metaAEl, metaBEl })
    }
  }
}

// World-space rect for a cell at LOD t in [0,1]. Returns the inner bounds the
// niivue tile renders into (`tileY1..y2` is the volume area) plus the label
// strip (`y1..tileY1`) just below it. y=0 is bottom (GL convention).
type CellRect = {
  x1: number
  x2: number
  y1: number // outer bottom (label strip starts here)
  y2: number // outer top
  tileY1: number // inner bottom — volume tile bottom (label strip ends here)
}
function cellBoundsWorld(row: number, col: number, t: number): CellRect {
  const g = BASE_GUTTER + (MAX_GUTTER - BASE_GUTTER) * t
  const labelH = MAX_LABEL_HEIGHT * t
  const x1 = col / GRID + g / 2
  const x2 = (col + 1) / GRID - g / 2
  const y1 = (GRID - 1 - row) / GRID + g / 2
  const y2 = (GRID - row) / GRID - g / 2
  const tileY1 = y1 + labelH
  return { x1, x2, y1, y2, tileY1 }
}

function createLabelEl(
  idx: number,
  volumeId: string | null,
): {
  labelEl: HTMLDivElement
  nameEl: HTMLDivElement
  metaAEl: HTMLDivElement
  metaBEl: HTMLDivElement
} {
  const labelEl = document.createElement('div')
  labelEl.className = 'cell-label'
  labelEl.dataset.cell = String(idx)
  const nameEl = document.createElement('div')
  nameEl.className = 'name'
  nameEl.textContent = volumeId ? prettyName(volumeId) : '—'
  const metaAEl = document.createElement('div')
  metaAEl.className = 'meta'
  const metaBEl = document.createElement('div')
  metaBEl.className = 'meta'
  labelEl.appendChild(nameEl)
  labelEl.appendChild(metaAEl)
  labelEl.appendChild(metaBEl)
  return { labelEl, nameEl, metaAEl, metaBEl }
}

function prettyName(id: string): string {
  return id.replace(/\.nii(\.gz)?$/i, '')
}

async function loadAllCells(volumeIds: string[]): Promise<void> {
  const meshUrl = currentMeshUrl()
  await Promise.all(
    cells.map(async (cell, idx) => {
      const id = volumeIds[idx]
      if (!id) return
      cell.volumeId = id
      cell.nameEl.textContent = prettyName(id)
      const colormap = PALETTE[idx % PALETTE.length] ?? 'gray'
      try {
        await cell.nv.loadVolumes([
          {
            url: `/volumes/${encodeURIComponent(id)}/raw`,
            colormap,
          },
        ])
        const meta = volumeMetaText(cell.nv)
        cell.metaAEl.textContent = meta.lineA
        cell.metaBEl.textContent = meta.lineB
        if (meshUrl) {
          await cell.nv.loadMeshes(meshOptsFor(idx, meshUrl))
          await alignCellMeshesToVolume(cell.nv)
        }
      } catch (err) {
        console.warn(`cell ${idx} (${id}) failed:`, err)
        cell.metaAEl.textContent = 'load failed'
        cell.metaBEl.textContent = ''
      }
    }),
  )
}

// Two-line label meta: `dimX × dimY × dimZ · pixX × pixY × pixZ mm` and
// `dtype · [calMin .. calMax]`. Kept terse so it stays readable in a narrow
// strip and degrades gracefully when the NIfTI header is sparse.
function volumeMetaText(nv: InstanceType<typeof NiiVue>): {
  lineA: string
  lineB: string
} {
  const v = nv.model.getVolumes()[0] as NVImage | undefined
  if (!v) return { lineA: '', lineB: '' }
  const hdr = v.hdr
  const dims = hdr?.dims ?? []
  const pix = hdr?.pixDims ?? []
  const dimStr =
    dims.length >= 4
      ? `${dims[1]}×${dims[2]}×${dims[3]}`
      : (v.dims ?? []).slice(1, 4).join('×')
  const pixStr =
    pix.length >= 4
      ? `${fmtNum(pix[1])}×${fmtNum(pix[2])}×${fmtNum(pix[3])} mm`
      : ''
  const dtype = dtypeName(hdr?.datatypeCode)
  const range = `${fmtNum(v.calMin)}..${fmtNum(v.calMax)}`
  return {
    lineA: pixStr ? `${dimStr} · ${pixStr}` : dimStr,
    lineB: `${dtype} · ${range}`,
  }
}

function fmtNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 100) return n.toFixed(0)
  if (Math.abs(n) >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

// NIfTI datatypeCode (subset relevant for fixtures). Falls back to the raw
// code so unfamiliar formats still show something traceable.
function dtypeName(code: number | undefined): string {
  switch (code) {
    case 2:
      return 'uint8'
    case 4:
      return 'int16'
    case 8:
      return 'int32'
    case 16:
      return 'float32'
    case 64:
      return 'float64'
    case 256:
      return 'int8'
    case 512:
      return 'uint16'
    case 768:
      return 'uint32'
    default:
      return code === undefined ? '?' : `dt${code}`
  }
}

// Volumes (subject-native T1w) and the ICBM152 hemisphere mesh live in different
// coordinate systems, so without a transform the mesh floats off-screen. For
// demo overlay quality we map the mesh bbox into the volume bbox via uniform
// scale (fit-to-90%) + translate-centers. Mutates positions in place then asks
// niivue to re-upload the GPU buffer; normals are regenerated from the new
// positions during upload.
async function alignCellMeshesToVolume(
  nv: InstanceType<typeof NiiVue>,
): Promise<void> {
  const volumes = nv.model.getVolumes() as NVImage[]
  const meshes = nv.model.getMeshes() as NVMesh[]
  if (volumes.length === 0 || meshes.length === 0) return
  const vol = volumes[0]
  if (!vol) return
  let mutated = false
  for (const mesh of meshes) {
    if (mesh.kind !== 'mesh') continue
    applyMeshAlignment(mesh, vol)
    mutated = true
  }
  if (mutated) await nv.updateGLVolume()
}

function applyMeshAlignment(mesh: NVMesh, vol: NVImage): void {
  const mSize = [
    mesh.extentsMax[0] - mesh.extentsMin[0],
    mesh.extentsMax[1] - mesh.extentsMin[1],
    mesh.extentsMax[2] - mesh.extentsMin[2],
  ]
  const vSize = [
    vol.extentsMax[0] - vol.extentsMin[0],
    vol.extentsMax[1] - vol.extentsMin[1],
    vol.extentsMax[2] - vol.extentsMin[2],
  ]
  if (mSize[0] <= 0 || mSize[1] <= 0 || mSize[2] <= 0) return
  const fit = 0.75
  const s = Math.min(
    (vSize[0] / mSize[0]) * fit,
    (vSize[1] / mSize[1]) * fit,
    (vSize[2] / mSize[2]) * fit,
  )
  const mCx = (mesh.extentsMin[0] + mesh.extentsMax[0]) / 2
  const mCy = (mesh.extentsMin[1] + mesh.extentsMax[1]) / 2
  const mCz = (mesh.extentsMin[2] + mesh.extentsMax[2]) / 2
  const vCx = (vol.extentsMin[0] + vol.extentsMax[0]) / 2
  const vCy = (vol.extentsMin[1] + vol.extentsMax[1]) / 2
  const vCz = (vol.extentsMin[2] + vol.extentsMax[2]) / 2
  // Anchor the mesh's rightmost extent to the volume's X center. For
  // hemisphere meshes (e.g. BrainMesh_ICBM152.lh) the +X end is the
  // midsagittal flat edge, so this places the cut surface at the volume
  // center with the curved hemisphere falling to -X. Y/Z are centered.
  const anchorX = vCx - (mSize[0] / 2) * s
  const p = mesh.positions
  let nMinX = Infinity
  let nMinY = Infinity
  let nMinZ = Infinity
  let nMaxX = -Infinity
  let nMaxY = -Infinity
  let nMaxZ = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    const x = (p[i] - mCx) * s + anchorX
    const y = (p[i + 1] - mCy) * s + vCy
    const z = (p[i + 2] - mCz) * s + vCz
    p[i] = x
    p[i + 1] = y
    p[i + 2] = z
    if (x < nMinX) nMinX = x
    if (y < nMinY) nMinY = y
    if (z < nMinZ) nMinZ = z
    if (x > nMaxX) nMaxX = x
    if (y > nMaxY) nMaxY = y
    if (z > nMaxZ) nMaxZ = z
  }
  mesh.extentsMin[0] = nMinX
  mesh.extentsMin[1] = nMinY
  mesh.extentsMin[2] = nMinZ
  mesh.extentsMax[0] = nMaxX
  mesh.extentsMax[1] = nMaxY
  mesh.extentsMax[2] = nMaxZ
}

function meshOptsFor(idx: number, meshUrl: string): MeshFromUrlOptions[] {
  const color = MESH_COLOR_BY_INDEX[idx % MESH_COLOR_BY_INDEX.length] ?? [
    0.7, 0.7, 0.7, 1,
  ]
  return [
    {
      url: meshUrl,
      rgba255: [
        Math.round(color[0] * 255),
        Math.round(color[1] * 255),
        Math.round(color[2] * 255),
        255,
      ],
    },
  ]
}

function currentMeshUrl(): string {
  const name = els.meshSelect.value
  if (!name) return ''
  return `/meshes/${name}`
}

function attachController(): void {
  if (controller) return
  controller = new NVCanvasViewportController(els.canvas, {
    apply: (vp) => {
      const first = cells[0]
      if (!first) return
      // Update bounds BEFORE setViewport — setViewport fans out resize+draw
      // to every sibling, so the new bounds get picked up in that same pass
      // without an extra round of draws.
      applyLodBounds(lodForZoom(vp.zoom))
      clearCanvas()
      first.nv.setViewport(vp)
      syncFromViewport(vp)
    },
    getViewport: () => getViewport(),
    panButton: 2,
    minZoom: 0.5,
    maxZoom: 50,
  })
  controller.attach()
}

function lodForZoom(zoom: number): number {
  if (zoom <= LOD_START) return 0
  if (zoom >= LOD_END) return 1
  const x = (zoom - LOD_START) / (LOD_END - LOD_START)
  // smoothstep
  return x * x * (3 - 2 * x)
}

// Mutates each cell's bounds in-place so the upcoming setViewport fan-out
// uses the new layout. `opts.bounds` is the same array reference the view
// reads in `_computeBoundsPixels`, so the change is picked up automatically
// on the next resize() without calling setBounds() (which would force a
// redundant drawScene per cell).
function applyLodBounds(t: number): void {
  // Snap to 1/100 steps so identical viewport ticks don't reassign the
  // bounds array every frame.
  const snapped = Math.round(t * 100) / 100
  if (snapped === lastLod) return
  lastLod = snapped
  for (const cell of cells) {
    const r = cellBoundsWorld(cell.row, cell.col, snapped)
    cell.nv.opts.bounds = [
      [r.x1, r.tileY1],
      [r.x2, r.y2],
    ]
  }
}

function positionLabels(vp: CanvasViewport): void {
  const rect = els.canvas.getBoundingClientRect()
  const cw = rect.width
  const ch = rect.height
  const z = vp.zoom
  const px = vp.pan[0]
  const py = vp.pan[1]
  // Label opacity ramps in over the upper portion of the LOD range so the
  // tiles separate visibly before text appears.
  const t = lastLod < 0 ? 0 : lastLod
  const opacity =
    t <= LABEL_REVEAL ? 0 : (t - LABEL_REVEAL) / (1 - LABEL_REVEAL)
  // Scale font with label height so a 7% strip stays legible without
  // overwhelming a tiny LOD-mid strip. Bound it between 9px and 15px.
  const stripPx = MAX_LABEL_HEIGHT * t * ch * z
  const fontPx = Math.max(9, Math.min(15, stripPx / 3.6))
  for (const cell of cells) {
    const r = cellBoundsWorld(cell.row, cell.col, t)
    // world → screen-normalized (GL y-up) → pixels (y-down).
    const sx1 = (r.x1 - 0.5) * z + 0.5 + px
    const sx2 = (r.x2 - 0.5) * z + 0.5 + px
    const sy1 = (r.y1 - 0.5) * z + 0.5 + py
    const syTile = (r.tileY1 - 0.5) * z + 0.5 + py
    const left = sx1 * cw
    const right = sx2 * cw
    // CSS top = (1 - screenY) * canvasHeight; the label strip sits between
    // screen-y `sy1` (bottom) and `syTile` (top, where the volume starts).
    const top = (1 - syTile) * ch
    const bottom = (1 - sy1) * ch
    cell.labelEl.style.left = `${left}px`
    cell.labelEl.style.top = `${top}px`
    cell.labelEl.style.width = `${Math.max(0, right - left)}px`
    cell.labelEl.style.height = `${Math.max(0, bottom - top)}px`
    cell.labelEl.style.opacity = String(opacity)
    cell.labelEl.style.fontSize = `${fontPx}px`
  }
}

function clearCanvas(): void {
  if (!gl) return
  gl.disable(gl.SCISSOR_TEST)
  gl.clearColor(CLEAR_COLOR[0], CLEAR_COLOR[1], CLEAR_COLOR[2], CLEAR_COLOR[3])
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
}

function wireControls(): void {
  els.sliceType.addEventListener('change', () => {
    const t = Number(els.sliceType.value)
    for (const cell of cells) {
      cell.nv.sliceType = t
    }
  })

  els.meshSelect.addEventListener('change', () => {
    void reloadMeshes()
  })

  els.zoomIn.addEventListener('click', () => {
    nudgeZoom(1.5)
  })
  els.zoomOut.addEventListener('click', () => {
    nudgeZoom(1 / 1.5)
  })
  els.zoomFit.addEventListener('click', () => {
    if (!controller) return
    controller.setViewport({ pan: [0, 0], zoom: 1 }, { animate: true })
  })

  els.canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault()
  })

  // Block wheel-zoom on the main canvas — NVCanvasViewportController attaches
  // its own bubble-phase wheel handler with no opt-out, so we register in the
  // capture phase and stop propagation before it can fire. Wheel-zoom is still
  // available over the minimap (which has its own listener).
  els.canvas.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
    },
    { capture: true, passive: false },
  )
}

async function reloadMeshes(): Promise<void> {
  const meshUrl = currentMeshUrl()
  setStatus(meshUrl ? `loading mesh ${meshUrl}…` : 'clearing meshes…')
  await Promise.all(
    cells.map(async (cell, idx) => {
      const existing = cell.nv.model.getMeshes()
      for (let i = existing.length - 1; i >= 0; i--) {
        await cell.nv.removeMesh(i)
      }
      if (meshUrl) {
        try {
          await cell.nv.loadMeshes(meshOptsFor(idx, meshUrl))
          await alignCellMeshesToVolume(cell.nv)
        } catch (err) {
          console.warn(`cell ${idx} mesh load failed:`, err)
        }
      }
    }),
  )
  setStatus(`${cells.length} cells · mesh: ${els.meshSelect.value || 'none'}`)
}

function nudgeZoom(factor: number): void {
  if (!controller) return
  const vp = getViewport()
  controller.setViewport(
    { pan: vp.pan, zoom: vp.zoom * factor },
    { animate: true },
  )
}

function getViewport(): CanvasViewport {
  const first = cells[0]
  if (!first) return { pan: [0, 0], zoom: 1 }
  return first.nv.getViewport()
}

function redrawAll(): void {
  clearCanvas()
  for (const cell of cells) {
    cell.nv.drawScene()
  }
}

function resizeCanvasToDisplay(): void {
  // Must match niivue's NVViewGL.resize() math (Math.floor on rect*dpr),
  // otherwise its resize() reassigns canvas.width every frame — which wipes
  // the entire backbuffer (HTML5 canvas spec) and leaves only the last
  // tile drawn during the multi-instance setViewport fan-out.
  const dpr = window.devicePixelRatio || 1
  const rect = els.canvas.getBoundingClientRect()
  const w = Math.max(1, Math.floor(rect.width * dpr))
  const h = Math.max(1, Math.floor(rect.height * dpr))
  if (els.canvas.width !== w) els.canvas.width = w
  if (els.canvas.height !== h) els.canvas.height = h
}

function updateHud(vp: CanvasViewport): void {
  els.hud.textContent = `zoom ${vp.zoom.toFixed(2)}× · pan ${vp.pan[0].toFixed(2)}, ${vp.pan[1].toFixed(2)} · right-drag sheet · wheel zooms · or use minimap`
}

function buildMinimapGrid(): void {
  els.minimapGrid.innerHTML = ''
  for (let i = 0; i < CELL_COUNT; i++) {
    const cellDiv = document.createElement('div')
    cellDiv.className = 'minimap-cell'
    const color = MESH_COLOR_BY_INDEX[i] ?? [0.5, 0.5, 0.5, 1]
    const r = Math.round(color[0] * 80)
    const g = Math.round(color[1] * 80)
    const b = Math.round(color[2] * 80)
    cellDiv.style.background = `rgb(${r},${g},${b})`
    els.minimapGrid.appendChild(cellDiv)
  }
}

// Minimap shows the world (canvas-normalized [0,1]²) in screen convention
// (y-down, top-left origin). Niivue's viewport math is:
//   screen.x = (world.x - 0.5) * zoom + 0.5 + pan.x
// Solving for the canvas-center world point gives:
//   world.x_center = 0.5 - pan.x / zoom
//   world.y_center = 0.5 - pan.y / zoom  (y-up)
// The minimap is y-down, so flip y to get mm.cy = 1 - world.y_center.
// Visible world-width = 1 / zoom (and height likewise).
function viewportToMinimapRect(vp: CanvasViewport): {
  cx: number
  cy: number
  w: number
  h: number
} {
  const w = 1 / vp.zoom
  const h = 1 / vp.zoom
  const cx = 0.5 - vp.pan[0] / vp.zoom
  const cy = 0.5 + vp.pan[1] / vp.zoom
  return { cx, cy, w, h }
}

// Inverse: minimap click (mx, my, y-down) → pan that centers that world
// point on the canvas. From the formulas above:
//   pan.x = (0.5 - mx) * zoom
//   pan.y = (my - 0.5) * zoom  (y-down minimap → y-up pan, sign flips)
function minimapToPan(mx: number, my: number, zoom: number): [number, number] {
  return [(0.5 - mx) * zoom, (my - 0.5) * zoom]
}

function syncFromViewport(maybeVp?: CanvasViewport): void {
  const vp = maybeVp ?? getViewport()
  updateHud(vp)
  const rect = viewportToMinimapRect(vp)
  const halfW = rect.w / 2
  const halfH = rect.h / 2
  const leftPct = (rect.cx - halfW) * 100
  const topPct = (rect.cy - halfH) * 100
  const wPct = rect.w * 100
  const hPct = rect.h * 100
  els.minimapView.style.left = `${leftPct}%`
  els.minimapView.style.top = `${topPct}%`
  els.minimapView.style.width = `${wPct}%`
  els.minimapView.style.height = `${hPct}%`
  positionLabels(vp)
}

function wireMinimap(): void {
  const minimap = els.minimap
  let panState: {
    pointerId: number
    startMx: number
    startMy: number
    startPan: [number, number]
  } | null = null

  function clientToMinimap(e: PointerEvent | WheelEvent): {
    mx: number
    my: number
  } {
    const rect = minimap.getBoundingClientRect()
    const mx = (e.clientX - rect.left) / rect.width
    const my = (e.clientY - rect.top) / rect.height
    return { mx, my }
  }

  function pointInViewRect(
    mx: number,
    my: number,
    vp: CanvasViewport,
  ): boolean {
    const r = viewportToMinimapRect(vp)
    return (
      mx >= r.cx - r.w / 2 &&
      mx <= r.cx + r.w / 2 &&
      my >= r.cy - r.h / 2 &&
      my <= r.cy + r.h / 2
    )
  }

  minimap.addEventListener('pointerdown', (e: PointerEvent) => {
    if (!controller) return
    e.preventDefault()
    const { mx, my } = clientToMinimap(e)
    const vp = getViewport()
    if (pointInViewRect(mx, my, vp)) {
      // Begin drag of the existing view rect.
      panState = {
        pointerId: e.pointerId,
        startMx: mx,
        startMy: my,
        startPan: [vp.pan[0], vp.pan[1]],
      }
      minimap.setPointerCapture(e.pointerId)
      minimap.style.cursor = 'grabbing'
    } else {
      // Recentre on click — convert minimap point to pan at current zoom.
      const nextPan = minimapToPan(mx, my, vp.zoom)
      controller.setViewport({ pan: nextPan, zoom: vp.zoom }, { animate: true })
    }
  })

  minimap.addEventListener('pointermove', (e: PointerEvent) => {
    if (!controller || !panState || panState.pointerId !== e.pointerId) return
    const { mx, my } = clientToMinimap(e)
    const dx = mx - panState.startMx
    const dy = my - panState.startMy
    const vp = getViewport()
    // Δmm_cx = dx → Δpan.x = -dx * zoom
    // Δmm_cy = dy (y-down) → Δworld_cy = -dy → Δpan.y = +dy * zoom
    const nextPan: [number, number] = [
      panState.startPan[0] - dx * vp.zoom,
      panState.startPan[1] + dy * vp.zoom,
    ]
    controller.setViewport({ pan: nextPan, zoom: vp.zoom })
  })

  function endPan(e: PointerEvent): void {
    if (!panState || panState.pointerId !== e.pointerId) return
    panState = null
    minimap.releasePointerCapture(e.pointerId)
    minimap.style.cursor = 'crosshair'
  }
  minimap.addEventListener('pointerup', endPan)
  minimap.addEventListener('pointercancel', endPan)

  minimap.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!controller) return
      e.preventDefault()
      const vp = getViewport()
      const factor = Math.exp(-e.deltaY * 0.0015)
      const nextZoom = Math.max(0.5, Math.min(50, vp.zoom * factor))
      if (nextZoom === vp.zoom) return
      const { mx, my } = clientToMinimap(e)
      // Keep the world point under the cursor fixed during zoom.
      // World point at cursor: WC = (mx, 1 - my) (y-flip; world is y-up).
      // Screen pos: s = (WC - 0.5) * z + 0.5 + pan. Hold s constant:
      //   pan_new = pan_old + (WC - 0.5) * (z_old - z_new)
      const wcx = mx
      const wcy = 1 - my
      const dz = vp.zoom - nextZoom
      const nextPan: [number, number] = [
        vp.pan[0] + (wcx - 0.5) * dz,
        vp.pan[1] + (wcy - 0.5) * dz,
      ]
      controller.setViewport({ pan: nextPan, zoom: nextZoom })
    },
    { passive: false },
  )
}

function setStatus(msg: string): void {
  els.statusPill.textContent = msg
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
