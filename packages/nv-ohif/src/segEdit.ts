import type NiiVue from '@niivue/niivue'
import type { DragReleaseInfo } from '@niivue/niivue'
import { DRAG_MODE, PEN_SHAPE, SLICE_TYPE } from '@niivue/niivue'
import { historyMemo } from './history'
import { cornerstoneLibraries } from './niivueRegistry'
import type { OhifExtensionManager } from './ohif-types'
import { apply, SLICE_AXIS } from './quantify'
import { lpsToVoxel } from './rtDrawing'

// OHIF's labelmap tools on a NiiVue pane drive NiiVue's drawing pen (value =
// the active segment). Each finished edit is diffed against the previous
// drawing: threshold range and segment locks are enforced on that diff (no
// core change), and it becomes one step of OHIF's undo history, so undo and
// redo run from OHIF's buttons and hotkeys in one order with annotations.

interface Pen {
  /** 3D ball across slices instead of the slice disc. */
  ball?: true
  erase?: true
  /** Fill the closed freehand stroke (lasso). */
  filled?: true
  /** Scissor: a drag (centre to edge, or corner to corner) fills this shape. */
  shape?: PEN_SHAPE
  threshold?: true
  /** The range is sampled at the stroke (cornerstone's isDynamic). */
  dynamic?: true
}

/**
 * OHIF tool name -> pen. ponytail: a scissor drag previews as NiiVue's
 * selection box (circle/sphere: the box from centre to edge).
 */
export const SEG_TOOLS: Readonly<Record<string, Pen>> = {
  CircularBrush: {},
  SphereBrush: { ball: true },
  CircularEraser: { erase: true },
  SphereEraser: { erase: true, ball: true },
  ThresholdCircularBrush: { threshold: true },
  ThresholdSphereBrush: { threshold: true, ball: true },
  ThresholdCircularBrushDynamic: { threshold: true, dynamic: true },
  ThresholdSphereBrushDynamic: { threshold: true, ball: true, dynamic: true },
  CircleScissor: { shape: PEN_SHAPE.CIRCLE },
  RectangleScissor: { shape: PEN_SHAPE.RECTANGLE },
  SphereScissor: { shape: PEN_SHAPE.SPHERE },
  LabelMapEditWithContour: { filled: true },
}

// OHIF's threshold option default (segmentationToolbarCustomization).
const DEFAULT_RANGE: [number, number] = [50, 600]
// OHIF's threshold.dynamicRadius (voxels) for the dynamic brushes.
const DYNAMIC_RADIUS = 3

/** Row-major 3x4 RAS mm -> RAS voxel of the pane's base (inverse vox2mm). */
function rasToVoxel(nv: NiiVue): number[] | null {
  const m = lpsToVoxel((v) => nv.vox2mm(v))
  // lpsToVoxel takes LPS mm: negate its x and y columns to take RAS.
  if (m) for (const i of [0, 1, 4, 5, 8, 9]) m[i] = -(m[i] as number)
  return m
}

/** The RAS voxel of the pane's base under a client point (2D tiles only). */
function rasVoxelAt(
  nv: NiiVue,
  clientX: number,
  clientY: number,
): [number, number, number] | undefined {
  const xy = nv.clientToCanvas(clientX, clientY)
  const mm = xy && nv.canvasToMM(xy[0], xy[1])
  return mm ? rasVoxelOfMM(nv, mm) : undefined
}

/** The RAS voxel of the pane's base at RAS point `mm`. */
function rasVoxelOfMM(
  nv: NiiVue,
  mm: ArrayLike<number>,
): [number, number, number] | undefined {
  const m = rasToVoxel(nv)
  if (!m) return undefined
  return [0, 1, 2].map((r) => Math.round(apply(m, mm, r))) as [
    number,
    number,
    number,
  ]
}

/** The drawing's value under a client point (0 off the drawing). */
export function drawingValueAt(
  nv: NiiVue,
  clientX: number,
  clientY: number,
): number {
  return drawingValueOfVoxel(nv, rasVoxelAt(nv, clientX, clientY))
}

/** The drawing's value at RAS point `mm` (0 off the drawing). */
export function drawingValueAtMM(nv: NiiVue, mm: ArrayLike<number>): number {
  return drawingValueOfVoxel(nv, rasVoxelOfMM(nv, mm))
}

function drawingValueOfVoxel(
  nv: NiiVue,
  v: [number, number, number] | undefined,
): number {
  const img = nv.drawingVolume?.img
  const dims = nv.volumes[0]?.dimsRAS
  if (!img || !v || !dims) return 0
  const [, nx = 0, ny = 0, nz = 0] = dims
  const [x, y, z] = v
  if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) return 0
  return Number(img[x + nx * (y + ny * z)])
}

/**
 * cornerstone's dynamic threshold: min/max over the in-plane disk (radius
 * DYNAMIC_RADIUS voxels, `fixed` = the RAS axis normal to the view) around the
 * stroke's first centre, widened by the value under every later centre.
 * `centers` are RAS voxel indices; `dims` the RAS grid.
 */
export function dynamicRange(
  intensity: (i: number) => number,
  dims: readonly [number, number, number],
  centers: ReadonlyArray<readonly [number, number, number]>,
  fixed: number,
): [number, number] | undefined {
  const [first, ...rest] = centers
  if (!first) return undefined
  const [nx, ny, nz] = dims
  const range: [number, number] = [Infinity, -Infinity]
  const add = (x: number, y: number, z: number) => {
    const g = intensity(x + nx * (y + ny * z))
    if (g < range[0]) range[0] = g
    if (g > range[1]) range[1] = g
  }
  const r = DYNAMIC_RADIUS
  const lo = first.map((c, a) => (a === fixed ? c : Math.max(0, c - r)))
  const hi = first.map((c, a) =>
    a === fixed ? c : Math.min([nx, ny, nz][a] as number, c + r + 1) - 1,
  )
  for (let z = lo[2] as number; z <= (hi[2] as number); z++)
    for (let y = lo[1] as number; y <= (hi[1] as number); y++)
      for (let x = lo[0] as number; x <= (hi[0] as number); x++) {
        const d =
          (x - first[0]) ** 2 + (y - first[1]) ** 2 + (z - first[2]) ** 2
        if (d <= r * r) add(x, y, z)
      }
  for (const [x, y, z] of rest) add(x, y, z)
  return range
}

type ToolGroup = {
  getToolConfiguration?: (tool: string, key: string) => unknown
  getToolInstance?: (tool: string) => { mode?: string } | undefined
}
type CstLibs = {
  cornerstone?: { eventTarget?: EventTarget }
  cornerstoneTools?: {
    utilities?: {
      segmentation?: {
        getBrushSizeForToolGroup?: (id: string) => number | undefined
      }
    }
    ToolGroupManager?: { getToolGroup?: (id: string) => ToolGroup | undefined }
  }
}

/** Cornerstone tool `tool`'s mode in tool group `toolGroupId` ('Active', 'Enabled', ...). */
export function toolMode(
  em: OhifExtensionManager | undefined,
  toolGroupId: string,
  tool: string,
): string | undefined {
  const group =
    cstLibs(em)?.cornerstoneTools?.ToolGroupManager?.getToolGroup?.(toolGroupId)
  return group?.getToolInstance?.(tool)?.mode
}

/**
 * Calls `cb(mode)` when cornerstone changes `tool`'s mode in `toolGroupId`
 * (e.g. its toolbar toggle disables it without activating another tool);
 * returns the unsubscribe.
 */
export function onToolModeChanged(
  em: OhifExtensionManager | undefined,
  toolGroupId: string,
  tool: string,
  cb: (mode: string | undefined) => void,
): () => void {
  const target = cstLibs(em)?.cornerstone?.eventTarget
  const fn = (e: Event) => {
    const d = (e as CustomEvent).detail
    if (d?.toolGroupId === toolGroupId && d.toolName === tool) cb(d.mode)
  }
  // cornerstoneTools Enums.Events.TOOL_MODE_CHANGED
  target?.addEventListener('CORNERSTONE_TOOLS_TOOL_MODE_CHANGED', fn)
  return () =>
    target?.removeEventListener('CORNERSTONE_TOOLS_TOOL_MODE_CHANGED', fn)
}

const cstLibs = (em: OhifExtensionManager | undefined) =>
  cornerstoneLibraries<CstLibs>(em)

interface Session {
  /** Its segmentation's id. */
  groupId?: string
  /**
   * Shared by the live sessions of one segmentation: an edit reaches them all.
   * A memo outliving them (pane remount, SEG reload) matches no new session.
   */
  group: object
  shadow: Uint8Array
  stroked: boolean
  tool?: string
  toolGroupId: string
  locked: ReadonlySet<number>
  /** The stroke's brush centres (RAS voxels), for a dynamic threshold. */
  centers: Array<[number, number, number]>
  extensionManager?: OhifExtensionManager
  onEdit: () => void
}
const sessions = new Map<NiiVue, Session>()
// The pane's tool before its drawing became editable, applied when it does.
const lastTool = new WeakMap<NiiVue, { tool?: string; toolGroupId: string }>()

/**
 * NiiVue pen size (voxel diameter) for an OHIF brush radius in mm, from the
 * RAS spacing in the plane drawn on (any plane in a multiplanar or 3D view).
 */
export function penSizeFor(
  radiusMm: number,
  pixDimsRAS: ArrayLike<number>,
  sliceType?: number,
) {
  const [, x = 1, y = 1, z = 1] = Array.from(pixDimsRAS)
  const inPlane =
    sliceType === SLICE_TYPE.AXIAL
      ? [x, y]
      : sliceType === SLICE_TYPE.CORONAL
        ? [x, z]
        : sliceType === SLICE_TYPE.SAGITTAL
          ? [y, z]
          : [x, y, z]
  return Math.max(1, Math.round((2 * radiusMm) / Math.min(...inPlane)))
}

/** `nv`'s pen size for OHIF's brush size of `toolGroupId` (default 25 mm). */
export function ohifPenSize(
  nv: NiiVue,
  toolGroupId: string,
  extensionManager: OhifExtensionManager | undefined,
): number {
  const radius =
    cstLibs(
      extensionManager,
    )?.cornerstoneTools?.utilities?.segmentation?.getBrushSizeForToolGroup?.(
      toolGroupId,
    ) ?? 25
  return penSizeFor(radius, nv.volumes[0]?.pixDimsRAS ?? [], nv.sliceType)
}

/**
 * Point `nv`'s pen at OHIF tool `tool`: true when it is a labelmap tool and
 * the pane has a drawing to edit (the drawing then owns the left button).
 */
export function applySegTool(
  nv: NiiVue,
  tool: string | undefined,
  toolGroupId: string,
  extensionManager: OhifExtensionManager | undefined,
): boolean {
  const pen = tool ? SEG_TOOLS[tool] : undefined
  const session = sessions.get(nv)
  lastTool.set(nv, { tool, toolGroupId })
  if (session) {
    session.tool = tool
    session.toolGroupId = toolGroupId
  }
  if (!pen || !session || !nv.drawingVolume) {
    if (nv.drawIsEnabled) nv.drawIsEnabled = false
    return false
  }
  nv.annotationIsEnabled = false
  if (pen.erase) nv.drawPenValue = 0
  else if (nv.drawPenValue === 0) nv.drawPenValue = activeValue.get(nv) ?? 1
  // Scissors: the left drag reports its box (dragRelease, below), no pen.
  if (pen.shape !== undefined) {
    nv.drawIsEnabled = false
    nv.primaryDragMode = DRAG_MODE.callbackOnly
    return true
  }
  nv.drawPenShape = pen.ball ? PEN_SHAPE.SPHERE : PEN_SHAPE.CIRCLE
  nv.drawPenSize = pen.filled
    ? 1
    : ohifPenSize(nv, toolGroupId, extensionManager)
  nv.drawPenFilled = !!pen.filled
  nv.drawPenAutoClose = !!pen.filled
  nv.drawIsFillOverwriting = true
  nv.drawIsEnabled = true
  return true
}

const activeValue = new WeakMap<NiiVue, number>()

/** The panel's active segment on `nv` (the pen's value before any). */
export const activeSegmentValue = (nv: NiiVue): number =>
  activeValue.get(nv) ?? (nv.drawPenValue || 1)

/** The segment the pen paints (the panel's active segment). */
export function setActiveSegmentValue(nv: NiiVue, value: number) {
  activeValue.set(nv, value)
  const tool = sessions.get(nv)?.tool
  if (!tool || !SEG_TOOLS[tool]?.erase) nv.drawPenValue = value
}

/**
 * Restore voxels the edit (shadow -> bitmap) changed against the rules: a
 * locked segment's voxels stay, and a threshold tool paints only where the
 * base is in `range`. Returns the indices still changed.
 */
export function constrainEdit(
  shadow: Uint8Array,
  bitmap: Uint8Array,
  locked: ReadonlySet<number>,
  intensity?: (i: number) => number,
  range?: readonly [number, number],
): number[] {
  const kept: number[] = []
  const [lo, hi] = range ?? [0, 0]
  for (let i = 0; i < bitmap.length; i++) {
    const was = shadow[i] as number
    const now = bitmap[i] as number
    if (was === now) continue
    if (
      locked.has(was) ||
      (intensity && now !== 0 && !(intensity(i) >= lo && intensity(i) <= hi))
    )
      bitmap[i] = was
    else kept.push(i)
  }
  return kept
}

function thresholdRange(
  session: Session,
  em: OhifExtensionManager | undefined,
): [number, number] {
  const group = cstLibs(em)?.cornerstoneTools?.ToolGroupManager?.getToolGroup?.(
    session.toolGroupId,
  )
  const t = group?.getToolConfiguration?.(session.tool ?? '', 'threshold') as
    | { range?: [number, number] }
    | undefined
  return t?.range ?? DEFAULT_RANGE
}

/**
 * Scaled intensity of `v` at a RAS voxel index, read live: a 4D frame or a
 * computed volume rewrites the voxels in place. Reads only the edited voxels,
 * so no full-volume copy.
 */
export function rasIntensity(v: NiiVue['volumes'][number]) {
  const { img, dimsRAS: dims, img2RASstep: step, img2RASstart: start } = v
  if (!img || !dims || !step || !start) return undefined
  const slope = v.hdr?.scl_slope || 1
  const inter = v.hdr?.scl_inter || 0
  const [, vx = 1, vy = 1] = dims
  const [s0 = 0, s1 = 0, s2 = 0] = start
  const [dx = 0, dy = 0, dz = 0] = step
  const offset = s0 + s1 + s2
  return (i: number) => {
    const x = i % vx
    const y = Math.floor(i / vx) % vy
    const z = Math.floor(i / (vx * vy))
    return Number(img[offset + x * dx + y * dy + z * dz]) * slope + inter
  }
}

/** Diff, constrain and record the edit since the last commit. */
function commit(
  nv: NiiVue,
  session: Session,
  em: OhifExtensionManager | undefined,
  isStroke: boolean,
) {
  const bitmap = nv.drawingVolume?.img
  if (
    !(bitmap instanceof Uint8Array) ||
    bitmap.length !== session.shadow.length
  )
    return
  const pen = session.tool ? SEG_TOOLS[session.tool] : undefined
  let intensity: ((i: number) => number) | undefined
  // The threshold applies to a stroke, not to extension edits (interpolation).
  if (pen?.threshold && isStroke) {
    const back = nv.volumes[0]
    intensity = back && rasIntensity(back)
  }
  const dims = nv.volumes[0]?.dimsRAS
  const range =
    intensity && pen?.dynamic && dims
      ? dynamicRange(
          intensity,
          [dims[1], dims[2], dims[3]] as [number, number, number],
          session.centers,
          SLICE_AXIS[nv.sliceType] ?? 2,
        )
      : undefined
  session.centers = []
  const kept = constrainEdit(
    session.shadow,
    bitmap,
    session.locked,
    intensity,
    intensity ? (range ?? thresholdRange(session, em)) : undefined,
  )
  if (!kept.length) {
    nv.refreshDrawing()
    return
  }
  const before = Uint8Array.from(kept, (i) => session.shadow[i] as number)
  const after = Uint8Array.from(kept, (i) => bitmap[i] as number)
  const { group } = session
  writeVoxels(group, kept, after)
  historyMemo(em)?.push({
    id: crypto.randomUUID(),
    restoreMemo: (undo?: boolean) =>
      writeVoxels(group, kept, undo ? before : after),
  })
}

/**
 * Write `values` at `indices` into every live pane of session group `group`
 * (pane `written` has them already); false when none is left.
 */
function writeVoxels(
  group: object,
  indices: ArrayLike<number>,
  values: ArrayLike<number>,
  written?: NiiVue,
): boolean {
  let live = false
  for (const [nv, s] of sessions) {
    if (s.group !== group) continue
    live = true
    const img = nv.drawingVolume?.img
    if (nv === written) {
      nv.refreshDrawing()
      s.onEdit()
      continue
    }
    if (!(img instanceof Uint8Array) || img.length !== s.shadow.length) continue
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k] as number
      img[i] = values[k] as number
      s.shadow[i] = values[k] as number
    }
    nv.refreshDrawing()
    s.onEdit()
  }
  return live
}

/** Re-apply every editable pane's tool (the brush radius changed). */
export function refreshSegTools(): void {
  for (const [nv, s] of sessions)
    applySegTool(nv, s.tool, s.toolGroupId, s.extensionManager)
}

/**
 * Track `nv`'s drawing edits until the cleanup: commit each finished stroke
 * (and extension edits) as above. `locked` is read per commit.
 */
export function startSegEditing(
  nv: NiiVue,
  options: {
    toolGroupId?: string
    /** The segmentation id: panes showing it share their edits. */
    group?: string
    extensionManager?: OhifExtensionManager
    locked: () => ReadonlySet<number>
    onEdit: () => void
  },
): () => void {
  const img = nv.drawingVolume?.img
  let peer: Session | undefined
  for (const s of sessions.values())
    if (options.group !== undefined && s.groupId === options.group) peer = s
  const session: Session = {
    groupId: options.group,
    group: peer?.group ?? {},
    shadow: img instanceof Uint8Array ? img.slice() : new Uint8Array(),
    stroked: false,
    toolGroupId: options.toolGroupId ?? 'default',
    locked: new Set(),
    centers: [],
    extensionManager: options.extensionManager,
    onEdit: options.onEdit,
  }
  sessions.set(nv, session)
  const last = lastTool.get(nv)
  if (last)
    applySegTool(nv, last.tool, last.toolGroupId, options.extensionManager)
  const reset = () => {
    const now = nv.drawingVolume?.img
    session.shadow = now instanceof Uint8Array ? now.slice() : new Uint8Array()
    session.stroked = false
  }
  const run = (isStroke: boolean) => {
    session.locked = options.locked()
    session.stroked = false
    commit(nv, session, options.extensionManager, isStroke)
  }
  const onDrawing = (e: Event) => {
    const action = (e as CustomEvent<{ action: string }>).detail?.action
    if (action === 'stroke') session.stroked = true
    else if (action === 'update') run(false)
    else reset()
  }
  const onPointerUp = () => {
    if (session.stroked) run(true)
  }
  // A primary scissor drag fills its shape; drawShapeFill's 'update' commits
  // it. dragRelease carries no button and fires for every drag mode.
  let button = 0
  // A dynamic threshold samples where the brush goes (RAS voxel per event).
  const onPointerMove = (e: PointerEvent) => {
    const tool = session.tool ? SEG_TOOLS[session.tool] : undefined
    if (!tool?.dynamic || !(e.buttons & 1)) return
    const v = rasVoxelAt(nv, e.clientX, e.clientY)
    if (!v) return
    const last = session.centers.at(-1)
    if (!last || last.some((c, a) => c !== v[a])) session.centers.push(v)
  }
  const onPointerDown = (e: PointerEvent) => {
    button = e.button
    session.centers = []
    onPointerMove(e)
  }
  const onDragRelease = (e: Event) => {
    const shape = session.tool ? SEG_TOOLS[session.tool]?.shape : undefined
    const info = (e as CustomEvent<DragReleaseInfo>).detail
    if (shape === undefined || button !== 0 || !info?.mmLength) return
    nv.drawIsFillOverwriting = true
    nv.drawShapeFill(shape, info.mmStart, info.mmEnd, info.axCorSag)
  }
  nv.addEventListener('drawingChanged', onDrawing)
  nv.addEventListener('pointerUp', onPointerUp)
  nv.addEventListener('dragRelease', onDragRelease)
  // Core keeps a cancelled pen stroke's voxels but emits neither pointerUp
  // nor its stroke event.
  const onPointerCancel = () => {
    if (nv.drawIsEnabled) run(true)
  }
  const { canvas } = nv
  canvas?.addEventListener('pointercancel', onPointerCancel)
  canvas?.addEventListener('pointerdown', onPointerDown, true)
  canvas?.addEventListener('pointermove', onPointerMove)
  return () => {
    canvas?.removeEventListener('pointermove', onPointerMove)
    nv.removeEventListener('drawingChanged', onDrawing)
    nv.removeEventListener('pointerUp', onPointerUp)
    nv.removeEventListener('dragRelease', onDragRelease)
    canvas?.removeEventListener('pointercancel', onPointerCancel)
    canvas?.removeEventListener('pointerdown', onPointerDown, true)
    if (sessions.get(nv) === session) sessions.delete(nv)
    nv.drawIsEnabled = false
    if (nv.primaryDragMode === DRAG_MODE.callbackOnly)
      nv.primaryDragMode = DRAG_MODE.crosshair
  }
}

/**
 * Zero `value`'s voxels in every pane of `nv`'s segmentation (its segment was
 * deleted); not an undo step. Returns a writer of those voxels bound to the segmentation's live panes at deletion: false (no
 * write) once all have stopped, so history never reaches a replacement.
 */
export function eraseSegmentValue(
  nv: NiiVue,
  value: number,
): ((value: number) => boolean) | undefined {
  const img = nv.drawingVolume?.img
  const session = sessions.get(nv)
  if (
    !(img instanceof Uint8Array) ||
    !session ||
    img.length !== session.shadow.length
  )
    return undefined
  const { shadow, group } = session
  // Whole-volume buffer: no growth check (or JS array push) per voxel.
  const found = new Int32Array(img.length)
  let n = 0
  for (let i = 0; i < img.length; i++) {
    if (img[i] !== value) continue
    found[n++] = i
    img[i] = 0
    shadow[i] = 0
  }
  const indices = found.slice(0, n)
  const write = (v: number, written?: NiiVue) =>
    writeVoxels(group, indices, new Uint8Array(n).fill(v), written)
  if (n) write(0, nv)
  return write
}

/**
 * OHIF's InterpolateLabelmap on a NiiVue pane: fill the slices between drawn
 * ones (nv-ext-drawing), along the pane's 2D view (axial otherwise), as one
 * undoable edit. As cornerstone, only the active segment, into empty voxels.
 */
export async function interpolateDrawing(nv: NiiVue): Promise<boolean> {
  const draw = nv.drawingVolume
  const back = nv.volumes[0]
  const dims = back?.dimsRAS
  if (!draw || !(draw.img instanceof Uint8Array) || !back || !dims) return false
  const { interpolateMaskSlices } = await import('@niivue/nv-ext-drawing')
  const view = nv.sliceType
  const sliceType =
    view === SLICE_TYPE.CORONAL || view === SLICE_TYPE.SAGITTAL
      ? view
      : SLICE_TYPE.AXIAL
  const active = activeSegmentValue(nv)
  const filled = await interpolateMaskSlices(
    draw.img.map((v) => (v === active ? v : 0)),
    {
      dimX: dims[1] as number,
      dimY: dims[2] as number,
      dimZ: dims[3] as number,
    },
    null,
    1,
    undefined,
    undefined,
    { sliceType: sliceType as 0 | 1 | 2 },
  )
  if (nv.drawingVolume !== draw) return false
  const img = draw.img
  for (let i = 0; i < img.length; i++)
    if (filled[i] === active && img[i] === 0) img[i] = active
  nv.refreshDrawing()
  nv.emit('drawingChanged', { action: 'update' })
  return true
}
