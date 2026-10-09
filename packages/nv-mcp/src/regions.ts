/**
 * Finding the region an agent named.
 *
 * Plain functions over a list of names, so the same matching serves the
 * page (which has the atlas) and the tests (which have a short list).
 */

/** A region as the matching sees it: its label, its name, and any older names it kept. */
export interface Nameable {
  label: string
  name: string
  aliases?: readonly string[]
}

/** What a query came to: one region, several it could mean, or none. */
export interface RegionMatch<R extends Nameable> {
  /** The region, when the query settles on exactly one. */
  region: R | null
  /**
   * Every region the query could mean when it settles on none: empty for a
   * query nothing contains, two or more for one that is ambiguous.
   */
  candidates: R[]
}

/**
 * The region an agent asked for, by label, spoken name or alias.
 *
 * An exact match on any wins, case aside, so `Hippocampus_L` is never
 * ambiguous. Failing that, every region with one containing the query is
 * a candidate: one candidate is the answer, `left precentral` finding
 * `Precentral_L`; several are handed back for the agent to choose between,
 * since `hippocampus` on its own names two regions and guessing a side is
 * worse than asking. Underscores and spaces are treated as the same, since
 * an agent copying a label out of a list may type either.
 */
export function findRegion<R extends Nameable>(
  regions: readonly R[],
  query: string,
): RegionMatch<R> {
  const wanted = fold(query)
  if (!wanted) return { region: null, candidates: [] }
  const exact = regions.find((r) =>
    namesOf(r).some((text) => fold(text) === wanted),
  )
  if (exact) return { region: exact, candidates: [] }
  const candidates = regions.filter((r) => regionMentions(r, wanted))
  if (candidates.length === 1) return { region: candidates[0], candidates: [] }
  return { region: null, candidates }
}

/** The one region a query means, or null when it means none or several. */
export function matchRegion<R extends Nameable>(
  regions: readonly R[],
  query: string,
): R | null {
  return findRegion(regions, query).region
}

/** Whether the region's label, name or an alias contains the query, case and separators aside. */
export function regionMentions(region: Nameable, query: string): boolean {
  const wanted = fold(query)
  return namesOf(region).some((text) => fold(text).includes(wanted))
}

/**
 * The words for a query that could mean several regions, with the names to
 * try instead: what `go_to_region` says rather than picking a side.
 */
export function ambiguityMessage(
  query: string,
  candidates: readonly Nameable[],
): string {
  const names = candidates.map((r) => `${r.label} (${r.name})`).join(', ')
  return `"${query}" could mean ${candidates.length} regions: ${names}. Say which.`
}

function namesOf(region: Nameable): string[] {
  return [region.label, region.name, ...(region.aliases ?? [])]
}

function fold(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
}
