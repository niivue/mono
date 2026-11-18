import type NiiVue from '@niivue/niivue'
import {
  getActiveNiivueEntry,
  getNiivueEntry,
  type NiivueViewportEntry,
  ohifCommandsManager,
  ohifServices,
} from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'
import { refreshBrushSizes, tmtvExport } from './petQuant'
import { rasGrid } from './quantify'
import { lpsToVoxel } from './rtDrawing'
import { addSegmentBidirectional } from './segBidirectional'
import { interpolateDrawing, refreshSegTools } from './segEdit'
import {
  buildRtssDataset,
  buildSegDataset,
  type ExportSegment,
  frameLabels,
  segmentationCsv,
} from './segExport'
import {
  type NiivueSegmentationPane,
  niivueSegmentationPane,
  paletteColor,
  startSegPanel,
} from './segPanel'

// OHIF's segmentation commands for segmentations shown in NiiVue panes: new
// segmentation, brush size, interpolation, and the panel's Save (DICOM SEG,
// RTSS, CSV). Each shadows OHIF's name (the NIIVUE context is searched first)
// and hands any other segmentation or pane back to OHIF's own context.

type Options = Record<string, unknown> & {
  segmentationId?: string
  viewportId?: string
  modality?: string
}
type Ds = Record<string, unknown>

// One created segmentation per pane: its panel entry, dropped when the
// drawing is replaced or closed, the base it was drawn on leaves, or the
// viewer is destroyed.
const created = new Map<string, () => void>()

function createSegmentation(
  entry: NiivueViewportEntry,
  { servicesManager, extensionManager }: OhifExtensionParams,
): string {
  const { nv, viewportId } = entry
  created.get(viewportId)?.()
  nv.createEmptyDrawing()
  const service = ohifServices(servicesManager)?.segmentationService as
    | {
        getSegmentations?: () => unknown[]
        setActiveSegmentation(viewportId: string, id: string): void
        setActiveSegment(id: string, index: number): void
      }
    | undefined
  const segmentationId = crypto.randomUUID()
  const seg: OhifDisplaySet = {
    displaySetInstanceUID: segmentationId,
    SeriesDescription: `Segmentation ${(service?.getSegmentations?.().length ?? 0) + 1}`,
    Modality: 'SEG',
  }
  const [r = 0, g = 0, b = 0] = paletteColor(1)
  const stopPanel = startSegPanel(
    nv,
    viewportId,
    seg,
    [{ value: 1, label: 'Segment 1', rgb: [r, g, b] }],
    { servicesManager, extensionManager },
  )
  const base = nv.volumes[0]
  const drawing = nv.drawingVolume
  const onDrawing = (e: Event) => {
    const action = (e as CustomEvent<{ action: string }>).detail?.action
    if (action === 'close' || action === 'load' || action === 'create') stop()
  }
  // The mask belongs to its base's grid and source instances.
  const onRemoved = (e: Event) => {
    if ((e as CustomEvent<{ volume: unknown }>).detail?.volume !== base) return
    stop()
    if (nv.drawingVolume === drawing) nv.closeDrawing()
  }
  // Also emitted on a backend switch, which keeps the viewer.
  const onDestroyed = () => {
    if (nv.isDestroyed) stop()
  }
  const stop = () => {
    nv.removeEventListener('drawingChanged', onDrawing)
    nv.removeEventListener('volumeRemoved', onRemoved)
    nv.removeEventListener('viewDestroyed', onDestroyed)
    stopPanel()
    if (created.get(viewportId) === stop) created.delete(viewportId)
  }
  nv.addEventListener('drawingChanged', onDrawing)
  nv.addEventListener('volumeRemoved', onRemoved)
  nv.addEventListener('viewDestroyed', onDestroyed)
  created.set(viewportId, stop)
  service?.setActiveSegmentation(viewportId, segmentationId)
  service?.setActiveSegment(segmentationId, 1)
  return segmentationId
}

/** dcmjs' sRGB (0..1) -> DICOM CIELab. */
async function dicomLab() {
  const dcmjs = (await import('dcmjs')).default as {
    data: { Colors: { rgb2DICOMLAB(rgb: readonly number[]): number[] } }
  }
  return (rgb: readonly number[]) =>
    dcmjs.data.Colors.rgb2DICOMLAB(rgb).map(Math.round)
}

/** The SEG or RTSTRUCT dataset of the TMTV PT label; undefined if empty. */
export async function tmtvDataset(
  services: OhifExtensionParams['servicesManager'],
  modality: string,
  label: string,
): Promise<Ds | undefined> {
  const src = tmtvExport(services)
  if (!src) return undefined
  const h = { SeriesDescription: label, SeriesNumber: 3000 }
  return modality === 'RTSTRUCT'
    ? buildRtssDataset(() => src.frames, src.segments, h)
    : buildSegDataset(src.frames, src.segments, h, await dicomLab())
}

/** The SEG or RTSTRUCT dataset of a pane's segmentation; undefined if empty. */
export async function niivueSegmentationDataset(
  pane: NiivueSegmentationPane,
  modality: string,
  label: string,
): Promise<Ds | undefined> {
  const entry = getNiivueEntry(pane.viewportId)
  const nv = entry?.nv
  const bitmap = nv?.drawingVolume?.img
  const dims = nv?.volumes[0]?.dimsRAS
  const lps2vox = nv && lpsToVoxel((v) => nv.vox2mm(v))
  // Only the shown output's instances: a series can hold others (orthogonal
  // localizers, echoes), and the SEG takes its orientation from its frames.
  const sops = entry?.sliceFrames?.frames.map((f) => f?.SOPInstanceUID)
  const instances = entry?.displaySets[0]?.instances?.filter(
    (i) => !sops || sops.includes(i.SOPInstanceUID as string),
  )
  // A base still loading has the new series' instances under the old drawing.
  if (
    !(bitmap instanceof Uint8Array) ||
    !dims ||
    !lps2vox ||
    !instances ||
    entry.baseLoading
  )
    return undefined
  const rows = pane.rows()
  const segments: ExportSegment[] = rows.map(({ value, label, rgb }) => ({
    value,
    label,
    rgb,
  }))
  const read = () =>
    frameLabels({
      bitmap,
      dims: [dims[1] as number, dims[2] as number, dims[3] as number],
      lps2vox,
      instances,
    })
  const h = { SeriesDescription: label, SeriesNumber: 3000 }
  const { rt } = pane
  const flat = rt ? undefined : read()
  // Overlapping (or hidden) ROIs: fill each alone, then restore what the panel shows.
  const framesFor = (s: ExportSegment) => {
    if (flat) return flat
    rt?.showOnly(new Set([s.value]))
    return read()
  }
  const restore = () =>
    rt?.showOnly(new Set(rows.filter((r) => r.visible).map((r) => r.value)))
  if (modality === 'RTSTRUCT')
    try {
      return buildRtssDataset(framesFor, segments, h)
    } finally {
      restore()
    }
  const toLab = await dicomLab()
  // A re-saved SEG keeps its segments' codes.
  const source = (
    (pane.seg.instance ?? pane.seg.instances?.[0]) as Ds | undefined
  )?.SegmentSequence
  try {
    return buildSegDataset(
      framesFor,
      segments,
      h,
      toLab,
      source === undefined ? undefined : ([source].flat() as Ds[]),
    )
  } finally {
    restore()
  }
}

function segmentationLabel(
  servicesManager: OhifExtensionParams['servicesManager'],
  pane: NiivueSegmentationPane,
): string {
  const service = ohifServices(servicesManager)?.segmentationService as
    | { getSegmentation?: (id: string) => { label?: string } | undefined }
    | undefined
  return (
    service?.getSegmentation?.(pane.segmentationId)?.label ??
    pane.seg.SeriesDescription ??
    'Segmentation'
  )
}

function download(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Command definitions for the NIIVUE context (see the file comment). */
export function getSegCommandDefinitions(params: OhifExtensionParams) {
  const { servicesManager, extensionManager, commandsManager } = params
  const commands = () => ohifCommandsManager(commandsManager)
  const back = (name: string, opts: Options, context = 'CORNERSTONE') =>
    commands()?.runCommand?.(name, opts, context)
  // Writes the dataset: to the active data source when it stores DICOM, else a download.
  // No pane: the TMTV PT label, named as cornerstone's save dialog defaults.
  const save = async (opts: Options, onlyDownload: boolean, tmtv = false) => {
    const pane = niivueSegmentationPane(opts.segmentationId)
    if (!pane && !tmtv) return undefined
    const modality = opts.modality === 'RTSTRUCT' ? 'RTSTRUCT' : 'SEG'
    const label = pane
      ? segmentationLabel(servicesManager, pane)
      : modality === 'RTSTRUCT'
        ? 'Contours'
        : 'Segmentation'
    const dataset = pane
      ? await niivueSegmentationDataset(pane, modality, label)
      : await tmtvDataset(servicesManager, modality, label)
    if (!dataset) throw new Error('Nothing is drawn in this segmentation')
    const name = (extensionManager as { activeDataSourceName?: string })
      ?.activeDataSourceName
    const file = `${modality === 'RTSTRUCT' ? 'rtss' : label}.dcm`
    const store = (dataSource: string | undefined) =>
      commands()?.runCommand?.('createStoreFunction', {
        dataSource,
        defaultFileName: file,
      }) as ((ds: Ds) => Promise<void>) | null | undefined
    const storeFn = (!onlyDownload && name && store(name)) || store('download')
    await storeFn?.(dataset)
    return dataset
  }
  return {
    // Hotkeys (e, b) activate a tool without a tool group, which OHIF resolves
    // from the active pane's cornerstone tool group: a NiiVue pane has its own id.
    setToolActive: {
      commandFn: (opts: Options = {}) => {
        const entry = opts.toolGroupId
          ? undefined
          : getActiveNiivueEntry(servicesManager)
        return back('setToolActive', {
          ...opts,
          ...(entry ? { toolGroupId: entry.toolGroupId ?? 'default' } : {}),
        })
      },
    },
    createLabelmapForViewport: {
      commandFn: (opts: Options = {}) => {
        const entry = getActiveNiivueEntry(servicesManager, opts.viewportId)
        return entry
          ? createSegmentation(entry, params)
          : back('createLabelmapForViewport', opts)
      },
    },
    ...Object.fromEntries(
      ['setBrushSize', 'increaseBrushSize', 'decreaseBrushSize'].map((name) => [
        name,
        {
          commandFn: (opts: Options = {}) => {
            const result = back(name, opts)
            refreshSegTools()
            refreshBrushSizes()
            return result
          },
        },
      ]),
    ),
    deleteSegment: {
      commandFn: (opts: Options = {}) => {
        const pane = niivueSegmentationPane(opts.segmentationId)
        return pane
          ? pane.deleteSegment(Number(opts.segmentIndex))
          : back('deleteSegment', opts)
      },
    },
    runSegmentBidirectional: {
      commandFn: (opts: Options = {}) => {
        const nv: NiiVue | undefined = getActiveNiivueEntry(
          servicesManager,
          opts.viewportId,
        )?.nv
        if (!nv) return back('runSegmentBidirectional', opts)
        const notify = ohifServices(servicesManager)?.uiNotificationService as
          | { show?: (n: object) => void }
          | undefined
        if (!addSegmentBidirectional(nv))
          notify?.show?.({
            title: 'Segment Bidirectional',
            message: 'Draw a segment before using bidirectional measurement',
            type: 'warning',
          })
      },
    },
    interpolateLabelmap: {
      commandFn: (opts: Options = {}) => {
        const nv: NiiVue | undefined = getActiveNiivueEntry(
          servicesManager,
          opts.viewportId,
        )?.nv
        return nv ? interpolateDrawing(nv) : back('interpolateLabelmap', opts)
      },
    },
    // The panel's Save menu: OHIF's storeSegmentationCommand (CORNERSTONE)
    // runs this name without a context, then shows the stored series.
    storeSegmentation: {
      commandFn: (opts: Options = {}) =>
        niivueSegmentationPane(opts.segmentationId)
          ? save(opts, false)
          : back('storeSegmentation', opts, 'SEGMENTATION'),
    },
    downloadSegmentation: {
      commandFn: (opts: Options = {}) =>
        niivueSegmentationPane(opts.segmentationId)
          ? save(opts, true)
          : back('downloadSegmentation', opts),
    },
    downloadRTSS: {
      commandFn: (opts: Options = {}) =>
        niivueSegmentationPane(opts.segmentationId)
          ? save({ ...opts, modality: 'RTSTRUCT' }, true)
          : back('downloadRTSS', opts),
    },
    // The TMTV panel's DICOM SEG / RTSS buttons: the PT label stored as the
    // panel's Save stores a segmentation, with createReportAsync's toast.
    niivueStoreTMTVSegmentation: {
      commandFn: async (opts: Options = {}) => {
        const ui = ohifServices(servicesManager)?.uiNotificationService as
          | { show?: (o: Record<string, string>) => void }
          | undefined
        try {
          const dataset = await save(opts, false, true)
          ui?.show?.({
            title: 'Create Report',
            message: 'Segmentation saved successfully',
            type: 'success',
          })
          return dataset
        } catch (e) {
          ui?.show?.({
            title: 'Create Report',
            message: (e as Error).message,
            type: 'error',
          })
        }
      },
    },
    /** A pane's drawing (RAS order) with its RAS voxel -> mm affine, as niivueGetLabelmap. */
    niivueGetDrawing: {
      commandFn: (opts: Options = {}) => {
        const nv = getActiveNiivueEntry(servicesManager, opts.viewportId)?.nv
        const img = nv?.drawingVolume?.img
        const grid = nv?.volumes[0] && rasGrid(nv.volumes[0])
        return img instanceof Uint8Array && grid
          ? { label: img.slice(), dims: grid.dims, affine: grid.affine }
          : undefined
      },
    },
    downloadCSVSegmentationReport: {
      commandFn: (opts: Options = {}) => {
        const pane = niivueSegmentationPane(opts.segmentationId)
        if (!pane) return back('downloadCSVSegmentationReport', opts)
        const label = segmentationLabel(servicesManager, pane)
        const base = getNiivueEntry(pane.viewportId)?.displaySets[0] ?? {}
        download(
          segmentationCsv(
            { id: pane.segmentationId, label },
            base,
            pane.rows(),
          ),
          `${label}.csv`,
        )
      },
    },
  }
}
