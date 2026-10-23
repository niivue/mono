import { type JSX, useMemo } from 'react'
import type { DesktopItem } from '../domain/desktop'
import {
  formatVoxelSpacing,
  volumeDisplayLabel,
  volumeFacetCounts,
  volumeFacetValue,
  volumeImageTypeDisplay,
  volumeImageTypeLabel,
  volumeRoleLabel,
  volumeSummary,
} from '../domain/volumeFacets'
import {
  previewImageForSize,
  SIDEBAR_PREVIEW_SIZE,
  StablePreviewImage,
} from './StablePreviewImage'

export interface VolumeFilterPanelProps {
  filteredItems: DesktopItem[]
  items: DesktopItem[]
  query: string
  selected: DesktopItem | null
  selectedDtypes: Set<string>
  selectedFormats: Set<string>
  selectedImageTypes: Set<string>
  selectedRoles: Set<string>
  onClearFilters: () => void
  onQueryChange: (query: string) => void
  onSelect: (item: DesktopItem) => void
  onToggleDtype: (value: string) => void
  onToggleFormat: (value: string) => void
  onToggleImageType: (value: string) => void
  onToggleRole: (value: string) => void
}

export function VolumeFilterPanel({
  filteredItems,
  items,
  query,
  selected,
  selectedDtypes,
  selectedFormats,
  selectedImageTypes,
  selectedRoles,
  onClearFilters,
  onQueryChange,
  onSelect,
  onToggleDtype,
  onToggleFormat,
  onToggleImageType,
  onToggleRole,
}: VolumeFilterPanelProps): JSX.Element {
  const roleCounts = useMemo(
    () => volumeFacetCounts(items, volumeRoleLabel),
    [items],
  )
  const imageTypeCounts = useMemo(
    () => volumeFacetCounts(items, volumeImageTypeLabel),
    [items],
  )
  const formatCounts = useMemo(
    () => volumeFacetCounts(items, (item) => volumeFacetValue(item.format)),
    [items],
  )
  const dtypeCounts = useMemo(
    () => volumeFacetCounts(items, (item) => volumeFacetValue(item.dtype)),
    [items],
  )
  const hasFilters =
    query.trim().length > 0 ||
    selectedRoles.size > 0 ||
    selectedImageTypes.size > 0 ||
    selectedFormats.size > 0 ||
    selectedDtypes.size > 0

  return (
    <div className="nv-volume-filter">
      <section
        className="nv-volume-filter-panel nv-volume-filter-facets"
        aria-label="Volume filters"
      >
        <div className="nv-filter-search-row">
          <input
            aria-label="Filter volumes"
            className="nv-search"
            placeholder="Filter volumes"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          <button
            className="nv-filter-clear"
            disabled={!hasFilters}
            onClick={onClearFilters}
            type="button"
          >
            Clear
          </button>
        </div>

        <VolumeFacetGroup
          counts={roleCounts}
          selected={selectedRoles}
          title="Role"
          onToggle={onToggleRole}
        />
        <VolumeFacetGroup
          counts={imageTypeCounts}
          selected={selectedImageTypes}
          title="Image"
          onToggle={onToggleImageType}
        />
        <VolumeFacetGroup
          counts={formatCounts}
          selected={selectedFormats}
          title="Format"
          onToggle={onToggleFormat}
        />
        <VolumeFacetGroup
          counts={dtypeCounts}
          selected={selectedDtypes}
          title="Data type"
          onToggle={onToggleDtype}
        />
      </section>

      <section
        className="nv-volume-filter-panel nv-volume-results-panel"
        aria-label="Filtered volumes"
      >
        <div className="nv-filter-panel-title">
          <span>Volumes</span>
          <em>{filteredItems.length}</em>
        </div>

        <div className="nv-volume-list">
          {filteredItems.map((item) => (
            <button
              className={`nv-volume-card ${selected?.id === item.id ? 'is-selected' : ''}`}
              key={item.id}
              aria-pressed={selected?.id === item.id}
              onClick={() => onSelect(item)}
              title={item.label}
              type="button"
            >
              <StablePreviewImage
                src={previewImageForSize(item, SIDEBAR_PREVIEW_SIZE)}
                frameClassName="nv-volume-thumb"
              />
              <span>
                <strong>{volumeDisplayLabel(item)}</strong>
                <small>{volumeSummary(item)}</small>
              </span>
            </button>
          ))}
          {filteredItems.length === 0 ? (
            <div className="nv-filter-empty">No matching volumes.</div>
          ) : null}
        </div>
      </section>

      {/* Metadata always describes the selected (loaded) volume, even when a
          filter hides it; hovering or focusing a row only highlights it. */}
      <VolumeFilterDetails item={selected} />
    </div>
  )
}

function VolumeFacetGroup({
  counts,
  selected,
  title,
  onToggle,
}: {
  counts: Map<string, number>
  selected: Set<string>
  title: string
  onToggle: (value: string) => void
}): JSX.Element {
  const entries = Array.from(counts.entries()).sort((left, right) =>
    left[0].localeCompare(right[0]),
  )

  return (
    <div className="nv-filter-facet-group">
      <div className="nv-filter-panel-title">
        <span>{title}</span>
        <em>{selected.size > 0 ? selected.size : 'Any'}</em>
      </div>
      <div className="nv-filter-facet-options">
        {entries.map(([value, count]) => (
          <label className="nv-filter-facet-option" key={value} title={value}>
            <input
              checked={selected.has(value)}
              onChange={() => onToggle(value)}
              type="checkbox"
            />
            <span>{value}</span>
            <em>{count}</em>
          </label>
        ))}
        {entries.length === 0 ? (
          <div className="nv-filter-empty">None</div>
        ) : null}
      </div>
    </div>
  )
}

function VolumeFilterDetails({
  item,
}: {
  item: DesktopItem | null
}): JSX.Element {
  return (
    <section
      className="nv-volume-filter-panel nv-volume-filter-details"
      aria-label="Volume metadata"
    >
      <div className="nv-filter-panel-title">
        <span>Metadata</span>
        <em>{item ? volumeRoleLabel(item) : 'None'}</em>
      </div>

      {item ? (
        <dl>
          <dt>Label</dt>
          <dd title={item.label}>{item.label}</dd>
          <dt>ID</dt>
          <dd title={item.id}>{item.id}</dd>
          <dt>Format</dt>
          <dd>{volumeFacetValue(item.format)}</dd>
          <dt>Image</dt>
          <dd>{volumeImageTypeDisplay(item)}</dd>
          <dt>Data type</dt>
          <dd>{volumeFacetValue(item.dtype)}</dd>
          <dt>Shape</dt>
          <dd>{item.shape.join(' x ')}</dd>
          <dt>Spacing</dt>
          <dd>{formatVoxelSpacing(item.spacing)}</dd>
          {item.derivedFrom ? (
            <>
              <dt>Source</dt>
              <dd title={item.derivedFrom}>{item.derivedFrom}</dd>
            </>
          ) : null}
          {item.derivation?.operation ? (
            <>
              <dt>Operation</dt>
              <dd>{item.derivation.operation}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <div className="nv-filter-empty">No volume selected.</div>
      )}
    </section>
  )
}
