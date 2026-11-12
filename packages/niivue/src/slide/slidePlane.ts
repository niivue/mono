import type {
  NVSlide,
  NVSlideLevelManifest,
  NVSlidePlacedPiece,
  NVSlideRequestOwner,
  NVSlideTileManifest,
  NVSlideVisibleTile,
} from './NVSlide'
import { levelTileHeight, levelTileWidth, pickLevel } from './slideLod'
import {
  countPieces,
  placedPlaneTiles,
  visitPiecesInOrder,
} from './slidePlacement'

// Geometry for rendering an NVSlide as a flat plane in a volume's 3D world space.
// Each slide tile is mapped from base (level-0) pixel coordinates to world mm via
// a `pixelToWorld` transform, yielding a quad the 3D renderer can draw (textured
// with that tile's bitmap from NVSlide's cache) and depth-composite with a volume.
// This leverages NVSlide's level selection, tile model, and tile cache; only the
// 2D->3D placement is new.

export type Vec3 = [number, number, number]

export interface SlidePlaneTile {
  /** NVSlide.tileKey of the tile. */
  key: string
  /** The level, its manifest tile, grid column / row, and size in level px. */
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  col: number
  row: number
  width: number
  height: number
  /** Crop in tile px (placement); absent, the whole tile. */
  src?: NVSlideVisibleTile['src']
  /** World-mm quad corners: top-left, top-right, bottom-left, bottom-right
   * (in base-pixel order before transform). */
  corners: [Vec3, Vec3, Vec3, Vec3]
}

// Apply a column-major 4x4 transform to a slide-pixel point (z = 0 plane).
function apply(m: readonly number[], px: number, py: number): Vec3 {
  return [
    m[0] * px + m[4] * py + m[12],
    m[1] * px + m[5] * py + m[13],
    m[2] * px + m[6] * py + m[14],
  ]
}

/**
 * A plane quad's 4 vertices, interleaved [pos.xyz, uv.xy] in TRIANGLE_STRIP
 * order TL, TR, BL, BR; UV origin top-left. `uv` is the interior span
 * [u0, v0, u1, v1] (a crop, see cropUv), mapped into the interior of a
 * `gutter`-sized tile texture when given.
 */
export function cornerQuad(
  corners: SlidePlaneTile['corners'],
  gutter?: { width: number; height: number },
  uv: readonly [number, number, number, number] = [0, 0, 1, 1],
): Float32Array<ArrayBuffer> {
  const [tl, tr, bl, br] = corners
  // A tile texture's interior inside its 1-texel gutter (slide/tileGutter.ts).
  const gw = gutter ? gutter.width : 1
  const gh = gutter ? gutter.height : 1
  const pad = gutter ? 1 : 0
  const u = (f: number) => (pad + f * gw) / (gw + 2 * pad)
  const v = (f: number) => (pad + f * gh) / (gh + 2 * pad)
  const [u0, v0, u1, v1] = [u(uv[0]), v(uv[1]), u(uv[2]), v(uv[3])]
  return new Float32Array([
    ...tl,
    u0,
    v0,
    ...tr,
    u1,
    v0,
    ...bl,
    u0,
    v1,
    ...br,
    u1,
    v1,
  ])
}

/**
 * Map every tile of `level` of `slide` to a world-space quad via `pixelToWorld`
 * (column-major 4x4, slide base pixels -> world mm). Mirrors
 * NVSlide.visibleTiles' base-pixel math, so a tile's plane position lines up
 * with its 2D position: level<->base uses each level's ACTUAL per-axis scale
 * (base / level dims), not the nominal `downsample`, so levels whose dims are
 * not an exact `base / 2^L` still cover exactly [0, base].
 */
export function slidePlaneTiles(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  pixelToWorld: readonly number[],
): SlidePlaneTile[] {
  const ix = slide.placementIndex(level)
  if (ix) return placedPlaneTiles(slide, ix, pixelToWorld)
  const out: SlidePlaneTile[] = []
  for (const tile of level.tiles)
    if (tile) out.push(planeTile(slide, level, tile, pixelToWorld)) // null: a hole
  return out
}

/**
 * A slide registered into a volume's 3D world space. `pixelToWorld` lays slide
 * base pixels into world mm; the active pyramid level is chosen per-frame from
 * the camera (`resolveSlidePlaneTiles`) unless `levelIndex` pins it. The renderer
 * pulls each tile's bitmap from `slide`'s cache by `key`, so streaming stays in
 * NVSlide. `tilesByLevel` caches the (stable) plane-tile array per level.
 */
/** An annotation drawn on the slide plane: an RGBA raster (slide space) shown as
 * a single quad spanning the whole slide extent, over the tiles. */
export interface SlidePlaneAnnotation {
  /** World-mm quad over the full slide extent: TL, TR, BL, BR. */
  corners: [Vec3, Vec3, Vec3, Vec3]
  rgba: Uint8Array
  width: number
  height: number
  /** Bumped when `rgba` changes so the renderer re-uploads its texture. */
  version: number
}

/** One render tile's camera from the last render, used for screen->slide picking. */
interface SlidePlanePickFrame {
  mvp: Float32Array
  /** Render-tile rect within the canvas (device px): left, top, width, height. */
  ltwh: [number, number, number, number]
  /** Sub-canvas bounds offset (device px); 0 for a full-canvas instance. */
  bx: number
  by: number
}

export interface SlidePlaneState {
  slide: NVSlide
  pixelToWorld: number[]
  /** Pinned level (camera LOD off) or undefined for automatic camera-distance LOD. */
  levelIndex?: number
  /** Sample tiles nearest-neighbour instead of linear (ENG-10). */
  isNearestInterpolation?: boolean
  annotation?: SlidePlaneAnnotation | null
  /** Per-level plane tiles built so far, by tile slot; set by the resolver. */
  tilesByLevel?: WeakMap<NVSlideLevelManifest, Map<number, SlidePlaneTile>>
  /** Per placed level, the quad of each piece; set by the resolver. */
  placedByLevel?: WeakMap<
    NVSlideLevelManifest,
    Map<NVSlidePlacedPiece, SlidePlaneTile>
  >
  /** The auto level last chosen (LOD hysteresis). */
  lodLevel?: NVSlideLevelManifest
  /** Last frame's draw list, returned again while unchanged. */
  drawn?: SlidePlaneTile[]
  /**
   * One plane3d (and one prefetch) owner per RENDER viewport drawn this frame,
   * by draw order, so one viewport never cancels another's loads (an edge-on
   * view wants nothing of its own). `slot` counts this frame's viewports,
   * `slots` last frame's; beginSlidePlaneFrame releases unused ones.
   */
  owners?: NVSlideRequestOwner[]
  coverOwners?: NVSlideRequestOwner[]
  slot?: number
  slots?: number
  /** One per render tile that drew the plane in the last frame. */
  pickFrames?: SlidePlanePickFrame[]
}

/** World-mm quad (TL, TR, BL, BR) spanning the whole slide extent. */
export function slideExtentCorners(
  pixelToWorld: readonly number[],
  width: number,
  height: number,
): [Vec3, Vec3, Vec3, Vec3] {
  return [
    apply(pixelToWorld, 0, 0),
    apply(pixelToWorld, width, 0),
    apply(pixelToWorld, 0, height),
    apply(pixelToWorld, width, height),
  ]
}

// Project a world-mm point to canvas device pixels (top-left origin) using the
// render-tile MVP + viewport rect. Mirrors the gl.viewport mapping both backends
// use: NDC (y up) -> tile-local px -> canvas px.
function projectToCanvas(
  frame: SlidePlanePickFrame,
  p: Vec3,
): [number, number] {
  const m = frame.mvp
  const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]
  const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]
  const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]
  const iw = cw !== 0 ? 1 / cw : 0
  const ndcX = cx * iw
  const ndcY = cy * iw
  const [lx, ty, w, h] = frame.ltwh
  const px = frame.bx + lx + (ndcX * 0.5 + 0.5) * w
  // NDC y is up; canvas y is down, so flip within the tile.
  const py = frame.by + ty + (0.5 - ndcY * 0.5) * h
  return [px, py]
}

/**
 * Map a canvas device pixel to slide base-pixel (u, v), or null if the ray
 * misses the slide. The 3D render is orthographic and the plane affine in slide
 * coords, so slide->canvas is a 2D affine — invert it from three projected
 * reference points, using the camera of the render tile under the point.
 */
export function pickSlidePixel(
  state: SlidePlaneState,
  canvasX: number,
  canvasY: number,
): { x: number; y: number } | null {
  const frame = state.pickFrames?.find(({ ltwh, bx, by }) => {
    const x = canvasX - bx - ltwh[0]
    const y = canvasY - by - ltwh[1]
    // Half-open, as hitTest: a shared edge belongs to the right/lower tile.
    return x >= 0 && y >= 0 && x < ltwh[2] && y < ltwh[3]
  })
  if (!frame) return null
  const w = state.slide.manifest.width
  const h = state.slide.manifest.height
  const o = projectToCanvas(frame, apply(state.pixelToWorld, 0, 0))
  const pu = projectToCanvas(frame, apply(state.pixelToWorld, w, 0))
  const pv = projectToCanvas(frame, apply(state.pixelToWorld, 0, h))
  const e1x = pu[0] - o[0]
  const e1y = pu[1] - o[1]
  const e2x = pv[0] - o[0]
  const e2y = pv[1] - o[1]
  const det = e1x * e2y - e2x * e1y
  if (Math.abs(det) < 1e-9) return null
  const rx = canvasX - o[0]
  const ry = canvasY - o[1]
  const a = (rx * e2y - e2x * ry) / det
  const b = (e1x * ry - rx * e1y) / det
  if (a < 0 || a > 1 || b < 0 || b > 1) return null
  return { x: a * w, y: b * h }
}

/** As {@link pickSlidePixel}, returning the hit in world mm. */
export function pickSlideWorld(
  state: SlidePlaneState,
  canvasX: number,
  canvasY: number,
): Vec3 | null {
  const hit = pickSlidePixel(state, canvasX, canvasY)
  return hit ? apply(state.pixelToWorld, hit.x, hit.y) : null
}

/**
 * The slide base pixel under world-mm point `mm`, projected orthogonally onto
 * the plane, or null when that lands off the slide.
 */
export function worldToSlidePixel(
  state: SlidePlaneState,
  mm: ArrayLike<number>,
): { x: number; y: number } | null {
  const m = state.pixelToWorld
  // Least squares on the plane's two axes, so a zero third column still works.
  const d = [mm[0] - m[12], mm[1] - m[13], mm[2] - m[14]]
  const uu = m[0] * m[0] + m[1] * m[1] + m[2] * m[2]
  const uv = m[0] * m[4] + m[1] * m[5] + m[2] * m[6]
  const vv = m[4] * m[4] + m[5] * m[5] + m[6] * m[6]
  const du = m[0] * d[0] + m[1] * d[1] + m[2] * d[2]
  const dv = m[4] * d[0] + m[5] * d[1] + m[6] * d[2]
  const det = uu * vv - uv * uv
  // Relative to the axis lengths: micrometre pixels give a tiny absolute det.
  if (!(det > 1e-12 * uu * vv)) return null
  const x = (du * vv - dv * uv) / det
  const y = (dv * uu - du * uv) / det
  const { width, height } = state.slide.manifest
  return x >= 0 && y >= 0 && x < width && y < height ? { x, y } : null
}

// Project a world-mm point through a column-major mvp (world mm -> clip) to
// viewport pixels. Returns x,y in [0,w]x[0,h]; w-component sign tells front/back.
function projectToScreen(
  mvp: ArrayLike<number>,
  p: Vec3,
  w: number,
  h: number,
): [number, number, number] {
  const cx = mvp[0] * p[0] + mvp[4] * p[1] + mvp[8] * p[2] + mvp[12]
  const cy = mvp[1] * p[0] + mvp[5] * p[1] + mvp[9] * p[2] + mvp[13]
  const cw = mvp[3] * p[0] + mvp[7] * p[1] + mvp[11] * p[2] + mvp[15]
  const iw = cw !== 0 ? 1 / cw : 0
  return [(cx * iw * 0.5 + 0.5) * w, (cy * iw * 0.5 + 0.5) * h, cw]
}

// The slide base-px rect under the viewport (plus `margin` px), clamped to
// the slide, from the affine slide->screen map of an orthographic camera.
// Null when the plane is edge-on or behind the camera.
function viewRectInSlide(
  state: SlidePlaneState,
  mvp: ArrayLike<number>,
  w: number,
  h: number,
  margin: number,
): [number, number, number, number] | null {
  const { width, height } = state.slide.manifest
  const m = state.pixelToWorld
  const o = projectToScreen(mvp, apply(m, 0, 0), w, h)
  const u = projectToScreen(mvp, apply(m, width, 0), w, h)
  const v = projectToScreen(mvp, apply(m, 0, height), w, h)
  if (o[2] <= 0 || u[2] <= 0 || v[2] <= 0) return null
  const e1x = u[0] - o[0]
  const e1y = u[1] - o[1]
  const e2x = v[0] - o[0]
  const e2y = v[1] - o[1]
  const det = e1x * e2y - e2x * e1y
  if (Math.abs(det) < 1e-9) return null
  let a0 = 1
  let a1 = 0
  let b0 = 1
  let b1 = 0
  for (const [sx, sy] of [
    [-margin, -margin],
    [w + margin, -margin],
    [-margin, h + margin],
    [w + margin, h + margin],
  ] as const) {
    const rx = sx - o[0]
    const ry = sy - o[1]
    const a = (rx * e2y - e2x * ry) / det
    const b = (e1x * ry - rx * e1y) / det
    a0 = Math.min(a0, a)
    a1 = Math.max(a1, a)
    b0 = Math.min(b0, b)
    b1 = Math.max(b1, b)
  }
  a0 = Math.max(0, a0)
  b0 = Math.max(0, b0)
  a1 = Math.min(1, a1)
  b1 = Math.min(1, b1)
  if (a0 >= a1 || b0 >= b1) return null
  return [a0 * width, b0 * height, a1 * width, b1 * height]
}

// Tiles (grid cells, or placed pieces) of `level` in base-px `rect`.
function tilesInRect(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  rect: readonly [number, number, number, number],
): number {
  const ix = slide.placementIndex(level)
  if (!ix) return cellRange(slide, level, rect).count
  const [x0, y0, x1, y1] = rect
  return countPieces(ix, x0 / ix.dsX, y0 / ix.dsY, x1 / ix.dsX, y1 / ix.dsY)
}

// Grid cells of `level` covering base-px `rect`.
function cellRange(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  rect: readonly [number, number, number, number],
) {
  const { manifest } = slide
  const cw = (levelTileWidth(manifest, level) * manifest.width) / level.width
  const ch = (levelTileHeight(manifest, level) * manifest.height) / level.height
  const c0 = Math.max(0, Math.floor(rect[0] / cw))
  const r0 = Math.max(0, Math.floor(rect[1] / ch))
  const c1 = Math.min(level.columns - 1, Math.ceil(rect[2] / cw) - 1)
  const r1 = Math.min(level.rows - 1, Math.ceil(rect[3] / ch) - 1)
  return { c0, r0, c1, r1, count: Math.max(0, (c1 - c0 + 1) * (r1 - r0 + 1)) }
}

// The plane tiles of `level` in `rect`, at most `limit` nearest `focus`.
function planeTilesIn(
  state: SlidePlaneState,
  level: NVSlideLevelManifest,
  rect: readonly [number, number, number, number],
  limit: number,
  focus: { x: number; y: number },
): SlidePlaneTile[] {
  const { slide } = state
  state.tilesByLevel ??= new WeakMap()
  let built = state.tilesByLevel.get(level)
  if (!built) {
    built = new Map()
    state.tilesByLevel.set(level, built)
  }
  const out: SlidePlaneTile[] = []
  const ix = slide.placementIndex(level)
  if (ix) {
    // Placed (SRC-20): one quad per piece in view, built once per level.
    let all = state.placedByLevel?.get(level)
    if (!all) {
      const tiles = placedPlaneTiles(slide, ix, state.pixelToWorld)
      all = new Map(
        ix.placement.pieces.map((p, i) => [p, tiles[i] as SlidePlaneTile]),
      )
      state.placedByLevel ??= new WeakMap()
      state.placedByLevel.set(level, all)
    }
    const quads = all
    const [x0, y0, x1, y1] = rect
    visitPiecesInOrder(
      ix,
      x0 / ix.dsX,
      y0 / ix.dsY,
      x1 / ix.dsX,
      y1 / ix.dsY,
      (p) => {
        const t = quads.get(p)
        if (t) out.push(t)
      },
    )
  }
  const { c0, r0, c1, r1 } = ix
    ? { c0: 0, r0: 0, c1: -1, r1: -1 }
    : cellRange(slide, level, rect)
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) {
      const slot = r * level.columns + c
      const tile = level.tiles[slot]
      if (!tile) continue // a sparse slide's hole
      let t = built.get(slot)
      if (!t) {
        t = planeTile(slide, level, tile, state.pixelToWorld)
        built.set(slot, t)
      }
      out.push(t)
    }
  if (out.length <= limit) return out
  // More than fit: the block nearest the focus, so the plane settles.
  const { width, height } = slide.manifest
  const d = (t: SlidePlaneTile) =>
    (((t.col + 0.5) * t.width * width) / level.width - focus.x) ** 2 +
    (((t.row + 0.5) * t.height * height) / level.height - focus.y) ** 2
  return out.sort((p, q) => d(p) - d(q)).slice(0, limit)
}

function planeTile(
  slide: NVSlide,
  level: NVSlideLevelManifest,
  tile: NVSlideTileManifest,
  pixelToWorld: readonly number[],
): SlidePlaneTile {
  const { width, height } = slide.manifest
  const dsX = width / level.width
  const dsY = height / level.height
  const baseX = tile.x * levelTileWidth(slide.manifest, level) * dsX
  const baseY = tile.y * levelTileHeight(slide.manifest, level) * dsY
  const baseW = tile.width * dsX
  const baseH = tile.height * dsY
  return {
    key: slide.tileKey(level, tile),
    level,
    tile,
    col: tile.x,
    row: tile.y,
    width: tile.width,
    height: tile.height,
    corners: [
      apply(pixelToWorld, baseX, baseY),
      apply(pixelToWorld, baseX + baseW, baseY),
      apply(pixelToWorld, baseX, baseY + baseH),
      apply(pixelToWorld, baseX + baseW, baseY + baseH),
    ],
  }
}

/**
 * Device px per slide base px under the camera (`mvp`, world mm -> clip;
 * viewport `w` x `h`), the larger of the two plane axes so an oblique or
 * anisotropic plane gets the detail its finer axis needs. The 3D render is
 * orthographic, so the scale is uniform and a centre sample is exact.
 */
function devicePxPerBasePx(
  state: SlidePlaneState,
  mvp: ArrayLike<number>,
  w: number,
  h: number,
): number {
  const cx = state.slide.manifest.width / 2
  const cy = state.slide.manifest.height / 2
  const o = projectToScreen(mvp, apply(state.pixelToWorld, cx, cy), w, h)
  const px = projectToScreen(mvp, apply(state.pixelToWorld, cx + 1, cy), w, h)
  const py = projectToScreen(mvp, apply(state.pixelToWorld, cx, cy + 1), w, h)
  return Math.max(
    Math.hypot(px[0] - o[0], px[1] - o[1]),
    Math.hypot(py[0] - o[0], py[1] - o[1]),
  )
}

/**
 * The plane's level under the camera: the pinned `state.levelIndex`, else the
 * 2D view's rule (ENG-05, `pickLevel`): the finest level giving the slide's
 * `targetScreenPixelsPerTilePixel` device px per level px, with hysteresis.
 */
export function selectSlidePlaneLevel(
  state: SlidePlaneState,
  mvp: ArrayLike<number>,
  w: number,
  h: number,
): NVSlideLevelManifest {
  const levels = state.slide.manifest.levels
  if (state.levelIndex !== undefined) {
    // `level.index` is a manifest identifier, not its position in the array:
    // NVSlide.selectLevel uses the same lookup. A bad persisted value falls
    // through to camera-driven LOD instead of returning undefined to render.
    const pinned = levels.find((level) => level.index === state.levelIndex)
    if (pinned) return pinned
  }
  return pickLevel(
    levels,
    devicePxPerBasePx(state, mvp, w, h),
    state.slide.targetScreenPixelsPerTilePixel,
    state.lodLevel,
  ) as NVSlideLevelManifest
}

// Coverage: at most this many tiles of the finest coarser level (ENG-03).
const COVER_TILES = 16

/**
 * Resolve the slide-plane tiles to draw this frame: pick the camera's level,
 * go coarser while its tiles in view exceed the plane's share of the tile
 * cache (`NVSlide.planeCapacity`, ENG-05), want them through the plane3d
 * owner (centre-out), want a small coarse coverage at prefetch rank, and
 * build `drawn`: resident coarser tiles (coarsest first) under the target
 * tiles while any target tile is missing (ENG-03). `drawn` keeps its identity
 * while unchanged, so a renderer can keep its vertex buffer.
 */
export function resolveSlidePlaneTiles(
  state: SlidePlaneState,
  mvp: ArrayLike<number>,
  w: number,
  h: number,
): {
  level: NVSlideLevelManifest
  tiles: SlidePlaneTile[]
  drawn: SlidePlaneTile[]
  /** The camera's level, when the plane's tile capacity forced `level` coarser. */
  requestedLevel?: NVSlideLevelManifest
} {
  const { slide } = state
  const levels = slide.manifest.levels
  let level = selectSlidePlaneLevel(state, mvp, w, h)
  if (state.levelIndex === undefined) state.lodLevel = level
  const slot = state.slot ?? 0
  state.slot = slot + 1
  state.owners ??= []
  state.coverOwners ??= []
  state.owners[slot] ??= slide.createRequestOwner('plane3d')
  state.coverOwners[slot] ??= slide.createRequestOwner('prefetch')
  const owner = state.owners[slot]
  const coverOwner = state.coverOwners[slot]
  // The plane's share of the cache, split between its viewports.
  const share = Math.max(1, state.slots ?? 1)
  const capacity = (l: NVSlideLevelManifest) =>
    Math.max(1, Math.floor(slide.planeCapacity(l) / share))
  const rect = viewRectInSlide(state, mvp, w, h, Math.max(w, h) * 0.1)
  if (!rect) {
    owner.want([])
    coverOwner.want([])
    state.drawn = []
    return { level, tiles: [], drawn: state.drawn }
  }
  const focus = { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2 }
  const requested = level
  let pos = levels.indexOf(level)
  while (
    pos < levels.length - 1 &&
    tilesInRect(slide, level, rect) > capacity(level)
  )
    level = levels[++pos] as NVSlideLevelManifest
  const tiles = planeTilesIn(state, level, rect, capacity(level), focus)
  owner.want(tiles, focus)
  // Coverage fits in what the targets leave of the plane's share (R4).
  const room = Math.min(COVER_TILES, capacity(level) - tiles.length)
  let cover: SlidePlaneTile[] = []
  for (let p = pos + 1; room > 0 && p < levels.length; p++) {
    const coarse = levels[p] as NVSlideLevelManifest
    if (tilesInRect(slide, coarse, rect) <= room) {
      cover = planeTilesIn(state, coarse, rect, room, focus)
      break
    }
  }
  coverOwner.want(cover, focus)
  // cachedTile refreshes LRU order: drawn tiles stay resident.
  const missing = tiles.some((t) => !slide.cachedTile(t.key))
  const layers: SlidePlaneTile[][] = []
  for (let p = pos + 1; missing && p < levels.length; p++) {
    const coarse = levels[p] as NVSlideLevelManifest
    const limit = COVER_TILES * 4
    // One past the limit tells a cut level, which covers the view only within
    // its cut: then look coarser.
    const found = planeTilesIn(state, coarse, rect, limit + 1, focus)
    const all = found.length > limit ? found.slice(0, limit) : found
    const resident = all.filter((t) => slide.cachedTile(t.key))
    if (resident.length) layers.push(resident)
    if (resident.length === found.length) break
  }
  const drawn = layers.length ? [...layers.reverse().flat(), ...tiles] : tiles
  const last = state.drawn
  const requestedLevel = level === requested ? undefined : requested
  if (
    last &&
    last.length === drawn.length &&
    last.every((t, i) => t === drawn[i])
  )
    return { level, tiles, drawn: last, requestedLevel }
  state.drawn = drawn
  return { level, tiles, drawn, requestedLevel }
}

/**
 * Start a view frame: drop last frame's pick cameras, and release the request
 * owners of viewports that no longer draw the plane.
 */
export function beginSlidePlaneFrame(state: SlidePlaneState): void {
  state.pickFrames = []
  const used = state.slot ?? 0
  for (const owners of [state.owners, state.coverOwners]) {
    if (!owners) continue
    for (const o of owners.splice(used)) o.release()
  }
  state.slots = used
  state.slot = 0
}

/** Release the plane's request owners (the plane is cleared or replaced). */
export function releaseSlidePlane(state: SlidePlaneState): void {
  for (const o of [...(state.owners ?? []), ...(state.coverOwners ?? [])])
    o.release()
  state.owners = state.coverOwners = undefined
  state.slot = state.slots = 0
}

export interface AxialPlaneOptions {
  /** World mm extents the slide should span. */
  xmin: number
  xmax: number
  ymin: number
  ymax: number
  /** World mm depth (slice position) of the plane. */
  z: number
  /** Flip the slide Y so its top maps to ymax (image rows go top->down). */
  flipY?: boolean
}

/**
 * Build a `pixelToWorld` (column-major 4x4) that lays a `width` x `height` slide
 * onto an axis-aligned plane spanning [xmin,xmax] x [ymin,ymax] at depth z — e.g.
 * an axial plane centred in an MNI152 volume. Maps base pixel (0,0)->(xmin, yTop)
 * and (width,height)->(xmax, yBottom).
 */
export function axialPlaneTransform(
  width: number,
  height: number,
  opts: AxialPlaneOptions,
): number[] {
  const sx = (opts.xmax - opts.xmin) / Math.max(1, width)
  const flip = opts.flipY ?? true
  // flipY: row 0 (top) -> ymax, row height -> ymin.
  const sy =
    (flip ? -(opts.ymax - opts.ymin) : opts.ymax - opts.ymin) /
    Math.max(1, height)
  const ty = flip ? opts.ymax : opts.ymin
  // Column-major: columns = X', Y', Z', translation.
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, opts.xmin, ty, opts.z, 1]
}
