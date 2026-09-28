/**
 * What crosses the socket between the server and a page.
 *
 * The server in `server/` turns each MCP tool call into one request and
 * waits for one response; the page in `browser/` answers it from the
 * scene. Nothing here touches NiiVue, the DOM or Bun, so both ends and
 * their tests share it.
 */

/**
 * The query parameter that names the tab a page opens as: `?tab=<id>` in
 * the page's address makes it say hello with that id, so an agent can hand
 * out an address and then reach the tab by `tab` on every later call.
 */
export const TAB_PARAM = 'tab'

/** The longest id a page takes from its address; longer ones are ignored. */
export const TAB_ID_MAX = 64

/** The id in a page's query string, or null when there is none it can use. */
export function tabFromSearch(search: string): string | null {
  let id: string | null
  try {
    id = new URLSearchParams(search).get(TAB_PARAM)
  } catch {
    return null
  }
  const trimmed = id?.trim() ?? ''
  return trimmed.length > 0 && trimmed.length <= TAB_ID_MAX ? trimmed : null
}

/** The first message a page sends after connecting: who it is. */
export interface Hello {
  hello: {
    /** Stable across a reload of the same tab; see `tabId` in the browser part. */
    id: string
    title: string
    url: string
    /** Where the scene stands as the page connects. */
    state: TabState
    /**
     * Set when this same page connected before and is back on a new
     * socket, as after the server restarted or the socket dropped. A
     * fresh load of the page, reload included, leaves it out.
     */
    reconnect?: boolean
  }
}

/**
 * The server's answer to a hello: the id it lists the tab under. That is
 * the page's own id unless a live tab already holds it, as when a tab is
 * duplicated; then it is a spare one, which the page keeps from there on.
 */
export interface Welcome {
  welcome: {
    id: string
  }
}

/**
 * The part of a scene the server keeps an eye on between calls, so a page
 * that reloads can be told apart from one that answers from where it was.
 * The core fills the three named fields; a host may add its own.
 */
export interface TabState {
  volume: string | null
  crosshair: { mm: number[] } | null
  plane: PlaneState | null
  [extra: string]: unknown
}

/** The plane that is cut, by name and by NiiVue's numbers. */
export interface PlaneState {
  name: string
  depth: number
  azimuth: number
  elevation: number
}

/** A tool call as it crosses the socket from the server to the page. */
export interface AgentRequest {
  id: number
  method: string
  params: Record<string, unknown>
}

/**
 * The page's answer: exactly one of `result` or `error`, plus where the
 * scene stands now and what the tab is called, since a title changes.
 */
export interface AgentResponse {
  id: number
  result?: unknown
  error?: string
  tab?: { title: string; url: string }
  state?: TabState
}

/** Whether a message from a page is its hello. */
export function isHello(message: unknown): message is Hello {
  const hello = (message as Hello)?.hello
  return typeof hello?.id === 'string' && typeof hello?.title === 'string'
}

/** Whether a message from the server is its answer to the hello. */
export function isWelcome(message: unknown): message is Welcome {
  return typeof (message as Welcome)?.welcome?.id === 'string'
}

/** One region of an atlas, as `list_regions` reports it. */
export interface RegionSummary {
  /** The label as the atlas spells it, `Precentral_L`. */
  label: string
  /** The same, as it is spoken: `left precentral gyrus`. */
  name: string
  /** The mean position of its voxels, in world millimetres. */
  centroid: [number, number, number]
  /** How many voxels carry the label. */
  voxels: number
}
