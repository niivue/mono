/**
 * CPU side of VOLUME_RENDER_MODE.CINEMATIC, shared by both backends: transfer
 * function bake, label materials, label dilation, intensity calibration, clip
 * planes, light and uniform packing. No GPU calls, so it is unit-tested.
 */
import { mat4 } from 'gl-matrix'
import { colormapKey, lookupColorMap } from '@/cmap/NVCmaps'
import { invGamma, isPaqd } from '@/NVConstants'
import type { CinematicOptions, ColorMap, NVImage } from '@/NVTypes'
import { getImageDataRAS } from '@/volume/utils'
import { drawnOpacity } from './NVVolumeVisibility'

/** Transfer function table: intensity (x) by sqrt-spaced gradient magnitude (y). */
export const TF_W = 256
export const TF_H = 64
/** Material id of a hidden label; so at most 254 labels. */
export const HIDDEN_LABEL = 255
/** Material table width in RGBA32F texels: two per label id. */
export const MATERIAL_TEXELS = 512
/** March uniform size in floats (see packMarchParams and cinematic.wgsl Params). */
export const MARCH_PARAM_FLOATS = 136
/** Display uniform size in floats (see packDisplayParams). */
export const DISPLAY_PARAM_FLOATS = 16
export const EXT_PARAM_FLOATS = 24
/** Empty-space skip reads this extinction mip (4 extinction voxels per texel). */
const SKIP_LOD = 2
// A plain label table has no surface ramp: always on, i.e. label-shaped.
// f32-exact so lo < hi survives upload.
const ALWAYS_ON_RAMP = [-1e6, -1e6 + 1]

export type BakedTransferFunction = {
  /** RGBA8, TF_W x TF_H. */
  color: Uint8Array
  /** RG8 (specular, surfaceness), TF_W x TF_H. */
  material: Uint8Array
  /** R8, TF_W: the most opaque an intensity gets at any gradient. */
  maxAlpha: Uint8Array
  huMin: number
  huMax: number
  gMax: number
  shininess: number
  labelBlend: number
}

function interpNodes(
  I: number[],
  V: number[] | undefined,
  fallback: number,
): Float32Array {
  const out = new Float32Array(TF_W)
  if (!V) return out.fill(fallback)
  for (let x = 0; x < TF_W; x++) {
    let k = 0
    while (k < I.length - 2 && x > I[k + 1]) k++
    const span = I[k + 1] - I[k]
    const f = span > 0 ? Math.min(Math.max((x - I[k]) / span, 0), 1) : 0
    out[x] = V[k] + f * (V[k + 1] - V[k])
  }
  return out
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * Bake a colormap, with its optional cinematic keys (`E`, `S`, `gradient`,
 * `gMax`, `shininess`, `labelBlend`; see ColorMap), into 2D tables mapped
 * across [huMin, huMax]. A plain colormap works unchanged: `A` is the alpha.
 * Row y holds gradient magnitude (y / (TF_H - 1))^2 * gMax, matching tfUV().
 */
export function bakeTransferFunction(
  cmap: ColorMap,
  huMin: number,
  huMax: number,
): BakedTransferFunction {
  const I =
    cmap.I ?? cmap.R.map((_, i) => Math.round((i * 255) / (cmap.R.length - 1)))
  const [R, G, B, A] = [cmap.R, cmap.G, cmap.B, cmap.A].map((v) =>
    interpNodes(I, v, 255),
  )
  const E = cmap.E ? interpNodes(I, cmap.E, 0) : A
  const S = interpNodes(I, cmap.S, 0)
  const gLo = cmap.gradient?.lo ?? 20
  const gHi = cmap.gradient?.hi ?? 200
  const gMax = cmap.gMax ?? 1000
  const color = new Uint8Array(TF_W * TF_H * 4)
  const material = new Uint8Array(TF_W * TF_H * 2)
  const maxAlpha = new Uint8Array(TF_W)
  for (let y = 0; y < TF_H; y++) {
    const g = (y / (TF_H - 1)) ** 2 * gMax
    const surf = smoothstep(gLo, gHi, g)
    for (let x = 0; x < TF_W; x++) {
      const a = A[x] + surf * (E[x] - A[x])
      color.set([R[x], G[x], B[x], a], (y * TF_W + x) * 4)
      material.set([S[x] * surf, surf * 255], (y * TF_W + x) * 2)
      maxAlpha[x] = Math.max(maxAlpha[x], Math.ceil(a))
    }
  }
  return {
    color,
    material,
    maxAlpha,
    huMin,
    huMax,
    gMax,
    shininess: cmap.shininess ?? 40,
    labelBlend: cmap.labelBlend ?? 0,
  }
}

/**
 * Material table from a label colormap: per label id, two RGBA texels (rgb +
 * opacity; surface ramp lo/hi, specular, surfaceness floor). Hidden labels get
 * opacity 0. `isVisible[id]` is 1 for labels drawn at all.
 */
export function labelMaterials(
  table: ColorMap,
  hidden: readonly number[] = [],
): { materials: Float32Array; isVisible: Uint8Array } {
  const materials = new Float32Array(MATERIAL_TEXELS * 4)
  const isVisible = new Uint8Array(256)
  const hiddenSet = new Set(hidden)
  for (let i = 0; i < table.R.length; i++) {
    const k = table.I?.[i] ?? i
    if (k < 1 || k >= HIDDEN_LABEL) continue
    const opacity = hiddenSet.has(k) ? 0 : (table.A?.[i] ?? 255) / 255
    materials.set(
      [table.R[i] / 255, table.G[i] / 255, table.B[i] / 255, opacity],
      k * 8,
    )
    const lo = table.lo?.[i] ?? ALWAYS_ON_RAMP[0]
    const hi = table.hi?.[i] ?? ALWAYS_ON_RAMP[1]
    const specular = (table.S?.[i] ?? 0) / 255
    const surface = (table.surface?.[i] ?? 0) / 255
    materials.set([lo, hi, specular, surface], k * 8 + 4)
    isVisible[k] = opacity > 0 ? 1 : 0
  }
  return { materials, isVisible }
}

/**
 * Material id per voxel: a visible label spreads one voxel (6-neighbours)
 * into unlabeled or hidden neighbours, so a structure's surface comes from
 * the intensity ramp across its partial-volume voxels rather than stopping at
 * the categorical label boundary. Hidden labels left over become HIDDEN_LABEL.
 */
export function dilateLabels(
  src: Uint8Array,
  dims: readonly [number, number, number],
  isVisible: Uint8Array,
): Uint8Array {
  const [nx, ny, nz] = dims
  const sz = nx * ny
  const out = new Uint8Array(src.length)
  // First visible neighbour wins; each test skips the face the voxel is on.
  const spread = (i: number, x: number, y: number, z: number): number => {
    if (x < nx - 1 && isVisible[src[i + 1]]) return src[i + 1]
    if (x > 0 && isVisible[src[i - 1]]) return src[i - 1]
    if (y < ny - 1 && isVisible[src[i + nx]]) return src[i + nx]
    if (y > 0 && isVisible[src[i - nx]]) return src[i - nx]
    if (z < nz - 1 && isVisible[src[i + sz]]) return src[i + sz]
    if (z > 0 && isVisible[src[i - sz]]) return src[i - sz]
    return 0
  }
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const l = src[i]
        if (isVisible[l]) {
          out[i] = l
          continue
        }
        out[i] = spread(i, x, y, z) || (l === 0 ? 0 : HIDDEN_LABEL)
      }
    }
  }
  return out
}

/**
 * Intensity calibration for uncalibrated images (MRI): maps the median inside
 * each listed label set to its target, piecewise linearly, extrapolating the
 * end segments. e.g. [[[CSF], 0], [[GM], 100], [[WM], 200]]. Null when fewer
 * than two label sets have voxels.
 */
export function calibrationMap(
  img: ArrayLike<number>,
  labelIds: Uint8Array,
  pairs: readonly (readonly [readonly number[], number])[],
): ((v: number) => number) | null {
  const points = pairs
    .map(([ids, target]) => {
      const values: number[] = []
      // Every 7th voxel is plenty for a median.
      for (let i = 0; i < img.length; i += 7) {
        if (ids.includes(labelIds[i])) values.push(img[i])
      }
      values.sort((a, b) => a - b)
      return [values[values.length >> 1], target]
    })
    .filter(([median]) => Number.isFinite(median))
    .sort((a, b) => a[0] - b[0])
  if (points.length < 2) return null
  return (v: number) => {
    let k = 0
    while (k < points.length - 2 && v > points[k + 1][0]) k++
    const [[x0, y0], [x1, y1]] = [points[k], points[k + 1]]
    // Equal medians give no slope: hold the lower target.
    return x1 === x0 ? y0 : y0 + ((v - x0) * (y1 - y0)) / (x1 - x0)
  }
}

/** Scaled intensities (scl_slope/scl_inter applied); NIfTI slope 0 means 1. */
function scaledIntensities(
  raw: ArrayLike<number>,
  slope: number,
  inter: number,
): Float32Array {
  const s = Number.isFinite(slope) && slope !== 0 ? slope : 1
  const b = Number.isFinite(inter) ? inter : 0
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw[i] * s + b
  return out
}

export type CinematicGeometry = {
  dims: [number, number, number]
  mm2frac: mat4
  /** Upper 3x3: d(intensity)/d(voxel) in RAS texture axes -> per mm. */
  gradToMM: mat4
  /** Smallest voxel edge, mm. */
  voxelMM: number
}

export function cinematicGeometry(
  frac2mm: mat4,
  dims: [number, number, number],
): CinematicGeometry {
  const mm2frac = mat4.invert(mat4.create(), frac2mm) ?? mat4.create()
  // grad_mm = L^T * diag(dims) * grad_vox, L = linear part of mm2frac.
  const gradToMM = mat4.create()
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      gradToMM[c * 4 + r] = mm2frac[r * 4 + c] * dims[c]
    }
  }
  const voxelMM = Math.min(
    ...[0, 1, 2].map(
      (a) =>
        Math.hypot(frac2mm[a * 4], frac2mm[a * 4 + 1], frac2mm[a * 4 + 2]) /
        dims[a],
    ),
  )
  return { dims, mm2frac, gradToMM, voxelMM }
}

/**
 * NiiVue clip planes (flat [nx, ny, nz, depth] x 6, |depth| > 1 = off) keep
 * dot(n, p - 0.5) - depth >= 0 with p in texture space. Rescale each active
 * plane so dot(n', p) - d' is the distance in mm. Layout: 6 planes, 6 unit
 * mm-space normals, then (count, cutaway, 0, 0).
 */
export function clipParams(
  planes: ArrayLike<number>,
  isCutaway: boolean,
  mm2frac: mat4,
): Float32Array {
  const L = mm2frac
  const out = new Float32Array(52)
  let count = 0
  for (let i = 0; i + 3 < planes.length && count < 6; i += 4) {
    const nx = planes[i]
    const ny = planes[i + 1]
    const nz = planes[i + 2]
    const depth = planes[i + 3]
    if (!(Math.abs(depth) <= 1) || nx * nx + ny * ny + nz * nz < 1e-12) continue
    // L^T n: the plane's gradient in mm, so its length converts frac to mm.
    const g = [0, 1, 2].map(
      (c) => L[c * 4] * nx + L[c * 4 + 1] * ny + L[c * 4 + 2] * nz,
    )
    const len = Math.hypot(g[0], g[1], g[2])
    const d = (depth + 0.5 * (nx + ny + nz)) / len
    out.set([nx / len, ny / len, nz / len, d], count * 4)
    out.set([g[0] / len, g[1] / len, g[2] / len, 0], 24 + count * 4)
    count++
  }
  out.set([count, isCutaway ? 1 : 0, 0, 0], 48)
  return out
}

/**
 * Direction toward the light in world (mm) space. The light is fixed to the
 * camera: its view-space direction is rotated by the transpose of the model
 * rotation.
 */
export function lightVector(
  model: ArrayLike<number>,
  elevationDeg: number,
  azimuthDeg: number,
): [number, number, number] {
  const le = (elevationDeg * Math.PI) / 180
  const la = (azimuthDeg * Math.PI) / 180
  const v = [
    Math.sin(la) * Math.cos(le),
    Math.sin(le),
    Math.cos(la) * Math.cos(le),
  ]
  const m = model
  const w = [0, 1, 2].map(
    (i) => m[i * 4] * v[0] + m[i * 4 + 1] * v[1] + m[i * 4 + 2] * v[2],
  )
  const len = Math.hypot(w[0], w[1], w[2]) || 1
  return [w[0] / len, w[1] / len, w[2] / len]
}

const tanDeg = (deg: number): number => Math.tan((deg * Math.PI) / 180)

/** Uniforms of one march dispatch; the layout of cinematic.wgsl `Params`. */
export function packMarchParams(p: {
  geometry: CinematicGeometry
  invMVP: ArrayLike<number>
  model: ArrayLike<number>
  width: number
  height: number
  frame: number
  options: CinematicOptions
  tf: BakedTransferFunction
  clip: Float32Array
  labelInfo: readonly number[]
  overlayInfo: readonly number[]
}): Float32Array {
  const s = p.options
  const { geometry: geo, tf } = p
  const extVoxelMM = 2 * geo.voxelMM
  const out = new Float32Array(MARCH_PARAM_FLOATS)
  out.set(geo.mm2frac, 0)
  out.set(geo.gradToMM, 16)
  out.set(p.invMVP, 32)
  out.set([p.width, p.height, s.volumetricDiffuse, s.specular], 48)
  out.set(
    [
      ...lightVector(p.model, s.lightElevation, s.lightAzimuth),
      tanDeg(s.lightConeDeg),
    ],
    52,
  )
  out.set([tf.huMin, tf.huMax, tf.gMax, geo.voxelMM], 56)
  out.set([s.stepVoxels * geo.voxelMM, p.frame, s.shadow, s.ambient], 60)
  out.set([s.ao, s.aoRadiusMM, s.lightIntensity, tf.shininess], 64)
  // A trilinear zero at SKIP_LOD guarantees half a texel of empty space ahead.
  out.set(
    [
      extVoxelMM,
      SKIP_LOD,
      0.5 * extVoxelMM * 2 ** SKIP_LOD,
      tanDeg(s.aoConeDeg),
    ],
    68,
  )
  out.set(p.clip, 72)
  out.set(p.labelInfo, 124)
  out.set(p.overlayInfo, 128)
  out.set([s.isStochasticLighting ? 1 : 0, 0, 0, 0], 132)
  return out
}

/** Uniforms of the extinction prep pass; the layout of `ExtParams`. */
export function packExtinctionParams(
  geometry: CinematicGeometry,
  tf: BakedTransferFunction,
  labelInfo: readonly number[],
): Float32Array {
  const out = new Float32Array(EXT_PARAM_FLOATS)
  out.set(geometry.gradToMM, 0)
  out.set([tf.huMin, tf.huMax, tf.gMax, geometry.voxelMM], 16)
  out.set(labelInfo, 20)
  return out
}

/**
 * Uniforms of the display pass: tile size and origin (device px), frames
 * accumulated, exposure, background colour.
 */
export function packDisplayParams(
  ltwh: readonly number[],
  frames: number,
  exposure: number,
  background: ArrayLike<number>,
): Float32Array {
  const out = new Float32Array(DISPLAY_PARAM_FLOATS)
  out.set([ltwh[2], ltwh[3], frames, exposure], 0)
  out.set([background[0], background[1], background[2], background[3]], 4)
  out.set([ltwh[0], ltwh[1], 0, 0], 8)
  return out
}

const TIMED_FRAMES = 10

/**
 * GPU time of the march, summed over tiles: the mean of the first
 * `TIMED_FRAMES` frames after any tile restarts. Results arrive frames late,
 * so each carries the generation it was measured in.
 */
export class CinematicFrameTimer {
  private samples: number[] = []
  generation = 0

  restart(): void {
    this.samples = []
    this.generation++
  }

  add(ms: number, generation: number): void {
    if (generation === this.generation && this.samples.length < TIMED_FRAMES)
      this.samples.push(ms)
  }

  /** Null until `TIMED_FRAMES` samples, or until convergence cut them short. */
  meanMs(isRefining: boolean): number | null {
    const n = this.samples.length
    if (n === 0 || (n < TIMED_FRAMES && isRefining)) return null
    return this.samples.reduce((a, b) => a + b, 0) / n
  }
}

/** `vol` viewed at its displayed 4D frame (getImageDataRAS reads frame 0). */
function frameOf(vol: NVImage): NVImage {
  const n = vol.nVox3D
  if (!vol.frame4D || !n || !vol.img) return vol
  const start = vol.frame4D * n
  return { ...vol, img: vol.img.subarray(start, start + n) } as NVImage
}

/** Half-float bits; hand-rounded where Float16Array is missing (pre-2025). */
export function halfFloatBits(f: Float32Array): Uint16Array {
  if (typeof Float16Array !== 'undefined')
    return new Uint16Array(new Float16Array(f).buffer)
  const out = new Uint16Array(f.length)
  const u = new Uint32Array(f.buffer, f.byteOffset, f.length)
  for (let i = 0; i < f.length; i++) {
    const x = u[i]
    const sign = (x >>> 16) & 0x8000
    const e = ((x >>> 23) & 0xff) - 112
    const m = x & 0x7fffff
    if (e >= 31) out[i] = sign | (e === 143 && m ? 0x7e00 : 0x7c00)
    else if (e > 0) {
      // Round to nearest; a mantissa carry correctly bumps the exponent.
      out[i] = sign | ((e << 10) + (m >> 13) + ((m >> 12) & 1))
    } else if (e > -11) {
      const mm = m | 0x800000
      const shift = 14 - e
      out[i] = sign | ((mm >> shift) + ((mm >> (shift - 1)) & 1))
    } else out[i] = sign
  }
  return out
}

/** Per-tile inputs from a view's tile loop. */
export type CinematicTileInput = {
  index: number
  /** Tile rect in device px: [x, y, w, h], origin as the backend's viewport. */
  rect: readonly number[]
  mvp: ArrayLike<number>
  /** Model (rotation) matrix of the same camera, for the light. */
  model: ArrayLike<number>
  clipPlanes: ArrayLike<number>
  isClipCutaway: boolean
  clipPlaneOverlay: boolean
  /** False when the background is hidden: only overlays are marched. */
  isBackgroundVisible: boolean
  gamma: number
  isOverlayOpacityCorrected: boolean
  background: ArrayLike<number>
}

/** Accumulation restarts when this key changes. */
export function tileKey(optionsKey: string, t: CinematicTileInput): string {
  return [
    optionsKey,
    Array.from(t.rect).join(),
    Array.from(t.mvp).join(),
    Array.from(t.clipPlanes).join(),
    t.isClipCutaway,
    t.clipPlaneOverlay,
    t.isBackgroundVisible,
    t.gamma,
    t.isOverlayOpacityCorrected,
    Array.from(t.background).join(),
  ].join('|')
}

export function tileMarchParams(
  t: CinematicTileInput,
  frame: number,
  geometry: CinematicGeometry,
  tf: BakedTransferFunction,
  options: CinematicOptions,
  labelInfo: readonly number[],
  hasOverlay: boolean,
): Float32Array {
  return packMarchParams({
    geometry,
    invMVP: mat4.invert(mat4.create(), t.mvp as mat4) ?? mat4.create(),
    model: t.model,
    width: Math.max(1, Math.round(t.rect[2])),
    height: Math.max(1, Math.round(t.rect[3])),
    frame,
    options,
    tf,
    clip: clipParams(t.clipPlanes, t.isClipCutaway, geometry.mm2frac),
    labelInfo: [...labelInfo.slice(0, 3), t.isBackgroundVisible ? 1 : 0],
    overlayInfo: [
      hasOverlay ? 1 : 0,
      t.clipPlaneOverlay ? 1 : 0,
      invGamma(t.gamma),
      t.isOverlayOpacityCorrected ? 1 : 0,
    ],
  })
}

/**
 * The label volume cinematic draws: the first volume after volumes[0] with a
 * label colormap that is drawn and shares volumes[0]'s grid.
 */
export function findLabelVolume(volumes: readonly NVImage[]): NVImage | null {
  const base = volumes[0]
  if (!base?.dimsRAS || !base.frac2mm) return null
  for (let i = 1; i < volumes.length; i++) {
    const v = volumes[i]
    if (!v.colormapLabel || drawnOpacity(v) <= 0) continue
    if (!v.dimsRAS || !v.frac2mm) continue
    const sameDims = [1, 2, 3].every(
      (d) => v.dimsRAS?.[d] === base.dimsRAS?.[d],
    )
    const frac2mm = v.frac2mm
    const sameMM = Array.from(base.frac2mm).every(
      (x, k) => Math.abs(x - frac2mm[k]) < 1e-3,
    )
    if (sameDims && sameMM) return v
  }
  return null
}

/** The standard overlay texture may be borrowed only without label, PAQD or streamed layers (PAQD lives in its own texture). */
export function canUseCinematicOverlays(volumes: readonly NVImage[]): boolean {
  return volumes
    .slice(1)
    .every(
      (v) =>
        drawnOpacity(v) <= 0 ||
        (!v.colormapLabel && !isPaqd(v.hdr) && !v.chunkPlan && !v.chunkSource),
    )
}

const sameKey = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])

/** Intensity volume to upload: scaled (and calibrated) values in RAS order. */
export type CinematicIntensity = {
  /** IEEE half-float bits (r16float / HALF_FLOAT). */
  values: Uint16Array
  geometry: CinematicGeometry
}

/** Labels to upload: dilated material ids, materials and label flags. */
export type CinematicLabels = {
  /** Null when labels are off: bind a 1x1x1 zero texture. */
  ids: Uint8Array | null
  materials: Float32Array
  /** (labels on, unlabeled tissue scale, label colour blend, 0). */
  info: [number, number, number, number]
}

/** What changed since the last update; null fields are unchanged. */
export type CinematicUpdate = {
  intensity: CinematicIntensity | null
  tf: BakedTransferFunction | null
  labels: CinematicLabels | null
  /** Bumps on any change, so a tile restarts its accumulation. */
  version: number
}

/**
 * Derived CPU data of the cinematic scene, rebuilt only when its inputs'
 * version tokens change: volume `_dataVersion`, `colormapKey`, calMin/calMax,
 * label volume identity, `_dataVersion` and `hiddenLabels`, label mode.
 * One per view (both backends); `update` returns what to upload.
 */
export class CinematicCpuCache {
  version = 0
  /** Why the labels are not used, once per cause; read by the view's warn. */
  labelProblem = ''
  private _intensityKey: unknown[] = []
  private _tfKey: unknown[] = []
  private _labelKey: unknown[] = []
  private _rawLabelKey: unknown[] = []
  private _rawLabels: Uint8Array | null = null
  private _geometry: CinematicGeometry | null = null
  private _calibration: ((v: number) => number) | null = null
  private _labelBlend = 0

  /** Label ids of `labelVol` in RAS order, or null when not 0..254. */
  private _labelIds(labelVol: NVImage | null): Uint8Array | null {
    const key = [labelVol, labelVol?._dataVersion ?? 0, labelVol?.frame4D]
    if (sameKey(key, this._rawLabelKey)) return this._rawLabels
    this._rawLabelKey = key
    this._rawLabels = null
    this.labelProblem = ''
    if (!labelVol) return null
    const raw = getImageDataRAS(frameOf(labelVol))
    if (!raw) return null
    const scaled = scaledIntensities(
      raw,
      labelVol.hdr?.scl_slope ?? 1,
      labelVol.hdr?.scl_inter ?? 0,
    )
    const ids = new Uint8Array(scaled.length)
    for (let i = 0; i < scaled.length; i++) {
      const v = Math.round(scaled[i])
      if (!(v >= 0 && v < HIDDEN_LABEL)) {
        this.labelProblem = 'label values must be 0-254'
        return null
      }
      ids[i] = v
    }
    this._rawLabels = ids
    return ids
  }

  /** Null when `vol` has no voxel data (nothing to draw). */
  update(
    vol: NVImage,
    labelVol: NVImage | null,
    options: CinematicOptions,
  ): CinematicUpdate | null {
    if (!vol.dimsRAS || !vol.frac2mm) return null
    const labelCmap = labelVol?.colormap
      ? lookupColorMap(labelVol.colormap)
      : null
    const out: CinematicUpdate = {
      intensity: null,
      tf: null,
      labels: null,
      version: this.version,
    }
    const intensityKey = [
      vol,
      vol._dataVersion ?? 0,
      vol.frame4D,
      labelVol,
      labelVol?._dataVersion ?? 0,
      labelVol?.frame4D,
      labelCmap?.normalize,
    ]
    if (!sameKey(intensityKey, this._intensityKey)) {
      const raw = getImageDataRAS(frameOf(vol))
      if (!raw) return null
      this._intensityKey = intensityKey
      const dims: [number, number, number] = [
        vol.dimsRAS[1],
        vol.dimsRAS[2],
        vol.dimsRAS[3],
      ]
      const img = scaledIntensities(
        raw,
        vol.hdr?.scl_slope ?? 1,
        vol.hdr?.scl_inter ?? 0,
      )
      const ids = this._labelIds(labelVol)
      this._calibration =
        ids && labelCmap?.normalize
          ? calibrationMap(img, ids, labelCmap.normalize)
          : null
      const map = this._calibration
      if (map) for (let i = 0; i < img.length; i++) img[i] = map(img[i])
      this._geometry = cinematicGeometry(vol.frac2mm, dims)
      out.intensity = {
        values: halfFloatBits(img),
        geometry: this._geometry,
      }
      // Window (calibration) and label ids (grid) follow the intensities.
      this._tfKey = []
      this._labelKey = []
    }
    const cmap =
      lookupColorMap(vol.colormap ?? 'gray') ?? lookupColorMap('gray')
    const tfKey = [colormapKey(vol.colormap), vol.calMin, vol.calMax]
    if (cmap && !sameKey(tfKey, this._tfKey)) {
      this._tfKey = tfKey
      // Calibrated intensities are in the calibration's units: the window is
      // the colormap's own (falling back to the calibrated calMin..calMax).
      const map = this._calibration
      const [lo, hi] = map
        ? cmap.min !== undefined && cmap.max !== undefined
          ? [cmap.min, cmap.max]
          : [map(vol.calMin), map(vol.calMax)]
        : [vol.calMin, vol.calMax]
      out.tf = bakeTransferFunction(cmap, lo, hi)
      if (out.tf.labelBlend !== this._labelBlend) this._labelKey = []
      this._labelBlend = out.tf.labelBlend
    }
    const isLabelOn = options.labelMode !== 'none' && !!labelVol && !!labelCmap
    const labelKey = [
      isLabelOn,
      options.labelMode,
      labelVol,
      labelVol?._dataVersion ?? 0,
      labelVol?.frame4D,
      labelVol ? colormapKey(labelVol.colormap) : '',
      labelVol?.hiddenLabels?.join(),
    ]
    if (!sameKey(labelKey, this._labelKey)) {
      this._labelKey = labelKey
      const ids = isLabelOn ? this._labelIds(labelVol) : null
      const unlabeledScale = options.labelMode === 'only' ? 0 : 1
      if (ids && labelCmap && this._geometry) {
        const { materials, isVisible } = labelMaterials(
          labelCmap,
          labelVol?.hiddenLabels,
        )
        out.labels = {
          ids: dilateLabels(ids, this._geometry.dims, isVisible),
          materials,
          info: [1, unlabeledScale, this._labelBlend, 0],
        }
      } else {
        out.labels = {
          ids: null,
          materials: new Float32Array(MATERIAL_TEXELS * 4),
          info: [0, unlabeledScale, this._labelBlend, 0],
        }
      }
    }
    if (out.intensity || out.tf || out.labels) out.version = ++this.version
    return out
  }
}
