import { createContext, useContext, useEffect, useRef } from 'react'
import { ohifServices } from './niivueRegistry'
import type { OhifExtensionManager, OhifServicesManager } from './ohif-types'

// OHIF's measurement tracking (longitudinal mode) learns of new measurements
// from TrackedCornerstoneViewport, which forwards MeasurementService additions
// to the tracking state machine. A NiiVue pane does the same when the mode
// provides the tracking context; without it (e.g. basic mode) this is inert.
const TRACKING_CONTEXT =
  '@ohif/extension-measurement-tracking.contextModule.TrackedMeasurementsContext'
const NO_TRACKING = createContext<unknown>(null)

type Send = (event: string, payload: Record<string, unknown>) => void

interface MeasurementServiceLike {
  EVENTS: Record<string, string>
  subscribe: (
    event: string,
    cb: (e: { measurement: Record<string, unknown> }) => void,
  ) => { unsubscribe: () => void }
}

/** Forward one added measurement to the tracker, from the active pane only. */
export function forwardMeasurement(
  send: Send | undefined,
  activeViewportId: string | undefined,
  viewportId: string,
  measurement: Record<string, unknown>,
): void {
  // Every pane hears the event; only the active one forwards it, once.
  if (!send || activeViewportId !== viewportId) return
  const SeriesInstanceUID = measurement.referenceSeriesUID
  send('SET_DIRTY', { SeriesInstanceUID })
  send('TRACK_SERIES', {
    viewportId,
    StudyInstanceUID: measurement.referenceStudyUID,
    SeriesInstanceUID,
    measurementId: measurement.uid,
    toolName: measurement.toolName,
  })
}

export function useMeasurementTracking(
  viewportId: string,
  servicesManager: OhifServicesManager | undefined,
  extensionManager: OhifExtensionManager | undefined,
): void {
  // Resolved once per mount, so the context hook below keeps a stable target.
  const context = useRef(
    (
      extensionManager?.getModuleEntry(TRACKING_CONTEXT) as
        | { context?: React.Context<unknown> }
        | undefined
    )?.context ?? NO_TRACKING,
  ).current
  const value = useContext(context) as [unknown, Send] | null
  const sendRef = useRef<Send | undefined>(undefined)
  sendRef.current = value?.[1]

  useEffect(() => {
    const services = ohifServices(servicesManager)
    const ms = services?.measurementService as
      | MeasurementServiceLike
      | undefined
    const grid = services?.viewportGridService as
      | { getState: () => { activeViewportId?: string } }
      | undefined
    if (!ms || !sendRef.current) return
    const onAdded = ({
      measurement,
    }: {
      measurement: Record<string, unknown>
    }) =>
      forwardMeasurement(
        sendRef.current,
        grid?.getState().activeViewportId,
        viewportId,
        measurement,
      )
    const subs = [ms.EVENTS.MEASUREMENT_ADDED, ms.EVENTS.RAW_MEASUREMENT_ADDED]
      .filter((e): e is string => Boolean(e))
      .map((e) => ms.subscribe(e, onAdded))
    return () => {
      for (const s of subs) s.unsubscribe()
    }
  }, [servicesManager, viewportId])
}
