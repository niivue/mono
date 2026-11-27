// Style helpers shared by the widget models.

/** A style with an override's keys on top; the base itself when there is none. */
export function resolveStyle<T>(base: T, override?: Partial<T>): T {
  return override ? { ...base, ...override } : base
}
