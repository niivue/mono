// OME-Zarr / OME-TIFF adapter (proof-of-concept stub).
//
// Real OME-Zarr support requires walking a Zarr v2/v3 store, reading
// .zarray / zarr.json, and decoding chunks. For this POC we register the
// volume by reading just enough of the .zattrs/zarr.json metadata to
// produce a manifest.

import fs from 'node:fs/promises'
import path from 'node:path'
import type { AdapterContext, ProbeMeta, VolumeAdapter } from './nifti.ts'
import type { Dtype, Shape3, Vec3 } from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

interface Summary {
  shape: Shape3
  spacing: Vec3
  dtype: Dtype
  ngffVersion: string
}

interface MultiscaleDataset {
  path?: string
  coordinateTransformations?: Array<{ type: string; scale?: number[] }>
}
interface Multiscale {
  version?: string
  datasets?: MultiscaleDataset[]
}

interface ZarrV2Attrs {
  multiscales?: Multiscale[]
}

interface ZarrV2ArrayMeta {
  shape?: number[]
  dtype?: Dtype
}

interface ZarrV3Root {
  shape?: number[]
  data_type?: Dtype
  attributes?: {
    ome?: { multiscales?: Multiscale[] }
    multiscales?: Multiscale[]
  }
}

export const omezarrAdapter: VolumeAdapter = {
  format: 'ome-zarr',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (!isDirectory) return false
    return /\.(ome\.)?zarr$/i.test(p)
  },

  async probe(dirPath: string): Promise<ProbeMeta> {
    const meta = await readZarrRoot(dirPath)
    return {
      shape: meta.shape,
      dtype: meta.dtype,
      spacing: meta.spacing,
      affine: null,
    }
  },

  async load(dirPath: string): Promise<VolumeHandle> {
    const meta = await readZarrRoot(dirPath)
    const [sx, sy, sz] = meta.shape
    const data = new Uint8Array(sx * sy * sz)
    for (let z = 0; z < sz; z++) {
      for (let y = 0; y < sy; y++) {
        for (let x = 0; x < sx; x++) {
          data[x + y * sx + z * sx * sy] = ((x + y + z) * 2) & 0xff
        }
      }
    }
    return new VolumeHandle({
      shape: meta.shape,
      spacing: meta.spacing,
      dtype: 'uint8',
      data,
      metadata: {
        note: 'OME-Zarr placeholder. Full chunk decoding is on the roadmap.',
        ngffVersion: meta.ngffVersion,
      },
    })
  },
}

async function readZarrRoot(dirPath: string): Promise<Summary> {
  const v3Path = path.join(dirPath, 'zarr.json')
  try {
    const txt = await fs.readFile(v3Path, 'utf8')
    const root = JSON.parse(txt) as ZarrV3Root
    return summarizeFromV3(root)
  } catch (_) {
    // fall through
  }

  const attrsPath = path.join(dirPath, '.zattrs')
  let attrs: ZarrV2Attrs = {}
  try {
    const txt = await fs.readFile(attrsPath, 'utf8')
    attrs = JSON.parse(txt) as ZarrV2Attrs
  } catch (_) {
    // no attrs; we'll guess
  }
  const multiscales = attrs.multiscales
  let arrPath = dirPath
  if (Array.isArray(multiscales) && multiscales.length > 0) {
    const ds = multiscales[0]?.datasets?.[0]
    if (ds?.path) arrPath = path.join(dirPath, ds.path)
  }
  const arrayMetaPath = path.join(arrPath, '.zarray')
  let arrayMeta: ZarrV2ArrayMeta = {}
  try {
    arrayMeta = JSON.parse(await fs.readFile(arrayMetaPath, 'utf8')) as ZarrV2ArrayMeta
  } catch (_) {
    // no .zarray
  }
  const shape = pick3DShape(arrayMeta.shape || [1, 1, 1])
  const spacing = guessSpacing(multiscales)
  return {
    shape,
    spacing,
    dtype: arrayMeta.dtype || 'uint8',
    ngffVersion: multiscales?.[0]?.version || 'unknown',
  }
}

function summarizeFromV3(root: ZarrV3Root): Summary {
  const ms = root.attributes?.ome?.multiscales || root.attributes?.multiscales
  let shape: Shape3 = [1, 1, 1]
  if (root.shape) shape = pick3DShape(root.shape)
  return {
    shape,
    spacing: guessSpacing(ms),
    dtype: root.data_type || 'uint8',
    ngffVersion: 'v3',
  }
}

function pick3DShape(shape: number[]): Shape3 {
  const last3 = shape.slice(-3)
  while (last3.length < 3) last3.unshift(1)
  return [last3[2] ?? 1, last3[1] ?? 1, last3[0] ?? 1]
}

function guessSpacing(multiscales: Multiscale[] | undefined): Vec3 {
  if (!Array.isArray(multiscales) || multiscales.length === 0) {
    return [1, 1, 1]
  }
  const ct = multiscales[0]?.datasets?.[0]?.coordinateTransformations || []
  for (const t of ct) {
    if (t.type === 'scale' && Array.isArray(t.scale)) {
      const last3 = t.scale.slice(-3)
      while (last3.length < 3) last3.unshift(1)
      return [last3[2] ?? 1, last3[1] ?? 1, last3[0] ?? 1]
    }
  }
  return [1, 1, 1]
}
