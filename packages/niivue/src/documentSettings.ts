// Pure helpers for sparse NVD settings: which settings a saved document
// includes, and (implicitly) how absent settings resolve on load. A document
// omits any setting that equals its default, so on load an omitted setting is
// left at the loading instance's current value rather than reset to default (see
// NVDocument.applyDocumentToModel). This lets an embedding app persist, say, the
// crosshair position across scenes by never saving it: any document that omits
// `scene.crosshairPos` leaves the crosshair where the user last put it.

/** Policy controlling which settings a saved document includes. */
export interface SettingsSavePolicy {
  /**
   * Settings to OMIT from a saved document even when they differ from the
   * default. Each entry is a group name (`'scene'`, `'ui'`, ...) or a dotted
   * `'group.key'` path (`'scene.crosshairPos'`). An omitted setting falls back
   * to the loading instance's current value.
   */
  neverSave?: string[]
  /**
   * Settings to INCLUDE in a saved document even when they equal the default.
   * Same `'group'` / `'group.key'` form as `neverSave`. `neverSave` wins when a
   * setting is listed in both.
   */
  alwaysSave?: string[]
}

/** How a setting the document OMITS is filled on load: reset to its built-in
 * `'default'`, or left at the loading instance's `'current'` value. A value the
 * document specifies always wins over both. */
export type SettingsFill = 'default' | 'current'

/**
 * Load-time fill policy. A single mode applies to every omitted setting; a map
 * targets specific groups (`'scene'`) or dotted keys (`'scene.crosshairPos'`),
 * with unlisted settings using `'default'`. Undefined => everything `'default'`.
 * Example: `{ 'scene.crosshairPos': 'current' }` keeps the user's crosshair while
 * resetting every other omitted setting.
 */
export type SettingsFillPolicy =
  | SettingsFill
  | Partial<Record<string, SettingsFill>>

/** Resolve the fill mode for one `group.key` under a policy (default `'default'`;
 * a dotted key beats a group entry). */
export function fillModeFor(
  group: string,
  key: string,
  policy: SettingsFillPolicy | undefined,
): SettingsFill {
  if (policy === undefined) return 'default'
  if (typeof policy === 'string') return policy
  return policy[`${group}.${key}`] ?? policy[group] ?? 'default'
}

// Shallow copy an array/object default so the model never aliases a *_DEFAULTS
// constant (mutating model.ui.graph would otherwise corrupt the constant).
function cloneDefault<V>(v: V): V {
  if (Array.isArray(v)) return [...v] as V
  if (v && typeof v === 'object') return { ...v } as V
  return v
}

/**
 * Resolve every schema key of a settings group on load: a value the document
 * specifies wins; an omitted key is reset to its default (`'default'`) or left at
 * the current value (`'current'`) per `policy`. Returns a full object (all keys
 * present), suitable for `Object.assign(model.group, fillGroup(...))`.
 */
export function fillGroup<T extends Record<string, unknown>>(
  group: string,
  current: T,
  defaults: T,
  docGroup: Partial<T> | undefined,
  policy: SettingsFillPolicy | undefined,
): T {
  const out = { ...current }
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    if (docGroup && docGroup[key] !== undefined) {
      out[key] = docGroup[key] as T[typeof key]
    } else if (fillModeFor(group, key, policy) === 'default') {
      out[key] = cloneDefault(defaults[key])
    }
    // 'current' => leave out[key] at the current value (already copied above)
  }
  return out
}

/** True for the indexed sequences settings actually hold: plain arrays and typed
 * arrays (gl-matrix vecs are Float32Array). Deliberately NOT a duck-typed
 * `typeof x.length === 'number'` check — that would treat any plain object with a
 * numeric `length` key as a sequence and compare it by index, ignoring its other
 * keys. `DataView` is excluded: it is an ArrayBuffer view with no `length`. */
function isIndexedSequence(v: object): v is ArrayLike<unknown> {
  return Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))
}

/** Deep value equality for settings: primitives, array-likes (incl. typed
 * arrays / gl-matrix vecs), and plain nested objects (e.g. `ui.graph`). */
export function settingEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aSeq = isIndexedSequence(a)
  const bSeq = isIndexedSequence(b)
  // A sequence never equals a plain object, whatever their keys look like.
  if (aSeq !== bSeq) return false
  if (aSeq && bSeq) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!settingEquals(a[i], b[i])) return false
    }
    return true
  }
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.hasOwn(b as object, k)) return false
    if (
      !settingEquals(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false
    }
  }
  return true
}

/**
 * Return a copy of `current` holding only the keys worth saving in a document:
 * a key is dropped when (a) `policy.neverSave` lists the group or the dotted
 * key, or (b) its value equals the default and `policy.alwaysSave` does not
 * force it. Returns `{}` when the whole group is in `neverSave`. With no policy
 * this is plain "omit defaults".
 */
export function sparsifyGroup<T extends Record<string, unknown>>(
  group: string,
  current: T,
  defaults: Partial<T>,
  policy?: SettingsSavePolicy,
): Partial<T> {
  const out: Partial<T> = {}
  const never = policy?.neverSave
  const always = policy?.alwaysSave
  if (never?.includes(group)) return out
  const groupForced = always?.includes(group) ?? false
  for (const key of Object.keys(current) as (keyof T & string)[]) {
    const dotted = `${group}.${key}`
    if (never?.includes(dotted)) continue
    const forced = groupForced || (always?.includes(dotted) ?? false)
    if (!forced && settingEquals(current[key], defaults[key])) continue
    out[key] = current[key]
  }
  return out
}
