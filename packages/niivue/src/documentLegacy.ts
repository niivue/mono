// Convert a classic-NiiVue JSON document (the original `@niivue/niivue`
// `ExportDocumentData` shape: flat `opts`, `sceneData`, `imageOptionsArray`,
// base64 `encodedImageBlobs`, `meshesString`) into this package's NVDocumentData.
//
// Best-effort + dependency-free (so it is unit-testable): volumes/meshes are
// LINKED by their URL (the classic doc always carries per-volume URLs), so the
// loader refetches them — the embedded base64 NIfTI blobs are NOT decoded (that
// needs the GPU-volume reader). Settings are mapped for the well-known fields and
// emitted sparsely; the loader fills the rest from defaults. Anything not mapped
// (the drawing blob, unrecognized opts, URL-less volumes) is reported in
// `warnings`. Used by `scripts/convert-legacy-nvd.ts`.

import * as NVConstants from '@/NVConstants'
import type {
  NVDocumentData,
  NVDocumentMesh,
  NVDocumentVolume,
} from '@/NVDocument'

/** Loose shape of a classic-NiiVue JSON document (only the fields we read). */
export interface LegacyDocument {
  title?: string
  sceneData?: Record<string, unknown>
  opts?: Record<string, unknown>
  imageOptionsArray?: Record<string, unknown>[]
  encodedImageBlobs?: (string | null)[]
  encodedDrawingBlob?: string | null
  meshesString?: string
  [key: string]: unknown
}

export interface LegacyConversionResult {
  doc: NVDocumentData
  warnings: string[]
}

// classic opts key -> [our group, our key]. Values are copied as-is (colors are
// already [r,g,b,a] arrays; booleans/numbers line up). Only mapped keys are
// emitted; the loader fills the rest from defaults.
const OPT_MAP: Record<string, [keyof NVDocumentData, string]> = {
  // ui
  isColorbar: ['ui', 'isColorbarVisible'],
  isOrientCube: ['ui', 'isOrientCubeVisible'],
  isRuler: ['ui', 'isRulerVisible'],
  show3Dcrosshair: ['ui', 'is3DCrosshairVisible'],
  crosshairColor: ['ui', 'crosshairColor'],
  crosshairWidth: ['ui', 'crosshairWidth'],
  selectionBoxColor: ['ui', 'selectionBoxColor'],
  rulerWidth: ['ui', 'rulerWidth'],
  isSliceMM: ['ui', 'isPositionInMM'],
  loadingText: ['ui', 'placeholderText'],
  thumbnail: ['ui', 'thumbnailUrl'],
  // layout
  isRadiologicalConvention: ['layout', 'isRadiological'],
  // volume
  isNearestInterpolation: ['volume', 'isNearestInterpolation'],
  // mesh
  meshThicknessOn2D: ['mesh', 'thicknessOn2D'],
  // draw
  drawingEnabled: ['draw', 'isEnabled'],
  penValue: ['draw', 'penValue'],
  // interaction — classic DRAG_MODE 0..5 (none/contrast/measurement/pan/slicer3D/
  // callbackOnly) matches ours 1:1.
  dragMode: ['interaction', 'primaryDragMode'],
}

function setGroup(
  doc: Record<string, Record<string, unknown>>,
  group: string,
  key: string,
  value: unknown,
): void {
  if (!doc[group]) doc[group] = {}
  doc[group][key] = value
}

/**
 * Convert a classic-NiiVue document to NVDocumentData. `created` stamps the new
 * document (pass a timestamp; defaults to empty so the function stays pure).
 */
export function convertLegacyDocument(
  legacy: LegacyDocument,
  created = '',
): LegacyConversionResult {
  const warnings: string[] = []
  const scene: Record<string, unknown> = {}
  const groups: Record<string, Record<string, unknown>> = {}

  // --- sceneData -> scene ---
  const sd = legacy.sceneData ?? {}
  if (typeof sd.azimuth === 'number') scene.azimuth = sd.azimuth
  if (typeof sd.elevation === 'number') scene.elevation = sd.elevation
  if (Array.isArray(sd.crosshairPos)) scene.crosshairPos = sd.crosshairPos
  if (typeof sd.volScaleMultiplier === 'number') {
    scene.scaleMultiplier = sd.volScaleMultiplier
  }
  if (sd.clipPlane !== undefined) {
    warnings.push('sceneData.clipPlane not mapped (clip-plane restore differs)')
  }

  // --- opts -> config groups ---
  const opts = legacy.opts ?? {}
  const unmapped: string[] = []
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'backColor') {
      scene.backgroundColor = v
    } else if (k === 'clipPlaneColor') {
      scene.clipPlaneColor = v
    } else if (OPT_MAP[k]) {
      const [group, key] = OPT_MAP[k]
      setGroup(groups, group as string, key, v)
    } else {
      unmapped.push(k)
    }
  }
  if (unmapped.length > 0) {
    warnings.push(`${unmapped.length} opts not mapped: ${unmapped.join(', ')}`)
  }

  // --- imageOptionsArray -> volumes (linked by URL) ---
  const volumes: NVDocumentVolume[] = []
  for (const io of legacy.imageOptionsArray ?? []) {
    const url = typeof io.url === 'string' ? io.url : undefined
    if (!url) {
      warnings.push(
        `volume "${io.name ?? '(unnamed)'}" has no URL — skipped (embedded blobs are not decoded)`,
      )
      continue
    }
    const vol: NVDocumentVolume = { url }
    if (typeof io.name === 'string') vol.name = io.name
    if (typeof io.colormap === 'string') vol.colormap = io.colormap
    if (typeof io.colormapNegative === 'string') {
      vol.colormapNegative = io.colormapNegative
    }
    if (typeof io.opacity === 'number') vol.opacity = io.opacity
    const calMin = io.cal_min ?? io.calMin
    const calMax = io.cal_max ?? io.calMax
    if (typeof calMin === 'number') vol.calMin = calMin
    if (typeof calMax === 'number') vol.calMax = calMax
    volumes.push(vol)
  }

  // --- meshesString -> meshes (linked by URL, best-effort) ---
  const meshes: NVDocumentMesh[] = []
  if (legacy.meshesString && legacy.meshesString.length > 2) {
    try {
      const parsed = JSON.parse(legacy.meshesString) as Record<
        string,
        unknown
      >[]
      for (const m of Array.isArray(parsed) ? parsed : []) {
        const url = typeof m.url === 'string' ? m.url : undefined
        if (!url) {
          warnings.push('a mesh has no URL — skipped')
          continue
        }
        const mesh: NVDocumentMesh = { url }
        if (typeof m.name === 'string') mesh.name = m.name
        if (typeof m.opacity === 'number') mesh.opacity = m.opacity
        meshes.push(mesh)
      }
    } catch {
      warnings.push('meshesString could not be parsed — meshes skipped')
    }
  }

  if (legacy.encodedDrawingBlob) {
    warnings.push(
      'encodedDrawingBlob not converted (drawing restore is skipped)',
    )
  }

  const doc: NVDocumentData = {
    version: NVConstants.NVD_DOCUMENT_VERSION,
    created,
    scene,
    layout: groups.layout ?? {},
    ui: groups.ui ?? {},
    volume: groups.volume ?? {},
    mesh: groups.mesh ?? {},
    draw: groups.draw ?? {},
    interaction: groups.interaction ?? {},
    clipPlanes: [],
    volumes,
    meshes,
  }
  return { doc, warnings }
}
