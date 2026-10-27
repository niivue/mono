import { log } from '@/logger'
import type { ColorMap, LUT } from '@/NVTypes'

export function makeLut(
  Rs: number[],
  Gs: number[],
  Bs: number[],
  As: number[],
  Is: number[],
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4)
  for (let i = 0; i < Is.length - 1; i++) {
    const idxLo = Is[i] as number
    const idxHi = Is[i + 1] as number
    const idxRng = idxHi - idxLo
    let k = idxLo * 4
    for (let j = idxLo; j <= idxHi; j++) {
      const f = (j - idxLo) / idxRng
      const rLo = Rs[i] as number
      const rHi = Rs[i + 1] as number
      const gLo = Gs[i] as number
      const gHi = Gs[i + 1] as number
      const bLo = Bs[i] as number
      const bHi = Bs[i + 1] as number
      const aLo = As[i] as number
      const aHi = As[i + 1] as number
      lut[k++] = Math.round(rLo + f * (rHi - rLo))
      lut[k++] = Math.round(gLo + f * (gHi - gLo))
      lut[k++] = Math.round(bLo + f * (bHi - bLo))
      lut[k++] = Math.round(aLo + f * (aHi - aLo))
    }
  }
  return lut
}

// A loop, not Math.min(...ids): a generated palette can hold millions of IDs,
// past the argument limit of a spread call.
function idSpan(ids: ArrayLike<number>): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let k = 0; k < ids.length; k++) {
    if (ids[k] < lo) lo = ids[k]
    if (ids[k] > hi) hi = ids[k]
  }
  return [lo, hi]
}

export function makeLabelLut(
  cm: ColorMap,
  alphaFill = 255,
  maxIdx = Infinity,
): LUT {
  if (!cm.R || !cm.G || !cm.B) {
    throw new Error(`Invalid colormap table`)
  }
  const nLabels = cm.R.length
  const idxs = cm.I ?? [...Array(nLabels).keys()]
  let hasInvalid = false
  for (let i = 0; i < idxs.length; i++) {
    if (idxs[i] > maxIdx) {
      hasInvalid = true
      idxs[i] = maxIdx
    }
  }
  if (hasInvalid) {
    log.warn('Some colormap indices clamped to match label range.')
  }
  if (
    nLabels !== cm.G.length ||
    nLabels !== cm.B.length ||
    nLabels !== idxs.length
  ) {
    throw new Error(`colormap does not make sense`)
  }
  let As = new Uint8ClampedArray(nLabels).fill(alphaFill)
  // Make index-0 (background) transparent if present in the index array
  const zeroPos = idxs.indexOf(0)
  if (zeroPos >= 0) {
    As[zeroPos] = 0
  }
  if (cm.A !== undefined) {
    As = Uint8ClampedArray.from(cm.A)
  }
  const [mnIdx, mxIdx] = idSpan(idxs)
  const nLabelsDense = mxIdx - mnIdx + 1
  const lut = new Uint8ClampedArray(nLabelsDense * 4).fill(0)
  for (let i = 0; i < nLabels; i++) {
    let k = (idxs[i] - mnIdx) * 4
    lut[k++] = cm.R[i]
    lut[k++] = cm.G[i]
    lut[k++] = cm.B[i]
    lut[k++] = As[i]
  }
  const cmap: LUT = {
    lut,
    min: mnIdx,
    max: mxIdx,
  }
  if (cm.labels) {
    const nL = cm.labels.length
    if (nL === nLabelsDense) {
      // Copy to decouple the returned LUT from the caller's array; callers
      // that mutate their input should not mutate the cached LUT.
      cmap.labels = cm.labels.slice()
    } else if (nL === nLabels) {
      cmap.labels = Array(nLabelsDense).fill('?')
      for (let i = 0; i < nLabels; i++) {
        cmap.labels[idxs[i] - mnIdx] = cm.labels[i]
      }
    }
  }
  return cmap
}

/* --------------- auto-discover JSON LUTs --------------- */
/* This uses Vite's import.meta.glob with eager:true.
   If your environment doesn't transform import.meta.glob, use the manifest approach. */
type LutDef = {
  R: number[]
  G: number[]
  B: number[]
  A: number[]
  I: number[]
  labels?: string[]
  // Suggested display window, e.g. the Hounsfield range a CT colormap targets.
  min?: number
  max?: number
}
let _lutIndex: Map<string, LutDef> | null = null

function buildLutIndex(): Map<string, LutDef> {
  if (_lutIndex) return _lutIndex
  const map = new Map<string, LutDef>()
  try {
    // import all json files in ./lut at build/dev time (Vite)
    const modules = import.meta.glob<Record<string, unknown>>('./luts/*.json', {
      eager: true,
    })
    for (const path in modules) {
      // module is the parsed JSON object
      const mod = modules[path]
      // derive a friendly name from filename: './luts/cividis.json' -> 'Cividis'
      const base = path.replace(/^.*\/([^/]+)\.json$/i, '$1')
      const name = base.charAt(0).toUpperCase() + base.slice(1)
      // Guard: expect R,G,B,A,I arrays of numbers
      if (
        mod &&
        Array.isArray(mod.R) &&
        Array.isArray(mod.G) &&
        Array.isArray(mod.B) &&
        Array.isArray(mod.I)
      ) {
        const entry: LutDef = {
          R: (mod.R as number[]).map(Number),
          G: (mod.G as number[]).map(Number),
          B: (mod.B as number[]).map(Number),
          A: Array.isArray(mod.A)
            ? (mod.A as number[]).map(Number)
            : new Array((mod.I as number[]).length).fill(255),
          I: (mod.I as number[]).map(Number),
        }
        if (Array.isArray(mod.labels)) {
          entry.labels = (mod.labels as string[]).slice()
        }
        // Some LUTs carry min = max = 0, which means "no window".
        if (
          typeof mod.min === 'number' &&
          typeof mod.max === 'number' &&
          mod.min < mod.max
        ) {
          entry.min = mod.min
          entry.max = mod.max
        }
        map.set(name, entry)
      } else {
        // skip malformed JSON but keep dev-visible warning
        log.warn(`Skipping LUT ${path}: expected { R,G,B,I } arrays`)
      }
    }
  } catch (err) {
    log.warn(
      'LUT auto-discovery failed (import.meta.glob not available). Use a manifest or build-step to create ./luts/index.js',
      err,
    )
  }

  // `Random` is generated rather than read from JSON: labelLutFor() extends it
  // over a volume's full ID range. This 0..255 entry is what lists, drawings
  // and lookups see.
  map.set('Random', randomLabels(0, 255))
  _lutIndex = map
  return _lutIndex
}

/** A colormap is a label table when it carries a `labels` array (even empty). */
export type ColormapKind = 'continuous' | 'label'

/**
 * Registered colormap names, sorted. Both kinds unless `kind` narrows the list.
 */
export function colormapNames(kind?: ColormapKind): string[] {
  const map = buildLutIndex()
  return Array.from(map.entries())
    .filter(([, def]) => !kind || kindOf(def) === kind)
    .map(([name]) => name)
    .sort()
}

function kindOf(def: LutDef): ColormapKind {
  return Array.isArray(def.labels) ? 'label' : 'continuous'
}

/** Whether `name` resolves to a label colormap. Unknown names are not. */
export function isLabelColormap(name?: string): boolean {
  if (!name) return false
  const def = buildLutIndex().get(canonicalName(name))
  return !!def && kindOf(def) === 'label'
}

function canonicalName(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Colour for a label ID in the generated `Random` palette: a 32-bit integer
 * hash, so the same ID gets the same colour in every volume and session.
 * Channels stay in 64..255 so no label reads as background black.
 */
function idColor(id: number): [number, number, number] {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return [
    64 + ((h & 0xff) % 192),
    64 + (((h >>> 8) & 0xff) % 192),
    64 + (((h >>> 16) & 0xff) % 192),
  ]
}

// ponytail: caps the generated palette at what one LUT texture holds on the
// default WebGPU limit (256 wide x 8192 rows); wider ID ranges clamp.
const MAX_GENERATED_LABELS = 256 * 8192

/** The generated palette over IDs lo..hi; ID 0 is transparent. */
function randomLabels(lo: number, hi: number): LutDef {
  const I: number[] = []
  const R: number[] = []
  const G: number[] = []
  const B: number[] = []
  const A: number[] = []
  for (let id = lo; id <= hi; id++) {
    const [r, g, b] = idColor(id)
    I.push(id)
    R.push(r)
    G.push(g)
    B.push(b)
    A.push(id === 0 ? 0 : 255)
  }
  return { R, G, B, A, I, labels: [] }
}

/**
 * Whether `name` resolves to the generated `Random` palette (not a table a
 * caller registered under that name), whose LUT is sized to a value range.
 */
export function isGeneratedLabelColormap(name?: string): boolean {
  if (!name) return false
  const canonical = canonicalName(name)
  return canonical === 'Random' && !_revisions.has(canonical)
}

/**
 * The label LUT a volume shows for colormap `name`, or null when `name` is
 * continuous (or unknown). `range` is the volume's value range: the generated
 * `Random` palette spans it, and at least IDs 0..255, so every ID in the
 * volume (and any a segmentation adds up to 255) gets a colour, while a table
 * colormap is used as defined.
 */
export function labelLutFor(
  name: string | undefined,
  range: [number, number] = [0, 255],
): LUT | null {
  if (!name) return null
  const canonical = canonicalName(name)
  const def = buildLutIndex().get(canonical)
  if (!def || kindOf(def) !== 'label') return null
  if (isGeneratedLabelColormap(canonical)) {
    // A non-finite end (an all-NaN frame, an infinite fill value) is ignored.
    const finite = (v: number) => (Number.isFinite(v) ? v : 0)
    let lo = Math.floor(Math.min(finite(range[0]), 0))
    let hi = Math.ceil(Math.max(finite(range[1]), 255))
    if (hi - lo + 1 > MAX_GENERATED_LABELS) {
      log.warn(
        `Random: label range ${lo}..${hi} exceeds ${MAX_GENERATED_LABELS} IDs; IDs outside the kept span share its end colours.`,
      )
      // Drop the far negative IDs first (often a fill value), then the high
      // ones, so 0..255 always keeps its colours.
      lo = Math.max(lo, hi - MAX_GENERATED_LABELS + 1)
      if (lo > 0) [lo, hi] = [0, MAX_GENERATED_LABELS - 1]
    }
    return makeLabelLut(randomLabels(lo, hi) as unknown as ColorMap)
  }
  return makeLabelLut(def as unknown as ColorMap)
}

/**
 * The finite value range of `img` in calibrated units (`slope`/`inter`, a
 * missing slope meaning 1), or null when it holds no finite voxel. What the
 * generated label palette grows to.
 */
export function finiteLabelRange(
  img: ArrayLike<number>,
  slope: number,
  inter: number,
): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (let i = 0; i < img.length; i++) {
    const v = img[i]
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (lo > hi) return null
  const m = slope || 1
  const b = inter || 0
  return m < 0 ? [hi * m + b, lo * m + b] : [lo * m + b, hi * m + b]
}

/**
 * The generated palette's `lut` widened to cover `range` (it never shrinks),
 * or null when it already covers it or `name` is not the generated palette:
 * a table colormap colours the IDs it defines.
 */
export function grownLabelLut(
  name: string | undefined,
  lut: LUT | null | undefined,
  range: [number, number],
): LUT | null {
  if (!lut || !isGeneratedLabelColormap(name)) return null
  const min = lut.min ?? 0
  const max = lut.max ?? 0
  // A capped palette already spans as many IDs as it can.
  if (max - min + 1 >= MAX_GENERATED_LABELS) return null
  const [lo, hi] = range
  if (!(lo < min || hi > max)) return null
  return labelLutFor(name, [Math.min(lo, min), Math.max(hi, max)])
}

/**
 * Definitions of colormaps registered at runtime (`addColormap`), keyed by
 * canonical name. Built-in colormaps are not included: a saved document names
 * those and embeds these.
 */
export function customColormaps(): Record<string, ColorMap> {
  const map = buildLutIndex()
  // fromEntries defines own keys, so a name like `__proto__` survives.
  return Object.fromEntries(
    [..._revisions.keys()].map((name) => [name, map.get(name) as ColorMap]),
  )
}

/**
 * Register a colormap at runtime so it becomes visible to `lutrgba8()`,
 * `lookupColorMap()`, and `colormapNames()`. Names are canonicalized to
 * match the auto-discovered luts (first letter uppercased). Re-registering
 * an existing name replaces the entry and changes its {@link colormapKey}, so
 * cached colormap textures are rebuilt on the next update. `A` and `I` are derived when absent
 * (A defaults to opaque; I distributes stops evenly across 0..255 so the
 * LUT fills the full range instead of collapsing to the first N slots).
 *
 * A `labels` array (empty is fine) makes it a label table: `I` then defaults
 * to 0..n-1 and a single entry is allowed.
 *
 * @returns The canonical name under which the colormap was stored, so
 *   callers can emit events or round-trip the value without re-applying
 *   the same casing rule.
 * @throws If `R`/`G`/`B` are empty, a single stop, or if any caller-
 *   supplied `A`/`I` disagree in length.
 */
export function addColormap(
  name: string,
  cmap: Pick<ColorMap, 'R' | 'G' | 'B'> &
    Partial<Pick<ColorMap, 'A' | 'I' | 'labels'>>,
): string {
  const R = cmap.R.map(Number)
  const G = cmap.G.map(Number)
  const B = cmap.B.map(Number)
  const isLabel = Array.isArray(cmap.labels)
  // A ramp needs two stops to interpolate between; a label table may hold one.
  if (
    R.length < (isLabel ? 1 : 2) ||
    G.length !== R.length ||
    B.length !== R.length
  ) {
    throw new Error(
      `addColormap('${name}'): R, G, B must all be the same length and have at least ${isLabel ? 1 : 2} entries`,
    )
  }
  const I = Array.isArray(cmap.I)
    ? cmap.I.map(Number)
    : isLabel
      ? R.map((_, i) => i)
      : // Distribute N stops evenly over [0..255] so a 3-stop R/G/B-only cmap
        // spans the full LUT instead of leaving 253 pixels transparent.
        R.map((_, i) => Math.round((i * 255) / (R.length - 1)))
  if (I.length !== R.length) {
    throw new Error(
      `addColormap('${name}'): I length (${I.length}) must equal R length (${R.length})`,
    )
  }
  // A label table's ID 0 is background, transparent as in every shipped table.
  const A = Array.isArray(cmap.A)
    ? cmap.A.map(Number)
    : I.map((i) => (isLabel && i === 0 ? 0 : 255))
  if (A.length !== I.length) {
    throw new Error(
      `addColormap('${name}'): A length (${A.length}) must equal I length (${I.length})`,
    )
  }
  // A label LUT is dense over min..max, so a few entries could ask for GBs.
  if (isLabel) {
    const [lo, hi] = idSpan(I)
    // Negated so an all-NaN `I` (lo > hi) is rejected too.
    if (!(hi - lo + 1 <= MAX_GENERATED_LABELS && hi >= lo))
      throw new Error(
        `addColormap('${name}'): label IDs ${lo}..${hi} span more than ${MAX_GENERATED_LABELS}`,
      )
  }
  const canonical = canonicalName(name)
  const map = buildLutIndex()
  const entry: LutDef = { R, G, B, A, I }
  if (Array.isArray(cmap.labels)) entry.labels = cmap.labels.slice()
  map.set(canonical, entry)
  _revisions.set(canonical, (_revisions.get(canonical) ?? 0) + 1)
  return canonical
}

// How many times each canonical name has been (re)registered by addColormap.
const _revisions = new Map<string, number>()

/**
 * A cache key for the colormap a name currently resolves to: the name plus how
 * many times `addColormap` has registered it. Caches of colormap textures key
 * on this rather than the bare name, so re-registering a name with new colors
 * invalidates them. `undefined` (no colormap) gives `''`.
 */
export function colormapKey(name?: string): string {
  if (!name) return ''
  const canonical = name.charAt(0).toUpperCase() + name.slice(1)
  return `${name}#${_revisions.get(canonical) ?? 0}`
}

/** Whether a drawing can use `name`: a label colormap with IDs 0..255. */
export function isDrawingColormap(name: string): boolean {
  const def = buildLutIndex().get(canonicalName(name))
  return !!def && isDrawingDef(def)
}

function isDrawingDef(def: LutDef): boolean {
  return kindOf(def) === 'label' && def.I.every((i) => i >= 0 && i <= 255)
}

/** Label colormaps a drawing can use: its bitmap holds IDs 0..255. */
export function drawingColormapNames(): string[] {
  const map = buildLutIndex()
  return Array.from(map.entries())
    .filter(([, def]) => isDrawingDef(def))
    .map(([name]) => name)
    .sort()
}

export function lookupColorMap(name: string): ColorMap | null {
  const def = buildLutIndex().get(canonicalName(name))
  if (!def) return null
  return def as unknown as ColorMap
}

/**
 * Reverse the colors of a 256-entry RGBA LUT, so the hue that was at the top of
 * the range moves to the bottom. Returns a new array; the input is untouched.
 *
 * Alpha stays at its own index rather than travelling with its color. The
 * shaders lean on a colormap being transparent at index 0 to hide voxels below
 * `calMin`, so carrying a ramped alpha to the other end would paint the whole
 * volume opaque the moment a statistical overlay was inverted.
 */
export function invertLut(lut: Uint8ClampedArray): Uint8ClampedArray {
  const n = Math.floor(lut.length / 4)
  const out = new Uint8ClampedArray(lut.length)
  for (let i = 0; i < n; i++) {
    const src = (n - 1 - i) * 4
    const dst = i * 4
    out[dst] = lut[src]
    out[dst + 1] = lut[src + 1]
    out[dst + 2] = lut[src + 2]
    out[dst + 3] = lut[dst + 3]
  }
  return out
}

export function lutrgba8(lutName?: string, invert = false): Uint8ClampedArray {
  const lut = buildLutRgba8(lutName)
  return invert ? invertLut(lut) : lut
}

function buildLutRgba8(lutName?: string): Uint8ClampedArray {
  const map = buildLutIndex()
  if (!lutName) {
    // unknown -> gray fallback
    return makeLut([0, 255], [0, 255], [0, 255], [0, 128], [0, 255])
  }
  const canonical = lutName.charAt(0).toUpperCase() + lutName.slice(1)
  const def = map.get(canonical)
  if (!def) {
    if (canonical !== 'Gray') {
      log.warn(`Unknown colormap "${lutName}", using Gray fallback`)
    }
    return makeLut([0, 255], [0, 255], [0, 255], [0, 128], [0, 255])
  }
  // Build LUT (ensure arrays are the expected length)
  const { R, G, B, A, I } = def
  // Ensure A and I are present; makeLut expects As and Is to match lengths
  const As = A && A.length === I.length ? A : new Array(I.length).fill(255)
  return makeLut(R, G, B, As, I)
}
