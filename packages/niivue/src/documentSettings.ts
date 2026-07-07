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

/** Deep value equality for settings: primitives, array-likes (incl. typed
 * arrays / gl-matrix vecs), and plain nested objects (e.g. `ui.graph`). */
export function settingEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  const aLen = (a as { length?: unknown }).length
  const bLen = (b as { length?: unknown }).length
  if (typeof aLen === 'number' && typeof bLen === 'number') {
    if (aLen !== bLen) return false
    const aa = a as ArrayLike<unknown>
    const ba = b as ArrayLike<unknown>
    for (let i = 0; i < aLen; i++) {
      if (!settingEquals(aa[i], ba[i])) return false
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
