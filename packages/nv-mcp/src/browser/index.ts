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
export type { Params } from './params'
export {
  choice,
  clamp,
  color,
  flag,
  integer,
  nameFromUrl,
  nothingIn,
  number,
  numbers,
  point,
  pointIfGiven,
  put,
  record,
  strings,
  text,
} from './params'
export type { Named } from './pick'
export { pickIndex } from './pick'
export {
  CLIP_PLANES,
  coreHandlers,
  fetchLabelTable,
  LABEL_TABLES,
  looksMni,
  matrix4,
  planeIsCut,
  SCREENSHOT_WIDTH,
  sceneState,
  viewState,
} from './scene'
export type {
  AffineTransform,
  AtlasLike,
  AtlasRegion,
  Descriptives,
  GlobalCamera,
  Handler,
  Handlers,
  LabelTable,
  LoadedVolume,
  NiiVueHost,
  ShownVolume,
  TransformedVolume,
  Triple,
  View,
  VolumeToLoad,
  VolumeTransform,
  VolumeUpdate,
} from './view'
