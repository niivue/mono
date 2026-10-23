import { useEffect, useState } from 'react'
import { type DesktopItem, fetchVolumeMetadata, type VolumeMetadata } from '../domain/desktop'

export interface VolumeMetadataState {
  metadata: VolumeMetadata | null
  metadataStatus: string
}

/** Fetches the selected volume's metadata (and JSON sidecars) on selection. */
export function useVolumeMetadata(selected: DesktopItem | null): VolumeMetadataState {
  const [metadata, setMetadata] = useState<VolumeMetadata | null>(null)
  const [metadataStatus, setMetadataStatus] = useState('No metadata loaded.')

  useEffect(() => {
    let cancelled = false

    async function loadMetadata(item: DesktopItem): Promise<void> {
      setMetadata(null)
      setMetadataStatus('Loading metadata.')
      try {
        const nextMetadata = await fetchVolumeMetadata(item)
        if (cancelled) return
        const sidecarCount = nextMetadata.sidecars?.length ?? 0
        setMetadata(nextMetadata)
        setMetadataStatus(
          sidecarCount > 0
            ? `${sidecarCount} JSON sidecar${sidecarCount === 1 ? '' : 's'} loaded.`
            : 'No JSON sidecars discovered.'
        )
      } catch (error) {
        if (cancelled) return
        setMetadata(null)
        setMetadataStatus(error instanceof Error ? error.message : String(error))
      }
    }

    if (!selected) {
      setMetadata(null)
      setMetadataStatus('No volume selected.')
      return () => {
        cancelled = true
      }
    }

    void loadMetadata(selected)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.metadata])

  return { metadata, metadataStatus }
}
