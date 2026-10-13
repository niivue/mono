/**
 * Where new voxel values or vertex positions come from for the live-data
 * tools: given in the call, fetched as raw bytes, or copied from another
 * volume or mesh on the page. Each tool takes exactly one of them.
 */

import { type Params, text } from './params'
import type { VoxelArray } from './view'

type TypedArrayConstructor = new (buffer: ArrayBuffer) => ArrayLike<number>

/** The key of the one source given, refusing none or several. */
export function oneSource(
  params: Params,
  keys: readonly string[],
  tool: string,
): string {
  const given = keys.filter(
    (key) => params?.[key] !== undefined && params[key] !== null,
  )
  if (given.length !== 1) {
    throw new Error(
      `${tool} needs exactly one of ${keys.slice(0, -1).join(', ')} or ${keys[keys.length - 1]}${given.length ? `; got ${given.join(' and ')}` : ''}.`,
    )
  }
  return given[0]
}

/**
 * Fetches raw values from an address the page can reach, in `like`'s own
 * datatype and the page's byte order (little-endian on every browser).
 * A gzip stream is unpacked first.
 */
export async function fetchValues(
  params: Params,
  key: string,
  like: VoxelArray,
): Promise<ArrayLike<number>> {
  const address = text(params, key) ?? ''
  let bytes: ArrayBuffer
  try {
    const response = await fetch(address)
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim())
    }
    bytes = await response.arrayBuffer()
    const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength))
    if (head[0] === 0x1f && head[1] === 0x8b) {
      const unpacked = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'))
      bytes = await new Response(unpacked).arrayBuffer()
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(`The values at ${address} could not be fetched: ${why}`)
  }
  const size = like.BYTES_PER_ELEMENT
  const type = typeName(like)
  if (bytes.byteLength % size !== 0) {
    throw new Error(
      `The values at ${address} are ${bytes.byteLength} bytes, not a whole number of ${type} values of ${size} bytes each.`,
    )
  }
  const Typed = (like as unknown as { constructor: TypedArrayConstructor })
    .constructor
  return new Typed(bytes)
}

/** The datatype a typed array holds, by name: `Float32`, `Int16` and so on. */
function typeName(like: VoxelArray): string {
  const name = (like as unknown as { constructor?: { name?: string } })
    .constructor?.name
  return name?.replace(/Array$/, '') || `${like.BYTES_PER_ELEMENT}-byte`
}

/** Whether these values are in a typed array, which has a datatype to keep. */
export function isTyped(
  values: ArrayLike<number> | null | undefined,
): values is VoxelArray {
  return ArrayBuffer.isView(values) && !(values instanceof DataView)
}

/** The largest finite Float32 value; anything beyond becomes Infinity. */
const FLOAT32_MAX = 3.4028234663852886e38

/**
 * Refuses values the target's datatype would change on the way in: a
 * fraction into whole numbers, or a value beyond the type's range, which a
 * typed array would truncate, wrap or turn into Infinity without a word.
 */
export function checkFits(
  values: ArrayLike<number>,
  like: VoxelArray,
  what: string,
): void {
  const type = typeName(like)
  // Uint8Array names itself Uint8, with a lower-case i.
  if (type === 'Float32') {
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      if (Number.isFinite(v) && Math.abs(v) > FLOAT32_MAX)
        throw new Error(
          `${what} holds Float32 values, at most ${FLOAT32_MAX} either way; value ${i} is ${v}.`,
        )
    }
    return
  }
  const whole = /^(Int|Uint)(8|16|32)(Clamped)?$/.exec(type)
  if (!whole) return
  const bits = like.BYTES_PER_ELEMENT * 8
  const signed = whole[1] === 'Int'
  const low = signed ? -(2 ** (bits - 1)) : 0
  const high = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isInteger(v) || v < low || v > high) {
      throw new Error(
        `${what} holds ${type} values, whole numbers from ${low} to ${high}; value ${i} is ${v}.`,
      )
    }
  }
}
