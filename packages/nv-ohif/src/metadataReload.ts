import { useEffect, useState } from 'react'
import { ohifServices } from './niivueRegistry'
import type { OhifServicesManager } from './ohif-types'

type Invalidated = { displaySetInstanceUID?: string; invalidateData?: boolean }
interface DisplaySetEvents {
  EVENTS?: { DISPLAY_SET_SERIES_METADATA_INVALIDATED?: string }
  subscribe?: (
    event: string,
    cb: (e: Invalidated) => void,
  ) => { unsubscribe: () => void }
}

/**
 * Bumps when OHIF invalidates the metadata of a display set in `uidsKey`
 * ('|'-joined), as the TMTV petSUV panel does after editing weight/dose:
 * keying the load on it re-converts with the new SUV factor, as
 * cornerstone's viewport rebuilds its volume.
 */
export function useMetadataRevision(
  servicesManager: OhifServicesManager | undefined,
  uidsKey: string,
): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const svc = ohifServices(servicesManager)?.displaySetService as
      | DisplaySetEvents
      | undefined
    const event = svc?.EVENTS?.DISPLAY_SET_SERIES_METADATA_INVALIDATED
    if (!event || !svc?.subscribe) return
    const uids = uidsKey.split('|')
    const { unsubscribe } = svc.subscribe(event, (e) => {
      if (
        e.invalidateData !== false &&
        uids.includes(String(e.displaySetInstanceUID))
      )
        setRevision((r) => r + 1)
    })
    return unsubscribe
  }, [servicesManager, uidsKey])
  return revision
}
