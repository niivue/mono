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
  const inverted = mip && optionsAt(dso, 0).voiInverted === true
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
  if (!mip) return
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
  loadedSeries: string | undefined,
  commandsManager: OhifCommandsManager | undefined,
): void {
  const overlays = overlayDisplaySets(displaySets)
  const key = overlays.map((ds) => ds.displaySetInstanceUID).join('|')
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the base load and overlay UIDs
  useEffect(() => {
    if (!nv || !loadedSeries || !commandsManager) return
    void (async () => {
      for (const ds of overlays) {
        const i = displaySets.indexOf(ds)
        const { knee, ...style } = niivueColormap(
          nv,
          optionsAt(dso, i).colormap,
        )
        const voi = voiRange(dso, i)
        await commandsManager.runCommand(
          'niivueAddOverlay',
          {
            viewportId,
            displaySetInstanceUID: ds.displaySetInstanceUID,
            ...style,
            ...(knee === undefined
              ? voi
              : {
                  colormapType: COLORMAP_TYPE.ZERO_TO_MAX_TRANSLUCENT_BELOW_MIN,
                }),
            ...(knee !== undefined && voi
              ? {
                  calMin: voi.calMin + knee * (voi.calMax - voi.calMin),
                  calMax: voi.calMax,
                }
              : {}),
          },
          'NIIVUE',
        )
        const hdr = getNiivueEntry(viewportId)?.overlays.get(
          String(ds.displaySetInstanceUID),
        )
        if (hdr && knee !== undefined) knees.set(hdr, knee)
      }
    })()
  }, [nv, loadedSeries, key])
}

/** Display sets after the base that NiiVue layers as overlays. */
export const overlayDisplaySets = (
  displaySets: ReadonlyArray<OhifDisplaySet>,
): OhifDisplaySet[] =>
  displaySets.slice(1).filter((ds) => {
    const kind = classifyDisplaySet(ds)
    return kind === 'nifti' || kind === 'dicom-volume'
  })
