import { useState } from 'react'

const RECENT_DATASETS_KEY = 'neurovue.recentDatasets.v1'
const MAX_RECENT_DATASETS = 10

function loadRecentDatasets(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_DATASETS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
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
}

/** Owns the persisted "recent datasets" list. */
export function useRecentDatasets(): RecentDatasets {
  const [recentDatasets, setRecentDatasets] = useState<string[]>(() => loadRecentDatasets())

  function promoteRecent(path: string): void {
    setRecentDatasets((previous) => persistRecentDatasets(promoteRecentDataset(previous, path)))
  }

  function removeRecent(path: string): void {
    setRecentDatasets((previous) => persistRecentDatasets(previous.filter((entry) => entry !== path)))
  }

  return { recentDatasets, promoteRecent, removeRecent }
}
