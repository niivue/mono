import { useEffect, useState } from 'react'
import { ohifServices } from './niivueRegistry'
import type { OhifServicesManager } from './ohif-types'

// OHIF's viewport prompts (measurement tracking, SR/SEG hydration) are shown
// with uiViewportDialogService, but drawn by cornerstone's viewport component
// from @ohif/ui-next's dialog context. nv-ohif takes no @ohif dependency, so
// it mirrors the dialog state by wrapping the service's show/hide once, and
// draws OHIF's own notification component (customization
// 'ui.notificationComponent') on a NiiVue pane, as cornerstone does.

type DialogState = { viewportId?: string } & Record<string, unknown>
type DialogService = {
  show: (p: DialogState) => void
  hide: () => void
  __nvMirror?: Set<(s: DialogState | null) => void>
}
// OHIF's modal dialogs (uiDialogService), e.g. the arrow text input. Some
// close through the provider itself, so only isEmpty is reliable.
type ModalService = { isEmpty?: () => boolean }

function mirror(
  service: DialogService,
  modal: ModalService | undefined,
): Set<(s: DialogState | null) => void> {
  if (service.__nvMirror) return service.__nvMirror
  const listeners = new Set<(s: DialogState | null) => void>()
  const show = service.show.bind(service)
  const hide = service.hide.bind(service)
  // Deliver after the gesture's click, in order: a prompt mounted before that
  // click (a measurement completes on pointerup, a multi-click one on its last
  // press) takes it as an outside click and dismisses itself.
  // Also held while a modal is open (cornerstone asks an arrow's text before
  // its measurement completes): clicking the modal would dismiss the prompt.
  let isPressed = false
  let pending: Array<() => void> = []
  const isModalOpen = () => modal?.isEmpty?.() === false
  const flush = () => {
    isPressed = false
    // Poll until the modal closes: its close may not pass through the service.
    if (isModalOpen()) {
      setTimeout(flush, 100)
      return
    }
    const run = pending
    pending = []
    for (const f of run) f()
  }
  window.addEventListener('pointerdown', () => (isPressed = true), true)
  // The click follows pointerup in the same task: run after it.
  const release = () => setTimeout(flush, 0)
  window.addEventListener('pointerup', release, true)
  window.addEventListener('pointercancel', release, true)
  const notify = (s: DialogState | null) => {
    const deliver = () => {
      for (const l of listeners) l(s)
    }
    if (isPressed || isModalOpen()) {
      pending.push(deliver)
      if (!isPressed) setTimeout(flush, 100)
    } else setTimeout(deliver, 0)
  }
  service.show = (p) => {
    show(p)
    notify(p)
  }
  service.hide = () => {
    hide()
    notify(null)
  }
  service.__nvMirror = listeners
  return listeners
}

export function ViewportNotification({
  viewportId,
  servicesManager,
}: {
  viewportId: string
  servicesManager: OhifServicesManager | undefined
}) {
  const [state, setState] = useState<DialogState | null>(null)
  const services = ohifServices(servicesManager)
  const dialog = services?.uiViewportDialogService as DialogService | undefined
  const modal = services?.uiDialogService as ModalService | undefined
  useEffect(() => {
    if (!dialog) return
    const listeners = mirror(dialog, modal)
    listeners.add(setState)
    return () => {
      listeners.delete(setState)
    }
  }, [dialog, modal])
  const Notification = (
    services?.customizationService as
      | { getCustomization?: (id: string) => unknown }
      | undefined
  )?.getCustomization?.('ui.notificationComponent') as
    | React.ComponentType<Record<string, unknown>>
    | undefined
  if (!Notification || state?.viewportId !== viewportId) return null
  // cornerstone offsets it 24px for the viewport action corners.
  return (
    <div style={{ position: 'absolute', top: 24, width: '100%' }}>
      {/* The dialog state has its own id; cornerstone sets this one. */}
      <Notification {...state} id="viewport-notification" />
    </div>
  )
}
