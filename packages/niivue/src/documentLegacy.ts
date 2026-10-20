// Convert a classic-NiiVue JSON document (the original `@niivue/niivue`
// `ExportDocumentData` shape: flat `opts`, `sceneData`, `imageOptionsArray`,
// base64 `encodedImageBlobs`, `meshesString`) into this package's NVDocumentData.
//
// Best-effort + dependency-free (so it is unit-testable): volumes/meshes are
// LINKED by their URL (the classic doc always carries per-volume URLs), so the
// loader refetches them — the embedded base64 NIfTI blobs are NOT decoded (that
// needs the GPU-volume reader). A mesh keeps its colour, shader and URL-linked
// scalar-overlay layers (colormap, window, opacity, negative colormap). Settings
// are mapped for the well-known fields and emitted sparsely; the loader fills the
// rest from defaults. Anything not mapped (the drawing blob, unrecognized opts,
// URL-less volumes or layers, unknown shader indices) is reported in `warnings`.
// Used by `scripts/convert-legacy-nvd.ts`.

import * as NVConstants from '@/NVConstants'
import type {
  NVDocumentData,
  NVDocumentMesh,
  NVDocumentMeshLayer,
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

// classic `meshShaderIndex` -> our `shaderType`, by classic's shader list order
// (Phong, Matte, Harmonic, Hemispheric, Crevice, Edge, Diffuse, Outline,
// Specular, Toon, Flat, Matcap, Rim, Silhouette, Crosscut). The six with no
// counterpart here fall back to 'phong' with a warning.
const LEGACY_SHADER_NAMES: Record<number, string> = {
  0: 'phong',
  1: 'matte',
  4: 'crevice',
  7: 'outline',
  9: 'toon',
  10: 'flat',
  12: 'rim',
  13: 'silhouette',
  14: 'crosscut',
}
const LEGACY_SHADER_FALLBACK = 'phong'

// classic's default negative colormap; `useNegativeCmap` was a boolean flag
// that enabled it, whereas we name the negative colormap directly.
const LEGACY_NEGATIVE_COLORMAP = 'winter'

function convertLegacyLayer(
  l: Record<string, unknown>,
  meshLabel: string,
  warnings: string[],
): NVDocumentMeshLayer | null {
  const url = typeof l.url === 'string' ? l.url : undefined
  if (!url) {
    warnings.push(
      `mesh "${meshLabel}": a layer has no URL — skipped (embedded layer values are not decoded)`,
    )
    return null
  }
  const layer: NVDocumentMeshLayer = { url }
  if (typeof l.name === 'string') layer.name = l.name
  if (typeof l.colormap === 'string') layer.colormap = l.colormap
  const calMin = l.cal_min ?? l.calMin
  const calMax = l.cal_max ?? l.calMax
  if (typeof calMin === 'number') layer.calMin = calMin
  if (typeof calMax === 'number') layer.calMax = calMax
  const calMinNeg = l.cal_minNeg ?? l.calMinNeg
  const calMaxNeg = l.cal_maxNeg ?? l.calMaxNeg
  if (typeof calMinNeg === 'number') layer.calMinNeg = calMinNeg
  if (typeof calMaxNeg === 'number') layer.calMaxNeg = calMaxNeg
  if (typeof l.opacity === 'number') layer.opacity = l.opacity
  if (l.useNegativeCmap === true) {
    layer.colormapNegative =
      typeof l.colormapNegative === 'string' && l.colormapNegative !== ''
        ? l.colormapNegative
        : LEGACY_NEGATIVE_COLORMAP
  }
  return layer
}

function convertLegacyMesh(
  m: Record<string, unknown>,
  warnings: string[],
): NVDocumentMesh | null {
  const url = typeof m.url === 'string' ? m.url : undefined
  const label = typeof m.name === 'string' ? m.name : (url ?? '(unnamed)')
  if (!url) {
    warnings.push(`mesh "${label}" has no URL — skipped`)
    return null
  }
  const mesh: NVDocumentMesh = { url }
  if (typeof m.name === 'string') mesh.name = m.name
  if (typeof m.opacity === 'number') mesh.opacity = m.opacity
  const rgba = m.rgba255
  if (
    Array.isArray(rgba) &&
    rgba.length === 4 &&
    rgba.every((c) => typeof c === 'number')
  ) {
    const [r, g, b, a] = rgba as number[]
    mesh.color = [r / 255, g / 255, b / 255, a / 255]
  }
  if (typeof m.meshShaderIndex === 'number') {
    const name = LEGACY_SHADER_NAMES[m.meshShaderIndex]
    if (name) {
      mesh.shaderType = name
    } else {
      mesh.shaderType = LEGACY_SHADER_FALLBACK
      warnings.push(
        `mesh "${label}": meshShaderIndex ${m.meshShaderIndex} has no equivalent — using '${LEGACY_SHADER_FALLBACK}'`,
      )
    }
  }
  if (Array.isArray(m.layers)) {
    const layers: NVDocumentMeshLayer[] = []
    for (const l of m.layers) {
      if (typeof l !== 'object' || l === null) continue
      const layer = convertLegacyLayer(
        l as Record<string, unknown>,
        label,
        warnings,
      )
      if (layer) layers.push(layer)
    }
    if (layers.length > 0) mesh.layers = layers
  }
  return mesh
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

  // --- meshesString -> meshes (linked by URL, with colour/shader/layers) ---
  const meshes: NVDocumentMesh[] = []
  if (legacy.meshesString && legacy.meshesString.length > 2) {
    try {
      const parsed = JSON.parse(legacy.meshesString) as Record<
        string,
        unknown
      >[]
      for (const m of Array.isArray(parsed) ? parsed : []) {
        const mesh = convertLegacyMesh(m, warnings)
        if (mesh) meshes.push(mesh)
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
