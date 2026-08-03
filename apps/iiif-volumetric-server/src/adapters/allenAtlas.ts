// Allen "volume-viewer" JSON + PNG atlas adapter.
//
// A dataset is one JSON sidecar plus N PNG atlases; each PNG is a row-major
// grid of tiles (one tile per Z slice) packing up to four independent image
// channels into its R/G/B/A planes. See
// packages/niivue/docs/allen-atlas-format.md.
//
// The sidecar parsing and plane deinterleave are shared with the browser
// loader rather than reimplemented here: a second copy of the validation
// would drift, and a mis-sized atlas decodes into plausible-looking garbage
// rather than failing loudly. The import reaches into niivue's source
// because that module is pure (no DOM) but the package publishes no subpath
// for it; a real subpath export is the tidier home if this sticks.

import fs from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import {
  type AllenAtlasInfo,
  allenAtlasSpacing,
  allenAtlasVolumeDims,
  deinterleaveAllenAtlasPlane,
  findAllenAtlasChannel,
  parseAllenAtlasInfo,
} from '../../../../packages/niivue/src/volume/allenAtlas.ts'
import type {
  AdapterChannel,
  AdapterContext,
  ChannelSelector,
  ProbeMeta,
  VolumeAdapter,
} from './nifti.ts'
import type { Affine4x4, Vec3 } from './volumeHandle.ts'
import { VolumeHandle } from './volumeHandle.ts'

// Sidecars are named `<dataset>_atlas.json` by Vol-E's exporter. Gating on
// that suffix rather than every .json keeps the scan from probing (and
// warning about) unrelated sidecars, e.g. a BIDS .json next to a NIfTI.
const SIDECAR_RE = /_atlas\.json$/i

export const allenAtlasAdapter: VolumeAdapter = {
  format: 'allen-atlas',

  canHandle(p: string, { isDirectory }: AdapterContext): boolean {
    if (isDirectory) return false
    return SIDECAR_RE.test(p)
  },

  async probe(filePath: string): Promise<ProbeMeta> {
    const info = await readSidecar(filePath)
    return {
      shape: allenAtlasVolumeDims(info),
      dtype: 'uint8',
      spacing: allenAtlasSpacing(info) as Vec3,
      affine: centredAffine(info),
    }
  },

  async probeChannels(filePath: string): Promise<AdapterChannel[]> {
    const info = await readSidecar(filePath)
    // Only channels an atlas actually carries: the sidecar's `channels`
    // count and the union of images[].channels can disagree, and an entry
    // for a channel no PNG holds would 500 on first load.
    const carried = info.channelNames
      .map((name, index) => ({ index, name }))
      .filter((c) => findAllenAtlasChannel(info, c.index) !== undefined)
    if (carried.length === 0) {
      // Returning none would make the registry fall back to a single
      // unnamed entry that 500s on first load; fail the scan instead.
      throw new Error('Allen atlas: no images[] entry carries any channel')
    }
    return carried
  },

  async load(
    filePath: string,
    channel?: ChannelSelector,
  ): Promise<VolumeHandle> {
    const info = await readSidecar(filePath)
    const index = channel ?? 0
    const located = findAllenAtlasChannel(info, index)
    if (!located) {
      throw new Error(`Allen atlas: no image carries channel ${index}`)
    }
    const rgba = await decodeAtlas(
      path.join(path.dirname(filePath), located.image.name),
      info,
    )
    const data = deinterleaveAllenAtlasPlane(rgba, info, located.plane)
    return new VolumeHandle({
      shape: allenAtlasVolumeDims(info),
      spacing: allenAtlasSpacing(info) as Vec3,
      dtype: 'uint8',
      data,
      affine: centredAffine(info),
      units: info.spacingUnit,
      metadata: {
        channel: index,
        channelName: info.channelNames[index],
        atlas: located.image.name,
        plane: located.plane,
      },
    })
  },
}

async function readSidecar(filePath: string): Promise<AllenAtlasInfo> {
  const text = await fs.readFile(filePath, 'utf8')
  return parseAllenAtlasInfo(JSON.parse(text))
}

async function decodeAtlas(
  imagePath: string,
  info: AllenAtlasInfo,
): Promise<Uint8Array> {
  const png = PNG.sync.read(await fs.readFile(imagePath))
  if (png.width !== info.atlasWidth || png.height !== info.atlasHeight) {
    throw new Error(
      `Allen atlas: ${path.basename(imagePath)} is ${png.width}x${png.height}, ` +
        `sidecar says ${info.atlasWidth}x${info.atlasHeight}`,
    )
  }
  // pngjs always yields 8-bit RGBA regardless of the source colour type,
  // which is exactly what deinterleave expects.
  return new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length)
}

// Centre the volume on the origin so every channel of a dataset shares one
// world position no matter which subset a client asks for. Matches what the
// browser loader builds.
function centredAffine(info: AllenAtlasInfo): Affine4x4 {
  const [sx, sy, sz] = allenAtlasVolumeDims(info)
  const [dx, dy, dz] = allenAtlasSpacing(info)
  return [
    [dx, 0, 0, -(sx - 1) * 0.5 * dx],
    [0, dy, 0, -(sy - 1) * 0.5 * dy],
    [0, 0, dz, -(sz - 1) * 0.5 * dz],
    [0, 0, 0, 1],
  ]
}
