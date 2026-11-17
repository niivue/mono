import { useEffect, useRef, useState } from 'react'
import { ohifCommandsManager, ohifServices } from './niivueRegistry'
import type {
  OhifCommandsManager,
  OhifDisplaySet,
  OhifServicesManager,
} from './ohif-types'

// A SEG or RTSTRUCT hung in a NiiVue pane previews as a drawing; OHIF's
// hydrate prompt (cornerstone's promptHydrationDialog, not exported) turns it
// into a segmentation shown wherever its referenced series is. Hydration is
// OHIF's own hydrateSecondaryDisplaySet, as the LOAD badge runs: it marks the
// display set hydrated and hangs the referenced series in its place.

// promptHydrationDialog's RESPONSE values.
const CANCEL = 0
const HYDRATE = 5

type Subscribable = {
  subscribe?: (event: string, cb: () => void) => { unsubscribe(): void }
  EVENTS?: Record<string, string>
}

/** Whether `viewportId` is the grid's active pane, kept current. */
function useIsActiveViewport(
  viewportId: string,
  servicesManager: OhifServicesManager | undefined,
): boolean {
  const grid = ohifServices(servicesManager)?.viewportGridService as
    | (Subscribable & { getActiveViewportId?: () => string | undefined })
    | undefined
  const read = () => grid?.getActiveViewportId?.() === viewportId
  const [isActive, setIsActive] = useState(read)
  // biome-ignore lint/correctness/useExhaustiveDependencies: read closes over grid and viewportId
  useEffect(() => {
    setIsActive(read())
    // Events fire before the provider's effect updates the service's state;
    // a new grid state (hanging protocol, layout) sets the active pane silently.
    const update = () => setTimeout(() => setIsActive(read()))
    const subs = ['ACTIVE_VIEWPORT_ID_CHANGED', 'GRID_STATE_CHANGED'].map(
      (name) => {
        const event = grid?.EVENTS?.[name]
        return event ? grid?.subscribe?.(event, update) : undefined
      },
    )
    return () => {
      for (const s of subs) s?.unsubscribe()
    }
  }, [grid, viewportId])
  return isActive
}

/**
 * Ask to hydrate a previewed `seg` once its base is shown on the active pane,
 * as cornerstone's SEG and RT viewports do; disableConfirmationPrompts
 * hydrates without asking.
 */
export function useHydratePrompt(
  seg: OhifDisplaySet | undefined,
  isPreview: boolean,
  isLoaded: boolean,
  managers: {
    viewportId: string
    servicesManager?: OhifServicesManager
    commandsManager?: OhifCommandsManager
    extensionManager?: unknown
  },
): void {
  const { viewportId, servicesManager } = managers
  const isActive = useIsActiveViewport(viewportId, servicesManager)
  const segKey = seg?.displaySetInstanceUID
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the SEG's UID
  useEffect(() => {
    if (!seg || !isPreview || !isLoaded || !isActive) return
    const services = ohifServices(servicesManager)
    const dialog = services?.uiViewportDialogService as
      | { show(p: Record<string, unknown>): void; hide(): void }
      | undefined
    const hydrate = () =>
      ohifCommandsManager(managers.commandsManager)?.runCommand?.(
        'hydrateSecondaryDisplaySet',
        { displaySet: seg, viewportId },
      )
    const appConfig = (
      managers.extensionManager as
        | { appConfig?: { disableConfirmationPrompts?: boolean } }
        | undefined
    )?.appConfig
    if (appConfig?.disableConfirmationPrompts) {
      hydrate()
      return
    }
    if (!dialog) return
    const isRt = seg.Modality === 'RTSTRUCT'
    const answer = (response: number) => {
      dialog.hide()
      if (response === HYDRATE) hydrate()
    }
    const customization = services?.customizationService as
      | { getCustomization?: (id: string) => unknown }
      | undefined
    dialog.show({
      id: isRt ? 'promptHydrateRT' : 'promptHydrateSEG',
      viewportId,
      type: 'info',
      message: customization?.getCustomization?.(
        isRt
          ? 'viewportNotification.hydrateRTMessage'
          : 'viewportNotification.hydrateSEGMessage',
      ),
      actions: [
        { id: 'no-hydrate', type: 'secondary', text: 'No', value: CANCEL },
        { id: 'yes-hydrate', type: 'primary', text: 'Yes', value: HYDRATE },
      ],
      onSubmit: answer,
      onOutsideClick: () => answer(CANCEL),
      onKeyPress: (e: KeyboardEvent) => {
        if (e.key === 'Enter') answer(HYDRATE)
      },
    })
  }, [segKey, isPreview, isLoaded, isActive])
}

/**
 * OHIF's own toolbar components for a pane corner, by UI type: the SEG/RT
 * LOAD badge and the data overlay menu (both work from the grid and display
 * set services). cornerstone draws them in its viewport action corners, on
 * the hovered or active pane only.
 */
export function PaneCorner({
  viewportId,
  displaySetsKey,
  servicesManager,
}: {
  viewportId: string
  /** The hung display sets. */
  displaySetsKey: string
  servicesManager: OhifServicesManager | undefined
}) {
  const anchor = useRef<HTMLSpanElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const isActive = useIsActiveViewport(viewportId, servicesManager)
  // OHIF's hook reads the grid service once, at mount, and the service sees a
  // new grid state only after the provider's effect: remount a task later.
  const [cornerKey, setCornerKey] = useState(displaySetsKey)
  useEffect(() => {
    const timer = setTimeout(() => setCornerKey(displaySetsKey))
    return () => clearTimeout(timer)
  }, [displaySetsKey])
  // As cornerstone's useViewportHover: pointer moves only, so a pane laid
  // out under a still pointer is not hovered.
  useEffect(() => {
    const pane = anchor.current?.parentElement
    if (!pane) return
    const move = (e: MouseEvent) => {
      const r = pane.getBoundingClientRect()
      setIsHovered(
        e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom,
      )
    }
    document.addEventListener('mousemove', move)
    return () => document.removeEventListener('mousemove', move)
  }, [])
  const toolbar = ohifServices(servicesManager)?.toolbarService as
    | { getButtonComponentForUIType?: (t: string) => unknown }
    | undefined
  type Component =
    | React.ComponentType<Record<string, unknown>>
    | null
    | undefined
  const Badge = toolbar?.getButtonComponentForUIType?.(
    'ohif.modalityLoadBadge',
  ) as Component
  const Menu = toolbar?.getButtonComponentForUIType?.(
    'ohif.dataOverlayMenu',
  ) as Component
  return (
    <>
      <span ref={anchor} hidden />
      {isActive || isHovered || isMenuOpen ? (
        <div
          key={cornerKey}
          style={{
            position: 'absolute',
            top: 4,
            right: 8,
            zIndex: 2,
            display: 'flex',
            gap: 4,
            alignItems: 'center',
          }}
        >
          {Badge ? <Badge viewportId={viewportId} /> : null}
          {Menu ? (
            <Menu
              // The test id cornerstone's corner gives it (`${name}-btn`).
              name={`dataOverlayMenu-${viewportId}`}
              viewportId={viewportId}
              location={2 /* ButtonLocation.TopRight */}
              isOpen={isMenuOpen}
              onOpen={() => setIsMenuOpen(true)}
              onClose={() => setIsMenuOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
    </>
  )
}
