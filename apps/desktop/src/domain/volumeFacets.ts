import type { DesktopItem } from './desktop'

const BIDS_IMAGE_TYPE_LABELS: Record<string, string> = {
  asl: 'ASL',
  bold: 'BOLD',
  dwi: 'DWI',
  epi: 'EPI',
  fieldmap: 'Field map',
  flair: 'FLAIR',
  inplanet1: 'Inplane T1',
  inplanet2: 'Inplane T2',
  magnitude1: 'Magnitude',
  magnitude2: 'Magnitude',
  m0scan: 'M0',
  phasediff: 'Phase diff',
  pd: 'PD',
  pdw: 'PDw',
  pet: 'PET',
  sbref: 'SBRef',
  t1map: 'T1 map',
  t1rho: 'T1rho',
  t1w: 'T1w',
  t2map: 'T2 map',
  t2star: 'T2star',
  t2starmap: 'T2star map',
  t2starw: 'T2starw',
  t2w: 'T2w',
  tof: 'TOF',
  unit1: 'UNIT1',
}

export function isDerivedItem(item: DesktopItem): boolean {
  return item.role === 'derived' || Boolean(item.derivedFrom || item.derivation)
}

export function volumeRoleLabel(item: DesktopItem): string {
  if (item.role === 'overlay') return 'Overlay'
  return isDerivedItem(item) ? 'Derived' : 'Source'
}

export function volumeImageTypeLabel(item: DesktopItem): string {
  const tokens = volumeIdentityCandidates(item).flatMap(volumeIdentityTokens)
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const label = BIDS_IMAGE_TYPE_LABELS[tokens[index]]
    if (label) return label
  }
  return 'Unknown'
}

// BIDS entity (e.g. `sub-01`, `ses-pre`) pulled from the item's identity
// strings (label / id / paths). Returns null when the entity isn't present.
function bidsEntity(item: DesktopItem, entity: 'sub' | 'ses'): string | null {
  const pattern = new RegExp(`(?:^|[^a-z0-9])${entity}-([a-z0-9]+)`, 'i')
  for (const candidate of volumeIdentityCandidates(item)) {
    const match = pattern.exec(safeDecodeURIComponent(candidate))
    if (match) return `${entity}-${match[1].toLowerCase()}`
  }
  return null
}

export function volumeSubject(item: DesktopItem): string | null {
  return bidsEntity(item, 'sub')
}

export function volumeSession(item: DesktopItem): string | null {
  return bidsEntity(item, 'ses')
}

// Short, scannable name for a volume list row: BIDS entities from the
// filename ("sub-10159 · T1w", "sub-01 · ses-pre · task-rest · run-02 ·
// BOLD"), or the bare filename when the name isn't BIDS. Derived volumes are
// labelled "<source label> / <operation>" by the backend; they keep the
// operation ("sub-10159 · T1w · smooth"). The full label stays in item.label
// for tooltips, search and metadata.
const BIDS_DISPLAY_ENTITIES = [
  'sub',
  'ses',
  'task',
  'acq',
  'ce',
  'rec',
  'dir',
  'run',
  'echo',
  'desc',
]

export function volumeDisplayLabel(item: DesktopItem): string {
  const source = (item.label || item.id).trim()
  const derivedAt = source.lastIndexOf(' / ')
  if (derivedAt > 0) {
    const operation = source.slice(derivedAt + 3).trim()
    const base = shortVolumeName(source.slice(0, derivedAt))
    return operation ? `${base} · ${operation}` : base
  }
  return shortVolumeName(source)
}

function shortVolumeName(path: string): string {
  const decoded = safeDecodeURIComponent(path).split(/[?#]/)[0].trim()
  const filename = decoded.split(/[\\/]/).pop() || decoded
  const stem = filename.replace(
    /\.(nii(\.gz)?|mgz|mgh|nrrd|mha|mhd|img|hdr|json)$/i,
    '',
  )
  const entities = new Map<string, string>()
  let suffix: string | null = null
  for (const part of stem.split('_')) {
    const dash = part.indexOf('-')
    if (dash > 0) {
      const key = part.slice(0, dash).toLowerCase()
      if (!entities.has(key)) entities.set(key, part)
    } else if (part) {
      suffix = part
    }
  }
  if (!entities.has('sub')) return stem || path
  const label = BIDS_DISPLAY_ENTITIES.flatMap((key) => {
    const value = entities.get(key)
    return value ? [value] : []
  })
  if (suffix) label.push(BIDS_IMAGE_TYPE_LABELS[suffix.toLowerCase()] ?? suffix)
  return label.join(' · ')
}

export function volumeFacetValue(value: string | null | undefined): string {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : 'Unknown'
}

/** The image type for display: an em dash instead of "Unknown". */
export function volumeImageTypeDisplay(item: DesktopItem): string {
  const label = volumeImageTypeLabel(item)
  return label === 'Unknown' ? '—' : label
}

/** "T1w / 207 x 256 x 215 / uint8", leaving out an unknown image type. */
export function volumeSummary(item: DesktopItem): string {
  const imageType = volumeImageTypeLabel(item)
  return [
    imageType === 'Unknown' ? null : imageType,
    item.shape.join(' x '),
    item.dtype,
  ]
    .filter(Boolean)
    .join(' / ')
}

/**
 * Voxel spacing rounded to 3 significant figures, e.g.
 * "0.737 × 0.737 × 0.737 mm" (raw headers carry values like 0.9999971985816956).
 */
export function formatVoxelSpacing(spacing: readonly number[]): string {
  if (spacing.length === 0) return '—'
  return `${spacing
    .map((value) =>
      Number.isFinite(value) ? String(Number(value.toPrecision(3))) : '?',
    )
    .join(' × ')} mm`
}

export function volumeSearchText(item: DesktopItem): string {
  return [
    item.label,
    item.id,
    item.type,
    item.format,
    item.dtype,
    volumeRoleLabel(item),
    volumeImageTypeLabel(item),
    item.shape.join(' x '),
    item.spacing.join(' x '),
    item.derivedFrom ?? '',
    item.derivation?.operation ?? '',
  ]
    .join(' ')
    .toLowerCase()
}

function volumeIdentityCandidates(item: DesktopItem): string[] {
  return [
    item.label,
    item.id,
    item.manifest,
    item.metadata,
    item.preview.image,
    item.preview.service,
    item.derivedFrom ?? '',
    item.derivation?.sourcePath ?? '',
    item.derivation?.outputPath ?? '',
  ].filter((value) => value.length > 0)
}

function volumeIdentityTokens(value: string): string[] {
  const decoded = safeDecodeURIComponent(value)
  const withoutQuery = decoded.split(/[?#]/)[0]
  const filename = withoutQuery.split(/[\\/]/).pop() ?? withoutQuery
  const stem = filename
    .replace(/\.nii(\.gz)?$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.png$/i, '')

  return stem
    .split(/[_\s.-]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean)
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function volumeFacetCounts(
  items: DesktopItem[],
  valueForItem: (item: DesktopItem) => string,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = valueForItem(item)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}
