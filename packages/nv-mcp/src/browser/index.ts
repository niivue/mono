/**
 * @niivue/nv-mcp/browser: the page side.
 *
 * `coreHandlers(host)` answers the core tools from a NiiVue scene;
 * `AgentClient` keeps the socket to the server and puts each request to
 * those handlers, plus any the app adds.
 */

export type { ClientOptions } from './client'
// biome-ignore lint/performance/noBarrelFile: package entry point
export {
  AGENT_PATH,
  AGENT_URL,
  AgentClient,
  agentUrls,
  CONNECT_MS,
  RETRY_MS,
  serve,
  TAB_ID_KEY,
  tabId,
} from './client'
export type {
  AtlasLike,
  AtlasRegion,
  Handler,
  Handlers,
  LabelTable,
  LoadedVolume,
  NiiVueHost,
  ShownVolume,
  Triple,
  View,
  VolumeToLoad,
  VolumeUpdate,
} from './scene'
export {
  coreHandlers,
  fetchLabelTable,
  looksMni,
  nameFromUrl,
  planeIsCut,
  SCREENSHOT_WIDTH,
  sceneState,
  viewState,
} from './scene'
