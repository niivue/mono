import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import type { Backend, ClipPlane } from './desktop'

// A NeuroVue bundle (`.nvbundle`) is a self-describing, transport-agnostic
// hand-off of one or more volumes plus the view that was set up over them. It
// is the payload the Apple share / AirDrop flow will carry, and the same format
// the integrity-check + assign/resync work builds on. See the Rust
// `export_bundle` for the on-disk layout (manifest.json + data/).
//
// The `view` blob below is deliberately shaped to mirror niivue's
// `NVDocumentData` / `NVDocumentVolume` field names (`volumes[]` with role +
// `colormap`/`opacity`/`calMin`/`calMax`, a `scene` with `crosshairPos` +
// `clipPlanes`). It is NOT yet a real NVDocument — mono's `serialize()` always
// embeds volume bytes and lacks the old-niivue sparse/linked path
// (`json(embedImages=false)` + `fetchLinkedData`; tracked in
// mono `packages/niivue/FEATURE_PARITY.md` §5). Once that lands, this maps to a
// *linked* NVDocument (volumes reference the bundle's `data/` files) and this
// hand-rolled shape retires with a near-mechanical rename.

/** App-side per-layer settings (matches `LayerSettings` in `App.tsx`). */
export interface BundleLayerSettings {
  colormap?: string
  opacity?: number
  hidden?: boolean
  window?: { min: number; max: number }
}

/**
 * One volume's display state, named after niivue's `NVDocumentVolume` so the
 * future port is a rename, not a redesign. `role` + array order capture layer
 * membership (base first, then overlays, then atlas) — no separate id lists.
 */
export interface BundleDocumentVolume {
  /** neurovue volume id; the bundle-data reference + future NVDocument url/name. */
  id: string
  role: 'base' | 'overlay' | 'atlas'
  colormap?: string
  opacity?: number
  /** Display window low — niivue's `calMin` (NOT the NIfTI `cal_min` header). */
  calMin?: number
  /** Display window high — niivue's `calMax`. */
  calMax?: number
  /**
   * neurovue visibility flag with no direct `NVDocumentVolume` field: renders at
   * opacity 0 without losing the stored `opacity`. Maps to effective opacity 0
   * on port.
   */
  hidden?: boolean
}

/**
 * The view-state blob stored inside the bundle manifest. Loose/forward-
 * compatible: an importer tolerates missing fields (older bundles) and ignores
 * unknown ones (newer bundles). Field names track `NVDocumentData`.
 */
export interface BundleViewState {
  version: 1
  /** Scene-level state, named toward `NVDocumentData.scene`. */
  scene: {
    /** RAS+ world-mm crosshair — niivue's `scene.crosshairPos`. */
    crosshairPos: [number, number, number] | null
    /**
     * Enabled clip planes. neurovue's `ClipPlane` is richer than niivue's flat
     * clip-plane params; it converts on port.
     */
    clipPlanes: ClipPlane[]
  }
  /** Volumes in render order (base → overlays → atlas); mirrors `NVDocumentData.volumes`. */
  volumes: BundleDocumentVolume[]
  viewMode: string
  backend: Backend
}

/**
 * Assemble the NVDocument-shaped view blob from the app's raw layer state.
 * Centralizes the `LayerSettings` → `NVDocumentVolume` field mapping (the part
 * that becomes a real NVDocument later).
 */
export function buildBundleViewState(params: {
  baseId: string
  overlayIds: string[]
  atlasId: string | null
  layerSettings: Record<string, BundleLayerSettings>
  viewMode: string
  backend: Backend
  clipPlanes: ClipPlane[]
  crosshairPos: [number, number, number] | null
}): BundleViewState {
  const toVolume = (id: string, role: BundleDocumentVolume['role']): BundleDocumentVolume => {
    const settings = params.layerSettings[id]
    const volume: BundleDocumentVolume = { id, role }
    if (settings?.colormap !== undefined) volume.colormap = settings.colormap
    if (settings?.opacity !== undefined) volume.opacity = settings.opacity
    if (settings?.hidden !== undefined) volume.hidden = settings.hidden
    if (settings?.window) {
      volume.calMin = settings.window.min
      volume.calMax = settings.window.max
    }
    return volume
  }

  const volumes: BundleDocumentVolume[] = [toVolume(params.baseId, 'base')]
  const seen = new Set<string>([params.baseId])
  for (const id of params.overlayIds) {
    if (seen.has(id)) continue
    seen.add(id)
    volumes.push(toVolume(id, 'overlay'))
  }
  if (params.atlasId && !seen.has(params.atlasId)) {
    seen.add(params.atlasId)
    volumes.push(toVolume(params.atlasId, 'atlas'))
  }

  return {
    version: 1,
    scene: {
      crosshairPos: params.crosshairPos,
      clipPlanes: params.clipPlanes.filter((plane) => plane.enabled)
    },
    volumes,
    viewMode: params.viewMode,
    backend: params.backend
  }
}

export interface ExportBundleResult {
  bundlePath: string
  volumeCount: number
  totalBytes: number
}

/**
 * Prompt for a destination and write the selected volumes + view as a bundle.
 * Returns `null` if the user cancels the save dialog.
 */
export async function exportDatasetBundle(params: {
  defaultName: string
  volumeIds: string[]
  view: BundleViewState
}): Promise<ExportBundleResult | null> {
  const destPath = await save({
    title: 'Export NeuroVue bundle',
    defaultPath: `${sanitizeBundleName(params.defaultName)}.nvbundle`
  })
  if (!destPath) return null

  return invoke<ExportBundleResult>('export_dataset_bundle', {
    destPath,
    volumeIds: params.volumeIds,
    view: params.view,
    // Timestamp stays on the JS side (matches the savePatch convention and
    // avoids a time-format crate on the Rust side).
    createdAt: new Date().toISOString()
  })
}

/**
 * Export the current view to a staged bundle and hand it to the macOS AirDrop
 * sheet (no save dialog — the bundle is staged under the app cache). macOS only;
 * gate the UI on `RuntimeCapabilities.airdropAvailable`.
 */
export async function shareViewViaAirDrop(params: {
  name: string
  volumeIds: string[]
  view: BundleViewState
}): Promise<ExportBundleResult> {
  return invoke<ExportBundleResult>('share_view_via_airdrop', {
    volumeIds: params.volumeIds,
    view: params.view,
    createdAt: new Date().toISOString(),
    name: params.name
  })
}

/** Human-readable byte size for status messages ("1.4 GB", "820 MB"). */
export function formatBundleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3))
  const value = bytes / 1000 ** exponent
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

function sanitizeBundleName(name: string): string {
  const cleaned = name.trim().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'neurovue-bundle'
}

// ── Import / reload ────────────────────────────────────────────────────────

export type BundleVerifyStatus = 'ok' | 'mismatch' | 'missing' | 'unreadable' | 'invalid'

export interface BundleVerifyEntry {
  data: string
  expected: string
  actual: string | null
  status: BundleVerifyStatus
}

/** One volume as recorded in a bundle manifest (see Rust `export_bundle`). */
export interface BundleManifestVolume {
  id: string
  role: string
  label?: string
  data: string
  sha256?: string
}

export interface BundleManifest {
  nvbundle?: string
  source?: { datasetName?: string | null; datasetDoi?: string | null; datasetRoot?: string | null }
  volumes: BundleManifestVolume[]
  view?: BundleViewState
}

export interface BundleReadResult {
  manifest: BundleManifest
  bundlePath: string
  dataDir: string
  verification: BundleVerifyEntry[]
  allVerified: boolean
}

/** Prompt for a `.nvbundle` file to open. Returns null if cancelled. */
export async function pickBundle(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: 'Open NeuroVue bundle',
    filters: [{ name: 'NeuroVue bundle', extensions: ['nvbundle'] }]
  })
  return typeof selected === 'string' ? selected : null
}

/** Read + hash-verify a bundle's manifest (no volumes loaded yet). */
export async function readBundle(path: string): Promise<BundleReadResult> {
  return invoke<BundleReadResult>('read_bundle_manifest', { path })
}

/**
 * The server volume id a bundle data file gets once its `data/` dir is opened
 * as a dataset. Mirrors Rust `volume_id()`: the filename stem (relative to the
 * `data/` root, which is flat) minus the `.nii` / `.nii.gz` extension.
 */
export function bundleVolumeId(dataRelPath: string): string {
  const base = dataRelPath.split('/').pop() ?? dataRelPath
  return base.replace(/\.nii\.gz$/i, '').replace(/\.nii$/i, '')
}

/** Count the files in a verification list that failed the integrity check. */
export function bundleVerifyFailures(verification: BundleVerifyEntry[]): BundleVerifyEntry[] {
  return verification.filter((entry) => entry.status !== 'ok')
}
