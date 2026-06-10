// Builds an OSD-style "volume desktop" manifest: a 2D grid of volume tiles
// where each tile points at the full IIIF Presentation manifest for one
// volume.

import type { Dtype, Shape3, Vec3 } from '../adapters/volumeHandle.ts'

const DEFAULT_TILE_SIZE = 1024
const DEFAULT_GAP = 96

export interface DesktopVolumeLevel {
  level: number
  shape: Shape3
  spacing: Vec3
  ready?: boolean
  bytes?: number | null
}

export interface DesktopVolume {
  id: string
  format: string
  shape: Shape3
  spacing: Vec3
  dtype: Dtype
  levels?: DesktopVolumeLevel[]
}

export interface BuildDesktopManifestArgs {
  baseUrl: string
  volumes: DesktopVolume[]
  desktopId?: string
  tileSize?: number
  gap?: number
}

export interface DesktopManifestItem {
  id: string
  type: 'NiftiVolumeItem'
  label: string
  index: number
  bounds: { x: number; y: number; width: number; height: number }
  format: string
  shape: Shape3
  spacing: Vec3
  dtype: Dtype
  manifest: string
  metadata: string
  preview: {
    axis: 'axial'
    slice: number
    service: string
    image: string
  }
  levels: Array<{
    level: number
    shape: Shape3
    spacing: Vec3
    ready: boolean
    bytes: number | null
    raw: string
  }>
  brickTemplate: string
  sliceServices: {
    axial: string
    coronal: string
    sagittal: string
  }
}

export interface DesktopManifest {
  type: 'VolumeDesktop'
  id: string
  label: string
  profile: string
  tileSize: number
  gap: number
  world: {
    width: number
    height: number
    units: 'desktop-px'
    columns: number
    rows: number
  }
  itemCount: number
  items: DesktopManifestItem[]
}

export function buildDesktopManifest(
  args: BuildDesktopManifestArgs,
): DesktopManifest {
  const {
    baseUrl,
    volumes,
    desktopId = 'neuro',
    tileSize = DEFAULT_TILE_SIZE,
    gap = DEFAULT_GAP,
  } = args
  const safeVolumes = Array.isArray(volumes) ? volumes : []
  const columns = Math.max(1, Math.ceil(Math.sqrt(safeVolumes.length || 1)))
  const rows = Math.max(1, Math.ceil((safeVolumes.length || 1) / columns))
  const pitch = tileSize + gap
  const worldWidth = columns * tileSize + Math.max(0, columns - 1) * gap
  const worldHeight = rows * tileSize + Math.max(0, rows - 1) * gap

  const items: DesktopManifestItem[] = safeVolumes.map((volume, index) => {
    const col = index % columns
    const row = Math.floor(index / columns)
    const encodedId = encodeURIComponent(volume.id)
    const previewAxis = 'axial' as const
    const previewSlice = Math.max(0, Math.floor((volume.shape[2] || 1) / 2))
    const previewService = `${baseUrl}/iiif/image/${encodedId}/${previewAxis}/${previewSlice}`

    return {
      id: volume.id,
      type: 'NiftiVolumeItem',
      label: volume.id,
      index,
      bounds: {
        x: col * pitch,
        y: row * pitch,
        width: tileSize,
        height: tileSize,
      },
      format: volume.format,
      shape: volume.shape,
      spacing: volume.spacing,
      dtype: volume.dtype,
      manifest: `${baseUrl}/iiif/presentation/${encodedId}/manifest`,
      metadata: `${baseUrl}/volumes/${encodedId}/metadata`,
      preview: {
        axis: previewAxis,
        slice: previewSlice,
        service: previewService,
        image: `${previewService}/full/384,/0/default.png`,
      },
      levels: (volume.levels ?? []).map((level) => ({
        level: level.level,
        shape: level.shape,
        spacing: level.spacing,
        ready: level.ready !== false,
        bytes: level.bytes ?? null,
        raw:
          level.level === 0
            ? `${baseUrl}/volumes/${encodedId}/raw.nii.gz`
            : `${baseUrl}/volumes/${encodedId}/raw.nii.gz?level=${level.level}`,
      })),
      brickTemplate: `${baseUrl}/volumes/${encodedId}/raw.nii.gz?level={level}&bbox={bbox}`,
      sliceServices: {
        axial: `${baseUrl}/iiif/image/${encodedId}/axial/{slice}`,
        coronal: `${baseUrl}/iiif/image/${encodedId}/coronal/{slice}`,
        sagittal: `${baseUrl}/iiif/image/${encodedId}/sagittal/{slice}`,
      },
    }
  })

  return {
    type: 'VolumeDesktop',
    id: `${baseUrl}/iiif/desktop/${encodeURIComponent(desktopId)}/manifest`,
    label: `NIfTI desktop: ${desktopId}`,
    profile: 'https://example.org/iiif/volumetric/osd-desktop/v1',
    tileSize,
    gap,
    world: {
      width: worldWidth,
      height: worldHeight,
      units: 'desktop-px',
      columns,
      rows,
    },
    itemCount: items.length,
    items,
  }
}
