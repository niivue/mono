import type NiiVue from '@niivue/niivue'
import { COLORMAP_TYPE, SLICE_TYPE, VOLUME_RENDER_MODE } from '@niivue/niivue'
import { useEffect } from 'react'
import { classifyDisplaySet } from './classifyDisplaySet'
import { initialRenderView, niivueColormapName, voiRange } from './commands'
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
}
type DisplaySetOptions = OhifViewportProps['displaySetOptions']

// Cornerstone's mapDisplaySetOptions accepts `item.options || item`.
const optionsAt = (dso: DisplaySetOptions, i: number): Options =>
  ((dso?.[i]?.options ?? dso?.[i]) as Options | undefined) ?? {}

/** A full-volume MIP (TMTV's MIP pane): a NiiVue maximum-intensity render. */
export const isMip = (dso: DisplaySetOptions): boolean =>
  optionsAt(dso, 0).blendMode === 'MIP'

/** A MIP shown inverted, as cornerstone's voiInverted MIP pane. */
export const isMipInverted = (dso: DisplaySetOptions): boolean =>
  isMip(dso) && optionsAt(dso, 0).voiInverted === true

type Point = { value: number; opacity: number }
type OverlayStyle = { colormap?: string; opacity?: number; knee?: number }

/**
 * The NiiVue colormap for an OHIF `colormap` option: a name, or `{ name,
 * opacity }` where opacity is a scalar or a ramp of `{ value, opacity }`
 * (value 0..1 across the window).
 * ponytail: core binarises overlay alpha on 2D slices, so a ramp becomes a
 * knee: alpha rises as f² from 0 to the ramp's second point, then holds its top
 * opacity (COLORMAP_TYPE 2, lookup from 0, as cornerstone's). Exact ramps need
 * core to keep an overlay's LUT alpha.
 */
export function niivueColormap(nv: NiiVue, colormap: unknown): OverlayStyle {
  const name = niivueColormapName(nv.colormaps, colormap)
  const opacity = (colormap as { opacity?: unknown } | null)?.opacity
  if (!name) return {}
  if (typeof opacity === 'number') return { colormap: name, opacity }
  if (!Array.isArray(opacity) || opacity.length < 2) return { colormap: name }
  const ramp = [...(opacity as Point[])].sort((a, b) => a.value - b.value)
  return {
    colormap: name,
    opacity: Math.max(...ramp.map((p) => p.opacity)),
    knee: ramp[1]?.value,
  }
}

// Overlay hdr -> knee, so a synced window keeps the ramp's transparent foot.
const knees = new WeakMap<object, number>()
// Overlays the hanging protocol added, per viewer: only these leave with it.
const hungBy = new WeakMap<NiiVue, Set<string>>()

/** The NiiVue window for OHIF window [lo, hi] on a volume (knee-aware). */
export function windowFor(
  hdr: object | undefined,
  calMin: number,
  calMax: number,
): { calMin: number; calMax: number } {
  const knee = hdr ? knees.get(hdr) : undefined
  return knee === undefined
    ? { calMin, calMax }
    : { calMin: calMin + knee * (calMax - calMin), calMax }
}

/** Base-volume load options from `displaySetOptions[0]` (colormap, inversion). */
export function baseStyle(
  nv: NiiVue,
  dso: DisplaySetOptions,
): { colormap?: string; isColormapInverted?: boolean } {
  const options = optionsAt(dso, 0)
  const { colormap } = niivueColormap(nv, options.colormap)
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
        const { knee, ...style } = niivueColormap(
          nv,
          optionsAt(dso, i).colormap,
        )
        const voi = voiRange(dso, i)
        const display = {
          ...style,
          // A restyle off a ramp must reset the type, not keep the ramp's.
          ...(knee === undefined
            ? { colormapType: COLORMAP_TYPE.MIN_TO_MAX, ...voi }
            : {
                colormapType: COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN,
              }),
          ...(knee !== undefined && voi
            ? {
                calMin: voi.calMin + knee * (voi.calMax - voi.calMin),
                calMax: voi.calMax,
              }
            : {}),
        }
        const entry = getNiivueEntry(viewportId)
        const loaded = entry?.overlays.get(uid)
        const index = loaded
          ? nv.volumes.findIndex((v) => v.hdr === loaded)
          : -1
        if (loaded && index > 0) {
          // Already layered (options changed): restyle in place.
          await nv.setVolume(index, display)
          if (knee === undefined) knees.delete(loaded)
          else knees.set(loaded, knee)
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
        if (hdr && knee !== undefined) knees.set(hdr, knee)
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
