import { describe, expect, test } from 'bun:test'
import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
  NVMesh,
} from '@niivue/niivue'
import { createStreamingNVImage } from '@niivue/niivue'
import { channelIsosurfaces } from './isosurface'

type Vec3 = [number, number, number]

/** In-memory u8 (or f32) pyramid; records every fetch. */
function memorySource(
  shape0: Vec3,
  spacing: Vec3,
  voxel: (x: number, y: number, z: number) => number,
  xyztUnits?: number,
  Arr: typeof Uint8Array | typeof Float32Array = Uint8Array,
) {
  const shape1: Vec3 = [shape0[0] / 2, shape0[1] / 2, shape0[2] / 2]
  const fill = (s: Vec3, step: number) => {
    const d = new Arr(s[0] * s[1] * s[2])
    for (let z = 0; z < s[2]; z++)
      for (let y = 0; y < s[1]; y++)
        for (let x = 0; x < s[0]; x++)
          d[(z * s[1] + y) * s[0] + x] = voxel(
            (x + 0.5) * step - 0.5,
            (y + 0.5) * step - 0.5,
            (z + 0.5) * step - 0.5,
          )
    return d
  }
  const data = [fill(shape0, 1), fill(shape1, 2)]
  const calls: ChunkedVolumeFetch[] = []
  const source: ChunkedVolumeSource = {
    datatypeCode: Arr === Uint8Array ? 2 : 16,
    xyztUnits,
    frames: 3,
    levels: [
      { level: 0, shape: shape0, spacing },
      {
        level: 1,
        shape: shape1,
        spacing: [2 * spacing[0], 2 * spacing[1], 2 * spacing[2]],
      },
    ],
    async fetchChunk(req) {
      calls.push(req)
      const s = source.levels[req.levelIndex].shape
      const [ox, oy, oz] = req.texOrigin
      const [dx, dy, dz] = req.texDims
      const out = new Arr(dx * dy * dz)
      for (let z = 0; z < dz; z++)
        for (let y = 0; y < dy; y++)
          for (let x = 0; x < dx; x++)
            if (ox + x < s[0] && oy + y < s[1] && oz + z < s[2])
              out[(z * dy + y) * dx + x] =
                data[req.levelIndex][((oz + z) * s[1] + oy + y) * s[0] + ox + x]
      return new Uint8Array(out.buffer)
    },
  }
  return { source, calls }
}

const C = 19.5
const R = 12
const sphere = (x: number, y: number, z: number) =>
  (x - C) ** 2 + (y - C) ** 2 + (z - C) ** 2 <= R * R ? 255 : 0

function vertices(m: NVMesh): Vec3[] {
  const v: Vec3[] = []
  for (let i = 0; i < m.positions.length; i += 3)
    v.push([m.positions[i], m.positions[i + 1], m.positions[i + 2]])
  return v
}

/** Every undirected edge is shared by exactly two triangles. */
function isClosed(m: NVMesh): boolean {
  const edges = new Map<string, number>()
  const idx = m.indices
  for (let t = 0; t < idx.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e]
      const b = idx[t + ((e + 1) % 3)]
      const k = a < b ? `${a},${b}` : `${b},${a}`
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  return idx.length > 0 && [...edges.values()].every((c) => c === 2)
}

/** Divergence-theorem volume: positive when triangles wind outward. */
function signedVolume(m: NVMesh): number {
  const p = m.positions
  const idx = m.indices
  let vol = 0
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3]
    vol +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return vol / 6
}

const sorted = (m: NVMesh) =>
  vertices(m)
    .map((v) => v.join())
    .sort()

describe('channelIsosurfaces', () => {
  const spacing: Vec3 = [0.5, 0.5, 2]

  test('sphere: closed, outward, within r +- 1 voxel, spacing in world units', async () => {
    const { source } = memorySource([40, 40, 40], spacing, sphere)
    const [mesh] = await channelIsosurfaces([
      { source, threshold: 128, level: 0 },
    ])
    const v = vertices(mesh)
    expect(v.length).toBeGreaterThan(0)
    for (const p of v) {
      const r = Math.hypot(p[0] / 0.5 - C, p[1] / 0.5 - C, p[2] / 2 - C)
      expect(Math.abs(r - R)).toBeLessThanOrEqual(1)
    }
    expect(isClosed(mesh)).toBe(true)
    const ideal = (4 / 3) * Math.PI * R ** 3 * 0.5 * 0.5 * 2
    expect(signedVolume(mesh) / ideal).toBeCloseTo(1, 1)
    expect(mesh.name).toBe('channel 0 (level 0)')
  })

  test('registers on the streamed volume box; micron units stay in world units', async () => {
    const vol = createStreamingNVImage({
      shape: [40, 40, 40],
      spacing,
      datatypeCode: 2,
      calMin: 0,
      calMax: 255,
    })
    // Sphere centred in the volume: mesh centre === streamed volume centre.
    const { source } = memorySource([40, 40, 40], spacing, sphere)
    const [mesh] = await channelIsosurfaces([{ source, threshold: 128 }])
    for (let a = 0; a < 3; a++) {
      const centre = (vol.extentsMin[a] + vol.extentsMax[a]) / 2
      expect((mesh.extentsMin[a] + mesh.extentsMax[a]) / 2).toBeCloseTo(
        centre,
        5,
      )
    }
    const um = memorySource([40, 40, 40], spacing, sphere, 3 + 8).source
    const [meshUm] = await channelIsosurfaces([{ source: um, threshold: 128 }])
    expect(sorted(meshUm)).toEqual(sorted(mesh))
  })

  test('coarse level covers the same box', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    const [mesh] = await channelIsosurfaces(
      [{ source, threshold: 128, name: 's' }],
      {
        maxVoxels: 20 ** 3,
      },
    )
    expect(mesh.name).toBe('s (level 1)')
    expect(calls.every((c) => c.levelIndex === 1)).toBe(true)
    // A half-voxel offset in the level mapping would shift the centre.
    for (let a = 0; a < 3; a++)
      expect((mesh.extentsMin[a] + mesh.extentsMax[a]) / 2).toBeCloseTo(
        C * spacing[a],
        5,
      )
    for (const p of vertices(mesh)) {
      const r = Math.hypot(p[0] / 0.5 - C, p[1] / 0.5 - C, p[2] / 2 - C)
      expect(Math.abs(r - R)).toBeLessThanOrEqual(2)
    }
    expect(isClosed(mesh)).toBe(true)
  })

  test('small bricks weld seamlessly: identical to one brick', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    const [one] = await channelIsosurfaces([
      { source, threshold: 128, level: 0 },
    ])
    calls.length = 0
    const [many] = await channelIsosurfaces(
      [{ source, threshold: 128, level: 0 }],
      { brickEdge: 7 },
    )
    expect(calls.length).toBe(6 ** 3)
    expect(isClosed(many)).toBe(true)
    expect(many.indices.length).toBe(one.indices.length)
    expect(sorted(many)).toEqual(sorted(one))
  })

  test('labels are per-ID masks, never a threshold on IDs', async () => {
    // Box id 1 (x 4..13) touches box id 3 (x 14..23); box id 2 is apart (x 28..35).
    const box = (x: number, y: number, z: number) => {
      if (y < 10 || y > 29 || z < 10 || z > 29) return 0
      if (x >= 4 && x <= 13) return 1
      if (x >= 14 && x <= 23) return 3
      if (x >= 28 && x <= 35) return 2
      return 0
    }
    const { source } = memorySource([40, 40, 40], [1, 1, 1], box)
    const [two, both] = await channelIsosurfaces([
      { source, labels: [2], level: 0 },
      { source, labels: [1, 2], level: 0 },
    ])
    // No surface at the 1|3 boundary where interpolated IDs would pass 2.
    expect(vertices(two).every((p) => p[0] > 27 && p[0] < 36)).toBe(true)
    expect(isClosed(two)).toBe(true)
    // Both blobs wrapped, nothing inside box 3.
    const v = vertices(both)
    expect(v.some((p) => p[0] < 14)).toBe(true)
    expect(v.some((p) => p[0] > 27)).toBe(true)
    expect(v.every((p) => p[0] < 14 || p[0] > 27)).toBe(true)
    expect(isClosed(both)).toBe(true)
  })

  test('a level over maxVoxels rejects before fetching', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    await expect(
      channelIsosurfaces([{ source, threshold: 128, level: 0 }], {
        maxVoxels: 1000,
      }),
    ).rejects.toThrow(RangeError)
    await expect(
      channelIsosurfaces([{ source, threshold: 128 }], { maxVoxels: 1000 }),
    ).rejects.toThrow(RangeError)
    expect(calls.length).toBe(0)
  })

  test('abort rejects AbortError and stops fetching', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    const ac = new AbortController()
    const run = channelIsosurfaces([{ source, threshold: 128, level: 0 }], {
      brickEdge: 8,
      signal: ac.signal,
      onProgress: () => ac.abort(),
    })
    await expect(run).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls.length).toBe(1)
    expect(calls[0].signal).toBe(ac.signal)
  })

  test('frame is passed to every fetch', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    await channelIsosurfaces([{ source, threshold: 128, frame: 2 }], {
      brickEdge: 16,
    })
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((c) => c.frame === 2)).toBe(true)
  })
  test('maxVertices rejects while the mesh grows', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    await expect(
      channelIsosurfaces([{ source, threshold: 128, level: 0 }], {
        brickEdge: 8,
        maxVertices: 10,
      }),
    ).rejects.toThrow(RangeError)
    expect(calls.length).toBeLessThan(6 ** 3)
  })

  test('labels weld across small bricks', async () => {
    const twoBalls = (x: number, y: number, z: number) =>
      (x - 12) ** 2 + (y - C) ** 2 + (z - C) ** 2 <= 64
        ? 1
        : (x - 28) ** 2 + (y - C) ** 2 + (z - C) ** 2 <= 64
          ? 2
          : 0
    const { source } = memorySource([40, 40, 40], [1, 1, 1], twoBalls)
    const [one] = await channelIsosurfaces([
      { source, labels: [1, 2], level: 0 },
    ])
    const [many] = await channelIsosurfaces(
      [{ source, labels: [1, 2], level: 0 }],
      { brickEdge: 5 },
    )
    expect(isClosed(many)).toBe(true)
    expect(sorted(many)).toEqual(sorted(one))
  })

  test('NaN and Infinity voxels are outside', async () => {
    const noisy = (x: number, y: number, z: number) =>
      x < 2 ? Number.NaN : x > 37 ? Infinity : sphere(x, y, z)
    const f32 = memorySource(
      [40, 40, 40],
      spacing,
      noisy,
      undefined,
      Float32Array,
    )
    const [mesh] = await channelIsosurfaces([
      { source: f32.source, threshold: 128, level: 0 },
    ])
    const v = vertices(mesh)
    expect(v.every((p) => p.every(Number.isFinite))).toBe(true)
    for (const p of v) {
      const r = Math.hypot(p[0] / 0.5 - C, p[1] / 0.5 - C, p[2] / 2 - C)
      expect(Math.abs(r - R)).toBeLessThanOrEqual(1)
    }
  })

  test('unknown datatype rejects before any channel fetches', async () => {
    const ok = memorySource([40, 40, 40], spacing, sphere)
    const rgb = memorySource([40, 40, 40], spacing, sphere)
    const source = { ...rgb.source, datatypeCode: 128 }
    await expect(
      channelIsosurfaces([
        { source: ok.source, threshold: 128 },
        { source, threshold: 128 },
      ]),
    ).rejects.toThrow(TypeError)
    expect(ok.calls.length).toBe(0)
  })

  test('long CPU work yields so a host abort lands', async () => {
    const { source } = memorySource([40, 40, 40], spacing, sphere)
    const ac = new AbortController()
    // A host task queued before the work runs at its first yield (same task
    // source, FIFO). A timer is not deterministic: Bun starves timers behind
    // a MessageChannel chain for tens of ms.
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      ac.abort()
    }
    port2.postMessage(null)
    const labels = Array.from({ length: 2000 }, (_, i) => i)
    await expect(
      channelIsosurfaces([{ source, labels, level: 0 }], { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('yields per time batch, not per label', async () => {
    const { source } = memorySource([8, 8, 8], [1, 1, 1], () => 1)
    const Real = globalThis.MessageChannel
    let yields = 0
    globalThis.MessageChannel = class extends Real {
      constructor() {
        super()
        yields++
      }
    }
    try {
      const labels = Array.from({ length: 50 }, (_, i) => i)
      await channelIsosurfaces([{ source, labels }])
    } finally {
      globalThis.MessageChannel = Real
    }
    expect(yields).toBeLessThan(5)
  })

  test('bad maxVertices, brickEdge or color rejects before fetching', async () => {
    const { source, calls } = memorySource([40, 40, 40], spacing, sphere)
    const ch = { source, threshold: 128 }
    for (const maxVertices of [0, 1.5, Number.NaN, Infinity])
      await expect(channelIsosurfaces([ch], { maxVertices })).rejects.toThrow(
        RangeError,
      )
    for (const brickEdge of [1, 2.5, Number.NaN])
      await expect(channelIsosurfaces([ch], { brickEdge })).rejects.toThrow(
        RangeError,
      )
    const colors = [
      [1, 0, 0],
      [2, 0, 0, 1],
      [Number.NaN, 0, 0, 1],
    ] as [number, number, number, number][]
    for (const color of colors)
      await expect(channelIsosurfaces([{ ...ch, color }])).rejects.toThrow(
        RangeError,
      )
    expect(calls.length).toBe(0)
  })
})
