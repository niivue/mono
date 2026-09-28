/**
 * @niivue/nv-mcp/server: the Bun side.
 *
 * `startServer` runs the whole thing; `Bridge`, `buildServer` and the tool
 * helpers are exported for an app that wires its own HTTP, and for tests.
 */

export type {
  AppSocket,
  BridgeOptions,
  CallResult,
  ResetReport,
  TabInfo,
  TabListing,
} from './bridge'
// biome-ignore lint/performance/noBarrelFile: package entry point
export { Bridge, CALL_TIMEOUT_MS, NO_APP, RETURN_GRACE_MS } from './bridge'
export type { RunningServer, ServerOptions } from './http'
export { DEFAULT_HOST, DEFAULT_PORT, startServer } from './http'
export type {
  AnswerOptions,
  Extension,
  ReplyShape,
  ToolContext,
  ToolReply,
} from './tools'
export {
  buildServer,
  CORE_SCHEMAS,
  CUT_NAMES,
  failure,
  PLANE_NAMES,
  registerCoreTools,
  reloadNotice,
  reply,
  TAB_ARG,
  tabAddress,
  toolContext,
} from './tools'
