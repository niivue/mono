import type NiiVue from '@niivue/niivue'
import type { OhifDisplaySet, OhifServicesManager } from './ohif-types'
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
  /** Current clip plane preset name ('none' when off). See commands.ts. */
  clipPlane: string
  /**
   * Last known base-volume window/level ({ window: width, level: center }).
   * Tracks both directions: forward commands set it; the viewport's
   * pointer-release observer updates it from a manual contrast drag and pushes
   * the change to OHIF (see commands.ts syncNiivueWindowLevelToOhif).
   */
  windowLevel?: { window: number; level: number }
  /** Visible NVSlide view when this viewport is showing a whole-slide series. */
  slideView?: WsiSlideView
  /** Viewport-provided sink so commands can surface progress text (null = clear). */
  setStatus?: (message: string | null) => void
}

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
  instances.delete(viewportId)
}

/** Merge viewport-owned fields into an entry (no-op when not registered). */
export function updateNiivueViewport(
  viewportId: string,
  patch: Partial<
    Pick<
      NiivueViewportEntry,
      'displaySets' | 'setStatus' | 'slideView' | 'windowLevel'
    >
  >,
): void {
  const entry = instances.get(viewportId)
  if (entry) Object.assign(entry, patch)
}

export function getNiivueEntry(
  viewportId: string | undefined,
): NiivueViewportEntry | undefined {
  return viewportId === undefined ? undefined : instances.get(viewportId)
}

// OHIF exposes its services on the manager in some builds and only on
// `window.services` in others (e.g. the current 3.x app), so read from either.
export function ohifServices(
  servicesManager: OhifServicesManager | undefined,
): Record<string, unknown> | undefined {
  if (servicesManager?.services) return servicesManager.services
  const g = globalThis as unknown as { services?: Record<string, unknown> }
  return g.services
}

interface ViewportGridServiceLike {
  getActiveViewportId?: () => string | undefined
}

/**
 * The entry for a viewport id, falling back to the sole registered entry
 * (covers layouts where a non-NiiVue viewport holds focus next to a single
 * NiiVue viewport).
 */
export function getNiivueEntryForViewport(
  viewportId: string | undefined,
): NiivueViewportEntry | undefined {
  const exact = getNiivueEntry(viewportId)
  if (exact) return exact
  if (instances.size === 1) {
    for (const entry of instances.values()) return entry
  }
  return undefined
}

/** The instance for a viewport id (same fallback as the entry lookup). */
export function getNiivueForViewport(
  viewportId: string | undefined,
): NiiVue | undefined {
  return getNiivueEntryForViewport(viewportId)?.nv
}

/** The entry a toolbar command should act on: the active viewport's. */
export function getActiveNiivueEntry(
  servicesManager: OhifServicesManager | undefined,
): NiivueViewportEntry | undefined {
  const grid = ohifServices(servicesManager)?.viewportGridService as
    | ViewportGridServiceLike
    | undefined
  return getNiivueEntryForViewport(grid?.getActiveViewportId?.())
}

/** The NiiVue instance a toolbar command should act on: the active viewport's. */
export function getActiveNiivue(
  servicesManager: OhifServicesManager | undefined,
): NiiVue | undefined {
  return getActiveNiivueEntry(servicesManager)?.nv
}

// Toolbar buttons are evaluated before our async attach registers the instance
// and hold state (overlay on/off, clip preset) that commands change after the
// evaluation, so nudge OHIF to re-evaluate on those transitions.
export function refreshToolbar(
  servicesManager: OhifServicesManager | undefined,
  viewportId: string,
): void {
  const svc = ohifServices(servicesManager)?.toolbarService as
    | { refreshToolbarState?: (props: Record<string, unknown>) => void }
    | undefined
  svc?.refreshToolbarState?.({ viewportId })
}

interface CommandsManagerLike {
  runCommand?: (name: string, options?: Record<string, unknown>) => unknown
}

// OHIF's commandsManager is passed as a viewport prop in some builds and only on
// `window.commandsManager` in others (set by cornerstone's init), so read either.
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
