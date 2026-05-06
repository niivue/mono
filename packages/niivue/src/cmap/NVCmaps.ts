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

export function makeLabelLut(
  cm: ColorMap,
  alphaFill = 255,
  maxIdx = Infinity,
): LUT {
  if (!cm.R || !cm.G || !cm.B) {
    throw new Error(`Invalid colormap table`)
  }
  const nLabels = cm.R.length
  // Copy `cm.I` so out-of-range clamping below can't mutate the caller's
  // colormap. Reusing the same const ColorMap across multiple calls would
  // otherwise see its `I` field clamped on every invocation.
  const idxs = cm.I ? cm.I.slice() : [...Array(nLabels).keys()]
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
  const mnIdx = Math.min(...idxs)
  const mxIdx = Math.max(...idxs)
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

  _lutIndex = map
  return _lutIndex
}

export function colormapNames(): string[] {
  const map = buildLutIndex()
  return Array.from(map.keys())
    .filter((n) => !n.startsWith('_'))
    .sort()
}

/**
 * Register a colormap at runtime so it becomes visible to `lutrgba8()`,
 * `lookupColorMap()`, and `colormapNames()`. Names are canonicalized to
 * match the auto-discovered luts (first letter uppercased). Re-registering
 * an existing name replaces the entry. `A` and `I` are derived when absent
 * (A defaults to opaque; I distributes stops evenly across 0..255 so the
 * LUT fills the full range instead of collapsing to the first N slots).
 *
 * For `labels` / `min` / `max` use `setColormapLabel()` — those are per-volume
 * concerns tied to atlas indices, not the shared LUT index.
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
  if (R.length < 2 || G.length !== R.length || B.length !== R.length) {
    throw new Error(
      `addColormap('${name}'): R, G, B must all be the same length and have at least 2 stops`,
    )
  }
  const I = Array.isArray(cmap.I)
    ? cmap.I.map(Number)
    : // Distribute N stops evenly over [0..255] so a 3-stop R/G/B-only cmap
      // spans the full LUT instead of leaving 253 pixels transparent.
      R.map((_, i) => Math.round((i * 255) / (R.length - 1)))
  if (I.length !== R.length) {
    throw new Error(
      `addColormap('${name}'): I length (${I.length}) must equal R length (${R.length})`,
    )
  }
  const A = Array.isArray(cmap.A)
    ? cmap.A.map(Number)
    : new Array(I.length).fill(255)
  if (A.length !== I.length) {
    throw new Error(
      `addColormap('${name}'): A length (${A.length}) must equal I length (${I.length})`,
    )
  }
  const canonical = name.charAt(0).toUpperCase() + name.slice(1)
  const map = buildLutIndex()
  const entry: LutDef = { R, G, B, A, I }
  if (Array.isArray(cmap.labels)) entry.labels = cmap.labels.slice()
  map.set(canonical, entry)
  return canonical
}

export function drawingColormapNames(): string[] {
  const map = buildLutIndex()
  return Array.from(map.keys())
    .filter((n) => n.startsWith('_'))
    .sort()
}

export function lookupColorMap(name: string): ColorMap | null {
  const map = buildLutIndex()
  const canonical = name.charAt(0).toUpperCase() + name.slice(1)
  const def = map.get(canonical)
  if (!def) return null
  return def as unknown as ColorMap
}

export function lutrgba8(lutName?: string): Uint8ClampedArray {
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
