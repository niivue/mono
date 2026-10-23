import { useCallback, useState } from 'react'

const RECENT_DATASETS_KEY = 'neurovue.recentDatasets.v1'
const MAX_RECENT_DATASETS = 10

function loadRecentDatasets(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_DATASETS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    )
  } catch {
    return []
  }
}

const normalizeSeparators = (path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+$/, '')

/**
 * Bundle import once recorded the bundle's extracted `<cacheRoot>/imports/<stem>/
 * data` dir instead of the `.nvbundle`. Those entries are dead: the dir sits under
 * the OS temp dir and is deleted on every re-import — and since the label is the
 * last path segment, each one displayed as a bare "data". Matching against the
 * server's real `cacheRoot` (rather than sniffing for temp-looking paths) keeps a
 * user's own `…/neurovue/imports/x/data` directory from being pruned too.
 */
function isExtractedBundleDir(path: string, cacheRoot: string): boolean {
  const root = normalizeSeparators(cacheRoot)
  if (!root) return false
  const prefix = `${root}/imports/`
  const normalized = normalizeSeparators(path)
  if (!normalized.startsWith(prefix)) return false
  const segments = normalized.slice(prefix.length).split('/')
  return segments.length === 2 && segments[1] === 'data'
}

function persistRecentDatasets(entries: string[]): string[] {
  try {
    window.localStorage.setItem(RECENT_DATASETS_KEY, JSON.stringify(entries))
  } catch {
    // localStorage may be disabled — recents stay in-memory for this session.
  }
  return entries
}

function promoteRecentDataset(entries: string[], path: string): string[] {
  const trimmed = path.trim()
  if (!trimmed) return entries
  const filtered = entries.filter((entry) => entry !== trimmed)
  return [trimmed, ...filtered].slice(0, MAX_RECENT_DATASETS)
}

/** Last path segment, for a compact recent-dataset label. */
export function recentDatasetLabel(path: string): string {
  const stripped = path.replace(/\/+$/, '')
  const segments = stripped.split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

export interface RecentDatasets {
  recentDatasets: string[]
  /** Move `path` to the front of the recents list (and persist). */
  promoteRecent: (path: string) => void
  /** Drop `path` from the recents list (and persist). */
  removeRecent: (path: string) => void
  /** One-time cleanup of pre-fix entries pointing into `<cacheRoot>/imports/`. */
  pruneExtractedBundleDirs: (cacheRoot: string) => void
}

/** Owns the persisted "recent datasets" list. */
export function useRecentDatasets(): RecentDatasets {
  const [recentDatasets, setRecentDatasets] = useState<string[]>(() =>
    loadRecentDatasets(),
  )

  function promoteRecent(path: string): void {
    setRecentDatasets((previous) =>
      persistRecentDatasets(promoteRecentDataset(previous, path)),
    )
  }

  function removeRecent(path: string): void {
    setRecentDatasets((previous) =>
      persistRecentDatasets(previous.filter((entry) => entry !== path)),
    )
  }

  // Stable identity, and returns `previous` untouched when there's nothing to
  // drop — otherwise the caller's effect would loop on a fresh array each render.
  const pruneExtractedBundleDirs = useCallback((cacheRoot: string): void => {
    setRecentDatasets((previous) => {
      const kept = previous.filter(
        (entry) => !isExtractedBundleDir(entry, cacheRoot),
      )
      return kept.length === previous.length
        ? previous
        : persistRecentDatasets(kept)
    })
  }, [])

  return {
    recentDatasets,
    promoteRecent,
    removeRecent,
    pruneExtractedBundleDirs,
  }
}
