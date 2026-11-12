// Ventana BIF tile joints (XMP EncodeInfo) to a per-piece placement. Behaviour
// spec, from our own decode: scratch/ventana/ventana-joints-spec.md and
// scratch/vendor/ventana-iscan-spec.md.

import { MAX_TILES } from '../channelDisplay'
import {
  attrs,
  levelPieces,
  type PlacedFrame,
  type StorageLevel,
  tagsOf,
  type VendorPlacement,
} from './placement'

/** A joined seam's residual after the solve: placed step minus stated step (px). */
export interface VentanaSeam {
  aoi: number
  tile1: number
  tile2: number
  rx: number
  ry: number
}

/**
 * Placement, or why the slide stays a plain grid. A placement made best
 * effort (unjoined neighbours, loops that disagree) carries `notice`, which
 * was also warned once, and every joined seam's residual.
 */
export type VentanaResult =
  | { placement: VendorPlacement; seams: VentanaSeam[]; notice?: string }
  | { warning: string }

interface Aoi {
  cols: number
  rows: number
  width: number
  height: number
  originX: number
  originY: number
  joints: Record<string, string>[]
}

/** Whether `xmp` (the level-0 IFD's tag 700) holds Ventana stitching data. */
export const isVentanaXmp = (xmp: string): boolean =>
  /<EncodeInfo\b/.test(xmp) && /<TileJointInfo\b/.test(xmp)

// 1-based serpentine frame number to (col, row): even rows run left to right.
function framePos(n: number, cols: number): [number, number] {
  const row = Math.floor((n - 1) / cols)
  const i = (n - 1) % cols
  return [row % 2 ? cols - 1 - i : i, row]
}

function scannedAois(xmp: string): Aoi[] {
  const origins = new Map<number, [number, number]>()
  const block = /<AoiOrigin\b[^>]*>([\s\S]*?)<\/AoiOrigin>/.exec(xmp)?.[1]
  for (const m of block?.matchAll(/<AOI(\d+)\b[^>]*>/g) ?? []) {
    const a = attrs(m[0])
    origins.set(Number(m[1]), [Number(a.OriginX), Number(a.OriginY)])
  }
  const aois: Aoi[] = []
  let order = 0
  for (const m of xmp.matchAll(
    /<ImageInfo\b([^>]*)>([\s\S]*?)<\/ImageInfo>/g,
  )) {
    const a = attrs(m[1] ?? '')
    const index = a.AOIIndex !== undefined ? Number(a.AOIIndex) : order
    order++
    if (a.AOIScanned === '0') continue
    const [originX, originY] = origins.get(index) ?? (index ? [] : [0, 0])
    aois.push({
      cols: Number(a.NumCols),
      rows: Number(a.NumRows),
      width: Number(a.Width),
      height: Number(a.Height),
      originX: Number(originX),
      originY: Number(originY),
      joints: tagsOf(m[2] ?? '', 'TileJointInfo'),
    })
  }
  return aois
}

const int = (v: string | undefined) => (v !== undefined ? Number(v) : NaN)

interface Edge {
  /** Frame indices: `b` sits at `a` + (dx, dy). */
  a: number
  b: number
  dx: number
  dy: number
  /** Joint confidence; -1 for an unjoined pair at the median step. */
  conf: number
  /** 1-based serpentine numbers of a joined joint; 0 for a median step. */
  t1: number
  t2: number
}

const median = (v: number[]) => {
  const s = [...v].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2
    ? (s[m] as number)
    : ((s[m - 1] as number) + (s[m] as number)) / 2
}

// Gauss-Seidel sweeps of the weighted least-squares fit of every edge,
// starting from the spanning-tree placement: a consistent mosaic is already
// its fixed point, so it does not move; loop residuals spread over the loop.
const SWEEPS = 200
const MEDIAN_WEIGHT = 0.01

interface AoiPlacement {
  frames: PlacedFrame[]
  seams: Omit<VentanaSeam, 'aoi'>[]
  unjoined: number
  pairs: number
}

// Frames of one AOI, placed relative to its frame 1 at its storage origin.
function aoiFrames(aoi: Aoi, l0: StorageLevel): AoiPlacement {
  const { cols, rows, width: W, height: H, originX, originY } = aoi
  if (!(cols > 0 && rows > 0 && Number.isInteger(cols * rows)))
    throw new Error('an AOI without a frame grid')
  if (W !== l0.tileWidth || H !== l0.tileHeight)
    throw new Error(
      `frames of ${W}x${H} are not the ${l0.tileWidth}x${l0.tileHeight} storage tiles`,
    )
  if (
    !Number.isInteger(originX / W) ||
    !Number.isInteger(originY / H) ||
    originX < 0 ||
    originY < 0
  )
    throw new Error(`AOI origin ${originX},${originY} is not on the tile grid`)
  if (originX / W + cols > l0.columns || originY / H + rows > l0.rows)
    throw new Error(
      `${cols}x${rows} frames at ${originX},${originY} exceed the ${l0.columns}x${l0.rows} storage tiles`,
    )
  const n = cols * rows
  // Before any per-frame allocation, whatever the storage grid claims.
  if (n > MAX_TILES) throw new Error(`${n} frames, over ${MAX_TILES}`)
  const edges: Edge[] = []
  const joined = new Set<number>()
  // Oriented left->right and top->bottom, for the median steps.
  const across: [number, number][] = []
  const down: [number, number][] = []
  for (const j of aoi.joints) {
    if (j.FlagJoined !== '1') continue
    const t1 = int(j.Tile1)
    const t2 = int(j.Tile2)
    const ox = int(j.OverlapX)
    const oy = int(j.OverlapY)
    if (![t1, t2].every((t) => Number.isInteger(t) && t >= 1 && t <= n))
      throw new Error(`joint ${j.Tile1}-${j.Tile2} names a missing frame`)
    if (!(Math.abs(ox) < W && Math.abs(oy) < H))
      throw new Error(`joint ${t1}-${t2} overlap ${ox},${oy} is out of range`)
    const [c1, r1] = framePos(t1, cols)
    const [c2, r2] = framePos(t2, cols)
    const dir = j.Direction ?? ''
    const isAcross = r1 === r2 && Math.abs(c1 - c2) === 1
    const isDown = c1 === c2 && Math.abs(r1 - r2) === 1
    // The label gives the axis only: Tile1 and Tile2 are grid neighbours, and
    // the overlap moves the right (lower) frame toward the left (upper) one.
    if (
      !(/^(LEFT|RIGHT)$/.test(dir)
        ? isAcross
        : /^(UP|DOWN)$/.test(dir) && isDown)
    )
      throw new Error(
        `joint ${t1}-${t2}: direction "${dir}" does not fit the frame grid`,
      )
    const s = c2 - c1 + r2 - r1
    const step: [number, number] = isAcross ? [W - ox, -oy] : [-ox, H - oy]
    ;(isAcross ? across : down).push(step)
    const conf = Number(j.Confidence)
    edges.push({
      a: t1 - 1,
      b: t2 - 1,
      dx: s * step[0],
      dy: s * step[1],
      conf: Number.isFinite(conf) ? conf : 0,
      t1,
      t2,
    })
    joined.add(Math.min(t1, t2) * (n + 1) + Math.max(t1, t2))
  }
  // Neighbours no joint links take the median joined step of their axis.
  const mid = (list: [number, number][], fallback: [number, number]) =>
    list.length
      ? ([
          median(list.map((v) => v[0])),
          median(list.map((v) => v[1])),
        ] as const)
      : fallback
  const stepAcross = mid(across, [W, 0])
  const stepDown = mid(down, [0, H])
  const at = (c: number, r: number) => r * cols + (r % 2 ? cols - 1 - c : c)
  let pairs = 0
  let unjoined = 0
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      for (const [dc, dr, [dx, dy]] of [
        [1, 0, stepAcross],
        [0, 1, stepDown],
      ] as const) {
        if (c + dc >= cols || r + dr >= rows) continue
        pairs++
        const a = at(c, r)
        const b = at(c + dc, r + dr)
        if (joined.has(Math.min(a, b) * (n + 1) + Math.max(a, b) + n + 2))
          continue
        unjoined++
        edges.push({ a, b, dx, dy, conf: -1, t1: 0, t2: 0 })
      }
  // Spanning tree, most confident first (Kruskal; the sort is stable).
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    let r = i
    while (parent[r] !== r) {
      parent[r] = parent[parent[r] as number] as number
      r = parent[r] as number
    }
    return r
  }
  const tree: Edge[][] = Array.from({ length: n }, () => [])
  for (const e of [...edges].sort((x, y) => y.conf - x.conf)) {
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra === rb) continue
    parent[ra] = rb
    tree[e.a]?.push(e)
    tree[e.b]?.push(e)
  }
  const X = new Float64Array(n).fill(Number.NaN)
  const Y = new Float64Array(n).fill(Number.NaN)
  X[0] = originX
  Y[0] = originY
  const queue = [0]
  for (let q = 0; q < queue.length; q++) {
    const f = queue[q] as number
    for (const e of tree[f] as Edge[]) {
      const [g, sg] = e.a === f ? [e.b, 1] : [e.a, -1]
      if (!Number.isNaN(X[g] as number)) continue
      X[g] = (X[f] as number) + sg * e.dx
      Y[g] = (Y[f] as number) + sg * e.dy
      queue.push(g)
    }
  }
  // Least squares over every edge, frame 1 held.
  const byFrame: Edge[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    byFrame[e.a]?.push(e)
    byFrame[e.b]?.push(e)
  }
  const residual = (e: Edge) =>
    Math.max(
      Math.abs((X[e.b] as number) - (X[e.a] as number) - e.dx),
      Math.abs((Y[e.b] as number) - (Y[e.a] as number) - e.dy),
    )
  if (edges.some((e) => residual(e) > 1e-9))
    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      let moved = 0
      for (let f = 1; f < n; f++) {
        let sx = 0
        let sy = 0
        let sw = 0
        for (const e of byFrame[f] as Edge[]) {
          const w = e.conf < 0 ? MEDIAN_WEIGHT : 1
          const [g, sg] = e.a === f ? [e.b, -1] : [e.a, 1]
          sx += w * ((X[g] as number) + sg * e.dx)
          sy += w * ((Y[g] as number) + sg * e.dy)
          sw += w
        }
        const x = sx / sw
        const y = sy / sw
        moved = Math.max(
          moved,
          Math.abs(x - (X[f] as number)),
          Math.abs(y - (Y[f] as number)),
        )
        X[f] = x
        Y[f] = y
      }
      if (moved < 1e-3) break
    }
  const seams = edges
    .filter((e) => e.conf >= 0)
    .map((e) => ({
      tile1: e.t1,
      tile2: e.t2,
      rx: (X[e.b] as number) - (X[e.a] as number) - e.dx,
      ry: (Y[e.b] as number) - (Y[e.a] as number) - e.dy,
    }))
  // Overlaps split at their midpoint; frames past the grid edge keep their side.
  const frames: PlacedFrame[] = []
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const i = at(c, r)
      const x = X[i] as number
      const y = Y[i] as number
      const left = c > 0 ? ((X[at(c - 1, r)] as number) + W + x) / 2 : x
      const right =
        c < cols - 1 ? (x + W + (X[at(c + 1, r)] as number)) / 2 : x + W
      const top = r > 0 ? ((Y[at(c, r - 1)] as number) + H + y) / 2 : y
      const bottom =
        r < rows - 1 ? (y + H + (Y[at(c, r + 1)] as number)) / 2 : y + H
      const sx = Math.min(W, Math.max(0, left - x))
      const sy = Math.min(H, Math.max(0, top - y))
      frames.push({
        x: originX + c * W,
        y: originY + r * H,
        sx,
        sy,
        sw: Math.min(W, Math.max(sx, right - x)) - sx,
        sh: Math.min(H, Math.max(sy, bottom - y)) - sy,
        dx: x + sx,
        dy: y + sy,
      })
    }
  return { frames, seams, unjoined, pairs }
}

/**
 * The placement of a Ventana BIF's frames from its level-0 XMP, for each of
 * `levels` (the storage grids, finest first). Frames are placed along a
 * spanning tree of the joints, most confident first; neighbours no joint
 * links take their axis's median joined step, and loop residuals are spread
 * by least squares (owner, CCR-V2). Never throws: invalid stitching data (an
 * unknown direction, a missing frame, frames past the storage grid) gives a
 * warning and the caller keeps the grid.
 */
export function ventanaPlacement(
  xmp: string,
  levels: readonly StorageLevel[],
): VentanaResult {
  try {
    const l0 = levels[0]
    if (!l0) throw new Error('no levels')
    const aois = scannedAois(xmp)
    if (!aois.length) throw new Error('no scanned AOI')
    const placedAois = aois.map((aoi) => aoiFrames(aoi, l0))
    const frames = placedAois.flatMap((a) => a.frames)
    const seams = placedAois.flatMap((a, i) =>
      a.seams.map((sm) => ({ aoi: i, ...sm })),
    )
    let minX = Infinity
    let minY = Infinity
    for (const f of frames) {
      minX = Math.min(minX, f.dx)
      minY = Math.min(minY, f.dy)
    }
    for (const f of frames) {
      f.dx -= minX
      f.dy -= minY
    }
    const unjoined = placedAois.reduce((n, a) => n + a.unjoined, 0)
    const pairs = placedAois.reduce((n, a) => n + a.pairs, 0)
    const worst = seams.reduce(
      (m, sm) => Math.max(m, Math.abs(sm.rx), Math.abs(sm.ry)),
      0,
    )
    // Best effort past 1 px or with unjoined pairs: placed, warned once.
    const notice =
      unjoined || worst > 1
        ? `Ventana tile joints placed best effort: ${unjoined} of ${pairs} neighbour pairs unjoined (median step), largest seam residual ${worst.toFixed(1)} px`
        : undefined
    if (notice) console.warn(notice)
    return {
      placement: levelPieces(frames, levels),
      seams,
      ...(notice && { notice }),
    }
  } catch (err) {
    return {
      warning: `Ventana tile joints not applied: ${err instanceof Error ? err.message : err}`,
    }
  }
}
