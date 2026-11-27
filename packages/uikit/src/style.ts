// Style helpers shared by the widget models.

/** A style with an override's keys on top; the base itself when there is none. */
export function resolveStyle<T>(base: T, override?: Partial<T>): T {
  return override ? { ...base, ...override } : base
}

/** A copy of `obj` with the listed lengths times `k`; unset ones stay unset. */
export function scaleKeys<T extends object>(
  obj: T,
  keys: readonly (keyof T)[],
  k: number,
): T {
  const out = { ...obj }
  for (const key of keys) {
    const v = out[key]
    if (typeof v === 'number') out[key] = (v * k) as T[keyof T]
  }
  return out
}
