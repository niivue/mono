import type { NVImage } from '@/NVTypes'

/**
 * The id a volume asks for: its own `id`, else its `name`, else `'volume'`.
 * Loaders default `id` to `name`, which defaults to the URL.
 */
function requestedVolumeId(vol: Pick<NVImage, 'id' | 'name'>): string {
  return vol.id || vol.name || 'volume'
}

/**
 * Return `base` when no volume in `volumes` uses it as its id, else the first
 * free `base-2`, `base-3`, ... Volume ids must be unique within one NiiVue
 * instance: every id lookup (`setModulationImage`, `setFrame4D`, a signal's
 * `attachedToId`, a document's `modulationImage` link) takes the first match,
 * so two volumes loaded from the same URL would otherwise be indistinguishable.
 * `self`, when given, is ignored, so a volume can keep the id it already has.
 */
export function uniqueVolumeId(
  base: string,
  volumes: readonly NVImage[],
  self?: NVImage,
): string {
  const taken = new Set<string>()
  for (const v of volumes) {
    if (v !== self && v.id !== undefined) taken.add(v.id)
  }
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * Give each of `added` (in order) an id that is unique among `existing` and
 * the earlier entries of `added`. A volume whose requested id is free keeps it;
 * `name` (the display label) is never changed.
 */
export function assignUniqueVolumeIds(
  added: readonly NVImage[],
  existing: readonly NVImage[] = [],
): void {
  const seen: NVImage[] = [...existing]
  for (const vol of added) {
    vol.id = uniqueVolumeId(requestedVolumeId(vol), seen, vol)
    seen.push(vol)
  }
}
