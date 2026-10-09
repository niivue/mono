/**
 * The data palette: the data a page can load, by id. Each entry is a load
 * call held for later, one of the loading tools with the arguments it
 * takes, so running an entry loads exactly what the same call would. The
 * page offers its own sample data as entries (`source: 'page'`); an agent
 * adds more (`source: 'agent'`), and binds a button to `data.<id>` so the
 * person can load it.
 */

/** The tools an entry may hold a call to. */
export const DATA_LOADERS = [
  'load_volume',
  'add_overlay',
  'load_mesh',
  'add_mesh_layer',
  'load_signal',
  'load_document',
] as const

export type DataLoader = (typeof DATA_LOADERS)[number]

/** Something the page can load, as a held call to one of the loading tools. */
export interface DataEntry {
  id: string
  /** What a person would call it; the id otherwise. */
  label?: string
  /** What it is, for an agent choosing among entries. */
  description?: string
  /** The loading tool the entry calls. */
  tool: DataLoader
  /** The arguments that tool takes, as an agent would give them. */
  args: Record<string, unknown>
}

/** An entry as the palette reports it: who put it there. */
export interface DataItem extends DataEntry {
  label: string
  source: 'page' | 'agent'
}
