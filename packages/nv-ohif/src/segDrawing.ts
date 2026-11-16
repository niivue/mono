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
 * classifies as unsupported. A SEG behind a primary series it does not
 * reference also stays, so the primary keeps the pane and the SEG is noted as
 * not shown.
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
    | '_drawingGeneration'
    | 'drawColormap'
    | 'drawIsEnabled'
    | 'drawOpacity'
    | 'drawRimOpacity'
    | 'addEventListener'
    | 'removeEventListener'
  >,
  seg: OhifDisplaySet,
  options: {
    headers?: Record<string, string>
    setNote: (message: string) => void
    // Core refuses a drawing without a background: resolves once the base is in.
    whenBase: Promise<boolean>
    convert?: typeof convertDisplaySetToNifti
  },
): () => void {
  let cancelled = false
  // Core bumps _drawingGeneration on every drawing load, install or close; a
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
    const atStart = nv._drawingGeneration
    const [converted, hasBase] = await Promise.all([
      convert(seg, { headers: options.headers, signal: abort.signal }),
      options.whenBase,
    ])
    if (
      !converted ||
      !hasBase ||
      cancelled ||
      nv._drawingGeneration !== atStart
    )
      return
    const load = nv.loadDrawing(converted.image)
    pending = nv._drawingGeneration
    const isShown = await load
    const loadGeneration = pending
    pending = undefined
    if (cancelled) {
      // Stopped after core installed it but before this resumed.
      if (isShown && nv._drawingGeneration === loadGeneration + 1)
        nv.closeDrawing()
      return
    }
    if (!isShown) {
      options.setNote('The segmentation could not be shown.')
      return
    }
    installed = nv.drawingVolume
    const prior = {
      drawColormap: nv.drawColormap,
      drawOpacity: nv.drawOpacity,
      drawRimOpacity: nv.drawRimOpacity,
    }
    const segments = converted.json?.Segments
    if (Array.isArray(segments) && segments.length > 0)
      nv.drawColormap = nv.addColormap(
        `seg-${seg.displaySetInstanceUID ?? seg.SeriesInstanceUID ?? ''}`,
        segColormap(segments),
      )
    // loadDrawing arms the pen; the pane's tools keep the left button.
    nv.drawIsEnabled = false
    nv.drawOpacity = SEG_FILL_OPACITY
    nv.drawRimOpacity = SEG_RIM_OPACITY
    const applied = {
      drawColormap: nv.drawColormap,
      drawOpacity: nv.drawOpacity,
      drawRimOpacity: nv.drawRimOpacity,
    }
    const onDrawingChanged = () => {
      if (nv.drawingVolume !== installed) restoreStyle?.()
    }
    restoreStyle = () => {
      restoreStyle = undefined
      nv.removeEventListener('drawingChanged', onDrawingChanged)
      // A style the user set since stays.
      if (nv.drawColormap === applied.drawColormap)
        nv.drawColormap = prior.drawColormap
      if (nv.drawOpacity === applied.drawOpacity)
        nv.drawOpacity = prior.drawOpacity
      if (nv.drawRimOpacity === applied.drawRimOpacity)
        nv.drawRimOpacity = prior.drawRimOpacity
    }
    nv.addEventListener('drawingChanged', onDrawingChanged)
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
    // A SEG load still reading gives way, keeping the drawing it would replace.
    if (pending === nv._drawingGeneration) nv._drawingGeneration++
    else if (installed && nv.drawingVolume === installed) nv.closeDrawing()
    restoreStyle?.()
  }
}

/**
 * Show `seg` as the drawing once the pane's base is installed; drop it on
 * change. `baseKey` changes whenever the load effect starts a new base.
 */
export function useSegDrawing(
  nvRef: RefObject<NiiVue | null>,
  seg: OhifDisplaySet | undefined,
  baseInstalledRef: RefObject<Promise<boolean>>,
  baseKey: string,
  servicesManager: OhifServicesManager | undefined,
  setNote: (message: string) => void,
): void {
  const segKey = seg?.displaySetInstanceUID ?? seg?.SeriesInstanceUID
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the SEG's UID and the base, as the load effect keys on displaySetsKey
  useEffect(() => {
    const nv = nvRef.current
    if (!nv || !seg) return
    return startSegDrawing(nv, seg, {
      headers: authHeaders(servicesManager),
      setNote,
      whenBase: baseInstalledRef.current,
    })
  }, [segKey, baseKey])
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
