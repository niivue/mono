import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  DatasetOpenResult,
  DesktopItem,
  DesktopManifest,
  StatusTone,
  WarmProgress,
} from '../domain/desktop'
import {
  fetchDesktopManifest,
  fetchDesktopManifestVersion,
  manifestLoadedStatus,
  openDatasetByPath,
  openDatasetDirectory,
  openVolumeFile,
  resolveServerInfo,
  resolveServerUrl,
} from '../domain/desktop'

const EMPTY_DESKTOP_ITEMS: DesktopItem[] = []

export interface DatasetManifestState {
  bidsDatasetDoi: string
  bidsName: string
  cacheRoot: string
  datasetRevision: number
  datasetRoot: string
  isOpeningDataset: boolean
  items: DesktopItem[]
  manifest: DesktopManifest | null
  selected: DesktopItem | null
  selectedId: string | null
  serverUrl: string
  status: string
  statusTone: StatusTone
  warmProgress: WarmProgress | null
  openLocalDataset: () => Promise<void>
  openLocalVolumeFile: () => Promise<void>
  /** Resolves false when the open failed (the error is already in the status). */
  openRecentDataset: (
    path: string,
    options?: { promoteAs?: string },
  ) => Promise<boolean>
  refreshDesktopManifest: (selectId?: string) => Promise<void>
  refreshDesktopManifestData: (
    selectId?: string,
  ) => Promise<DesktopManifest | null>
  setSelectedId: (id: string | null) => void
  /**
   * Replace the status line. Every user action calls this, so it always wins,
   * including over an error.
   */
  setStatus: (status: string, tone?: StatusTone) => void
}

export interface UseDatasetManifestOptions {
  promoteRecent: (path: string) => void
}

export function useDatasetManifest({
  promoteRecent,
}: UseDatasetManifestOptions): DatasetManifestState {
  const manifestRef = useRef<DesktopManifest | null>(null)
  const manifestVersionRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const isOpeningDatasetRef = useRef(false)
  const promoteRecentRef = useRef(promoteRecent)
  const [serverUrl, setServerUrl] = useState('')
  const [datasetRoot, setDatasetRoot] = useState('')
  const [bidsName, setBidsName] = useState('')
  const [bidsDatasetDoi, setBidsDatasetDoi] = useState('')
  const [cacheRoot, setCacheRoot] = useState('')
  const [datasetRevision, setDatasetRevision] = useState(0)
  const [warmProgress, setWarmProgress] = useState<WarmProgress | null>(null)
  const [manifest, setManifest] = useState<DesktopManifest | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState<{
    text: string
    tone: StatusTone
  }>({ text: 'Starting NeuroVue.', tone: 'info' })
  const setStatus = useCallback(
    (text: string, tone: StatusTone = 'info'): void => {
      setStatusLine({ text, tone })
    },
    [],
  )
  // Routine refreshes (the manifest poll, re-reads after an action) must not
  // wipe an error the user hasn't acted on yet; the next real action clears it.
  const setBackgroundStatus = useCallback((text: string): void => {
    setStatusLine((current) =>
      current.tone === 'error' ? current : { text, tone: 'info' },
    )
  }, [])
  const [isOpeningDataset, setIsOpeningDataset] = useState(false)

  useEffect(() => {
    promoteRecentRef.current = promoteRecent
  }, [promoteRecent])

  useEffect(() => {
    manifestRef.current = manifest
  }, [manifest])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const items = useMemo(
    () => manifest?.items ?? EMPTY_DESKTOP_ITEMS,
    [manifest],
  )
  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  )

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        const serverInfo = await resolveServerInfo()
        const resolved = serverInfo?.url ?? (await resolveServerUrl())
        if (cancelled) return
        setServerUrl(resolved)
        setDatasetRoot(serverInfo?.datasetRoot ?? '')
        setBidsName(serverInfo?.bidsName ?? '')
        setBidsDatasetDoi(serverInfo?.bidsDatasetDoi ?? '')
        setCacheRoot(serverInfo?.cacheRoot ?? '')
        setWarmProgress(serverInfo?.warmProgress ?? null)
        const nextManifest = await fetchDesktopManifest(resolved)
        const nextVersion = await fetchDesktopManifestVersion(resolved).catch(
          () => null,
        )
        if (cancelled) return
        manifestVersionRef.current = nextVersion
        setManifest(nextManifest)
        setSelectedId(nextManifest.items[0]?.id ?? null)
        setDatasetRevision((revision) => revision + 1)
        setStatus(manifestLoadedStatus(nextManifest))
      } catch (error) {
        if (!cancelled)
          setStatus(
            error instanceof Error ? error.message : String(error),
            'error',
          )
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [setStatus])

  const refreshDesktopManifestData = useCallback(
    async (selectId?: string): Promise<DesktopManifest | null> => {
      if (!serverUrl) return null
      const nextManifest = await fetchDesktopManifest(serverUrl)
      manifestVersionRef.current = await fetchDesktopManifestVersion(
        serverUrl,
      ).catch(() => null)
      setManifest(nextManifest)
      if (selectId && nextManifest.items.some((item) => item.id === selectId)) {
        setSelectedId(selectId)
      }
      setBackgroundStatus(manifestLoadedStatus(nextManifest))
      return nextManifest
    },
    [serverUrl, setBackgroundStatus],
  )

  const refreshDesktopManifest = useCallback(
    async (selectId?: string): Promise<void> => {
      await refreshDesktopManifestData(selectId)
    },
    [refreshDesktopManifestData],
  )

  // `promoteAs` overrides which path lands in recents. A bundle import opens the
  // bundle's extracted `data/` dir, but that is an app-internal copy that is
  // re-extracted on every import — so recents must remember the `.nvbundle`.
  const applyDatasetOpenResult = useCallback(
    async (result: DatasetOpenResult, promoteAs?: string): Promise<void> => {
      setManifest(null)
      setSelectedId(null)
      setServerUrl(result.url)
      setDatasetRoot(result.datasetRoot)
      setBidsName(result.bidsName ?? '')
      setBidsDatasetDoi(result.bidsDatasetDoi ?? '')
      setCacheRoot(result.cacheRoot)
      setWarmProgress(result.warmProgress ?? null)
      setDatasetRevision((revision) => revision + 1)
      setStatus(`Loading ${result.datasetRoot}.`)

      const nextManifest = await fetchDesktopManifest(result.url)
      manifestVersionRef.current = await fetchDesktopManifestVersion(
        result.url,
      ).catch(() => null)
      setManifest(nextManifest)
      setSelectedId(nextManifest.items[0]?.id ?? null)
      setStatus(
        manifestLoadedStatus(nextManifest, result.datasetRoot),
        'success',
      )
      promoteRecentRef.current(promoteAs ?? result.datasetRoot)
    },
    [setStatus],
  )

  const openLocalDataset = useCallback(async (): Promise<void> => {
    if (isOpeningDatasetRef.current) return

    isOpeningDatasetRef.current = true
    setIsOpeningDataset(true)
    setStatus('Choosing dataset directory.')
    try {
      const result = await openDatasetDirectory()
      if (!result) {
        setStatus('Open directory cancelled.')
        return
      }
      await applyDatasetOpenResult(result)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      isOpeningDatasetRef.current = false
      setIsOpeningDataset(false)
    }
  }, [applyDatasetOpenResult, setStatus])

  const openLocalVolumeFile = useCallback(async (): Promise<void> => {
    if (isOpeningDatasetRef.current) return

    isOpeningDatasetRef.current = true
    setIsOpeningDataset(true)
    setStatus('Choosing a NIfTI file.')
    try {
      const result = await openVolumeFile()
      if (!result) {
        setStatus('Open file cancelled.')
        return
      }
      await applyDatasetOpenResult(result)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      isOpeningDatasetRef.current = false
      setIsOpeningDataset(false)
    }
  }, [applyDatasetOpenResult, setStatus])

  const openRecentDataset = useCallback(
    async (
      path: string,
      options?: { promoteAs?: string },
    ): Promise<boolean> => {
      if (isOpeningDatasetRef.current) return false

      isOpeningDatasetRef.current = true
      setIsOpeningDataset(true)
      setStatus(`Opening ${options?.promoteAs ?? path}.`)
      try {
        const result = await openDatasetByPath(path)
        await applyDatasetOpenResult(result, options?.promoteAs)
        return true
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : String(error),
          'error',
        )
        return false
      } finally {
        isOpeningDatasetRef.current = false
        setIsOpeningDataset(false)
      }
    },
    [applyDatasetOpenResult, setStatus],
  )

  useEffect(() => {
    let unlisten: (() => void) | null = null

    void listen('neurovue-open-directory', () => {
      void openLocalDataset()
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten
      })
      .catch(() => {
        unlisten = null
      })

    return () => {
      unlisten?.()
    }
  }, [openLocalDataset])

  useEffect(() => {
    if (!serverUrl) return
    let cancelled = false
    let inFlight = false

    async function refreshChangedManifest(): Promise<void> {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const nextVersion = await fetchDesktopManifestVersion(serverUrl)
        if (cancelled) return
        if (manifestRef.current && manifestVersionRef.current === nextVersion) {
          return
        }

        const nextManifest = await fetchDesktopManifest(serverUrl)
        if (cancelled) return

        manifestVersionRef.current = nextVersion
        setManifest(nextManifest)
        const currentSelectedId = selectedIdRef.current
        if (
          !currentSelectedId ||
          !nextManifest.items.some((item) => item.id === currentSelectedId)
        ) {
          setSelectedId(nextManifest.items[0]?.id ?? null)
        }
        setBackgroundStatus(manifestLoadedStatus(nextManifest))
      } catch {
        try {
          const serverInfo = await resolveServerInfo()
          if (cancelled || !serverInfo || serverInfo.url === serverUrl) return
          setServerUrl(serverInfo.url)
          setDatasetRoot(serverInfo.datasetRoot ?? '')
          setBidsName(serverInfo.bidsName ?? '')
          setBidsDatasetDoi(serverInfo.bidsDatasetDoi ?? '')
          setCacheRoot(serverInfo.cacheRoot ?? '')
          setWarmProgress(serverInfo.warmProgress ?? null)
          setDatasetRevision((revision) => revision + 1)
        } catch {
          // Server unreachable; keep current state and retry on the next tick.
        }
      } finally {
        inFlight = false
      }
    }

    void refreshChangedManifest()
    const interval = window.setInterval(() => {
      if (!document.hidden) void refreshChangedManifest()
    }, 5000)
    const onFocus = (): void => {
      void refreshChangedManifest()
    }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [serverUrl, setBackgroundStatus])

  useEffect(() => {
    if (!serverUrl) return
    let cancelled = false
    let inFlight = false

    async function refreshWarmProgress(): Promise<void> {
      if (cancelled || inFlight) return
      inFlight = true
      try {
        const serverInfo = await resolveServerInfo()
        if (!cancelled) setWarmProgress(serverInfo?.warmProgress ?? null)
      } finally {
        inFlight = false
      }
    }

    void refreshWarmProgress()
    const interval = window.setInterval(() => {
      void refreshWarmProgress()
    }, 1000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [serverUrl])

  return {
    bidsDatasetDoi,
    bidsName,
    cacheRoot,
    datasetRevision,
    datasetRoot,
    isOpeningDataset,
    items,
    manifest,
    selected,
    selectedId,
    serverUrl,
    status: statusLine.text,
    statusTone: statusLine.tone,
    warmProgress,
    openLocalDataset,
    openLocalVolumeFile,
    openRecentDataset,
    refreshDesktopManifest,
    refreshDesktopManifestData,
    setSelectedId,
    setStatus,
  }
}
