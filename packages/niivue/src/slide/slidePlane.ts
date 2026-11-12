import type { NVSlide, NVSlideLevelManifest } from './NVSlide'

// Geometry for rendering an NVSlide as a flat plane in a volume's 3D world space.
// Each slide tile is mapped from base (level-0) pixel coordinates to world mm via
// a `pixelToWorld` transform, yielding a quad the 3D renderer can draw (textured
// with that tile's bitmap from NVSlide's cache) and depth-composite with a volume.
// This leverages NVSlide's level selection, tile model, and tile cache; only the
// 2D->3D placement is new.

export type Vec3 = [number, number, number]

export interface SlidePlaneTile {
  /** Cache key matching NVSlide.tileKey: `L<index>/<x>/<y>`. */
  key: string
  /** Level index, tile grid column / row in it, and tile size in level px. */
  level: number
  col: number
  row: number
  width: number
  height: number
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
 * order TL, TR, BL, BR; UV origin top-left, inset to the interior of a
 * `gutter`-sized tile texture when given.
 */
export function cornerQuad(
  corners: SlidePlaneTile['corners'],
  gutter?: { width: number; height: number },
): Float32Array<ArrayBuffer> {
  const [tl, tr, bl, br] = corners
  // A tile texture's interior inside its 1-texel gutter (slide/tileGutter.ts).
  const u0 = gutter ? 1 / (gutter.width + 2) : 0
  const v0 = gutter ? 1 / (gutter.height + 2) : 0
  const [u1, v1] = [1 - u0, 1 - v0]
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
 * Map every tile of `level` to a world-space quad via `pixelToWorld` (column-major
 * 4x4, slide base pixels -> world mm). Mirrors NVSlide.visibleTiles' base-pixel
 * math, so a tile's plane position lines up with its 2D position. When the base
 * slide dims are given, level<->base uses each level's ACTUAL per-axis scale
 * (base / level dims) rather than the nominal `downsample`; this keeps levels
 * whose dims are not an exact `base / 2^L` (rounding) covering exactly [0, base],
 * so registered drawings don't drift when zoom crosses a LOD boundary. Falls back
 * to `downsample` when base dims are omitted.
 */
export function slidePlaneTiles(
  level: NVSlideLevelManifest,
  tileWidth: number,
  tileHeight: number,
  pixelToWorld: readonly number[],
  baseWidth?: number,
  baseHeight?: number,
): SlidePlaneTile[] {
  const dsX =
    baseWidth && level.width > 0 ? baseWidth / level.width : level.downsample
  const dsY =
    baseHeight && level.height > 0
      ? baseHeight / level.height
      : level.downsample
  const out: SlidePlaneTile[] = []
  for (const tile of level.tiles) {
    if (!tile) continue // a sparse slide's hole
    const baseX = tile.x * tileWidth * dsX
    const baseY = tile.y * tileHeight * dsY
    const baseW = tile.width * dsX
    const baseH = tile.height * dsY
    out.push({
      key: `L${level.index}/${tile.x}/${tile.y}`,
      level: level.index,
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
    })
  }
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
  tilesByLevel: Map<number, SlidePlaneTile[]>
  annotation?: SlidePlaneAnnotation | null
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
    return x >= 0 && y >= 0 && x <= ltwh[2] && y <= ltwh[3]
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

/**
 * Pick the pyramid level whose pixels map closest to one screen pixel under the
 * current camera (`mvp`, world mm -> clip; viewport `w`x`h`). Returns the pinned
 * level when `state.levelIndex` is set. The 3D render uses an orthographic
 * projection, so the slide's screen scale is uniform — a center sample is exact.
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
  // Screen pixels spanned by one base (level-0) slide pixel at the plane center.
  const cx = state.slide.manifest.width / 2
  const cy = state.slide.manifest.height / 2
  const o = projectToScreen(mvp, apply(state.pixelToWorld, cx, cy), w, h)
  const px = projectToScreen(mvp, apply(state.pixelToWorld, cx + 1, cy), w, h)
  const py = projectToScreen(mvp, apply(state.pixelToWorld, cx, cy + 1), w, h)
  const dx = Math.hypot(px[0] - o[0], px[1] - o[1])
  const dy = Math.hypot(py[0] - o[0], py[1] - o[1])
  const perBasePx = Math.max(dx, dy)
  // A level pixel spans `downsample` base px, so `downsample * perBasePx` screen
  // px. Aim for ~1: downsample ~ 1/perBasePx. Pick the closest in log space.
  const want =
    perBasePx > 1e-6 ? 1 / perBasePx : levels[levels.length - 1].downsample
  let best = levels[0]
  let bestErr = Number.POSITIVE_INFINITY
  for (const lv of levels) {
    const err = Math.abs(
      Math.log2(lv.downsample) - Math.log2(Math.max(want, 1e-6)),
    )
    if (err < bestErr) {
      bestErr = err
      best = lv
    }
  }
  return best
}

/**
 * Resolve the slide-plane tiles to draw this frame: pick the camera-appropriate
 * level, cull its tiles to the viewport, and request the visible ones from
 * NVSlide (streaming). Returns the chosen level and the visible plane tiles.
 */
export function resolveSlidePlaneTiles(
  state: SlidePlaneState,
  mvp: ArrayLike<number>,
  w: number,
  h: number,
): { level: NVSlideLevelManifest; tiles: SlidePlaneTile[] } {
  const level = selectSlidePlaneLevel(state, mvp, w, h)
  let all = state.tilesByLevel.get(level.index)
  if (!all) {
    const tw = level.tileWidth ?? state.slide.manifest.tileSize ?? 256
    const th = level.tileHeight ?? state.slide.manifest.tileSize ?? 256
    all = slidePlaneTiles(
      level,
      tw,
      th,
      state.pixelToWorld,
      state.slide.manifest.width,
      state.slide.manifest.height,
    )
    state.tilesByLevel.set(level.index, all)
  }
  // Cull to the viewport so a deep level only streams/draws on-screen tiles.
  const margin = Math.max(w, h) * 0.1
  const tiles: SlidePlaneTile[] = []
  for (let i = 0; i < all.length; i++) {
    const t = all[i]
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    let anyFront = false
    for (const c of t.corners) {
      const s = projectToScreen(mvp, c, w, h)
      if (s[2] > 0) anyFront = true
      minX = Math.min(minX, s[0])
      maxX = Math.max(maxX, s[0])
      minY = Math.min(minY, s[1])
      maxY = Math.max(maxY, s[1])
    }
    if (
      !anyFront ||
      maxX < -margin ||
      minX > w + margin ||
      maxY < -margin ||
      minY > h + margin
    ) {
      continue
    }
    const tm = level.tiles[t.row * level.columns + t.col]
    if (tm) state.slide.requestTile(level, tm)
    tiles.push(t)
  }
  return { level, tiles }
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
