import type { NiiVueOptions } from '@niivue/niivue'
import NiiVue from '@niivue/niivue'
import { defaultViewerOptions } from './nvscene-controller'

export type OptionValues = Record<string, unknown>

/**
 * True when `proto` or an ancestor defines a setter for `key`. Such options
 * apply to a live viewer; any other key (getter-only, absent) can only be
 * passed to the constructor, so changing it recreates the viewer.
 */
export function hasSetter(proto: object, key: string): boolean {
  for (let p: object | null = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, key)
    if (d) return typeof d.set === 'function'
  }
  return false
}

// Keys a dedicated NvViewer prop owns: the prop wins, so the option is only an
// initial value and never applied live.
const PROP_OWNED = new Set(['sliceType'])

/** Split supplied options (undefined = not supplied) into live and construction-only. */
export function splitOptions(
  proto: object,
  options: Partial<NiiVueOptions> = {},
): { live: OptionValues; construction: OptionValues } {
  const live: OptionValues = {}
  const construction: OptionValues = {}
  for (const key of Object.keys(options).sort()) {
    const value = options[key as keyof NiiVueOptions]
    if (value === undefined || PROP_OWNED.has(key)) continue
    ;(hasSetter(proto, key) ? live : construction)[key] = value
  }
  return { live, construction }
}

/** Value-equality key; typed arrays compare by contents. */
export function signature(value: unknown): string {
  return (
    JSON.stringify(value, (_k, v) =>
      ArrayBuffer.isView(v) ? Array.from(v as unknown as ArrayLike<number>) : v,
    ) ?? ''
  )
}

// NiiVue's own defaults, read from a detached instance (no canvas, view,
// listeners or timers) built with the viewer's construction-only options, since
// some defaults depend on them (volumeMatcap on `matcaps`); and its constructor
// sets the global log level from them. Rebuilt only when those options change.
let reference: { key: string; values: OptionValues } | undefined
function defaultFor(key: string, construction: OptionValues): unknown {
  const sig = signature(construction)
  if (reference?.key !== sig) {
    const values = new NiiVue({ ...defaultViewerOptions, ...construction })
    reference = { key: sig, values: values as unknown as OptionValues }
  }
  // Setters keep the object they are given; never share the reference's.
  return structuredClone(reference.values[key])
}

/**
 * Set live options that differ from `prev`; reset keys dropped since `prev`
 * to their defaults. Keys never supplied are left alone.
 */
export function applyLiveOptions(
  nv: NiiVue,
  prev: OptionValues,
  next: OptionValues,
  onError: (err: unknown) => void,
  construction: OptionValues = {},
): void {
  const target = nv as unknown as OptionValues
  // `value` is a thunk so a failing default lookup reports through onError too.
  const set = (key: string, value: () => unknown) => {
    try {
      const v = value()
      // The constructor merges volumeCinematic over the defaults, the setter
      // over the current value; merge over the defaults to match.
      target[key] =
        key === 'volumeCinematic'
          ? { ...(defaultFor(key, construction) as object), ...(v as object) }
          : v
    } catch (err) {
      onError(err)
    }
  }
  for (const key of Object.keys(next)) {
    if (signature(next[key]) !== signature(prev[key])) set(key, () => next[key])
  }
  for (const key of Object.keys(prev)) {
    if (!(key in next)) set(key, () => defaultFor(key, construction))
  }
}
