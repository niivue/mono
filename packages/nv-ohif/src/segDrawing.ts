import type NiiVue from '@niivue/niivue'
import { type RefObject, useEffect } from 'react'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { authHeaders, ohifServices } from './niivueRegistry'
import type { OhifDisplaySet, OhifServicesManager } from './ohif-types'

// A DICOM SEG hung in a NiiVue pane shows as a NiiVue drawing over the series
// it references: the pane loads that series as its base, and dcm2niix turns the
// SEG into a label volume (values = LabelValue) plus a sidecar naming each one.

// As NiiVue's drawing demo: a translucent fill under an opaque rim.
const SEG_FILL_OPACITY = 0.5
const SEG_RIM_OPACITY = 1

interface DisplaySetLookup {
  getDisplaySetByUID?: (uid: string) => OhifDisplaySet | undefined
  getDisplaySetsForSeries?: (uid: string) => ReadonlyArray<OhifDisplaySet>
}

/**
 * The display sets a pane shows, with the first SEG swapped for the series it
 * references (OHIF sets referencedDisplaySetInstanceUID once that series is
 * known; the series UID covers the gap). Without a reference the SEG stays, and
 * classifies as unsupported.
 */
export function resolveSegDisplaySets(
  hung: ReadonlyArray<OhifDisplaySet>,
  lookup: DisplaySetLookup | undefined,
): { displaySets: ReadonlyArray<OhifDisplaySet>; seg?: OhifDisplaySet } {
  const index = hung.findIndex((ds) => ds.Modality === 'SEG')
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
 * Convert `seg` and load it as `nv`'s drawing, coloured from its sidecar.
 * Resolves false when cancelled or when nothing loaded.
 */
export async function loadSegDrawing(
  nv: NiiVue,
  seg: OhifDisplaySet,
  options: {
    headers?: Record<string, string>
    signal?: AbortSignal
    cancelled: () => boolean
  },
): Promise<boolean> {
  const converted = await convertDisplaySetToNifti(seg, options)
  if (!converted || options.cancelled()) return false
  const segments = converted.json?.Segments
  if (!(await nv.loadDrawing(converted.image)) || options.cancelled())
    return false
  if (Array.isArray(segments) && segments.length > 0)
    nv.drawColormap = nv.addColormap(
      `seg-${seg.displaySetInstanceUID ?? seg.SeriesInstanceUID ?? ''}`,
      segColormap(segments),
    )
  // loadDrawing arms the pen; the pane's tools keep the left button.
  nv.drawIsEnabled = false
  nv.drawOpacity = SEG_FILL_OPACITY
  nv.drawRimOpacity = SEG_RIM_OPACITY
  return true
}

/** Show `seg` as the drawing once the pane's base is loaded; drop it on change. */
export function useSegDrawing(
  nvRef: RefObject<NiiVue | null>,
  seg: OhifDisplaySet | undefined,
  isLoaded: boolean,
  servicesManager: OhifServicesManager | undefined,
  setNote: (message: string) => void,
): void {
  const segKey = seg?.displaySetInstanceUID ?? seg?.SeriesInstanceUID
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the SEG's UID, as the load effect keys on displaySetsKey
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !seg || !isLoaded) return
    let cancelled = false
    const abort = new AbortController()
    loadSegDrawing(nv, seg, {
      headers: authHeaders(servicesManager),
      signal: abort.signal,
      cancelled: () => cancelled,
    })
      .then((shown) => {
        if (!shown && !cancelled)
          setNote('The segmentation could not be shown.')
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[nv-ohif] SEG load failed', err)
        setNote(
          `Segmentation failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    return () => {
      cancelled = true
      abort.abort()
      if (nv.drawingVolume) nv.closeDrawing()
    }
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
