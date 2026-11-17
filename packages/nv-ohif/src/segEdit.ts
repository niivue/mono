import type NiiVue from '@niivue/niivue'
import { PEN_SHAPE, SLICE_TYPE } from '@niivue/niivue'
import { historyMemo } from './history'
import type { OhifExtensionManager } from './ohif-types'

// OHIF's labelmap tools on a NiiVue pane drive NiiVue's drawing pen (value =
// the active segment). Each finished edit is diffed against the previous
// drawing: threshold range and segment locks are enforced on that diff (no
// core change), and it becomes one step of OHIF's undo history, so undo and
// redo run from OHIF's buttons and hotkeys in one order with annotations.

interface Pen {
  erase?: true
  /** Fill the closed freehand stroke (lasso). */
  filled?: true
  threshold?: true
}

/**
 * OHIF tool name -> pen. ponytail: the sphere variants paint the current slice
 * (core's 2D pen is a disc); circle/rectangle/sphere scissors are a lasso
 * fill; dynamic threshold uses the configured range, not one sampled at the
 * click. Add each when a reviewer needs it.
 */
export const SEG_TOOLS: Readonly<Record<string, Pen>> = {
  CircularBrush: {},
  SphereBrush: {},
  CircularEraser: { erase: true },
  SphereEraser: { erase: true },
  ThresholdCircularBrush: { threshold: true },
  ThresholdSphereBrush: { threshold: true },
  ThresholdCircularBrushDynamic: { threshold: true },
  ThresholdSphereBrushDynamic: { threshold: true },
  CircleScissor: { filled: true },
  RectangleScissor: { filled: true },
  SphereScissor: { filled: true },
  LabelMapEditWithContour: { filled: true },
}

// OHIF's threshold option default (segmentationToolbarCustomization).
const DEFAULT_RANGE: [number, number] = [50, 600]

type ToolGroup = {
  getToolConfiguration?: (tool: string, key: string) => unknown
}
type CstLibs = {
  cornerstoneTools?: {
    utilities?: {
      segmentation?: {
        getBrushSizeForToolGroup?: (id: string) => number | undefined
      }
    }
    ToolGroupManager?: { getToolGroup?: (id: string) => ToolGroup | undefined }
  }
}

function cstLibs(em: OhifExtensionManager | undefined): CstLibs | undefined {
  const entry = em?.getModuleEntry(
    '@ohif/extension-cornerstone.utilityModule.common',
  ) as { exports?: { getCornerstoneLibraries?: () => unknown } } | undefined
  return entry?.exports?.getCornerstoneLibraries?.() as CstLibs | undefined
}

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
  const radius =
    cstLibs(
      extensionManager,
    )?.cornerstoneTools?.utilities?.segmentation?.getBrushSizeForToolGroup?.(
      toolGroupId,
    ) ?? 25
  nv.annotationIsEnabled = false
  nv.drawPenShape = PEN_SHAPE.CIRCLE
  nv.drawPenSize = pen.filled
    ? 1
    : penSizeFor(radius, nv.volumes[0]?.pixDimsRAS ?? [], nv.sliceType)
  nv.drawPenFilled = !!pen.filled
  nv.drawPenAutoClose = !!pen.filled
  nv.drawIsFillOverwriting = true
  if (pen.erase) nv.drawPenValue = 0
  else if (nv.drawPenValue === 0) nv.drawPenValue = activeValue.get(nv) ?? 1
  nv.drawIsEnabled = true
  return true
}

const activeValue = new WeakMap<NiiVue, number>()

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
  const kept = constrainEdit(
    session.shadow,
    bitmap,
    session.locked,
    intensity,
    intensity ? thresholdRange(session, em) : undefined,
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
  nv.addEventListener('drawingChanged', onDrawing)
  nv.addEventListener('pointerUp', onPointerUp)
  // Core keeps a cancelled pen stroke's voxels but emits neither pointerUp
  // nor its stroke event.
  const onPointerCancel = () => {
    if (nv.drawIsEnabled) run(true)
  }
  const { canvas } = nv
  canvas?.addEventListener('pointercancel', onPointerCancel)
  return () => {
    nv.removeEventListener('drawingChanged', onDrawing)
    nv.removeEventListener('pointerUp', onPointerUp)
    canvas?.removeEventListener('pointercancel', onPointerCancel)
    if (sessions.get(nv) === session) sessions.delete(nv)
    nv.drawIsEnabled = false
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
 * undoable edit. ponytail: interpolates every segment, not only the active one.
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
  const filled = await interpolateMaskSlices(
    draw.img,
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
  draw.img.set(filled)
  nv.refreshDrawing()
  nv.emit('drawingChanged', { action: 'update' })
  return true
}
