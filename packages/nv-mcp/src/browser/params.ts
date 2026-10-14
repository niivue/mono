/**
 * Reading a tool's parameters.
 *
 * The server's schema has checked the shape, but a handler is also called
 * by an app's own code and by tests, so each reader takes what it is
 * given loosely (a number as a string, a flag as `'true'`) and refuses in
 * words when it cannot. A value left out reads as `undefined`, so a
 * handler can tell "not asked for" from "asked to be empty".
 */

export type Params = Record<string, unknown>

export function text(params: Params, key: string): string | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  const trimmed = String(value).trim()
  return trimmed ? trimmed : undefined
}

export function number(params: Params, key: string): number | undefined {
  const value = params?.[key]
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number.`)
  return n
}

/** A whole number, `min` at least. */
export function integer(
  params: Params,
  key: string,
  min = 0,
): number | undefined {
  const n = number(params, key)
  if (n === undefined) return undefined
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${key} must be a whole number, ${min} at least.`)
  return n
}

export function flag(params: Params, key: string): boolean | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  return value === true || value === 'true'
}

/** A list of numbers, `length` long when given. */
export function numbers(
  params: Params,
  key: string,
  length?: number,
): number[] | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  if (
    !Array.isArray(value) ||
    (length !== undefined && value.length !== length) ||
    value.some((v) => !Number.isFinite(Number(v)))
  ) {
    throw new Error(
      length === undefined
        ? `${key} must be a list of numbers.`
        : `${key} must be ${length} numbers.`,
    )
  }
  return value.map(Number)
}

/** A point, three numbers, that must be given. */
export function point(params: Params, key: string): [number, number, number] {
  const value = params?.[key]
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((v) => !Number.isFinite(Number(v)))
  ) {
    throw new Error(`${key} must be three numbers, [x, y, z] in millimetres.`)
  }
  return [Number(value[0]), Number(value[1]), Number(value[2])]
}

/** A point when given. */
export function pointIfGiven(
  params: Params,
  key: string,
): [number, number, number] | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  return point(params, key)
}

/** A colour: three or four numbers 0 to 1, alpha 1 when left out. */
export function color(
  params: Params,
  key: string,
): [number, number, number, number] | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    value.length > 4 ||
    value.some((v) => !Number.isFinite(Number(v)))
  ) {
    throw new Error(
      `${key} must be three or four numbers 0 to 1: red, green, blue and alpha.`,
    )
  }
  const rgba = value.map((v) => Math.min(1, Math.max(0, Number(v))))
  return [rgba[0], rgba[1], rgba[2], rgba.length === 4 ? rgba[3] : 1]
}

/** A plain object, when given. */
export function record(params: Params, key: string): Params | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${key} must be an object.`)
  return value as Params
}

/** A list of strings, when given. */
export function strings(params: Params, key: string): string[] | undefined {
  const value = params?.[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw new Error(`${key} must be a list of strings.`)
  return value
}

/** One of a few words, when given. */
export function choice<T extends string>(
  params: Params,
  key: string,
  choices: readonly T[],
): T | undefined {
  const value = text(params, key)?.toLowerCase()
  if (value === undefined) return undefined
  const found = choices.find((c) => c.toLowerCase() === value)
  if (found === undefined)
    throw new Error(`Unknown ${key} "${value}". One of: ${choices.join(', ')}.`)
  return found
}

/** A number clamped to a range. */
export function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n))
}

/** Whether anything was set: a guard for a tool that needs something to do. */
export function nothingIn(update: object): boolean {
  return Object.keys(update).length === 0
}

/** `update[key] = value` only when the value was given, so an update holds only what was asked for. */
export function put<T extends object, K extends keyof T>(
  update: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) update[key] = value
}

/** The file name at the end of a URL, without its query. */
export function nameFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0]
  return path.slice(path.lastIndexOf('/') + 1) || url
}
