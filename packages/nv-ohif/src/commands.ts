import { SLICE_TYPE } from '@niivue/niivue'
import { classifyDisplaySet } from './classifyDisplaySet'
import { convertDisplaySetToNifti } from './dicomToNiivue'
import { displaySetToNiivue } from './displaySetToNiivue'
import {
  authHeaders,
  getActiveNiivue,
  getActiveNiivueEntry,
  type NiivueViewportEntry,
  ohifServices,
  refreshToolbar,
} from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'

// Toolbar-facing slice type names -> NiiVue SLICE_TYPE values. String keys keep
// the toolbar button definitions plain JSON (commandOptions survive OHIF's
// customization-service cloning).
export const NIIVUE_SLICE_TYPES: Record<string, number> = {
  axial: SLICE_TYPE.AXIAL,
  coronal: SLICE_TYPE.CORONAL,
  sagittal: SLICE_TYPE.SAGITTAL,
  multiplanar: SLICE_TYPE.MULTIPLANAR,
  render: SLICE_TYPE.RENDER,
}

// Clip plane presets as NiiVue [depth, azimuth, elevation]. Depth 2 is out of
// range, which disables the plane (NiiVue's own convention for "off").
export const NIIVUE_CLIP_PLANES: Record<string, [number, number, number]> = {
  none: [2, 0, 0],
  right: [0, 90, 0],
  left: [0, 270, 0],
  anterior: [0, 180, 0],
  posterior: [0, 0, 0],
  superior: [0, 0, 90],
  inferior: [0, 0, -90],
}

// Overlay styling: a warm colormap over the grayscale base, half transparent.
export const OVERLAY_COLORMAP = 'warm'
export const OVERLAY_OPACITY = 0.5

// Matches NiiVue's SCENE_DEFAULTS (NVConstants.ts), which the public API does
// not export — restated here.
const VIEW_DEFAULTS = {
  azimuth: 110,
  elevation: 10,
  scaleMultiplier: 1.0,
  pan2Dxyzmm: [0, 0, 0, 1] as [number, number, number, number],
  renderPan: [0, 0] as [number, number],
  crosshairPos: [0.5, 0.5, 0.5] as [number, number, number],
}

interface DisplaySetServiceLike {
  getActiveDisplaySets?: () => OhifDisplaySet[]
}

// The next display set in the study that NiiVue could load but is not already
// the base or an overlay of this viewport.
export function findOverlayCandidate(
  entry: Pick<NiivueViewportEntry, 'displaySets' | 'overlayUIDs'>,
  activeDisplaySets: ReadonlyArray<OhifDisplaySet>,
): OhifDisplaySet | undefined {
  const loaded = new Set<string>(entry.overlayUIDs)
  for (const ds of entry.displaySets) {
    if (typeof ds.displaySetInstanceUID === 'string')
      loaded.add(ds.displaySetInstanceUID)
  }
  return activeDisplaySets.find((ds) => {
    const uid = ds.displaySetInstanceUID
    if (typeof uid !== 'string' || loaded.has(uid)) return false
    const kind = classifyDisplaySet(ds)
    return kind === 'nifti' || kind === 'dicom-volume'
  })
}

// Show a transient message in the viewport (no-op if the viewport did not
// register a status sink).
function flashStatus(entry: NiivueViewportEntry, message: string): void {
  entry.setStatus?.(message)
  setTimeout(() => entry.setStatus?.(null), 4000)
}

/**
 * getCommandsModule: OHIF commands operating on the active NiiVue viewport.
 * Toolbar buttons (see toolbar.ts) reference these by name; they are also
 * runnable from any OHIF surface via `commandsManager.runCommand(...)`.
 */
export function getNiivueCommandsModule({
  servicesManager,
}: OhifExtensionParams) {
  const actions = {
    /** Switch the view: axial / coronal / sagittal / multiplanar / render. */
    niivueSetSliceType: ({ sliceType }: { sliceType?: string } = {}) => {
      const nv = getActiveNiivue(servicesManager)
      const mapped = sliceType ? NIIVUE_SLICE_TYPES[sliceType] : undefined
      if (!nv || mapped === undefined) return
      nv.sliceType = mapped
    },

    /** Reset camera, pan, zoom, and crosshair to their defaults. */
    niivueResetView: () => {
      const nv = getActiveNiivue(servicesManager)
      if (!nv) return
      nv.azimuth = VIEW_DEFAULTS.azimuth
      nv.elevation = VIEW_DEFAULTS.elevation
      nv.scaleMultiplier = VIEW_DEFAULTS.scaleMultiplier
      nv.pan2Dxyzmm = [...VIEW_DEFAULTS.pan2Dxyzmm]
      nv.renderPan = [...VIEW_DEFAULTS.renderPan]
      nv.crosshairPos = [...VIEW_DEFAULTS.crosshairPos]
    },

    /** Set (or clear, plane: 'none') the 3D render clip plane. */
    niivueSetClipPlane: ({ plane }: { plane?: string } = {}) => {
      const entry = getActiveNiivueEntry(servicesManager)
      const preset = plane ? NIIVUE_CLIP_PLANES[plane] : undefined
      if (!entry || !preset || plane === undefined) return
      entry.nv.setClipPlane([...preset])
      entry.clipPlane = plane
    },

    /**
     * Toggle a colormapped overlay: with overlays loaded, remove them;
     * otherwise load the study's next loadable series on top of the base
     * (fetch + dcm2niix conversion for DICOM).
     */
    niivueToggleOverlay: async () => {
      const entry = getActiveNiivueEntry(servicesManager)
      if (!entry || entry.overlayLoading) return
      const { nv, viewportId } = entry

      if (entry.overlayUIDs.length > 0) {
        while (nv.volumes.length > 1) {
          nv.model.removeVolume(nv.volumes.length - 1)
        }
        entry.overlayUIDs = []
        await nv.updateGLVolume()
        refreshToolbar(servicesManager, viewportId)
        return
      }

      // Need a loaded base to overlay onto.
      if (nv.volumes.length === 0) return

      const dsService = ohifServices(servicesManager)?.displaySetService as
        | DisplaySetServiceLike
        | undefined
      const candidate = findOverlayCandidate(
        entry,
        dsService?.getActiveDisplaySets?.() ?? [],
      )
      if (!candidate) {
        flashStatus(entry, 'No other loadable series in this study.')
        return
      }
      const uid = String(candidate.displaySetInstanceUID)
      const label =
        typeof candidate.SeriesDescription === 'string'
          ? candidate.SeriesDescription
          : 'overlay'

      entry.overlayLoading = true
      try {
        // Direct volume-URL display sets skip conversion.
        const direct = displaySetToNiivue(candidate)
        if (direct) {
          await nv.addVolume({
            ...direct,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        } else {
          entry.setStatus?.(`Fetching overlay: ${label}...`)
          const niftiFile = await convertDisplaySetToNifti(candidate, {
            headers: authHeaders(servicesManager),
            onProgress: (phase, loaded, total) => {
              entry.setStatus?.(
                phase === 'fetching'
                  ? `Fetching overlay: ${label}... ${loaded}/${total}`
                  : `Converting overlay: ${label} (dcm2niix)...`,
              )
            },
          })
          if (!niftiFile) throw new Error('conversion produced no volume')
          await nv.addVolume({
            url: niftiFile,
            name: niftiFile.name,
            colormap: OVERLAY_COLORMAP,
            opacity: OVERLAY_OPACITY,
          })
        }
        entry.overlayUIDs.push(uid)
        entry.setStatus?.(null)
      } catch (err) {
        console.error('[nv-ohif] overlay load failed', err)
        const message = err instanceof Error ? err.message : String(err)
        flashStatus(entry, `Overlay load failed: ${message || 'unknown error'}`)
      } finally {
        entry.overlayLoading = false
        refreshToolbar(servicesManager, viewportId)
      }
    },
  }

  return {
    actions,
    definitions: {
      niivueSetSliceType: actions.niivueSetSliceType,
      niivueResetView: actions.niivueResetView,
      niivueSetClipPlane: actions.niivueSetClipPlane,
      niivueToggleOverlay: actions.niivueToggleOverlay,
    },
    defaultContext: 'NIIVUE',
  }
}
