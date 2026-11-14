import type { ChunkedVolumeSource, NVMesh } from '@niivue/niivue'
import { createMesh } from '@niivue/niivue'

export interface IsosurfaceChannel {
  source: ChunkedVolumeSource
  /** Pyramid level index; default: the finest level with voxel count <= maxVoxels. */
  level?: number
  /** Surface where stored value >= threshold. Exactly one of threshold/labels. */
  threshold?: number
  /** One surface per ID (mask value === id), merged into this channel's mesh. */
  labels?: number[]
  frame?: number
  color?: [number, number, number, number]
  name?: string
}

export interface IsosurfaceOptions {
  /** Largest level (voxels) a channel may extract from (default 256^3). */
  maxVoxels?: number
  /** Most vertices one channel's mesh may reach (default 4e6). */
  maxVertices?: number
  /** Brick edge in cells (default 64). */
  brickEdge?: number
  signal?: AbortSignal
  onProgress?(done: number, total: number): void
}

type Voxels = ArrayLike<number>
type VoxelArray = {
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): Voxels
  BYTES_PER_ELEMENT: number
}

const ARRAYS: Record<number, VoxelArray> = {
  2: Uint8Array,
  4: Int16Array,
  8: Int32Array,
  16: Float32Array,
  64: Float64Array,
  256: Int8Array,
  512: Uint16Array,
  768: Uint32Array,
}

// Finite (not -Infinity) so f0 / (f0 - PAD) stays a number: the crossing snaps
// to the outermost in-volume voxel.
const PAD = -1e30
// Cube corner c sits at (c & 1, (c >> 1) & 1, c >> 2); the 12 cube edges.
const EDGES = [
  0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7,
]

const voxelCount = (s: number[]): number => s[0] * s[1] * s[2]

// A macrotask yield without setTimeout's nested-timer clamp (4 ms in browsers).
const yieldToHost = (): Promise<void> =>
  new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      resolve()
    }
    port2.postMessage(null)
  })
// Work between yields; keeps the host responsive at about one frame.
const YIELD_MS = 8

interface MeshBuffers {
  positions: Float32Array
  indices: Uint32Array
  nv: number
  ni: number
  maxVertices: number
}

/**
 * One NVMesh per channel: naive surface nets over the chosen pyramid level,
 * fetched brick by brick. Vertices are in the streamed volume's world space:
 * the source's own units (mm, or um for a micron `xyztUnits`), unconverted,
 * exactly as NiiVue renders the volume, so each mesh overlays its volume.
 */
export async function channelIsosurfaces(
  channels: IsosurfaceChannel[],
  options: IsosurfaceOptions = {},
): Promise<NVMesh[]> {
  const {
    maxVoxels = 256 ** 3,
    maxVertices = 4e6,
    brickEdge = 64,
    signal,
    onProgress,
  } = options
  // Validate everything before the first fetch.
  if (!Number.isInteger(maxVertices) || maxVertices < 1)
    throw new RangeError(`isosurface: bad maxVertices ${maxVertices}`)
  if (!Number.isInteger(brickEdge) || brickEdge < 2)
    throw new RangeError(`isosurface: bad brickEdge ${brickEdge}`)
  const plans = channels.map((ch) => {
    // createMesh takes RGBA in 0..1.
    if (
      ch.color &&
      (ch.color.length !== 4 || !ch.color.every((c) => c >= 0 && c <= 1))
    )
      throw new RangeError(`isosurface: bad color ${ch.color}`)
    const { levels, datatypeCode } = ch.source
    if (!ARRAYS[datatypeCode])
      throw new TypeError(`isosurface: unsupported datatype ${datatypeCode}`)
    const level =
      ch.level ?? levels.findIndex((l) => voxelCount(l.shape) <= maxVoxels)
    if (!levels[level] || voxelCount(levels[level].shape) > maxVoxels)
      throw new RangeError(
        `isosurface: no level within maxVoxels ${maxVoxels} (level ${ch.level})`,
      )
    if ((ch.threshold === undefined) === (ch.labels === undefined))
      throw new TypeError('isosurface: set exactly one of threshold or labels')
    // Cells span -1..n-1 per axis so surfaces close at the volume edge.
    const nb = levels[level].shape.map((n) => Math.ceil((n + 1) / brickEdge))
    return { ch, level, nb }
  })
  const total = plans.reduce((t, p) => t + voxelCount(p.nb), 0)
  let done = 0
  let lastYield = performance.now()
  const meshes: NVMesh[] = []
  for (const { ch, level, nb } of plans) {
    const { source, threshold } = ch
    const n = source.levels[level].shape
    const s0 = source.levels[0].spacing
    const n0 = source.levels[0].shape
    // Level voxels tile the level-0 box [-0.5, n0 - 0.5] * s0 (streamed affine
    // diag(s0), voxel i centred at i * s0).
    const vox = [0, 1, 2].map((a) => (s0[a] * n0[a]) / n[a])
    const off = [0, 1, 2].map((a) => 0.5 * (vox[a] - s0[a]))
    const Arr = ARRAYS[source.datatypeCode]
    const bpv = Arr.BYTES_PER_ELEMENT
    // Only float data can hold NaN/Inf; those become outside (PAD).
    const isFloat = Arr === Float32Array || Arr === Float64Array
    const surfaces = ch.labels ?? [0]
    // Vertex index per brick cell plus a 1-cell lower halo, restored from the
    // top faces saved by the lower neighbours: welding memory is
    // labels * (nb.x * nb.y + nb.x + 1) * (brickEdge + 1)^2 Int32.
    const S = brickEdge + 1
    const S2 = S * S
    const cells = new Int32Array(S2 * S)
    const faces = surfaces.map(() => ({
      x: new Int32Array(S2),
      y: new Int32Array(nb[0] * S2),
      z: new Int32Array(nb[0] * nb[1] * S2),
    }))
    const lowFace = [0, 1, 2].map((a) => faceIndex(S, a, 0))
    const highFace = [0, 1, 2].map((a) => faceIndex(S, a, brickEdge))
    const mesh: MeshBuffers = {
      positions: new Float32Array(3 * 4096),
      indices: new Uint32Array(6 * 4096),
      nv: 0,
      ni: 0,
      maxVertices,
    }
    const field = new Float32Array(S2 * S)
    for (let iz = 0; iz < nb[2]; iz++)
      for (let iy = 0; iy < nb[1]; iy++)
        for (let ix = 0; ix < nb[0]; ix++) {
          signal?.throwIfAborted()
          const c0 = [ix, iy, iz].map((i) => i * brickEdge - 1)
          // Field = brick cells + 1 voxel overlap; fetch only its in-volume part.
          const dims = c0.map((c, a) => Math.min(c + brickEdge, n[a]) - c + 1)
          const texOrigin = c0.map((c) => Math.max(c, 0))
          const texDims = c0.map(
            (c, a) => Math.min(c + brickEdge, n[a] - 1) - texOrigin[a] + 1,
          )
          const bytes = await source.fetchChunk({
            levelIndex: level,
            texOrigin: [texOrigin[0], texOrigin[1], texOrigin[2]],
            texDims: [texDims[0], texDims[1], texDims[2]],
            bytesPerVoxel: bpv,
            signal,
            frame: ch.frame,
          })
          signal?.throwIfAborted()
          const aligned = bytes.byteOffset % bpv ? bytes.slice() : bytes
          const src = new Arr(
            aligned.buffer,
            aligned.byteOffset,
            aligned.length / bpv,
          )
          const lo = texOrigin.map((t, a) => t - c0[a])
          const zFace = (iy * nb[0] + ix) * S2
          const yFace = ix * S2
          for (let k = 0; k < surfaces.length; k++) {
            const id = surfaces[k]
            fillField(
              field,
              dims,
              texDims,
              lo,
              threshold === undefined
                ? (d, s, len) => {
                    for (let x = 0; x < len; x++)
                      field[d + x] = src[s + x] === id ? 1 : -1
                  }
                : isFloat
                  ? (d, s, len) => {
                      for (let x = 0; x < len; x++) {
                        const v = src[s + x] - threshold
                        // v - v is NaN for NaN and +-Infinity.
                        field[d + x] = v - v === 0 ? v : PAD
                      }
                    }
                  : (d, s, len) => {
                      for (let x = 0; x < len; x++)
                        field[d + x] = src[s + x] - threshold
                    },
            )
            const f = faces[k]
            if (iz) restore(cells, f.z, zFace, lowFace[2])
            if (iy) restore(cells, f.y, yFace, lowFace[1])
            if (ix) restore(cells, f.x, 0, lowFace[0])
            surfaceNets(field, dims, c0, cells, S, vox, off, mesh)
            save(cells, f.z, zFace, highFace[2])
            save(cells, f.y, yFace, highFace[1])
            save(cells, f.x, 0, highFace[0])
            if (performance.now() - lastYield > YIELD_MS) {
              await yieldToHost()
              signal?.throwIfAborted()
              lastYield = performance.now()
            }
          }
          onProgress?.(++done, total)
        }
    const color = ch.color ?? [1, 1, 1, 1]
    const rgba = color.map((c) => Math.round(c * 255))
    const colors = new Uint32Array(mesh.nv).fill(
      ((rgba[3] << 24) | (rgba[2] << 16) | (rgba[1] << 8) | rgba[0]) >>> 0,
    )
    meshes.push(
      createMesh(
        mesh.positions.slice(0, 3 * mesh.nv),
        mesh.indices.slice(0, mesh.ni),
        colors,
        {
          name: `${ch.name ?? `channel ${meshes.length}`} (level ${level})`,
          color,
        },
      ),
    )
  }
  return meshes
}

/** Brick-cell indices of the S x S layer `layer` normal to `axis`. */
function faceIndex(S: number, axis: number, layer: number): Int32Array {
  const st = [1, S, S * S]
  const sb = st[(axis + 1) % 3]
  const sc = st[(axis + 2) % 3]
  const out = new Int32Array(S * S)
  for (let u = 0; u < S; u++)
    for (let v = 0; v < S; v++)
      out[u * S + v] = layer * st[axis] + u * sb + v * sc
  return out
}

function save(
  cells: Int32Array,
  buf: Int32Array,
  at: number,
  face: Int32Array,
) {
  for (let i = 0; i < face.length; i++) buf[at + i] = cells[face[i]]
}

function restore(
  cells: Int32Array,
  buf: Int32Array,
  at: number,
  face: Int32Array,
) {
  for (let i = 0; i < face.length; i++) cells[face[i]] = buf[at + i]
}

function grow<T extends Float32Array | Uint32Array>(a: T): T {
  const b = new (a.constructor as new (length: number) => T)(a.length * 2)
  b.set(a)
  return b
}

/** Copy the fetched rows into the PAD-filled field; `row` converts one x-run. */
function fillField(
  field: Float32Array,
  dims: number[],
  texDims: number[],
  lo: number[],
  row: (dst: number, src: number, len: number) => void,
): void {
  field.fill(PAD, 0, voxelCount(dims))
  for (let z = 0; z < texDims[2]; z++)
    for (let y = 0; y < texDims[1]; y++)
      row(
        ((z + lo[2]) * dims[1] + y + lo[1]) * dims[0] + lo[0],
        (z * texDims[1] + y) * texDims[0],
        texDims[0],
      )
}

/**
 * Naive surface nets over one brick (inside: f >= 0). One vertex per cell,
 * its index kept in `cells` (stride S, local cell c at c + 1). Each quad is
 * emitted by the cell at the edge's start voxel; its three lower neighbour
 * cells were made earlier in this brick (cells run z, y, x ascending) or sit
 * in the halo restored from lower bricks.
 */
function surfaceNets(
  f: Float32Array,
  dims: number[],
  c0: number[],
  cells: Int32Array,
  S: number,
  vox: number[],
  off: number[],
  m: MeshBuffers,
): void {
  const [X, Y, Z] = dims
  const corner = [0, 1, X, X + 1, X * Y, X * Y + 1, X * Y + X, X * Y + X + 1]
  const strides = [1, S, S * S]
  const v = new Float64Array(8)
  for (let z = 0; z < Z - 1; z++)
    for (let y = 0; y < Y - 1; y++)
      for (let x = 0; x < X - 1; x++) {
        const i = (z * Y + y) * X + x
        let mask = 0
        for (let c = 0; c < 8; c++) {
          v[c] = f[i + corner[c]]
          if (v[c] >= 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue
        let px = 0
        let py = 0
        let pz = 0
        let count = 0
        for (let e = 0; e < 24; e += 2) {
          const a = EDGES[e]
          const b = EDGES[e + 1]
          if (!(((mask >> a) ^ (mask >> b)) & 1)) continue
          const t = v[a] / (v[a] - v[b])
          px += (a & 1) + t * ((b & 1) - (a & 1))
          py += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1))
          pz += (a >> 2) + t * ((b >> 2) - (a >> 2))
          count++
        }
        if (m.nv === m.maxVertices)
          throw new RangeError(`isosurface: over maxVertices ${m.maxVertices}`)
        if (3 * m.nv === m.positions.length) m.positions = grow(m.positions)
        const v0 = m.nv++
        const ci = ((z + 1) * S + y + 1) * S + x + 1
        cells[ci] = v0
        m.positions[3 * v0] = (c0[0] + x + px / count) * vox[0] + off[0]
        m.positions[3 * v0 + 1] = (c0[1] + y + py / count) * vox[1] + off[1]
        m.positions[3 * v0 + 2] = (c0[2] + z + pz / count) * vox[2] + off[2]
        // Edges from this cell's min corner along +x, +y, +z (corners 1, 2, 4).
        for (let a = 0; a < 3; a++) {
          if (!((mask ^ (mask >> (1 << a))) & 1)) continue
          const kb = strides[(a + 1) % 3]
          const kc = strides[(a + 2) % 3]
          // (v0, cells[ci - kb], v2) faces +a; swap sides when the inside is
          // at the far end.
          const v1 = cells[mask & 1 ? ci - kb : ci - kc]
          const v2 = cells[ci - kb - kc]
          const v3 = cells[mask & 1 ? ci - kc : ci - kb]
          if (m.ni + 6 > m.indices.length) m.indices = grow(m.indices)
          const I = m.indices
          I[m.ni++] = v0
          I[m.ni++] = v1
          I[m.ni++] = v2
          I[m.ni++] = v0
          I[m.ni++] = v2
          I[m.ni++] = v3
        }
      }
}
