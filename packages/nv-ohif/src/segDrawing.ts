import type NiiVue from '@niivue/niivue'
import { type RefObject, useEffect, useState } from 'react'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { authHeaders, ohifServices } from './niivueRegistry'
import { holdOverlayPlanes } from './overlayPlanes'
import type {
  OhifDisplaySet,
  OhifExtensionManager,
  OhifServicesManager,
} from './ohif-types'
import {
  type Restyle,
  type RtLabels,
  startRtDrawing,
  styleDrawing,
} from './rtDrawing'
import {
  type PanelSegment,
  SEG_FILL_OPACITY,
  SEG_RIM_OPACITY,
  startSegPanel,
} from './segPanel'

// A DICOM SEG hung in a NiiVue pane shows as a NiiVue drawing over the series
// it references: the pane loads that series as its base, and dcm2niix turns the
// SEG into a label volume (values = LabelValue) plus a sidecar naming each one.

interface DisplaySetLookup {
  getDisplaySetByUID?: (uid: string) => OhifDisplaySet | undefined
  getDisplaySetsForSeries?: (uid: string) => ReadonlyArray<OhifDisplaySet>
  getActiveDisplaySets?: () => ReadonlyArray<OhifDisplaySet>
}

const isSegOrRt = (ds: OhifDisplaySet) =>
  ds.Modality === 'SEG' || ds.Modality === 'RTSTRUCT'

// OHIF records no hydration time: order SEG/RTs by when first seen hydrated.
// A Map, not WeakMap: sets that leave the active list are forgotten, so a re-add is newest.
const hydratedOrder = new Map<OhifDisplaySet, number>()
let hydrations = 0

/**
 * The display sets a pane shows, with the first SEG or RTSTRUCT swapped for the series it
 * references (OHIF sets referencedDisplaySetInstanceUID once that series is
 * known; the series UID covers the gap). Without a reference the SEG stays, and
 * classifies as unsupported. A SEG behind a primary series it does not
 * reference also stays, so the primary keeps the pane and the SEG is noted as
 * not shown. With none hung, the latest hydrated SEG or RTSTRUCT on the base
 * series is the pane's, as cornerstone shows it wherever that series is.
 */
export function resolveSegDisplaySets(
  hung: ReadonlyArray<OhifDisplaySet>,
  lookup: DisplaySetLookup | undefined,
): { displaySets: ReadonlyArray<OhifDisplaySet>; seg?: OhifDisplaySet } {
  const index = hung.findIndex(isSegOrRt)
  const seg = hung[index]
  if (!seg) {
    const baseUid = hung[0]?.displaySetInstanceUID
    // A NiiVue pane holds one drawing: the latest hydrated, as cornerstone
    // activates the newest segmentation.
    let hydrated: OhifDisplaySet | undefined
    let newest = 0
    const active = baseUid ? (lookup?.getActiveDisplaySets?.() ?? []) : []
    // Removal drops the set or un-hydrates the same object, whichever series
    // is shown: forget its order so a reload is newest.
    if (baseUid)
      for (const ds of hydratedOrder.keys())
        if (!active.includes(ds) || ds.isHydrated !== true)
          hydratedOrder.delete(ds)
    for (const ds of active) {
      if (
        !isSegOrRt(ds) ||
        ds.referencedDisplaySetInstanceUID !== baseUid ||
        ds.isHydrated !== true
      )
        continue
      const order = hydratedOrder.get(ds) ?? ++hydrations
      hydratedOrder.set(ds, order)
      if (order > newest) [hydrated, newest] = [ds, order]
    }
    return hydrated
      ? { displaySets: hung, seg: hydrated }
      : { displaySets: hung }
  }
  const uid = seg.referencedDisplaySetInstanceUID
  const series = seg.referencedSeriesInstanceUID
  const base =
    (typeof uid === 'string' ? lookup?.getDisplaySetByUID?.(uid) : undefined) ??
    (typeof series === 'string'
      ? lookup?.getDisplaySetsForSeries?.(series)?.[0]
      : undefined)
  if (!base) return { displaySets: hung }
  if (
    index > 0 &&
    hung[0]?.displaySetInstanceUID !== base.displaySetInstanceUID
  )
    return { displaySets: hung }
  // The base leads (it is what the pane loads); a base also hung stays once.
  const rest = hung.filter(
    (ds, i) =>
      i !== index && ds.displaySetInstanceUID !== base.displaySetInstanceUID,
  )
  return { displaySets: [base, ...rest], seg }
}

interface SidecarSegment {
  LabelValue?: number
  SegmentLabel?: string
  RGB?: number[]
  SegmentedPropertyTypeModifierCode?: { CodeMeaning?: string }
}

/**
 * NiiVue label colormap from dcm2niix's SEG sidecar `Segments`. Index 0 is the
 * transparent background, as in NiiVue's own drawing colormaps.
 */
export function segColormap(segments: ReadonlyArray<SidecarSegment>) {
  const cmap = {
    R: [0],
    G: [0],
    B: [0],
    A: [0],
    I: [0],
    labels: [''],
  }
  for (const s of segments) {
    if (typeof s.LabelValue !== 'number') continue
    const [r = 255, g = 255, b = 255] = s.RGB ?? []
    cmap.R.push(r)
    cmap.G.push(g)
    cmap.B.push(b)
    cmap.A.push(255)
    cmap.I.push(s.LabelValue)
    // Paired segments often share a label and differ only by laterality.
    const side = s.SegmentedPropertyTypeModifierCode?.CodeMeaning
    const label = s.SegmentLabel ?? String(s.LabelValue)
    cmap.labels.push(side && !label.includes(side) ? `${side} ${label}` : label)
  }
  return cmap
}

/**
 * Convert `seg` and show it as `nv`'s drawing, coloured from its sidecar.
 * Returns the cleanup: a load still reading gives way (the prior drawing
 * stays); a shown SEG closes unless another drawing replaced it.
 */
export function startSegDrawing(
  nv: Pick<
    NiiVue,
    | 'loadDrawing'
    | 'closeDrawing'
    | 'addColormap'
    | 'drawingVolume'
    | 'drawingGeneration'
    | 'cancelDrawingLoad'
    | 'drawColormap'
    | 'drawIsEnabled'
    | 'drawOpacity'
    | 'drawRimOpacity'
    | 'drawRimWidth'
    | 'addEventListener'
    | 'removeEventListener'
  >,
  seg: OhifDisplaySet,
  options: {
    headers?: Record<string, string>
    // brief: a warning that clears itself, as the base volume's notes do.
    setNote: (message: string, brief?: boolean) => void
    // Core refuses a drawing without a background: resolves once the base is in.
    whenBase: Promise<boolean>
    convert?: typeof convertDisplaySetToNifti
    /** Called once shown, with the segments; returns its cleanup. */
    onShown?: (segments: PanelSegment[], restyle: Restyle) => () => void
  },
): () => void {
  let cancelled = false
  let stopShown: (() => void) | undefined
  // Core bumps drawingGeneration on every drawing load, install or close; a
  // loadDrawing still reading gives way to a bump. `pending` is the SEG's load
  // generation while it reads; `installed` the volume it put there.
  let pending: number | undefined
  let installed: NiiVue['drawingVolume'] = null
  // Gives back the style the SEG replaced once its drawing leaves.
  let restoreStyle: (() => void) | undefined
  const abort = new AbortController()
  const show = async () => {
    const convert = options.convert ?? convertDisplaySetToNifti
    // Any drawing call during the conversion (even one still reading) wins.
    const atStart = nv.drawingGeneration
    const [converted, hasBase] = await Promise.all([
      convert(seg, { headers: options.headers, signal: abort.signal }),
      options.whenBase,
    ])
    if (!converted || !hasBase || cancelled || nv.drawingGeneration !== atStart)
      return
    const load = nv.loadDrawing(converted.image)
    pending = nv.drawingGeneration
    const isShown = await load
    const loadGeneration = pending
    pending = undefined
    if (cancelled) {
      // Stopped after core installed it but before this resumed.
      if (isShown && nv.drawingGeneration === loadGeneration + 1)
        nv.closeDrawing()
      return
    }
    if (!isShown) {
      options.setNote('The segmentation could not be shown.')
      return
    }
    installed = nv.drawingVolume
    // dcm2niix warnings (e.g. an incomplete SEG) reach the pane as the base's do.
    if (converted.note) options.setNote(converted.note, true)
    const segments = converted.json?.Segments
    const cmap = segColormap(Array.isArray(segments) ? segments : [])
    // loadDrawing arms the pen; the pane's tools keep the left button.
    nv.drawIsEnabled = false
    const style = styleDrawing(nv, () => {
      if (cmap.I.length > 1)
        nv.drawColormap = nv.addColormap(
          `seg-${seg.displaySetInstanceUID ?? seg.SeriesInstanceUID ?? ''}`,
          cmap,
        )
      nv.drawOpacity = SEG_FILL_OPACITY
      nv.drawRimOpacity = SEG_RIM_OPACITY
    })
    restoreStyle = style.restore
    // Without the sidecar's segments the panel has nothing to list.
    if (cmap.I.length > 1)
      stopShown = options.onShown?.(
        cmap.I.slice(1).map((value, i) => ({
          value,
          label: cmap.labels[i + 1] ?? String(value),
          rgb: [cmap.R[i + 1] ?? 0, cmap.G[i + 1] ?? 0, cmap.B[i + 1] ?? 0],
        })),
        style.restyle,
      )
  }
  show().catch((err) => {
    if (cancelled) return
    console.error('[nv-ohif] SEG load failed', err)
    options.setNote(
      `Segmentation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  })
  return () => {
    cancelled = true
    abort.abort()
    stopShown?.()
    // A SEG load still reading gives way, keeping the drawing it would replace.
    if (pending === nv.drawingGeneration) nv.cancelDrawingLoad()
    else if (installed && nv.drawingVolume === installed) nv.closeDrawing()
    restoreStyle?.()
  }
}

/**
 * Show `seg` (SEG or RTSTRUCT) as the drawing once the pane's base is
 * installed, listed in OHIF's segmentation panel unless it is a preview
 * awaiting hydration (as cornerstone's SEG viewport); drop both on change.
 * `baseKey` changes whenever the load effect starts a new base.
 */
export function useSegDrawing(
  nvRef: RefObject<NiiVue | null>,
  seg: OhifDisplaySet | undefined,
  isPreview: boolean,
  baseInstalledRef: RefObject<Promise<boolean>>,
  baseKey: string,
  managers: {
    viewportId: string
    servicesManager?: OhifServicesManager
    extensionManager?: OhifExtensionManager
  },
  setNote: (message: string, brief?: boolean) => void,
): void {
  const segKey = seg?.displaySetInstanceUID ?? seg?.SeriesInstanceUID
  const [shown, setShown] = useState<{
    segments: PanelSegment[]
    labels?: RtLabels
    restyle: Restyle
  }>()
  const onShown = (
    segments: PanelSegment[],
    labels: RtLabels | undefined,
    restyle: Restyle,
  ) => {
    setShown({ segments, labels, restyle })
    return () => setShown(undefined)
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the SEG's UID and the base, as the load effect keys on displaySetsKey
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !seg) return
    const options = {
      headers: authHeaders(managers.servicesManager),
      setNote,
      whenBase: baseInstalledRef.current,
    }
    const release = holdOverlayPlanes(nv)
    const stop =
      seg.Modality === 'RTSTRUCT'
        ? startRtDrawing(nv, seg, { ...options, onShown })
        : startSegDrawing(nv, seg, {
            ...options,
            onShown: (segments, restyle) =>
              onShown(segments, undefined, restyle),
          })
    return () => {
      stop()
      release()
    }
  }, [segKey, baseKey])
  // Hydrating keeps the drawing: only the panel entry starts.
  // biome-ignore lint/correctness/useExhaustiveDependencies: shown changes with the SEG
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !seg || !shown || isPreview) return
    return startSegPanel(
      nv,
      managers.viewportId,
      seg,
      shown.segments,
      managers,
      shown.labels,
      shown.restyle,
    )
  }, [shown, isPreview])
}

/** resolveSegDisplaySets against the app's display set service. */
export function resolveSegDisplaySetsFor(
  hung: ReadonlyArray<OhifDisplaySet>,
  servicesManager: OhifServicesManager | undefined,
) {
  return resolveSegDisplaySets(
    hung,
    ohifServices(servicesManager)?.displaySetService as
      | DisplaySetLookup
      | undefined,
  )
}
