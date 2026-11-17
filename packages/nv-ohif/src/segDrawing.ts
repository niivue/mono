import type NiiVue from '@niivue/niivue'
import { type RefObject, useEffect } from 'react'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { authHeaders, ohifServices } from './niivueRegistry'
import type {
  OhifDisplaySet,
  OhifExtensionManager,
  OhifServicesManager,
} from './ohif-types'
import { startRtDrawing } from './rtDrawing'
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
}

/**
 * The display sets a pane shows, with the first SEG or RTSTRUCT swapped for the series it
 * references (OHIF sets referencedDisplaySetInstanceUID once that series is
 * known; the series UID covers the gap). Without a reference the SEG stays, and
 * classifies as unsupported.
 */
export function resolveSegDisplaySets(
  hung: ReadonlyArray<OhifDisplaySet>,
  lookup: DisplaySetLookup | undefined,
): { displaySets: ReadonlyArray<OhifDisplaySet>; seg?: OhifDisplaySet } {
  const index = hung.findIndex(
    (ds) => ds.Modality === 'SEG' || ds.Modality === 'RTSTRUCT',
  )
  const seg = hung[index]
  if (!seg) return { displaySets: hung }
  const uid = seg.referencedDisplaySetInstanceUID
  const series = seg.referencedSeriesInstanceUID
  const base =
    (typeof uid === 'string' ? lookup?.getDisplaySetByUID?.(uid) : undefined) ??
    (typeof series === 'string'
      ? lookup?.getDisplaySetsForSeries?.(series)?.[0]
      : undefined)
  if (!base) return { displaySets: hung }
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
 * Returns the cleanup: it closes the drawing only while this owns it (loading
 * in core or shown), so it never erases a drawing that replaced it; closing
 * also makes a core load still reading its file give way.
 */
export function startSegDrawing(
  nv: Pick<
    NiiVue,
    | 'loadDrawing'
    | 'closeDrawing'
    | 'addColormap'
    | 'drawColormap'
    | 'drawIsEnabled'
    | 'drawOpacity'
    | 'drawRimOpacity'
  >,
  seg: OhifDisplaySet,
  options: {
    headers?: Record<string, string>
    setNote: (message: string) => void
    convert?: typeof convertDisplaySetToNifti
    /** Called once shown, with the segments; returns its cleanup. */
    onShown?: (segments: PanelSegment[]) => () => void
  },
): () => void {
  let cancelled = false
  let isOwned = false
  let stopShown: (() => void) | undefined
  const abort = new AbortController()
  const show = async () => {
    const convert = options.convert ?? convertDisplaySetToNifti
    const converted = await convert(seg, {
      headers: options.headers,
      signal: abort.signal,
    })
    if (!converted || cancelled) return
    isOwned = true
    const isShown = await nv.loadDrawing(converted.image)
    if (cancelled) return
    if (!isShown) {
      isOwned = false
      options.setNote('The segmentation could not be shown.')
      return
    }
    const segments = converted.json?.Segments
    const cmap = segColormap(Array.isArray(segments) ? segments : [])
    if (cmap.I.length > 1)
      nv.drawColormap = nv.addColormap(
        `seg-${seg.displaySetInstanceUID ?? seg.SeriesInstanceUID ?? ''}`,
        cmap,
      )
    // loadDrawing arms the pen; the pane's tools keep the left button.
    nv.drawIsEnabled = false
    nv.drawOpacity = SEG_FILL_OPACITY
    nv.drawRimOpacity = SEG_RIM_OPACITY
    // Without the sidecar's segments the panel has nothing to list.
    if (cmap.I.length > 1)
      stopShown = options.onShown?.(
        cmap.I.slice(1).map((value, i) => ({
          value,
          label: cmap.labels[i + 1] ?? String(value),
          rgb: [cmap.R[i + 1] ?? 0, cmap.G[i + 1] ?? 0, cmap.B[i + 1] ?? 0],
        })),
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
    if (isOwned) nv.closeDrawing()
  }
}

/**
 * Show `seg` (SEG or RTSTRUCT) as the drawing once the pane's base is loaded, listed in OHIF's
 * segmentation panel; drop both on change.
 */
export function useSegDrawing(
  nvRef: RefObject<NiiVue | null>,
  seg: OhifDisplaySet | undefined,
  isLoaded: boolean,
  managers: {
    viewportId: string
    servicesManager?: OhifServicesManager
    extensionManager?: OhifExtensionManager
  },
  setNote: (message: string) => void,
): void {
  const segKey = seg?.displaySetInstanceUID ?? seg?.SeriesInstanceUID
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the SEG's UID, as the load effect keys on displaySetsKey
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !seg || !isLoaded) return
    const headers = authHeaders(managers.servicesManager)
    if (seg.Modality === 'RTSTRUCT')
      return startRtDrawing(nv, seg, {
        headers,
        setNote,
        onShown: (segments, labels) =>
          startSegPanel(
            nv,
            managers.viewportId,
            seg,
            segments,
            managers,
            labels,
          ),
      })
    return startSegDrawing(nv, seg, {
      headers,
      setNote,
      onShown: (segments) =>
        startSegPanel(nv, managers.viewportId, seg, segments, managers),
    })
  }, [segKey, isLoaded])
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
