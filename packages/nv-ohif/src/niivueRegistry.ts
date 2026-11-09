import type NiiVue from '@niivue/niivue'
import type { OhifDisplaySet, OhifServicesManager } from './ohif-types'
import type { SliceFrames } from './sliceFrames'
import type { WsiSlideView } from './wsiSlideView'

/**
 * Per-viewport state shared between the React viewport and the OHIF
 * commands / toolbar evaluators (which live outside React). The viewport
 * registers on attach and keeps `displaySets` / `setStatus` current; commands
 * mutate the overlay/clip state they own.
 */
export interface NiivueViewportEntry {
  viewportId: string
  nv: NiiVue
  /** Display sets currently hung in the viewport (the base load). */
  displaySets: ReadonlyArray<OhifDisplaySet>
  /** displaySetInstanceUIDs loaded as overlays (niivueToggleOverlay). */
  overlayUIDs: string[]
  /** Guard against concurrent overlay loads. */
  overlayLoading: boolean
  /** Cancels the overlay load in flight (re-toggle, base swap, unregister). */
  overlayAbort?: AbortController
  /** Current clip plane preset name ('none' when off). See commands.ts. */
  clipPlane: string
  /**
   * Last known base-volume window/level ({ window: width, level: center }).
   * The baseline for the change readout (commands.ts trackNiivueWindowLevel).
   */
  windowLevel?: { window: number; level: number }
  /** OHIF tool group whose primary tool drives this viewport. */
  toolGroupId?: string
  /** Base volume slice -> DICOM frame, when converted from DICOM. */
  sliceFrames?: SliceFrames
  /** Visible NVSlide view when this viewport is showing a whole-slide series. */
  slideView?: WsiSlideView
  /** Viewport-provided sink so commands can surface progress text (null = clear). */
  setStatus?: (message: string | null, kind?: StatusKind) => void
}

/** How the viewport styles a status message. */
export type StatusKind = 'loading' | 'note' | 'error'

const instances = new Map<string, NiivueViewportEntry>()

export function registerNiivue(viewportId: string, nv: NiiVue): void {
  instances.set(viewportId, {
    viewportId,
    nv,
    displaySets: [],
    overlayUIDs: [],
    overlayLoading: false,
    clipPlane: 'none',
  })
}

export function unregisterNiivue(viewportId: string): void {
  instances.get(viewportId)?.overlayAbort?.abort()
  instances.delete(viewportId)
}

/** Merge viewport-owned fields into an entry (no-op when not registered). */
export function updateNiivueViewport(
  viewportId: string,
  patch: Partial<
    Pick<
      NiivueViewportEntry,
      | 'displaySets'
      | 'setStatus'
      | 'slideView'
      | 'windowLevel'
      | 'overlayUIDs'
      | 'overlayLoading'
      | 'toolGroupId'
      | 'sliceFrames'
    >
  >,
): void {
  const entry = instances.get(viewportId)
  if (!entry) return
  // A new base series invalidates an overlay conversion in flight.
  if (patch.displaySets && patch.displaySets !== entry.displaySets)
    entry.overlayAbort?.abort()
  Object.assign(entry, patch)
}

export function getNiivueEntry(
  viewportId: string | undefined,
): NiivueViewportEntry | undefined {
  return viewportId === undefined ? undefined : instances.get(viewportId)
}

// The viewport and commands get the managers from OHIF's module params; the
// `window.services` fallback covers callers without one (the toolbar module,
// the demo harness).
export function ohifServices(
  servicesManager: OhifServicesManager | undefined,
): Record<string, unknown> | undefined {
  if (servicesManager?.services) return servicesManager.services
  const g = globalThis as unknown as { services?: Record<string, unknown> }
  return g.services
}

interface ViewportGridServiceLike {
  getActiveViewportId?: () => string | null | undefined
}

/**
 * The entry for a viewport id. Only a missing id (no viewport grid, as in the
 * demo harness, or OHIF's grid before a viewport is active) falls back to the
 * sole registered entry: an id that is not ours means a Cornerstone viewport is
 * active, which NiiVue must not touch.
 */
export function getNiivueEntryForViewport(
  viewportId: string | null | undefined,
): NiivueViewportEntry | undefined {
  const id = viewportId ?? undefined
  if (id === undefined && instances.size === 1) {
    return instances.values().next().value
  }
  return getNiivueEntry(id)
}

/** The entry a command acts on: `viewportId`'s, else the active viewport's. */
export function getActiveNiivueEntry(
  servicesManager: OhifServicesManager | undefined,
  viewportId?: string,
): NiivueViewportEntry | undefined {
  const grid = ohifServices(servicesManager)?.viewportGridService as
    | ViewportGridServiceLike
    | undefined
  return getNiivueEntryForViewport(viewportId ?? grid?.getActiveViewportId?.())
}

/** The NiiVue instance a toolbar command should act on: the active viewport's. */
export function getActiveNiivue(
  servicesManager: OhifServicesManager | undefined,
): NiiVue | undefined {
  return getActiveNiivueEntry(servicesManager)?.nv
}

// Toolbar buttons are evaluated before our async attach registers the instance
// and hold state (overlay on/off, clip preset) that commands change after the
// evaluation, so nudge OHIF to re-evaluate on those transitions. Evaluators
// see this id as the toolbar's viewport, so it must be the active one (as in
// OHIF's own refreshes): a NiiVue id while a Cornerstone pane is active would
// disable that pane's buttons. `viewportId` is used only when none is active.
export function refreshToolbar(
  servicesManager: OhifServicesManager | undefined,
  viewportId: string,
): void {
  const services = ohifServices(servicesManager)
  const svc = services?.toolbarService as
    | { refreshToolbarState?: (props: Record<string, unknown>) => void }
    | undefined
  const grid = services?.viewportGridService as
    | ViewportGridServiceLike
    | undefined
  svc?.refreshToolbarState?.({
    viewportId: grid?.getActiveViewportId?.() ?? viewportId,
  })
}

interface CommandsManagerLike {
  runCommand?: (
    name: string,
    options?: Record<string, unknown>,
    context?: string,
  ) => unknown
}

// As for services: the module params' commandsManager, else
// `window.commandsManager` (set by cornerstone's init).
export function ohifCommandsManager(
  commandsManager: CommandsManagerLike | undefined,
): CommandsManagerLike | undefined {
  if (commandsManager?.runCommand) return commandsManager
  const g = globalThis as unknown as { commandsManager?: CommandsManagerLike }
  return g.commandsManager
}

// Pull a DICOMweb Authorization header out of OHIF's auth service, if present,
// so instance retrieval works against secured data sources.
export function authHeaders(
  servicesManager: OhifServicesManager | undefined,
): Record<string, string> {
  const svc = ohifServices(servicesManager)?.userAuthenticationService as
    | { getAuthorizationHeader?: () => { Authorization?: string } | undefined }
    | undefined
  const header = svc?.getAuthorizationHeader?.()
  return header?.Authorization ? { Authorization: header.Authorization } : {}
}
