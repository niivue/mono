/**
 * @niivue/nv-mcp/browser: the page side.
 *
 * `coreHandlers(host)` answers the core tools from a NiiVue scene;
 * `AgentClient` keeps the socket to the server and puts each request to
 * those handlers, plus any the app adds.
 */

export type {
  ControlKind,
  ControlOption,
  ControlPatch,
  ControlSpec,
  ControlState,
  ControlValue,
} from '../controls'
export type {
  BindOptions,
  BoundControls,
  PageAction,
} from './bindings'
// biome-ignore lint/performance/noBarrelFile: package entry point
export { bindControls, resolveBinding } from './bindings'
export type { ClientOptions } from './client'
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
  BindingVocabulary,
  ControlEvent,
  ControlListener,
  ControlSurface,
  MemoryControls,
} from './controls'
export {
  coerceValue,
  controlHandlers,
  defaultValue,
  memoryControls,
  patched,
  VALUE_KINDS,
} from './controls'
export { markHandlers } from './marks'
export { describeMesh, meshHandlers } from './meshes'
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
export { settingHandlers } from './settings'
export { describeSignal, signalHandlers } from './signals'
export type {
  AffineTransform,
  Annotation,
  AtlasLike,
  AtlasRegion,
  ColormapToAdd,
  Descriptives,
  DocumentOptions,
  GlobalCamera,
  GraphRange,
  Handler,
  Handlers,
  HitTest,
  LabelTable,
  LayoutTile,
  LoadedVolume,
  Measurement,
  MeasurementOptions,
  MeshLayerToLoad,
  MeshLayerUpdate,
  MeshToLoad,
  MeshUpdate,
  NiiVueHost,
  PointLabel,
  ShownMesh,
  ShownMeshLayer,
  ShownSignal,
  ShownVolume,
  SignalAnnotation,
  SignalDisplay,
  SignalToLoad,
  SignalUpdate,
  TilePoint,
  TransformedVolume,
  TransformInfo,
  Triple,
  View,
  Viewport,
  VolumeToLoad,
  VolumeTransform,
  VolumeUpdate,
} from './view'
export { viewportHandlers } from './viewport'
