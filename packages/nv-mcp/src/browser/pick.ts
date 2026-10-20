/**
 * Picking one of the things on show by index or by name.
 *
 * A volume, a mesh, a signal or a layer is named on a tool as its index,
 * counted from 0 as the listing tools count them, or as its name: exactly
 * first, then as a part of one name, case ignored. A part that fits
 * several is refused with the choices, and a name that fits none is
 * refused with what is shown.
 */

export interface Named {
  name?: string
}

/** The index of the item `wanted` names among `items`; `fallback` when nothing was asked. */
export function pickIndex(
  items: ReadonlyArray<Named>,
  wanted: unknown,
  noun: string,
  fallback?: number,
): number {
  const nameOf = (item: Named, i: number) => item.name ?? `${noun} ${i}`
  const shown = items.map(nameOf).join(', ')
  if (wanted === undefined || wanted === null || wanted === '') {
    if (fallback !== undefined && items[fallback]) return fallback
    if (!items.length) throw new Error(`No ${noun} is loaded.`)
    throw new Error(`Say which ${noun}: an index from 0, or a name (${shown}).`)
  }
  if (typeof wanted === 'number' || /^\d+$/.test(String(wanted).trim())) {
    const index = Number(wanted)
    if (!items[index]) {
      throw new Error(
        `There is no ${noun} ${index}: ${items.length} shown, numbered from 0 (${shown}).`,
      )
    }
    return index
  }
  const name = String(wanted).trim().toLowerCase()
  const exact = items.findIndex(
    (item, i) => nameOf(item, i).toLowerCase() === name,
  )
  if (exact >= 0) return exact
  const hits = items
    .map((item, i) => (nameOf(item, i).toLowerCase().includes(name) ? i : -1))
    .filter((i) => i >= 0)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    const which = hits.map((i) => `${i} (${nameOf(items[i], i)})`).join(', ')
    throw new Error(
      `"${wanted}" could mean ${hits.length} ${noun}s: ${which}. Say which, or give its index.`,
    )
  }
  throw new Error(
    items.length
      ? `No ${noun} is named "${wanted}". Shown: ${shown}.`
      : `No ${noun} is loaded.`,
  )
}
