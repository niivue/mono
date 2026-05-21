// Smoke test: scan the fixtures directory, generate the synthetic NIfTI
// if needed, and check that the in-process pipeline produces a valid
// IIIF info.json, a valid Presentation 4.0 manifest, and a slice PNG.

import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import url from 'node:url'
import zlib, { gzipSync } from 'node:zlib'
import express from 'express'

import { niftiAdapter } from '../src/adapters/nifti.ts'
import { VolumeHandle } from '../src/adapters/volumeHandle.ts'
import { buildDesktopManifest } from '../src/desktop/manifest.ts'
import { composeExplodedBuffer, planExplodedView } from '../src/iiif/explode.ts'
import { infoJson, renderImageRequest } from '../src/iiif/imageApi.ts'
import {
  buildExplodedManifest,
  buildManifest,
  PREZI_4_CONTEXT,
} from '../src/iiif/presentation.ts'
import { Registry, registry } from '../src/registry.ts'
import {
  cropRawNiftiFile,
  mountVolumeRoutes,
} from '../src/routes/volumeRoutes.ts'
import {
  autocropBackground,
  computeTightBbox,
  cropVolume,
} from '../src/util/autocrop.ts'
import { downsampleVolume } from '../src/util/downsample.ts'
import {
  type ContentEncoding,
  compressBuffer,
  encodeNiftiRaw,
  negotiateEncoding,
} from '../src/util/niftiEncoder.ts'
import {
  decodeNiftiRle,
  decodeRle,
  encodeNiftiRle,
  encodeRle,
  NIFTI_RLE_MEDIA_TYPE,
} from '../src/util/rleEncoder.ts'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, '..', 'fixtures')

interface RawResponse {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

async function ensureFixture(): Promise<void> {
  const target = path.join(FIXTURES, 'synthetic.nii.gz')
  try {
    await fs.access(target)
  } catch (_) {
    spawnSync(
      'bun',
      [path.resolve(__dirname, '..', 'scripts', 'make-synthetic-nifti.ts')],
      { stdio: 'inherit' },
    )
  }
}

beforeAll(async () => {
  await ensureFixture()
  await registry.scan(FIXTURES)
})

function firstModelBody(body: {
  type: string
  items?: Array<Record<string, unknown>>
  [key: string]: unknown
}): Record<string, unknown> {
  if (body.type === 'Choice' && Array.isArray(body.items)) {
    return body.items[0] as Record<string, unknown>
  }
  return body as unknown as Record<string, unknown>
}

function listenAnywhere(server: http.Server): Promise<number> {
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve(addr.port)
    })
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
}

describe('server smoke', () => {
  test('registry scans NIfTI', () => {
    const list = registry.list()
    const synthetic = list.find((v) => v.id.startsWith('synthetic'))
    expect(synthetic).toBeTruthy()
    if (!synthetic) return
    expect(synthetic.format).toBe('nifti')
    expect(synthetic.shape).toEqual([64, 64, 64])
  })

  test('Image API info.json shape', async () => {
    const niftiEntry = registry.list().find((v) => v.format === 'nifti')
    if (!niftiEntry) throw new Error('no nifti entries')
    const entry = await registry.load(niftiEntry.id)
    const j = infoJson({
      baseUrl: 'http://localhost',
      volId: entry.id,
      axis: 'axial',
      sliceIndex: 32,
      width: 64,
      height: 64,
    })
    expect(j['@context']).toBe('http://iiif.io/api/image/3/context.json')
    expect(j.type).toBe('ImageService3')
    expect(j.profile).toBe('level1')
    expect(j.width).toBe(64)
    expect(j.height).toBe(64)
    expect(Array.isArray(j.sizes) && j.sizes.length > 0).toBe(true)
  })

  test('Image API render produces PNG bytes', async () => {
    const niftiEntry = registry.list().find((v) => v.format === 'nifti')
    if (!niftiEntry) throw new Error('no nifti entries')
    const entry = await registry.load(niftiEntry.id)
    if (!entry.volume) throw new Error('volume not loaded')
    const { buffer, contentType } = await renderImageRequest(
      entry.volume,
      'axial',
      32,
      {
        region: 'full',
        size: 'max',
        rotation: '0',
        quality: 'default',
        format: 'png',
      },
    )
    expect(contentType).toBe('image/png')
    expect([...buffer.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  test('Presentation 4.0 manifest contains a Scene with a Model body', async () => {
    const niftiEntry = registry.list().find((v) => v.format === 'nifti')
    if (!niftiEntry) throw new Error('no nifti entries')
    const entry = await registry.load(niftiEntry.id)
    const manifest = buildManifest({
      baseUrl: 'http://localhost:8080',
      entry,
    }) as unknown as {
      '@context': string
      type: string
      items: Array<{
        type: string
        items: Array<{
          items: Array<{ body: Record<string, unknown> }>
        }>
      }>
    }
    expect(manifest['@context']).toBe(PREZI_4_CONTEXT)
    expect(manifest.type).toBe('Manifest')
    const scene = manifest.items.find((i) => i.type === 'Scene')
    expect(scene).toBeTruthy()
    if (!scene) return
    const body = scene.items[0].items[0].body as {
      type: string
      items?: Array<Record<string, unknown>>
      [key: string]: unknown
    }
    const model = firstModelBody(body)
    expect(model.type).toBe('Model')
    expect(model.format).toBe('application/x.nifti')
    expect(String(model.id)).toMatch(/\/volumes\/.*\/raw\.nii\.gz/)
  })

  test('planExplodedView produces nx*ny*nz cells with correct shape', async () => {
    const synthetic = registry.list().find((v) => v.id === 'synthetic')
    if (!synthetic) return
    const entry = await registry.load(synthetic.id)
    if (!entry.volume) throw new Error('volume not loaded')
    const layout = planExplodedView(entry.volume, {
      nx: 3,
      ny: 3,
      nz: 3,
      explode: 1.5,
    })
    expect(layout.cellShape).toEqual([21, 21, 21])
    expect(layout.cells.length).toBe(27)
    const naturalSpan = layout.cellShape.map((d) => d * 3)
    for (let d = 0; d < 3; d++) {
      const span = naturalSpan[d] as number
      expect(layout.compositeShape[d]).toBeGreaterThanOrEqual(span)
      expect(layout.compositeShape[d]).toBeLessThanOrEqual(span * 1.5 + 2)
    }
    const cellShape = layout.cellShape
    for (let a = 0; a < layout.cells.length; a++) {
      for (let b = a + 1; b < layout.cells.length; b++) {
        const A = (
          layout.cells[a] as { compositeOrigin: [number, number, number] }
        ).compositeOrigin
        const B = (
          layout.cells[b] as { compositeOrigin: [number, number, number] }
        ).compositeOrigin
        const overlap =
          Math.abs(A[0] - B[0]) < cellShape[0] &&
          Math.abs(A[1] - B[1]) < cellShape[1] &&
          Math.abs(A[2] - B[2]) < cellShape[2]
        expect(overlap).toBe(false)
      }
    }
  })

  test('composeExplodedBuffer copies source voxels to cell origins', async () => {
    const synthetic = registry.list().find((v) => v.id === 'synthetic')
    if (!synthetic) return
    const entry = await registry.load(synthetic.id)
    if (!entry.volume) throw new Error('volume not loaded')
    const layout = planExplodedView(entry.volume, {
      nx: 2,
      ny: 2,
      nz: 2,
      explode: 2,
    })
    const buf = composeExplodedBuffer(entry.volume, layout)
    const [Cx, Cy] = layout.compositeShape
    for (const cell of layout.cells) {
      const [x0, y0, z0] = cell.sourceBbox
      const [sx, sy] = entry.volume.shape
      const srcVal = entry.volume.data[x0 + y0 * sx + z0 * sx * sy] as number
      const [ox, oy, oz] = cell.compositeOrigin
      const dstVal = buf[ox + oy * Cx + oz * Cx * Cy] as number
      expect(Math.abs(dstVal - srcVal)).toBeLessThan(1e-5)
    }
  })

  test('buildExplodedManifest emits a Scene with one Annotation per cell', async () => {
    const synthetic = registry.list().find((v) => v.id === 'synthetic')
    if (!synthetic) return
    const entry = await registry.load(synthetic.id)
    if (!entry.volume) throw new Error('volume not loaded')
    const layout = planExplodedView(entry.volume, {
      nx: 2,
      ny: 2,
      nz: 2,
      explode: 1.5,
    })
    const manifest = buildExplodedManifest({
      baseUrl: 'http://localhost:8080',
      entry,
      layout,
    }) as unknown as {
      items: Array<{
        type: string
        items: Array<{
          items: Array<{
            body: { type: string; items?: Array<Record<string, unknown>> }
            selector: { type: string }
          }>
        }>
        rendering: Array<{ format: string }>
      }>
      rendering: Array<{ format: string; id: string }>
    }
    const scene = manifest.items.find((i) => i.type === 'Scene')
    expect(scene).toBeTruthy()
    if (!scene) return
    const annotations = scene.items[0]?.items ?? []
    expect(annotations.length).toBe(8)
    for (const a of annotations) {
      const model = firstModelBody(a.body)
      expect(model.type).toBe('Model')
      expect(model.format).toBe('application/x.nifti')
      expect(String(model.id)).toMatch(/\?bbox=/)
      expect(a.selector.type).toBe('PointSelector')
      expect(
        Array.isArray(model.boundingBox) &&
          (model.boundingBox as unknown[]).length === 6,
      ).toBe(true)
      expect(Number.isFinite(model.bytes) && (model.bytes as number) > 0).toBe(
        true,
      )
      expect(
        Array.isArray(model.service) &&
          ((model.service as Array<{ id: string }>)[0]?.id ?? '').includes(
            '/occupancy',
          ),
      ).toBe(true)
    }
    for (const r of manifest.rendering) {
      expect(r.format).not.toBe('application/x.nifti')
    }
    for (const r of scene.rendering) {
      expect(r.format).not.toBe('application/x.nifti')
    }

    const compManifest = buildExplodedManifest({
      baseUrl: 'http://localhost:8080',
      entry,
      layout,
      wantsComposite: true,
    }) as unknown as { rendering: Array<{ format: string; id: string }> }
    const composite = compManifest.rendering.find(
      (r) => r.format === 'application/x.nifti',
    )
    expect(composite).toBeTruthy()
    if (!composite) return
    expect(composite.id).toMatch(/\/exploded\.nii\.gz\?nx=2.*composite=1/)
  })

  test('buildManifest enriches each LOD Choice item with bbox, bytes, and occupancy service', async () => {
    const synthetic = registry.list().find((v) => v.id === 'synthetic')
    if (!synthetic) return
    const entry = await registry.load(synthetic.id)
    const manifest = buildManifest({
      baseUrl: 'http://localhost:8080',
      entry,
    }) as unknown as {
      items: Array<{
        type: string
        items: Array<{
          items: Array<{
            body: {
              type: string
              items?: Array<Record<string, unknown>>
              [key: string]: unknown
            }
          }>
        }>
      }>
    }
    const scene = manifest.items.find((i) => i.type === 'Scene')
    if (!scene) throw new Error('no scene')
    const body = scene.items[0].items[0].body
    const items: Array<Record<string, unknown>> =
      body.type === 'Choice' && Array.isArray(body.items)
        ? body.items
        : [body as Record<string, unknown>]
    expect(items.length).toBeGreaterThanOrEqual(1)
    for (const it of items) {
      const bbox = it.boundingBox as unknown[] | undefined
      expect(Array.isArray(bbox) && bbox.length === 6).toBe(true)
      expect(Number.isFinite(it.bytes) && (it.bytes as number) > 0).toBe(true)
      const services = it.service as Array<{ id: string }>
      expect(Array.isArray(services) && services.length >= 1).toBe(true)
      expect((services[0] as { id: string }).id).toMatch(
        /\/volumes\/synthetic\/occupancy\?block=/,
      )
      const ext = it['https://example.org/iiif/volumetric#'] as {
        dataBoundingBox: unknown[]
      }
      expect(
        Array.isArray(ext.dataBoundingBox) && ext.dataBoundingBox.length === 6,
      ).toBe(true)
    }
  })

  test('buildDesktopManifest emits positioned NIfTI desktop items', () => {
    const volumes = registry
      .list()
      .filter((v) => v.format === 'nifti')
      .slice(0, 4)
    const manifest = buildDesktopManifest({
      baseUrl: 'http://localhost:8080',
      desktopId: 'test',
      volumes,
    })
    expect(manifest.type).toBe('VolumeDesktop')
    expect(manifest.items.length).toBe(volumes.length)
    expect(manifest.world.width).toBeGreaterThan(0)
    expect(manifest.world.height).toBeGreaterThan(0)
    const [first] = manifest.items
    if (!first) return
    expect(first.type).toBe('NiftiVolumeItem')
    expect(first.preview.image).toMatch(
      /\/iiif\/image\/.*\/axial\/\d+\/full\/384,\/0\/default\.png$/,
    )
    const [firstLevel] = first.levels
    expect(firstLevel?.raw).toMatch(/\/volumes\/.*\/raw\.nii\.gz$/)
  })
})

describe('downsampling', () => {
  test('downsampleVolume handles non-cubic volumes on the z axis', () => {
    const shape: readonly [number, number, number] = [4, 4, 6]
    const data = new Float32Array(shape[0] * shape[1] * shape[2])
    for (let z = 0; z < shape[2]; z++) {
      for (let y = 0; y < shape[1]; y++) {
        for (let x = 0; x < shape[0]; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] = z
        }
      }
    }
    const volume = new VolumeHandle({
      shape,
      spacing: [1, 1, 1],
      dtype: 'float32',
      data,
    })
    const down = downsampleVolume(volume, 2)
    expect(down.shape).toEqual([2, 2, 3])
    expect(down.data[0]).toBe(0.5)
    expect(down.data[2 * 2 * 2]).toBe(4.5)
  })
})

describe('raw cropping', () => {
  test('cropRawNiftiFile crops bbox rows without loading a full gzip', async () => {
    const shape: readonly [number, number, number] = [5, 4, 3]
    const data = new Int16Array(shape[0] * shape[1] * shape[2])
    for (let z = 0; z < shape[2]; z++) {
      for (let y = 0; y < shape[1]; y++) {
        for (let x = 0; x < shape[0]; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] =
            x + y * 10 + z * 100
        }
      }
    }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-nifti-crop-'))
    const sourcePath = path.join(dir, 'source.nii')
    const cropPath = path.join(dir, 'crop.nii')
    await fs.writeFile(
      sourcePath,
      encodeNiftiRaw({
        data,
        shape,
        spacing: [1, 1, 1],
        dtype: 'int16',
        affine: null,
      }),
    )

    const bbox = { x0: 1, y0: 1, z0: 1, x1: 4, y1: 3, z1: 3 }
    const cropped = await cropRawNiftiFile(
      sourcePath,
      {
        shape,
        originalShape: shape,
        cropOffset: [0, 0, 0],
        spacing: [1, 1, 1],
        dtype: 'int16',
        affine: null,
        background: null,
        sclSlope: 0,
        sclInter: 0,
        voxOffset: 352,
      },
      bbox,
    )
    await fs.writeFile(cropPath, cropped)
    const volume = await niftiAdapter.load(cropPath)

    expect(volume.shape).toEqual([3, 2, 2])
    expect(Array.from(volume.data)).toEqual([
      111, 112, 113, 121, 122, 123, 211, 212, 213, 221, 222, 223,
    ])
  })

  test('computeTightBbox finds the non-background extent and cropVolume shifts affine', () => {
    const shape: readonly [number, number, number] = [32, 32, 32]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let z = 5; z < 8; z++) {
      for (let y = 8; y < 12; y++) {
        for (let x = 10; x < 16; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] = 200
        }
      }
    }
    const volume = new VolumeHandle({
      shape,
      spacing: [2, 2, 2],
      dtype: 'uint8',
      data,
      affine: [
        [2, 0, 0, 100],
        [0, 2, 0, 200],
        [0, 0, 2, 300],
        [0, 0, 0, 1],
      ],
    })
    expect(autocropBackground(volume)).toBe(0)
    const bbox = computeTightBbox(volume, 0)
    expect(bbox).toEqual([10, 8, 5, 16, 12, 8])
    if (!bbox) return

    const cropped = cropVolume(volume, bbox)
    expect(cropped.shape).toEqual([6, 4, 3])
    expect(cropped.data[0]).toBe(200)
    if (!cropped.affine) throw new Error('expected affine')
    expect([
      cropped.affine[0][3],
      cropped.affine[1][3],
      cropped.affine[2][3],
    ]).toEqual([100 + 2 * 10, 200 + 2 * 8, 300 + 2 * 5])
  })
})

function makeUint8NiftiBuffer(
  shape: readonly [number, number, number],
  data: Uint8Array,
): Buffer {
  const header = new ArrayBuffer(352)
  const view = new DataView(header)
  view.setInt32(0, 348, true)
  view.setInt16(40, 3, true)
  view.setInt16(42, shape[0], true)
  view.setInt16(44, shape[1], true)
  view.setInt16(46, shape[2], true)
  view.setInt16(48, 1, true)
  view.setInt16(50, 1, true)
  view.setInt16(52, 1, true)
  view.setInt16(54, 1, true)
  view.setInt16(70, 2, true)
  view.setInt16(72, 8, true)
  view.setFloat32(76, 1, true)
  view.setFloat32(80, 1, true)
  view.setFloat32(84, 1, true)
  view.setFloat32(88, 1, true)
  view.setFloat32(108, 352, true)
  const magic = new Uint8Array(header, 344, 4)
  magic[0] = 0x6e
  magic[1] = 0x2b
  magic[2] = 0x31
  magic[3] = 0x00
  const buf = Buffer.alloc(352 + data.byteLength)
  Buffer.from(header).copy(buf, 0)
  Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(buf, 352)
  return buf
}

describe('pyramid', () => {
  test('pyramid build autocrops zero borders and records sidecar metadata', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-autocrop-'))
    const shape: readonly [number, number, number] = [32, 32, 32]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let z = 8; z < 24; z++) {
      for (let y = 8; y < 24; y++) {
        for (let x = 8; x < 24; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] = 200
        }
      }
    }
    const buf = makeUint8NiftiBuffer(shape, data)
    await fs.writeFile(path.join(dir, 'sparse.nii.gz'), gzipSync(buf))

    const reg = new Registry()
    await reg.scan(dir)
    const sparseEntry = reg.list().find((v) => v.id === 'sparse')
    expect(sparseEntry).toBeTruthy()

    await reg.awaitPyramid('sparse')

    const entry = reg.get('sparse')
    if (!entry) throw new Error('missing entry')
    const l1 = entry.levels.find((l) => l.level === 1)
    expect(l1).toBeTruthy()
    if (!l1) return
    expect(l1.shape).toEqual([8, 8, 8])
    expect(l1.originalShape).toEqual([16, 16, 16])
    expect(l1.cropOffset).toEqual([4, 4, 4])

    if (!l1.path) throw new Error('missing path')
    const l1Vol = await niftiAdapter.load(l1.path)
    expect(l1Vol.data[0]).toBe(200)

    await fs.rm(dir, { recursive: true, force: true })
  })
})

describe('volume routes', () => {
  test('/occupancy returns uint8 macroblock grid with dims headers', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-occupancy-'))
    const shape: readonly [number, number, number] = [64, 64, 64]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let z = 24; z < 32; z++) {
      for (let y = 24; y < 32; y++) {
        for (let x = 24; x < 32; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] = 200
        }
      }
    }
    const buf = makeUint8NiftiBuffer(shape, data)
    await fs.writeFile(path.join(dir, 'occgrid.nii.gz'), gzipSync(buf))

    const reg = new Registry()
    await reg.scan(dir)
    await reg.awaitPyramid('occgrid')
    await reg.load('occgrid')

    const app = express()
    mountVolumeRoutes(app, reg)
    const server = http.createServer(app)
    const port = await listenAnywhere(server)

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/volumes/occgrid/occupancy?block=16`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('x-occupancy-dims')).toBe('4,4,4')
      expect(res.headers.get('x-occupancy-block')).toBe('16')
      const body = Buffer.from(await res.arrayBuffer())
      expect(body.length).toBe(64)
      expect(body[0]).toBe(0)
      expect(body[1 + 1 * 4 + 1 * 16]).toBe(1)
    } finally {
      await closeServer(server)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('/exploded returns plan JSON by default and composite only when requested', async () => {
    const synthetic = registry.list().find((v) => v.id === 'synthetic')
    if (!synthetic) return
    await registry.load(synthetic.id)

    const app = express()
    mountVolumeRoutes(app, registry)
    const server = http.createServer(app)
    const port = await listenAnywhere(server)

    try {
      const base = `http://127.0.0.1:${port}/volumes/${synthetic.id}/exploded?nx=2&ny=2&nz=2&explode=1.5`

      const planRes = await fetch(base)
      expect(planRes.status).toBe(200)
      expect(planRes.headers.get('content-type') ?? '').toMatch(
        /application\/json/,
      )
      const plan = (await planRes.json()) as {
        volumeId: string
        cellCount: number
        cells: unknown[]
        params: Record<string, number>
      }
      expect(plan.volumeId).toBe(synthetic.id)
      expect(plan.cellCount).toBe(8)
      expect(Array.isArray(plan.cells)).toBe(true)
      expect(plan.params).toEqual({
        nx: 2,
        ny: 2,
        nz: 2,
        ex: 1.5,
        ey: 1.5,
        ez: 1.5,
      })

      const compositeRes = await fetch(`${base}&composite=1`)
      expect(compositeRes.status).toBe(200)
      expect(compositeRes.headers.get('content-type')).toBe(
        'application/x.nifti',
      )
      const body = Buffer.from(await compositeRes.arrayBuffer())
      expect(body.length).toBeGreaterThan(352)
    } finally {
      await closeServer(server)
    }
  })

  test('/raw.bin streams bbox payload bytes without NIfTI wrapper', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-raw-bin-'))
    const shape: readonly [number, number, number] = [8, 7, 6]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 3) & 0xff
    }
    const buf = makeUint8NiftiBuffer(shape, data)
    await fs.writeFile(path.join(dir, 'rawbin.nii.gz'), gzipSync(buf))

    const reg = new Registry()
    await reg.scan(dir)
    await reg.awaitPyramid('rawbin')
    await reg.load('rawbin')

    const app = express()
    mountVolumeRoutes(app, reg)
    const server = http.createServer(app)
    const port = await listenAnywhere(server)
    const bbox = [1, 2, 3, 5, 5, 6]

    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/volumes/rawbin/raw.bin?level=0&bbox=${bbox.join(',')}`,
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('x-volume-shape')).toBe('4,3,3')
      expect(res.headers.get('x-volume-dtype')).toBe('uint8')

      const body = new Uint8Array(await res.arrayBuffer())
      const expected: number[] = []
      for (let z = bbox[2]; z < bbox[5]; z++) {
        for (let y = bbox[1]; y < bbox[4]; y++) {
          for (let x = bbox[0]; x < bbox[3]; x++) {
            expected.push(data[x + y * shape[0] + z * shape[0] * shape[1]])
          }
        }
      }
      expect(body.byteLength).toBe(expected.length)
      expect(Array.from(body)).toEqual(expected)
    } finally {
      await closeServer(server)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test('/raw.nii serves uncompressed bytes with Range support', async () => {
    const synthetic = registry.list().find((v) => v.id === 'synthetic')
    if (!synthetic) return
    await registry.load(synthetic.id)

    const app = express()
    mountVolumeRoutes(app, registry)
    const server = http.createServer(app)
    const port = await listenAnywhere(server)

    try {
      const target = `http://127.0.0.1:${port}/volumes/${synthetic.id}/raw.nii?level=0`

      const headRes = await fetch(target)
      expect(headRes.status).toBe(200)
      expect(headRes.headers.get('accept-ranges')).toBe('bytes')
      expect(headRes.headers.get('content-type')).toBe(
        'application/octet-stream',
      )
      const fullLen = Number(headRes.headers.get('content-length'))
      expect(fullLen).toBeGreaterThan(352)
      await headRes.arrayBuffer()

      const rangeRes = await fetch(target, {
        headers: { Range: 'bytes=352-1023' },
      })
      expect(rangeRes.status).toBe(206)
      const contentRange = rangeRes.headers.get('content-range')
      expect(contentRange).toMatch(/^bytes 352-1023\/\d+$/)
      const partial = Buffer.from(await rangeRes.arrayBuffer())
      expect(partial.length).toBe(1023 - 352 + 1)
    } finally {
      await closeServer(server)
    }
  })
})

describe('RLE encoding', () => {
  test('RLE encoder round-trips uint8 voxels byte-equal', () => {
    const inputs = [
      new Uint8Array([0]),
      new Uint8Array([1, 1, 1, 1, 1]),
      new Uint8Array([0, 0, 0, 1, 1, 2, 2, 2, 2, 0]),
      Uint8Array.from({ length: 4096 }, (_, i) =>
        i < 1024 ? 0 : i < 3072 ? 7 : 0,
      ),
    ]
    for (const data of inputs) {
      const encoded = encodeRle(data)
      const decoded = decodeRle(encoded, data.length)
      expect(decoded).toEqual(data)
    }
  })

  test('encodeNiftiRle/decodeNiftiRle round-trips a sparse uint8 volume', () => {
    const shape: readonly [number, number, number] = [16, 16, 16]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let z = 5; z < 11; z++) {
      for (let y = 5; y < 11; y++) {
        for (let x = 5; x < 11; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] = 200
        }
      }
    }
    const buf = encodeNiftiRle({
      data,
      shape,
      spacing: [1, 1, 1],
      dtype: 'uint8',
      affine: null,
    })
    expect(buf.length - 352).toBeLessThan(1000)
    const restored = decodeNiftiRle(buf, data.length)
    expect(restored).toEqual(data)
  })

  test('buildManifest emits an RLE sibling per LOD for uint8 volumes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-rle-manifest-'))
    const shape: readonly [number, number, number] = [16, 16, 16]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let i = 0; i < data.length; i += 7) data[i] = 1
    const buf = makeUint8NiftiBuffer(shape, data)
    await fs.writeFile(path.join(dir, 'u8mask.nii.gz'), gzipSync(buf))

    const reg = new Registry()
    await reg.scan(dir)
    await reg.awaitPyramid('u8mask')
    const entry = await reg.load('u8mask')
    if (!entry.volume) throw new Error('volume not loaded')

    const manifest = buildManifest({
      baseUrl: 'http://localhost:8080',
      entry,
    }) as unknown as {
      items: Array<{
        type: string
        items: Array<{
          items: Array<{
            body: {
              type: string
              items?: Array<{ format: string; [k: string]: unknown }>
            }
          }>
        }>
      }>
    }
    const scene = manifest.items.find((i) => i.type === 'Scene')
    if (!scene) throw new Error('no scene')
    const body = scene.items[0].items[0].body
    expect(body.type).toBe('Choice')
    const choiceItems = body.items as Array<{
      format: string
      boundingBox: unknown[]
      bytes: number
    }>
    const formats = choiceItems.map((it) => it.format)
    const niftiCount = formats.filter((f) => f === 'application/x.nifti').length
    const rleCount = formats.filter(
      (f) => f === 'application/x.nifti-rle',
    ).length
    expect(niftiCount).toBe(rleCount)
    expect(niftiCount).toBeGreaterThanOrEqual(1)
    for (const it of choiceItems) {
      expect(Array.isArray(it.boundingBox) && it.boundingBox.length === 6).toBe(
        true,
      )
      expect(Number.isFinite(it.bytes) && it.bytes > 0).toBe(true)
    }

    const layout = planExplodedView(entry.volume, {
      nx: 2,
      ny: 2,
      nz: 2,
      explode: 1.5,
    })
    const xMan = buildExplodedManifest({
      baseUrl: 'http://localhost:8080',
      entry,
      layout,
    }) as unknown as {
      items: Array<{
        type: string
        items: Array<{
          items: Array<{
            body: {
              items: Array<{ format: string }>
            }
          }>
        }>
      }>
    }
    const xScene = xMan.items.find((i) => i.type === 'Scene')
    if (!xScene) throw new Error('no scene')
    const firstCell = xScene.items[0].items[0].body
    const xFormats = firstCell.items.map((it) => it.format)
    expect(xFormats.includes('application/x.nifti')).toBe(true)
    expect(xFormats.includes('application/x.nifti-rle')).toBe(true)

    await fs.rm(dir, { recursive: true, force: true })
  })

  test('/raw.nii.gz?bbox honors Accept: application/x.nifti-rle for uint8 volumes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-rle-'))
    const shape: readonly [number, number, number] = [32, 32, 32]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let z = 8; z < 24; z++) {
      for (let y = 8; y < 24; y++) {
        for (let x = 8; x < 24; x++) {
          data[x + y * shape[0] + z * shape[0] * shape[1]] = 250
        }
      }
    }
    const buf = makeUint8NiftiBuffer(shape, data)
    await fs.writeFile(path.join(dir, 'rlemask.nii.gz'), gzipSync(buf))

    const reg = new Registry()
    await reg.scan(dir)
    await reg.awaitPyramid('rlemask')
    await reg.load('rlemask')

    const app = express()
    mountVolumeRoutes(app, reg)
    const server = http.createServer(app)
    const port = await listenAnywhere(server)

    try {
      const target = `http://127.0.0.1:${port}/volumes/rlemask/raw.nii.gz?bbox=0,0,0,32,32,32`
      const rleRes = await fetch(target, {
        headers: { Accept: NIFTI_RLE_MEDIA_TYPE },
      })
      expect(rleRes.status).toBe(200)
      expect(rleRes.headers.get('content-type')).toBe(NIFTI_RLE_MEDIA_TYPE)
      const rleBody = Buffer.from(await rleRes.arrayBuffer())
      const restored = decodeNiftiRle(rleBody, data.length)
      expect(restored).toEqual(data)

      const niftiRes = await fetch(target)
      expect(niftiRes.status).toBe(200)
      expect(niftiRes.headers.get('content-type')).toBe(
        'application/x.nifti+gzip',
      )
    } finally {
      await closeServer(server)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('content encoding negotiation', () => {
  test('negotiateEncoding picks the best supported encoding from Accept-Encoding', () => {
    expect(negotiateEncoding(undefined)).toBe('gzip')
    expect(negotiateEncoding('')).toBe('gzip')
    expect(negotiateEncoding('gzip')).toBe('gzip')
    expect(negotiateEncoding('br')).toBe('br')
    expect(negotiateEncoding('identity')).toBe('identity')
    const hasZstd =
      typeof (zlib as unknown as { zstdCompressSync?: unknown })
        .zstdCompressSync === 'function'
    expect(negotiateEncoding('gzip, br, zstd')).toBe(hasZstd ? 'zstd' : 'br')
    expect(negotiateEncoding('gzip;q=1, br;q=0')).toBe('gzip')
    expect(negotiateEncoding('*')).toBe(hasZstd ? 'zstd' : 'br')
  })

  function rawGet(
    port: number,
    urlPath: string,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method: 'GET',
          headers,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          )
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  test('/raw bbox crop negotiates content-encoding by URL form', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-enc-'))
    const shape: readonly [number, number, number] = [16, 16, 16]
    const data = new Uint8Array(shape[0] * shape[1] * shape[2])
    for (let i = 0; i < data.length; i++) {
      data[i] = (i * 7) & 0xff
    }
    const buf = makeUint8NiftiBuffer(shape, data)
    await fs.writeFile(path.join(dir, 'encvol.nii.gz'), gzipSync(buf))

    const reg = new Registry()
    await reg.scan(dir)
    await reg.awaitPyramid('encvol')
    await reg.load('encvol')

    const app = express()
    mountVolumeRoutes(app, reg)
    const server = http.createServer(app)
    const port = await listenAnywhere(server)

    const bbox = '0,0,0,16,16,16'
    try {
      const legacy = await fetch(
        `http://127.0.0.1:${port}/volumes/encvol/raw.nii.gz?bbox=${bbox}`,
      )
      expect(legacy.status).toBe(200)
      expect(legacy.headers.get('content-type')).toBe(
        'application/x.nifti+gzip',
      )
      expect(legacy.headers.get('content-encoding')).toBeNull()
      await legacy.arrayBuffer()

      const brRes = await rawGet(port, `/volumes/encvol/raw?bbox=${bbox}`, {
        'Accept-Encoding': 'br',
      })
      expect(brRes.statusCode).toBe(200)
      expect(brRes.headers['content-type']).toBe('application/x.nifti')
      expect(brRes.headers['content-encoding']).toBe('br')
      const brDecoded = zlib.brotliDecompressSync(brRes.body)
      expect(brDecoded.length).toBe(352 + data.byteLength)

      const gzRes = await rawGet(port, `/volumes/encvol/raw.nii?bbox=${bbox}`, {
        'Accept-Encoding': 'gzip',
      })
      expect(gzRes.statusCode).toBe(200)
      expect(gzRes.headers['content-type']).toBe('application/x.nifti')
      expect(gzRes.headers['content-encoding']).toBe('gzip')
      const gzDecoded = zlib.gunzipSync(gzRes.body)
      expect(gzDecoded.length).toBe(352 + data.byteLength)

      const idRes = await rawGet(port, `/volumes/encvol/raw?bbox=${bbox}`, {
        'Accept-Encoding': 'identity',
      })
      expect(idRes.statusCode).toBe(200)
      expect(idRes.headers['content-type']).toBe('application/x.nifti')
      expect(idRes.headers['content-encoding']).toBeUndefined()
      expect(idRes.body.length).toBe(352 + data.byteLength)
    } finally {
      await closeServer(server)
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('scl_slope round trip', () => {
  test('encodeNiftiRaw preserves scl_slope/scl_inter and the adapter round-trips them', async () => {
    const shape: readonly [number, number, number] = [4, 4, 4]
    const data = new Int16Array(shape[0] * shape[1] * shape[2])
    for (let i = 0; i < data.length; i++) data[i] = i - 32

    const encoded = encodeNiftiRaw({
      data,
      shape,
      spacing: [1, 1, 1],
      dtype: 'int16',
      affine: null,
      sclSlope: 0.5,
      sclInter: 100,
    })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iiif-scl-'))
    const filePath = path.join(dir, 'scl.nii')
    try {
      await fs.writeFile(filePath, encoded)
      const loaded = await niftiAdapter.load(filePath)
      expect(loaded.sclSlope).toBe(0.5)
      expect(loaded.sclInter).toBe(100)
      expect(Array.from(loaded.data)).toEqual(Array.from(data))
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('compress encodings', () => {
  test('compressBuffer round-trips through every supported encoding', () => {
    const input = Buffer.from('the quick brown fox '.repeat(64))
    const cases: ContentEncoding[] = ['identity', 'gzip', 'br']
    if (
      typeof (zlib as unknown as { zstdCompressSync?: unknown })
        .zstdCompressSync === 'function'
    ) {
      cases.push('zstd')
    }
    for (const enc of cases) {
      const out = compressBuffer(input, enc)
      let restored: Buffer
      if (enc === 'identity') restored = out
      else if (enc === 'gzip') restored = zlib.gunzipSync(out)
      else if (enc === 'br') restored = zlib.brotliDecompressSync(out)
      else
        restored = (
          zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }
        ).zstdDecompressSync(out)
      expect(Buffer.from(restored)).toEqual(input)
    }
  })
})
