import type NiiVue from '@niivue/niivue'
import { ohifServices } from './niivueRegistry'
import type {
  OhifDisplaySet,
  OhifExtensionManager,
  OhifServicesManager,
} from './ohif-types'
import type { RtLabels } from './rtDrawing'

// OHIF's segmentation panel lists cornerstone's segmentation state for the
// active viewport id. A NiiVue pane's SEG drawing is entered there as a
// segmentation without voxel data (NiiVue keeps rendering its own drawing) and
// panel edits are mirrored back into the drawing. cornerstone refuses a
// representation on a viewport outside its rendering engine, so it is written
// into the state directly; everything the panel then calls is keyed by id only.

const CORNERSTONE_COMMON = '@ohif/extension-cornerstone.utilityModule.common'
const LABELMAP = 'Labelmap'

type Color = number[]
type Rep = {
  visible?: boolean
  segments?: Record<number, { visible?: boolean }>
}
type Segment = { label?: string }
type Style = {
  renderFill?: boolean
  renderOutline?: boolean
  fillAlpha?: number
  outlineOpacity?: number
}
type Specifier = { segmentationId: string; type: string }
interface CstSegmentation {
  addSegmentations(input: unknown[]): void
  removeSegmentationRepresentations(viewportId: string, s: object): void
  state: {
    getSegmentation(
      id: string,
    ): { segments: Record<string, Segment> } | undefined
    getSegmentationRepresentation(
      viewportId: string,
      s: Specifier,
    ): Rep | undefined
  }
  config: {
    color: {
      addColorLUT(lut: Color[]): number
      getSegmentIndexColor(
        viewportId: string,
        id: string,
        i: number,
      ): Color | null
    }
    style: { getStyle(s: Specifier & { viewportId: string }): Style }
  }
  defaultSegmentationStateManager: {
    updateState(
      fn: (state: {
        viewportSegRepresentations: Record<string, unknown[]>
      }) => void,
    ): void
    addDefaultSegmentationRepresentation(
      state: unknown,
      viewportId: string,
      id: string,
      type: string,
      config: { colorLUTIndex: number },
    ): void
  }
  segmentationStyle: {
    setRenderInactiveSegmentations(viewportId: string, v: boolean): void
  }
  triggerSegmentationEvents: {
    triggerSegmentationRepresentationModified(
      viewportId: string,
      id: string,
      type: string,
    ): void
  }
}
interface SegmentationServiceLike {
  EVENTS: Record<string, string>
  subscribe(
    event: string,
    cb: (e?: { segmentationId?: string }) => void,
  ): { unsubscribe(): void }
  setActiveSegmentation(viewportId: string, id: string): void
  setActiveSegment(id: string, index: number): void
}

// As NiiVue's drawing demo: a translucent fill under an opaque rim.
export const SEG_FILL_OPACITY = 0.5
export const SEG_RIM_OPACITY = 1

export type SegmentStats = { count: number; centroid: [number, number, number] }

export interface PanelSegment {
  value: number
  label: string
  rgb: [number, number, number]
}

/** Per-label voxel count and RAS-voxel centroid of a drawing bitmap, one pass. */
export function labelStats(bitmap: Uint8Array, dims: ArrayLike<number>) {
  const [nx = 0, ny = 0, nz = 0] = Array.from(dims)
  const n = new Float64Array(256)
  const sx = new Float64Array(256)
  const sy = new Float64Array(256)
  const sz = new Float64Array(256)
  let i = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i++) {
        const v = bitmap[i] as number
        if (v === 0) continue
        n[v] = (n[v] as number) + 1
        sx[v] = (sx[v] as number) + x
        sy[v] = (sy[v] as number) + y
        sz[v] = (sz[v] as number) + z
      }
  const stats = new Map<number, SegmentStats>()
  for (let v = 1; v < 256; v++) {
    const count = n[v] as number
    if (count)
      stats.set(v, {
        count,
        centroid: [
          (sx[v] as number) / count,
          (sy[v] as number) / count,
          (sz[v] as number) / count,
        ],
      })
  }
  return stats
}

/**
 * NiiVue drawing opacities for a cornerstone labelmap style. The shader draws a
 * rim only where the fill alpha is nonzero, so outline-only keeps a 1/255 fill.
 */
export function drawOpacities(style: Style): { fill: number; rim: number } {
  const fill = style.renderFill === false ? 0 : (style.fillAlpha ?? 0.5)
  const rim = style.renderOutline === false ? -1 : (style.outlineOpacity ?? 1)
  return { fill: rim >= 0 && fill === 0 ? 1 / 255 : fill, rim }
}

/** Label colormap of the panel's segments; a hidden one gets alpha 0. */
export function panelColormap(
  rows: ReadonlyArray<{
    value: number
    label: string
    color: Color
    visible: boolean
  }>,
) {
  const cmap = { R: [0], G: [0], B: [0], A: [0], I: [0], labels: [''] }
  for (const r of rows) {
    cmap.R.push(r.color[0] ?? 0)
    cmap.G.push(r.color[1] ?? 0)
    cmap.B.push(r.color[2] ?? 0)
    cmap.A.push(r.visible ? (r.color[3] ?? 255) : 0)
    cmap.I.push(r.value)
    cmap.labels.push(r.label)
  }
  return cmap
}

function cornerstoneSegmentation(
  extensionManager: OhifExtensionManager | undefined,
): CstSegmentation | undefined {
  const entry = extensionManager?.getModuleEntry(CORNERSTONE_COMMON) as
    | { exports?: { getCornerstoneLibraries?: () => unknown } }
    | undefined
  const libs = entry?.exports?.getCornerstoneLibraries?.() as
    | { cornerstoneTools?: { segmentation?: CstSegmentation } }
    | undefined
  return libs?.cornerstoneTools?.segmentation
}

const panels = new Map<
  string,
  { segmentationId: string; jump(index: number): void }
>()

/**
 * The panel's "click segment" on a NiiVue pane: activate it and move the
 * crosshair to its centroid. False when the pane does not show `segmentationId`.
 */
export function jumpToNiivueSegment(
  servicesManager: OhifServicesManager | undefined,
  viewportId: string | undefined,
  segmentationId: string,
  segmentIndex: number,
): boolean {
  const panel = viewportId ? panels.get(viewportId) : undefined
  if (!viewportId || panel?.segmentationId !== segmentationId) return false
  const service = ohifServices(servicesManager)?.segmentationService as
    | SegmentationServiceLike
    | undefined
  service?.setActiveSegmentation(viewportId, segmentationId)
  service?.setActiveSegment(segmentationId, segmentIndex)
  panel.jump(segmentIndex)
  return true
}

/**
 * List `seg`'s segments (shown as `nv`'s drawing) in OHIF's segmentation panel
 * for `viewportId` and mirror panel visibility, colour, label and fill/outline
 * style into the drawing. Returns the cleanup.
 */
export function startSegPanel(
  nv: Pick<
    NiiVue,
    | 'addColormap'
    | 'drawColormap'
    | 'drawOpacity'
    | 'drawRimOpacity'
    | 'drawingVolume'
    | 'volumes'
    | 'vox2mm'
    | 'setCrosshairPos'
  >,
  viewportId: string,
  seg: OhifDisplaySet,
  segments: ReadonlyArray<PanelSegment>,
  managers: {
    servicesManager?: OhifServicesManager
    extensionManager?: OhifExtensionManager
  },
  /** RT ROIs overlap: the bitmap holds neither their stats nor hidden ones' voxels. */
  rt?: RtLabels,
): () => void {
  const cst = cornerstoneSegmentation(managers.extensionManager)
  const service = ohifServices(managers.servicesManager)?.segmentationService as
    | SegmentationServiceLike
    | undefined
  const bitmap = nv.drawingVolume?.img
  const back = nv.volumes[0]
  // The id is the SEG display set's, as OHIF's own: a segmentation added under
  // another id makes OHIF create a display set for it.
  const segmentationId = seg.displaySetInstanceUID
  if (
    !cst ||
    !service ||
    !(bitmap instanceof Uint8Array) ||
    !back?.dimsRAS ||
    !segmentationId
  )
    return () => {}
  const stats = rt?.stats ?? labelStats(bitmap, back.dimsRAS.slice(1, 4))
  const [, px = 1, py = 1, pz = 1] = back.hdr?.pixDims ?? []
  // A second pane on the same SEG shares the segmentation, with its own colours.
  const lut: Color[] = [[0, 0, 0, 0]]
  for (const s of segments) lut[s.value] = [...s.rgb, 255]
  for (let i = 0; i < lut.length; i++) lut[i] ??= [0, 0, 0, 0]
  if (!cst.state.getSegmentation(segmentationId))
    cst.addSegmentations([
      {
        segmentationId,
        representation: { type: LABELMAP, data: { imageIds: [] } },
        config: {
          label: seg.SeriesDescription,
          fallbackLabel: `S:${seg.SeriesNumber ?? ''} ${seg.Modality ?? 'SEG'}`,
          segments: Object.fromEntries(
            segments.map((s) => {
              const count = stats.get(s.value)?.count ?? 0
              return [
                s.value,
                {
                  segmentIndex: s.value,
                  label: s.label,
                  locked: false,
                  active: false,
                  // No `center`: OHIF's own jump would then look for a cornerstone viewport.
                  cachedStats: { count, volume: count * px * py * pz },
                },
              ]
            }),
          ),
        },
      },
    ])
  addRepresentation(
    cst,
    viewportId,
    segmentationId,
    cst.config.color.addColorLUT(lut),
  )

  const specifier = { segmentationId, type: LABELMAP }
  const colormapName = `seg-panel-${viewportId}`
  let applied = ''
  // RT: the voxels shown, as filled (all ROIs) at first.
  let shown = segments.map((s) => s.value).join()
  const sync = () => {
    const segmentation = cst.state.getSegmentation(segmentationId)
    const rep = cst.state.getSegmentationRepresentation(viewportId, specifier)
    // Deleted or removed from the pane in the panel: hide the drawing.
    if (!segmentation || !rep) {
      applied = ''
      nv.drawOpacity = 0
      nv.drawRimOpacity = -1
      return
    }
    const rows = Object.entries(segmentation.segments).map(([key, s]) => {
      const value = Number(key)
      return {
        value,
        label: s.label ?? key,
        color: cst.config.color.getSegmentIndexColor(
          viewportId,
          segmentationId,
          value,
        ) ?? [0, 0, 0, 0],
        visible:
          rep.visible !== false && rep.segments?.[value]?.visible !== false,
      }
    })
    const { fill, rim } = drawOpacities(
      cst.config.style.getStyle({ viewportId, ...specifier }),
    )
    // Events fire for unrelated edits too; rebuilding the drawing texture is not free.
    const key = JSON.stringify([rows, fill, rim])
    if (key === applied) return
    applied = key
    const visible = rows.filter((r) => r.visible).map((r) => r.value)
    if (rt && visible.join() !== shown) {
      shown = visible.join()
      rt.showOnly(new Set(visible))
    }
    nv.drawColormap = nv.addColormap(colormapName, panelColormap(rows))
    nv.drawOpacity = fill
    nv.drawRimOpacity = rim
  }
  sync()

  const { EVENTS } = service
  const subscriptions = [
    EVENTS.SEGMENTATION_MODIFIED,
    EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
    EVENTS.SEGMENTATION_STYLE_MODIFIED,
    EVENTS.SEGMENTATION_REMOVED,
    EVENTS.SEGMENTATION_REPRESENTATION_REMOVED,
  ]
    .filter((event): event is string => !!event)
    .map((event) =>
      service.subscribe(event, (e) => {
        if (!e?.segmentationId || e.segmentationId === segmentationId) sync()
      }),
    )
  panels.set(viewportId, {
    segmentationId,
    jump: (index) => {
      const centroid = stats.get(index)?.centroid
      const mm = centroid && nv.vox2mm(centroid)
      if (mm) nv.setCrosshairPos(mm)
    },
  })
  return () => {
    for (const s of subscriptions) s.unsubscribe()
    if (panels.get(viewportId)?.segmentationId === segmentationId)
      panels.delete(viewportId)
    // The segmentation stays, as OHIF leaves its own: removing it makes OHIF
    // strip the SEG display set from every viewport that hangs it.
    cst.removeSegmentationRepresentations(viewportId, { segmentationId })
  }
}

function addRepresentation(
  cst: CstSegmentation,
  viewportId: string,
  segmentationId: string,
  colorLUTIndex: number,
): void {
  const manager = cst.defaultSegmentationStateManager
  manager.updateState((state) => {
    state.viewportSegRepresentations[viewportId] ??= []
    manager.addDefaultSegmentationRepresentation(
      state,
      viewportId,
      segmentationId,
      LABELMAP,
      {
        colorLUTIndex,
      },
    )
  })
  // As cornerstone's own first representation on a viewport.
  cst.segmentationStyle.setRenderInactiveSegmentations(viewportId, true)
  cst.triggerSegmentationEvents.triggerSegmentationRepresentationModified(
    viewportId,
    segmentationId,
    LABELMAP,
  )
}
