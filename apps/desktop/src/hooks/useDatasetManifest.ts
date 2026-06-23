import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type {
  DatasetOpenResult,
  DesktopItem,
  DesktopManifest,
  WarmProgress
} from '../domain/desktop'
import {
  fetchDesktopManifest,
  fetchDesktopManifestVersion,
  openDatasetByPath,
  openDatasetDirectory,
  resolveServerInfo,
  resolveServerUrl
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
  warmProgress: WarmProgress | null
  openLocalDataset: () => Promise<void>
  openRecentDataset: (path: string) => Promise<void>
  refreshDesktopManifest: (selectId?: string) => Promise<void>
  refreshDesktopManifestData: (selectId?: string) => Promise<DesktopManifest | null>
  setSelectedId: (id: string | null) => void
  setStatus: (status: string) => void
}

export interface UseDatasetManifestOptions {
  promoteRecent: (path: string) => void
}

export function useDatasetManifest({
  promoteRecent
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
  const [status, setStatus] = useState('Starting NeuroVue.')
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

  const items = useMemo(() => manifest?.items ?? EMPTY_DESKTOP_ITEMS, [manifest])
  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? items[0] ?? null,
    [items, selectedId]
  )

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        const serverInfo = await resolveServerInfo()
        const resolved = serverInfo?.url ?? await resolveServerUrl()
        if (cancelled) return
        setServerUrl(resolved)
        setDatasetRoot(serverInfo?.datasetRoot ?? '')
        setBidsName(serverInfo?.bidsName ?? '')
        setBidsDatasetDoi(serverInfo?.bidsDatasetDoi ?? '')
        setCacheRoot(serverInfo?.cacheRoot ?? '')
        setWarmProgress(serverInfo?.warmProgress ?? null)
        const nextManifest = await fetchDesktopManifest(resolved)
        const nextVersion = await fetchDesktopManifestVersion(resolved).catch(() => null)
        if (cancelled) return
        manifestVersionRef.current = nextVersion
        setManifest(nextManifest)
        setSelectedId(nextManifest.items[0]?.id ?? null)
        setDatasetRevision((revision) => revision + 1)
        setStatus(`${nextManifest.itemCount} volume item(s) loaded.`)
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error))
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const refreshDesktopManifestData = useCallback(async (selectId?: string): Promise<DesktopManifest | null> => {
    if (!serverUrl) return null
    const nextManifest = await fetchDesktopManifest(serverUrl)
    manifestVersionRef.current = await fetchDesktopManifestVersion(serverUrl).catch(() => null)
    setManifest(nextManifest)
    if (selectId && nextManifest.items.some((item) => item.id === selectId)) {
      setSelectedId(selectId)
    }
    setStatus(`${nextManifest.itemCount} volume item(s) loaded.`)
    return nextManifest
  }, [serverUrl])

  const refreshDesktopManifest = useCallback(async (selectId?: string): Promise<void> => {
    await refreshDesktopManifestData(selectId)
  }, [refreshDesktopManifestData])

  const applyDatasetOpenResult = useCallback(async (result: DatasetOpenResult): Promise<void> => {
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
    manifestVersionRef.current = await fetchDesktopManifestVersion(result.url).catch(() => null)
    setManifest(nextManifest)
    setSelectedId(nextManifest.items[0]?.id ?? null)
    setStatus(`${nextManifest.itemCount} volume item(s) loaded from ${result.datasetRoot}.`)
    promoteRecentRef.current(result.datasetRoot)
  }, [])

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
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      isOpeningDatasetRef.current = false
      setIsOpeningDataset(false)
    }
  }, [applyDatasetOpenResult])

  const openRecentDataset = useCallback(async (path: string): Promise<void> => {
    if (isOpeningDatasetRef.current) return

    isOpeningDatasetRef.current = true
    setIsOpeningDataset(true)
    setStatus(`Opening ${path}.`)
    try {
      const result = await openDatasetByPath(path)
      await applyDatasetOpenResult(result)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error))
    } finally {
      isOpeningDatasetRef.current = false
      setIsOpeningDataset(false)
    }
  }, [applyDatasetOpenResult])

  useEffect(() => {
    let unlisten: (() => void) | null = null

    void listen('neurovue-open-directory', () => {
      void openLocalDataset()
    }).then((nextUnlisten) => {
      unlisten = nextUnlisten
    }).catch(() => {
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
        if (!currentSelectedId || !nextManifest.items.some((item) => item.id === currentSelectedId)) {
          setSelectedId(nextManifest.items[0]?.id ?? null)
        }
        setStatus(`${nextManifest.itemCount} volume item(s) loaded.`)
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
  }, [serverUrl])

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
    status,
    warmProgress,
    openLocalDataset,
    openRecentDataset,
    refreshDesktopManifest,
    refreshDesktopManifestData,
    setSelectedId,
    setStatus
  }
}
