// IIIF Presentation API 4.0 alpha (draft 3D) manifest generation.

import type {
  Affine4x4,
  Axis,
  Dtype,
  Shape3,
  Vec3,
} from '../adapters/volumeHandle.ts'
import type { LevelMetadata, RegistryEntry } from '../registry.ts'
import type { Bbox6, ExplodeLayout } from './explode.ts'

export const PREZI_4_CONTEXT =
  'http://iiif.io/api/presentation/4/context.json'

const NIFTI_MEDIA_TYPE = 'application/x.nifti'
const NIFTI_RLE_MEDIA_TYPE = 'application/x.nifti-rle'
const VOL_NS = 'https://example.org/iiif/volumetric#'

const DTYPE_BYTES: Record<Dtype, number> = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
  rgb24: 3,
  rgba32: 4,
}

function dtypeByteWidth(dtype: Dtype): number {
  return DTYPE_BYTES[dtype] ?? 1
}

function levelDataBoundingBox(level: LevelMetadata): Bbox6 {
  const off = level.cropOffset ?? [0, 0, 0]
  const [sx, sy, sz] = level.shape
  return [off[0], off[1], off[2], off[0] + sx, off[1] + sy, off[2] + sz]
}

function affineCorner(
  aff: Affine4x4,
  i: number,
  j: number,
  k: number,
): [number, number, number] {
  return [
    aff[0][0] * i + aff[0][1] * j + aff[0][2] * k + aff[0][3],
    aff[1][0] * i + aff[1][1] * j + aff[1][2] * k + aff[1][3],
    aff[2][0] * i + aff[2][1] * j + aff[2][2] * k + aff[2][3],
  ]
}

function worldBboxFromVoxelBbox(
  affine: Affine4x4 | null,
  bbox: Bbox6,
): Bbox6 {
  const [x0, y0, z0, x1, y1, z1] = bbox
  if (!affine) return [x0, y0, z0, x1, y1, z1]
  let xmin = Number.POSITIVE_INFINITY
  let ymin = Number.POSITIVE_INFINITY
  let zmin = Number.POSITIVE_INFINITY
  let xmax = Number.NEGATIVE_INFINITY
  let ymax = Number.NEGATIVE_INFINITY
  let zmax = Number.NEGATIVE_INFINITY
  for (const i of [x0, x1]) {
    for (const j of [y0, y1]) {
      for (const k of [z0, z1]) {
        const [x, y, z] = affineCorner(affine, i, j, k)
        if (x < xmin) xmin = x
        if (x > xmax) xmax = x
        if (y < ymin) ymin = y
        if (y > ymax) ymax = y
        if (z < zmin) zmin = z
        if (z > zmax) zmax = z
      }
    }
  }
  return [xmin, ymin, zmin, xmax, ymax, zmax]
}

function worldBboxFromAffine(
  affine: Affine4x4 | null | undefined,
  shape: Shape3,
): Bbox6 {
  if (!affine) {
    return [0, 0, 0, shape[0], shape[1], shape[2]]
  }
  let xmin = Number.POSITIVE_INFINITY
  let ymin = Number.POSITIVE_INFINITY
  let zmin = Number.POSITIVE_INFINITY
  let xmax = Number.NEGATIVE_INFINITY
  let ymax = Number.NEGATIVE_INFINITY
  let zmax = Number.NEGATIVE_INFINITY
  for (const i of [0, shape[0]]) {
    for (const j of [0, shape[1]]) {
      for (const k of [0, shape[2]]) {
        const [x, y, z] = affineCorner(affine, i, j, k)
        if (x < xmin) xmin = x
        if (x > xmax) xmax = x
        if (y < ymin) ymin = y
        if (y > ymax) ymax = y
        if (z < zmin) zmin = z
        if (z > zmax) zmax = z
      }
    }
  }
  return [xmin, ymin, zmin, xmax, ymax, zmax]
}

interface OccupancyService {
  id: string
  type: 'OccupancyService'
  profile: string
  block: number
}

function occupancyService(
  baseUrl: string,
  id: string,
  block = 16,
): OccupancyService {
  return {
    id: `${baseUrl}/volumes/${id}/occupancy?block=${block}`,
    type: 'OccupancyService',
    profile: `${VOL_NS}occupancy`,
    block,
  }
}

export interface ManifestBuildArgs {
  baseUrl: string
  entry: RegistryEntry
}

export function buildManifest({ baseUrl, entry }: ManifestBuildArgs): unknown {
  const id = encodeURIComponent(entry.id)
  const manifestId = `${baseUrl}/iiif/presentation/${id}/manifest`
  const sceneId = `${baseUrl}/iiif/presentation/${id}/scene/0`
  const rawNiftiUrl = `${baseUrl}/volumes/${id}/raw.nii.gz`
  const viewerUrl = `${baseUrl}/?manifest=${encodeURIComponent(manifestId)}`

  const canvases = (['axial', 'coronal', 'sagittal'] as const).map((axis) =>
    buildSliceCanvas({ baseUrl, entry, axis, manifestId }),
  )

  const scene = buildScene({
    sceneId,
    rawNiftiUrl,
    entry,
    viewerUrl,
    baseUrl,
  })

  return {
    '@context': PREZI_4_CONTEXT,
    id: manifestId,
    type: 'Manifest',
    label: { en: [`Volume ${entry.id}`] },
    summary: {
      en: [
        `Volumetric ${entry.format} dataset, ${entry.shape.join(
          ' × ',
        )}, dtype ${entry.dtype}.`,
      ],
    },
    metadata: [
      { label: { en: ['Format'] }, value: { en: [entry.format] } },
      { label: { en: ['Shape'] }, value: { en: [entry.shape.join(' × ')] } },
      {
        label: { en: ['Voxel spacing'] },
        value: { en: [entry.spacing.join(' × ')] },
      },
      { label: { en: ['Data type'] }, value: { en: [entry.dtype] } },
    ],
    rendering: [
      {
        id: rawNiftiUrl,
        type: 'Dataset',
        label: { en: ['Raw NIfTI volume'] },
        format: NIFTI_MEDIA_TYPE,
      },
      {
        id: viewerUrl,
        type: 'Text',
        label: { en: ['3D viewer (niivuegpu)'] },
        format: 'text/html',
      },
    ],
    items: [...canvases, scene],
  }
}

function buildSliceCanvas(args: {
  baseUrl: string
  entry: RegistryEntry
  axis: Axis
  manifestId: string
}): unknown {
  const { baseUrl, entry, axis, manifestId } = args
  const [w, h] = sliceDims(entry.shape, axis)
  const n = sliceCount(entry.shape, axis)
  const middle = Math.floor(n / 2)
  const id = `${manifestId}/canvas/${axis}`
  return {
    id,
    type: 'Canvas',
    label: { en: [`${cap(axis)} slice (mid=${middle} of ${n})`] },
    width: w,
    height: h,
    items: [
      {
        id: `${id}/page`,
        type: 'AnnotationPage',
        items: [
          {
            id: `${id}/annotation`,
            type: 'Annotation',
            motivation: 'painting',
            target: id,
            body: {
              id: `${baseUrl}/iiif/image/${encodeURIComponent(entry.id)}/${axis}/${middle}/full/max/0/default.png`,
              type: 'Image',
              format: 'image/png',
              width: w,
              height: h,
              service: [
                {
                  id: `${baseUrl}/iiif/image/${encodeURIComponent(entry.id)}/${axis}/${middle}`,
                  type: 'ImageService3',
                  profile: 'level1',
                },
              ],
            },
          },
        ],
      },
    ],
    behavior: ['paged'],
    metadata: [
      { label: { en: ['Slice axis'] }, value: { en: [axis] } },
      { label: { en: ['Slice count'] }, value: { en: [String(n)] } },
    ],
  }
}

function buildScene(args: {
  sceneId: string
  rawNiftiUrl: string
  entry: RegistryEntry
  viewerUrl: string
  baseUrl: string
}): unknown {
  const { sceneId, rawNiftiUrl, entry, viewerUrl, baseUrl } = args
  const id = encodeURIComponent(entry.id)
  const [sx, sy, sz] = entry.shape
  const [dx, dy, dz] = entry.spacing
  const occ = occupancyService(baseUrl, id)

  const buildLevelBody = (l: LevelMetadata): unknown => {
    const voxels = l.shape[0] * l.shape[1] * l.shape[2]
    return {
      id: l.level === 0 ? rawNiftiUrl : `${rawNiftiUrl}?level=${l.level}`,
      type: 'Model',
      format: NIFTI_MEDIA_TYPE,
      label: {
        en: [
          l.level === 0
            ? `${entry.id} (Native Resolution)`
            : `${entry.id} (Level ${l.level} Downsampled)`,
        ],
      },
      boundingBox: worldBboxFromAffine(l.affine, l.shape),
      bytes: l.bytes ?? voxels * dtypeByteWidth(entry.dtype),
      service: [occ],
      [VOL_NS]: {
        shape: l.shape,
        spacing: l.spacing,
        dtype: entry.dtype,
        dataBoundingBox: levelDataBoundingBox(l),
        originalShape: l.originalShape || l.shape,
        viewer: viewerUrl,
      },
    }
  }

  const buildLevelRleSibling = (l: LevelMetadata): unknown => {
    const voxels = l.shape[0] * l.shape[1] * l.shape[2]
    return {
      id: l.level === 0 ? rawNiftiUrl : `${rawNiftiUrl}?level=${l.level}`,
      type: 'Model',
      format: NIFTI_RLE_MEDIA_TYPE,
      label: {
        en: [
          l.level === 0
            ? `${entry.id} (Native Resolution, RLE)`
            : `${entry.id} (Level ${l.level} Downsampled, RLE)`,
        ],
      },
      boundingBox: worldBboxFromAffine(l.affine, l.shape),
      bytes: 352 + voxels * 5,
      service: [occ],
      [VOL_NS]: {
        shape: l.shape,
        spacing: l.spacing,
        dtype: entry.dtype,
        dataBoundingBox: levelDataBoundingBox(l),
        originalShape: l.originalShape || l.shape,
        viewer: viewerUrl,
        encoding: 'rle',
      },
    }
  }

  const choiceItems = (l: LevelMetadata): unknown[] =>
    entry.dtype === 'uint8'
      ? [buildLevelBody(l), buildLevelRleSibling(l)]
      : [buildLevelBody(l)]

  let body: unknown
  if (entry.levels && entry.levels.length > 1) {
    body = {
      type: 'Choice',
      items: entry.levels.flatMap(choiceItems),
    }
  } else if (entry.levels && entry.levels.length === 1) {
    const items = choiceItems(entry.levels[0] as LevelMetadata)
    body = items.length === 1 ? items[0] : { type: 'Choice', items }
  } else {
    body = {
      id: rawNiftiUrl,
      type: 'Model',
      format: NIFTI_MEDIA_TYPE,
      label: { en: [`${entry.id} (NIfTI)`] },
      boundingBox: worldBboxFromAffine(entry.affine, entry.shape),
      service: [occ],
      [VOL_NS]: {
        shape: entry.shape,
        spacing: entry.spacing,
        dtype: entry.dtype,
        dataBoundingBox: [
          0,
          0,
          0,
          entry.shape[0],
          entry.shape[1],
          entry.shape[2],
        ],
        originalShape: entry.shape,
        viewer: viewerUrl,
      },
    }
  }

  return {
    id: sceneId,
    type: 'Scene',
    label: { en: [`3D volume of ${entry.id}`] },
    width: sx * dx,
    height: sy * dy,
    depth: sz * dz,
    backgroundColor: '#000000',
    items: [
      {
        id: `${sceneId}/page`,
        type: 'AnnotationPage',
        items: [
          {
            id: `${sceneId}/annotation/model`,
            type: 'Annotation',
            motivation: 'painting',
            target: sceneId,
            body,
            selector: {
              type: 'PointSelector',
              x: (sx * dx) / 2,
              y: (sy * dy) / 2,
              z: (sz * dz) / 2,
            },
          },
        ],
      },
    ],
    rendering: [
      {
        id: viewerUrl,
        type: 'Text',
        format: 'text/html',
        label: { en: ['3D viewer (niivuegpu)'] },
      },
    ],
  }
}

export interface ExplodedManifestArgs {
  baseUrl: string
  entry: RegistryEntry
  layout: ExplodeLayout
  wantsComposite?: boolean
}

export function buildExplodedManifest(args: ExplodedManifestArgs): unknown {
  const { baseUrl, entry, layout, wantsComposite = false } = args
  const id = encodeURIComponent(entry.id)
  const { nx, ny, nz, ex, ey, ez } = layout.params
  const qs = `nx=${nx}&ny=${ny}&nz=${nz}&ex=${ex}&ey=${ey}&ez=${ez}`
  const manifestId = `${baseUrl}/iiif/presentation/${id}/exploded/manifest?${qs}`
  const sceneId = `${baseUrl}/iiif/presentation/${id}/exploded/scene?${qs}`
  const compositeUrl = `${baseUrl}/volumes/${id}/exploded.nii.gz?${qs}&composite=1`
  const viewerUrl = `${baseUrl}/?manifest=${encodeURIComponent(manifestId)}&mode=exploded`
  const occ = occupancyService(baseUrl, id)
  const dtBytes = dtypeByteWidth(entry.dtype)

  const [Cx, Cy, Cz] = layout.compositeShape
  const [dx, dy, dz] = layout.compositeSpacing

  const cellAnnotations = layout.cells.map((cell, idx) => {
    const cellWorldBbox = worldBboxFromVoxelBbox(entry.affine, cell.sourceBbox)
    const items = entry.levels.flatMap((l) => {
      const scale = 2 ** l.level
      const bboxAtLevel = cell.sourceBbox.map((v) => Math.floor(v / scale)) as Bbox6
      const bboxQ = bboxAtLevel.join(',')
      const levelQ = l.level > 0 ? `&level=${l.level}` : ''
      const cellUrl = `${baseUrl}/volumes/${id}/raw.nii.gz?bbox=${bboxQ}${levelQ}`
      const cellShapeAtLevel = layout.cellShape.map((v) => Math.floor(v / scale)) as [
        number,
        number,
        number,
      ]
      const voxels =
        cellShapeAtLevel[0] * cellShapeAtLevel[1] * cellShapeAtLevel[2]
      const extCommon = {
        gridIndex: [cell.i, cell.j, cell.k],
        sourceBbox: cell.sourceBbox,
        bboxAtLevel,
        cellShape: cellShapeAtLevel,
        level: l.level,
      }
      const niftiItem: unknown = {
        id: cellUrl,
        type: 'Model',
        format: NIFTI_MEDIA_TYPE,
        label: {
          en: [
            l.level === 0
              ? `${entry.id} cell ${cell.i},${cell.j},${cell.k} (Native)`
              : `${entry.id} cell ${cell.i},${cell.j},${cell.k} (Level ${l.level})`,
          ],
        },
        boundingBox: cellWorldBbox,
        bytes: voxels * dtBytes + 352,
        service: [occ],
        [VOL_NS]: extCommon,
      }
      if (entry.dtype !== 'uint8') return [niftiItem]
      const rleItem: unknown = {
        id: cellUrl,
        type: 'Model',
        format: NIFTI_RLE_MEDIA_TYPE,
        label: {
          en: [
            l.level === 0
              ? `${entry.id} cell ${cell.i},${cell.j},${cell.k} (Native, RLE)`
              : `${entry.id} cell ${cell.i},${cell.j},${cell.k} (Level ${l.level}, RLE)`,
          ],
        },
        boundingBox: cellWorldBbox,
        bytes: 352 + voxels * 5,
        service: [occ],
        [VOL_NS]: { ...extCommon, encoding: 'rle' },
      }
      return [niftiItem, rleItem]
    })

    return {
      id: `${sceneId}#cell-${idx}`,
      type: 'Annotation',
      motivation: 'painting',
      target: sceneId,
      label: { en: [`Cell (${cell.i}, ${cell.j}, ${cell.k})`] },
      body: { type: 'Choice', items },
      selector: {
        type: 'PointSelector',
        x: cell.sceneCenter[0],
        y: cell.sceneCenter[1],
        z: cell.sceneCenter[2],
      },
    }
  })

  const sceneRendering: Array<Record<string, unknown>> = [
    {
      id: viewerUrl,
      type: 'Text',
      format: 'text/html',
      label: { en: ['3D viewer (niivuegpu)'] },
    },
  ]
  if (wantsComposite) {
    sceneRendering.unshift({
      id: compositeUrl,
      type: 'Dataset',
      format: NIFTI_MEDIA_TYPE,
      label: { en: ['Composite NIfTI (single volume render)'] },
    })
  }

  const scene = {
    id: sceneId,
    type: 'Scene',
    label: {
      en: [
        `Exploded view of ${entry.id} (${nx}×${ny}×${nz}, ex=${ex}, ey=${ey}, ez=${ez})`,
      ],
    },
    width: Cx * dx,
    height: Cy * dy,
    depth: Cz * dz,
    backgroundColor: '#000000',
    items: [
      {
        id: `${sceneId}/page`,
        type: 'AnnotationPage',
        items: cellAnnotations,
      },
    ],
    rendering: sceneRendering,
  }

  const manifestRendering: Array<Record<string, unknown>> = [
    {
      id: viewerUrl,
      type: 'Text',
      format: 'text/html',
      label: { en: ['3D viewer (niivuegpu)'] },
    },
  ]
  if (wantsComposite) {
    manifestRendering.unshift({
      id: compositeUrl,
      type: 'Dataset',
      format: NIFTI_MEDIA_TYPE,
      label: { en: ['Composite exploded NIfTI'] },
    })
  }

  return {
    '@context': PREZI_4_CONTEXT,
    id: manifestId,
    type: 'Manifest',
    label: {
      en: [`Exploded ${entry.id} ${nx}×${ny}×${nz} ex=${ex} ey=${ey} ez=${ez}`],
    },
    summary: {
      en: [
        `Exploded view of ${entry.id}: ${nx * ny * nz} cells of ${layout.cellShape.join(
          '×',
        )}, composite shape ${layout.compositeShape.join('×')}.`,
      ],
    },
    metadata: [
      { label: { en: ['Source volume'] }, value: { en: [entry.id] } },
      { label: { en: ['Grid'] }, value: { en: [`${nx} × ${ny} × ${nz}`] } },
      {
        label: { en: ['Explode factors'] },
        value: { en: [`X=${ex}, Y=${ey}, Z=${ez}`] },
      },
      {
        label: { en: ['Cell shape'] },
        value: { en: [layout.cellShape.join(' × ')] },
      },
      {
        label: { en: ['Composite shape'] },
        value: { en: [layout.compositeShape.join(' × ')] },
      },
    ],
    rendering: manifestRendering,
    items: [scene],
  }
}

function sliceDims(shape: Shape3, axis: Axis): [number, number] {
  if (axis === 'axial') return [shape[0], shape[1]]
  if (axis === 'coronal') return [shape[0], shape[2]]
  if (axis === 'sagittal') return [shape[1], shape[2]]
  throw new Error(`Unknown axis: ${axis as string}`)
}

function sliceCount(shape: Shape3, axis: Axis): number {
  if (axis === 'axial') return shape[2]
  if (axis === 'coronal') return shape[1]
  if (axis === 'sagittal') return shape[0]
  throw new Error(`Unknown axis: ${axis as string}`)
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export type { Vec3 }
