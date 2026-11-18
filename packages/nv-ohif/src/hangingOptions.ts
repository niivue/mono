import type NiiVue from '@niivue/niivue'
import { COLORMAP_TYPE, SLICE_TYPE, VOLUME_RENDER_MODE } from '@niivue/niivue'
import { useEffect } from 'react'
import { classifyDisplaySet } from './classifyDisplaySet'
import {
  initialRenderView,
  niivueColormapName,
  rampColormap,
  voiRange,
} from './commands'
import { getNiivueEntry } from './niivueRegistry'
import type {
  OhifCommandsManager,
  OhifDisplaySet,
  OhifViewportProps,
} from './ohif-types'

// Hanging-protocol display options as cornerstone reads them: per display set
// (colormap, voi, voiInverted, blendMode) and per viewport (background).

type Options = {
  colormap?: unknown
  voiInverted?: boolean
  blendMode?: string
  slabThickness?: unknown
}
type DisplaySetOptions = OhifViewportProps['displaySetOptions']

// Cornerstone's mapDisplaySetOptions accepts `item.options || item`.
const optionsAt = (dso: DisplaySetOptions, i: number): Options =>
  ((dso?.[i]?.options ?? dso?.[i]) as Options | undefined) ?? {}

/**
 * A full-volume MIP (TMTV's MIP pane): a NiiVue maximum-intensity render.
 * Without `slabThickness` cornerstone's MIP spans its minimal slab, a slice
 * (the 4D demo's PT panes).
 */
export const isMip = (dso: DisplaySetOptions): boolean => {
  const { blendMode, slabThickness } = optionsAt(dso, 0)
  return blendMode === 'MIP' && slabThickness === 'fullVolume'
}

// vtk.js's '2hot' preset (cornerstone's PET colormap in the 4D demo), which
// NiiVue lacks; interpolated in RGB, not vtk's Lab. Alpha as NiiVue's 'hot'.
// Starts black, not vtk's dark red: the demo's ramp makes 0 transparent, and
// a base volume's 2D slice ignores LUT alpha.
const TWO_HOT = {
  R: [
    0, 53, 96, 138, 181, 218, 239, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255,
  ],
  G: [0, 0, 0, 0, 0, 0, 10, 53, 96, 138, 181, 219, 242, 255, 255, 255, 255],
  B: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8, 40, 80, 143, 207, 255],
  I: [
    0, 16, 32, 49, 65, 81, 97, 113, 130, 146, 162, 178, 194, 210, 227, 243, 255,
  ],
}

/** Register the cornerstone colormaps NiiVue lacks (once; the registry is global). */
export function addCornerstoneColormaps(nv: NiiVue): void {
  if (!niivueColormapName(nv.colormaps, '2hot'))
    nv.addColormap('2hot', {
      ...TWO_HOT,
      A: TWO_HOT.I.map((i) => Math.round(i / 2)),
    })
}

/** A MIP shown inverted, as cornerstone's voiInverted MIP pane. */
export const isMipInverted = (dso: DisplaySetOptions): boolean =>
  isMip(dso) && optionsAt(dso, 0).voiInverted === true

type Point = { value: number; opacity: number }
type OverlayStyle = {
  colormap?: string
  opacity?: number
  isColormapAlphaKept?: boolean
}

/**
 * The NiiVue colormap for an OHIF `colormap` option: a name, or `{ name,
 * opacity }` where opacity is a scalar or a ramp of `{ value, opacity }`. A
 * ramp becomes the colormap's alpha, which the overlay keeps.
 */
export function niivueColormap(nv: NiiVue, colormap: unknown): OverlayStyle {
  const name = niivueColormapName(nv.colormaps, colormap)
  const opacity = (colormap as { opacity?: unknown } | null)?.opacity
  if (!name) return {}
  if (typeof opacity === 'number') return { colormap: name, opacity }
  if (!Array.isArray(opacity) || opacity.length < 2) return { colormap: name }
  const ramp = [...(opacity as Point[])].sort((a, b) => a.value - b.value)
  return {
    colormap: rampColormap(nv, name, ramp),
    opacity: 1,
    isColormapAlphaKept: true,
  }
}

// Overlays the hanging protocol added, per viewer: only these leave with it.
const hungBy = new WeakMap<NiiVue, Set<string>>()

/** Base-volume load options from `displaySetOptions[0]` (colormap, inversion). */
export function baseStyle(
  nv: NiiVue,
  dso: DisplaySetOptions,
): { colormap?: string; isColormapInverted?: boolean } {
  const options = optionsAt(dso, 0)
  // The plain colormap: a ramp is an overlay's (a base 2D slice ignores LUT alpha).
  const colormap = niivueColormapName(nv.colormaps, options.colormap)
  return {
    ...(colormap ? { colormap } : {}),
    // NiiVue's MIP takes the brightest colour, so an inverted MIP inverts the canvas instead.
    ...(options.voiInverted && !isMip(dso) ? { isColormapInverted: true } : {}),
  }
}

/**
 * Viewport-level setup before the first load: background colour and the MIP
 * render, its camera as a 3D pane's in that orientation.
 */
export function applyViewportStyle(
  nv: NiiVue,
  canvas: HTMLCanvasElement,
  viewportOptions: { background?: number[]; orientation?: string } | undefined,
  dso: DisplaySetOptions,
): void {
  const mip = isMip(dso)
  const inverted = isMipInverted(dso)
  canvas.style.filter = inverted ? 'invert(1)' : ''
  const bg = viewportOptions?.background
  if (bg?.length === 3) {
    const [r, g, b] = (inverted ? bg.map((c) => 1 - c) : bg) as [
      number,
      number,
      number,
    ]
    nv.backgroundColor = [r, g, b, 1]
  }
  if (!mip) {
    // Leaving a MIP: the view effect re-sets the slice type and camera.
    if (nv.volumeRenderMode === VOLUME_RENDER_MODE.MAXIMUM)
      nv.volumeRenderMode = VOLUME_RENDER_MODE.COMPOSITE
    return
  }
  nv.sliceType = SLICE_TYPE.RENDER
  nv.volumeRenderMode = VOLUME_RENDER_MODE.MAXIMUM
  const view = initialRenderView({
    ...viewportOptions,
    viewportType: 'volume3d',
  })
  if (view) [nv.azimuth, nv.elevation] = view
}

/**
 * Layers display sets 1.. over the base once it has loaded, as cornerstone's
 * volume viewport does (TMTV fusion: PT over CT), each with its own colormap,
 * opacity and window.
 */
export function useHungOverlays(
  nv: NiiVue | null,
  viewportId: string,
  displaySets: ReadonlyArray<OhifDisplaySet>,
  dso: DisplaySetOptions,
  loadedBase: string | undefined,
  commandsManager: OhifCommandsManager | undefined,
): void {
  const overlays = overlayDisplaySets(displaySets)
  const key = overlays.map((ds) => ds.displaySetInstanceUID).join('|')
  const styleKey = JSON.stringify(
    overlays.map((ds) => optionsAt(dso, displaySets.indexOf(ds))),
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the base load and the overlays' UIDs and options
  useEffect(() => {
    if (!nv || !loadedBase || !commandsManager) return
    // A newer overlay set or base load supersedes this run.
    let stale = false
    // The load this run started, aborted by the cleanup.
    let pending: AbortController | undefined
    void (async () => {
      const hung = hungBy.get(nv) ?? new Set<string>()
      hungBy.set(nv, hung)
      const keep = new Set(
        overlays.map((ds) => String(ds.displaySetInstanceUID)),
      )
      for (const uid of hung) {
        if (keep.has(uid)) continue
        hung.delete(uid)
        // The command also refreshes the toolbar's overlay list.
        await commandsManager.runCommand(
          'niivueRemoveOverlay',
          { viewportId, displaySetInstanceUID: uid },
          'NIIVUE',
        )
      }
      for (const ds of overlays) {
        if (stale) return
        const i = displaySets.indexOf(ds)
        const uid = String(ds.displaySetInstanceUID)
        const style = niivueColormap(nv, optionsAt(dso, i).colormap)
        const display = {
          ...style,
          // A restyle off a ramp must drop the kept alpha.
          isColormapAlphaKept: style.isColormapAlphaKept ?? false,
          colormapType: COLORMAP_TYPE.MIN_TO_MAX,
          ...voiRange(dso, i),
        }
        const entry = getNiivueEntry(viewportId)
        const loaded = entry?.overlays.get(uid)
        const index = loaded
          ? nv.volumes.findIndex((v) => v.hdr === loaded)
          : -1
        if (loaded && index > 0) {
          // Already layered (options changed): restyle in place.
          await nv.setVolume(index, display)
          continue
        }
        const before = entry?.overlayAbort
        const run = commandsManager.runCommand(
          'niivueAddOverlay',
          { viewportId, displaySetInstanceUID: uid, ...display },
          'NIIVUE',
        )
        // niivueAddOverlay installs its controller before its first await.
        const started = entry?.overlayAbort
        pending = started === before ? undefined : started
        await run
        pending = undefined
        const hdr = getNiivueEntry(viewportId)?.overlays.get(uid)
        if (hdr) hung.add(uid)
      }
    })()
    return () => {
      stale = true
      // An overlay dropped (or restyled) mid-load must not install.
      pending?.abort()
    }
  }, [nv, loadedBase, key, styleKey])
}

/** Display sets after the base that NiiVue layers as overlays. */
export const overlayDisplaySets = (
  displaySets: ReadonlyArray<OhifDisplaySet>,
): OhifDisplaySet[] =>
  displaySets.slice(1).filter((ds) => {
    const kind = classifyDisplaySet(ds)
    return kind === 'nifti' || kind === 'dicom-volume'
  })
