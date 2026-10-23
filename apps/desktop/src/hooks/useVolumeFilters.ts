import { useMemo, useState } from 'react'
import type { DesktopItem } from '../domain/desktop'
import {
  volumeFacetValue,
  volumeImageTypeLabel,
  volumeRoleLabel,
  volumeSearchText
} from '../domain/volumeFacets'

export interface VolumeFilters {
  query: string
  selectedRoles: Set<string>
  selectedImageTypes: Set<string>
  selectedFormats: Set<string>
  selectedDtypes: Set<string>
  activeFilterItemId: string | null
  filteredItems: DesktopItem[]
  setQuery: (query: string) => void
  setActiveFilterItemId: (id: string | null) => void
  toggleRole: (value: string) => void
  toggleImageType: (value: string) => void
  toggleFormat: (value: string) => void
  toggleDtype: (value: string) => void
  /** Clear the query and all facet selections (leaves the active item). */
  clearFilters: () => void
}

function toggleValue(set: Set<string>, value: string): Set<string> {
  const next = new Set(set)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}

/** Owns the volume filter state (query + facet selections) and the derived
 *  filtered list. */
export function useVolumeFilters(items: DesktopItem[]): VolumeFilters {
  const [query, setQuery] = useState('')
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(() => new Set())
  const [selectedImageTypes, setSelectedImageTypes] = useState<Set<string>>(() => new Set())
  const [selectedFormats, setSelectedFormats] = useState<Set<string>>(() => new Set())
  const [selectedDtypes, setSelectedDtypes] = useState<Set<string>>(() => new Set())
  const [activeFilterItemId, setActiveFilterItemId] = useState<string | null>(null)

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return items.filter((item) => {
      if (selectedRoles.size > 0 && !selectedRoles.has(volumeRoleLabel(item))) return false
      if (selectedImageTypes.size > 0 && !selectedImageTypes.has(volumeImageTypeLabel(item))) return false
      if (selectedFormats.size > 0 && !selectedFormats.has(volumeFacetValue(item.format))) return false
      if (selectedDtypes.size > 0 && !selectedDtypes.has(volumeFacetValue(item.dtype))) return false
      if (!normalized) return true
      return volumeSearchText(item).includes(normalized)
    })
  }, [items, query, selectedDtypes, selectedFormats, selectedImageTypes, selectedRoles])

  function clearFilters(): void {
    setQuery('')
    setSelectedRoles(new Set())
    setSelectedImageTypes(new Set())
    setSelectedFormats(new Set())
    setSelectedDtypes(new Set())
  }

  return {
    query,
    selectedRoles,
    selectedImageTypes,
    selectedFormats,
    selectedDtypes,
    activeFilterItemId,
    filteredItems,
    setQuery,
    setActiveFilterItemId,
    toggleRole: (value) => setSelectedRoles((current) => toggleValue(current, value)),
    toggleImageType: (value) => setSelectedImageTypes((current) => toggleValue(current, value)),
    toggleFormat: (value) => setSelectedFormats((current) => toggleValue(current, value)),
    toggleDtype: (value) => setSelectedDtypes((current) => toggleValue(current, value)),
    clearFilters
  }
}
