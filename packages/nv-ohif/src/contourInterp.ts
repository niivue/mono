// OHIF's Interpolate Contours on a NiiVue contour segmentation, as
// cornerstone's (utilities/contours/interpolation): between two drawn ("key")
// contours of a segment on slices of one orientation, the slices in between
// get contours blended linearly from the two, point by point after both rings
// are resampled to corresponding points. They are auto-generated: drawn
// fainter, regenerated when a key contour changes, and an edit to one's
// outline makes it a key contour; switching off stops regenerating and keeps them. ponytail: outer rings only (holes are not interpolated); the
// largest ring of a slice with several pieces.
import type { AnnotationPoint, NiiVue, VectorAnnotation } from '@niivue/niivue'
import { ringArea, voxelDepth } from './contourOps'

/** `ring` resampled to `n` points evenly spaced along its closed length. */
export function resampleRing(
  ring: readonly AnnotationPoint[],
  n: number,
): AnnotationPoint[] {
  const m = ring.length
  const cum = [0]
  for (let i = 0; i < m; i++) {
    const p = ring[i] as AnnotationPoint
    const q = ring[(i + 1) % m] as AnnotationPoint
    cum.push((cum[i] as number) + Math.hypot(q.x - p.x, q.y - p.y))
  }
  const total = cum[m] as number
  const out: AnnotationPoint[] = []
  let seg = 0
  for (let k = 0; k < n; k++) {
    const s = (total * k) / n
    while ((cum[seg + 1] as number) < s) seg++
    const p = ring[seg % m] as AnnotationPoint
    const q = ring[(seg + 1) % m] as AnnotationPoint
    const len = (cum[seg + 1] as number) - (cum[seg] as number)
    const t = len > 0 ? (s - (cum[seg] as number)) / len : 0
    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  }
  return out
}

const signedArea = (r: readonly AnnotationPoint[]) =>
  r.reduce((s, p, i) => {
    const q = r[(i + 1) % r.length] as AnnotationPoint
    return s + p.x * q.y - q.x * p.y
  }, 0)

/**
 * Two rings as `n` corresponding points each: same winding, and `b` rotated
 * to the start that puts its points nearest `a`'s.
 */
export function correspond(
  a: readonly AnnotationPoint[],
  b: readonly AnnotationPoint[],
  n: number,
): [AnnotationPoint[], AnnotationPoint[]] {
  const ra = resampleRing(a, n)
  let rb = resampleRing(b, n)
  if (Math.sign(signedArea(ra)) !== Math.sign(signedArea(rb))) rb.reverse()
  let best = 0
  let bestCost = Number.POSITIVE_INFINITY
  for (let off = 0; off < n; off++) {
    let cost = 0
    for (let i = 0; i < n && cost < bestCost; i++) {
      const p = ra[i] as AnnotationPoint
      const q = rb[(i + off) % n] as AnnotationPoint
      cost += (p.x - q.x) ** 2 + (p.y - q.y) ** 2
    }
    if (cost < bestCost) {
      bestCost = cost
      best = off
    }
  }
  rb = rb.map((_, i) => rb[(i + best) % n] as AnnotationPoint)
  return [ra, rb]
}

/** The ring a fraction `t` of the way from `a` to `b` (corresponding points). */
export const blendRing = (
  a: readonly AnnotationPoint[],
  b: readonly AnnotationPoint[],
  t: number,
): AnnotationPoint[] =>
  a.map((p, i) => {
    const q = b[i] as AnnotationPoint
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
  })

// group:label:orientation:depth -> the id of the shape generated there: a
// slice keeps its id across regenerations.
const slotIds = new Map<string, string>()
// Every outline generated per id, as a 53-bit hash (no eviction: any
// generation an undo or redo can restore must be recognised). A shape is
// auto-generated while it has one of them: a user edit to its outline (any
// tool) makes it a key contour, and undo restores one.
const outlines = new Map<string, Set<number>>()
const remember = (id: string, key: number) => {
  const seen = outlines.get(id) ?? new Set<number>()
  seen.add(key)
  outlines.set(id, seen)
}
// Corresponding points per ring pair: the match is O(n^2).
const MAX_POINTS = 256
// Shapes are replaced, not mutated, on edit: one hash per polygons object.
const hashes = new WeakMap<object, number>()
// cyrb53 of the serialised polygons.
const polygonsKey = (p: VectorAnnotation['polygons']): number => {
  let h = hashes.get(p)
  if (h !== undefined) return h
  const s = JSON.stringify(p)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  h = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  hashes.set(p, h)
  return h
}

export const isInterpolated = (
  a: Pick<VectorAnnotation, 'id' | 'polygons'>,
): boolean => outlines.get(a.id)?.has(polygonsKey(a.polygons)) ?? false

/**
 * Regenerate segment shapes of `group` on `nv` between key contours (every
 * label, every orientation). Returns whether anything changed.
 */
export function interpolateGroup(nv: NiiVue, group: string): boolean {
  const mine = nv.annotations.filter((a) => a.group === group)
  const keys = mine.filter((a) => !isInterpolated(a))
  const slice = (a: VectorAnnotation) =>
    `${a.label}:${a.sliceType}:${Math.round(voxelDepth(nv, a) ?? Number.NaN)}`
  const keySlices = new Set(keys.map(slice))
  // As cornerstone: a generated contour stays once its slice gains a key.
  const old = mine.filter((a) => isInterpolated(a) && !keySlices.has(slice(a)))
  // Key contours per (label, orientation), by voxel depth.
  const series = new Map<string, Map<number, VectorAnnotation[]>>()
  for (const a of keys) {
    const depth = voxelDepth(nv, a)
    if (depth === undefined) continue
    const k = `${a.label}:${a.sliceType}`
    const bySlice = series.get(k) ?? new Map<number, VectorAnnotation[]>()
    const d = Math.round(depth)
    bySlice.set(d, [...(bySlice.get(d) ?? []), a])
    series.set(k, bySlice)
  }
  const added: VectorAnnotation[] = []
  const largest = (shapes: VectorAnnotation[]) =>
    shapes
      .flatMap((s) => s.polygons.map((p) => p.outer))
      .reduce((m, r) => (ringArea(r) > ringArea(m) ? r : m))
  for (const bySlice of series.values()) {
    const depths = [...bySlice.keys()].sort((x, y) => x - y)
    for (let i = 0; i + 1 < depths.length; i++) {
      const d0 = depths[i] as number
      const d1 = depths[i + 1] as number
      if (d1 - d0 < 2) continue
      const s0 = bySlice.get(d0) as VectorAnnotation[]
      const s1 = bySlice.get(d1) as VectorAnnotation[]
      const r0 = largest(s0)
      const r1 = largest(s1)
      const n = Math.min(Math.max(r0.length, r1.length, 32), MAX_POINTS)
      const [a, b] = correspond(r0, r1, n)
      const k0 = s0[0] as VectorAnnotation
      const k1 = s1[0] as VectorAnnotation
      for (let d = d0 + 1; d < d1; d++) {
        const t = (d - d0) / (d1 - d0)
        const anchor =
          k0.anchorMM && k1.anchorMM
            ? (k0.anchorMM.map(
                (v, j) => v + ((k1.anchorMM?.[j] as number) - v) * t,
              ) as [number, number, number])
            : undefined
        const {
          stats: _stats,
          text: _text,
          shape: _shape,
          ...rest
        } = t > 0.5 ? k1 : k0
        const slot = `${group}:${k0.label}:${k0.sliceType}:${d}`
        const id = slotIds.get(slot) ?? crypto.randomUUID()
        slotIds.set(slot, id)
        added.push({
          ...rest,
          id,
          anchorMM: anchor,
          slicePosition:
            k0.slicePosition + (k1.slicePosition - k0.slicePosition) * t,
          polygons: [{ outer: blendRing(a, b, t), holes: [] }],
        })
      }
    }
  }
  const same =
    added.length === old.length &&
    added.every((a) => {
      const o = old.find((x) => x.id === a.id)
      return !!o && polygonsKey(o.polygons) === polygonsKey(a.polygons)
    })
  if (same) return false
  for (const a of added) remember(a.id, polygonsKey(a.polygons))
  nv.replaceAnnotations(
    old.map((a) => a.id),
    added,
    false,
  )
  return true
}
