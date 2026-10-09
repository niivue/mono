/**
 * The data palette on the page: the data it can load, by id. The page
 * seeds it with its own sample data, an agent adds entries with
 * `add_data`, and `load_data` (or a control bound to `data.<id>`) runs an
 * entry: the loading tool it names, with the arguments it holds. The
 * palette runs the page's own handlers, so an entry loads exactly what the
 * same tool call would.
 */

import {
  DATA_LOADERS,
  type DataEntry,
  type DataItem,
  type DataLoader,
} from '../data'
import { choice, type Params, record, text } from './params'
import type { Handlers, NiiVueHost } from './view'

/** The data a page can load, by id. */
export interface DataPalette {
  list(): DataItem[]
  get(id: string): DataItem | undefined
  /** Adds an entry, or throws in words when the id is taken or the call is not a load. */
  add(entry: DataEntry, source?: DataItem['source']): DataItem
  /** Takes an entry away; a page's own entries stay. */
  remove(id: string): void
  /** Loads the entry, through the handlers `connect` gave it. */
  load(id: string): Promise<unknown>
  /**
   * The handlers that answer the loading tools, which `load` calls. `coreHandlers`
   * connects its own; a page that wraps a loader (to track or check what
   * loads) connects its own map afterwards, or `load_data` and `data.<id>` skip the wrapper.
   */
  connect(handlers: Handlers): void
}

/** An entry checked: a loader, an object of arguments with a url, and no tab (the entry loads where it is pressed). */
function checkedEntry(entry: DataEntry): DataEntry {
  const id = entry.id?.trim()
  if (!id) throw new Error('A data entry needs an id.')
  if (!DATA_LOADERS.includes(entry.tool))
    throw new Error(
      `A data entry calls one of the loading tools: ${DATA_LOADERS.join(', ')}.`,
    )
  const args = entry.args
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error(`The arguments of "${id}" must be an object.`)
  if (typeof args.url !== 'string' || !args.url.trim())
    throw new Error(`"${id}" needs a url among its arguments.`)
  const { tab: _tab, ...rest } = args
  return { ...entry, id, args: rest }
}

/** A palette seeded with the page's own entries. */
export function dataPalette(catalog: readonly DataEntry[] = []): DataPalette {
  const entries = new Map<string, DataItem>()
  let handlers: Handlers | undefined

  const palette: DataPalette = {
    list: () =>
      [...entries.values()].map((e) => ({ ...e, args: { ...e.args } })),

    get(id) {
      const entry = entries.get(id)
      return entry && { ...entry, args: { ...entry.args } }
    },

    add(entry, source = 'agent') {
      const checked = checkedEntry(entry)
      if (entries.has(checked.id))
        throw new Error(
          `There is already data called "${checked.id}". Remove it first, or pick another id.`,
        )
      const item: DataItem = {
        ...checked,
        label: checked.label?.trim() || checked.id,
        source,
      }
      entries.set(item.id, item)
      return { ...item, args: { ...item.args } }
    },

    remove(id) {
      const entry = entries.get(id)
      if (!entry) throw new Error(missing(id, entries))
      if (entry.source === 'page')
        throw new Error(`"${id}" is the page's own data, which stays.`)
      entries.delete(id)
    },

    async load(id) {
      const entry = entries.get(id)
      if (!entry) throw new Error(missing(id, entries))
      const handler = handlers?.[entry.tool]
      if (!handler)
        throw new Error(`This page cannot ${entry.tool.replace('_', ' ')}.`)
      return handler({ ...entry.args })
    },

    connect(given) {
      handlers = given
    },
  }

  for (const entry of catalog) palette.add(entry, 'page')
  return palette
}

function missing(id: string, entries: Map<string, DataItem>): string {
  const known = [...entries.keys()]
  return known.length
    ? `There is no data "${id}". There is: ${known.join(', ')}.`
    : `There is no data "${id}": the palette is empty.`
}

/** The tools over the palette; a page without one declines in words. */
export function dataHandlers(host: NiiVueHost): Handlers {
  const palette = () => {
    if (!host.data)
      throw new Error('This page has no data palette to load from.')
    return host.data
  }

  return {
    list_data() {
      return { data: palette().list() }
    },

    add_data(params: Params) {
      const id = text(params, 'id')
      if (!id) throw new Error('add_data needs an id for the entry.')
      const from = text(params, 'from')
      const base = from ? palette().get(from) : undefined
      if (from && !base)
        throw new Error(`There is no data "${from}" to start from.`)
      const tool =
        choice<DataLoader>(params, 'tool', DATA_LOADERS) ?? base?.tool
      if (!tool)
        throw new Error(
          `add_data needs the tool the entry calls: one of ${DATA_LOADERS.join(', ')}.`,
        )
      // Another loader takes other arguments, so only the same one keeps the base's.
      const same = base?.tool === tool
      const kept = same ? base?.args : undefined
      const args = { ...kept, ...(record(params, 'args') ?? {}) }
      const label = text(params, 'label')
      const description =
        text(params, 'description') ?? (same ? base?.description : undefined)
      const data = palette().add({
        id,
        tool,
        args,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
      })
      return { data }
    },

    remove_data(params: Params) {
      const id = text(params, 'id')
      if (!id) throw new Error('remove_data needs the id of the entry.')
      palette().remove(id)
      return {
        data: palette()
          .list()
          .map((e) => e.id),
      }
    },

    async load_data(params: Params) {
      const id = text(params, 'id')
      if (!id) throw new Error('load_data needs the id of the entry.')
      const result = await palette().load(id)
      return { loaded: id, result }
    },
  }
}
