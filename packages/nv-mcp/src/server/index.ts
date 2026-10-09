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
export type {
  AnswerOptions,
  Extension,
  ReplyShape,
  ToolContext,
  ToolReply,
} from './context'
export {
  failure,
  reloadNotice,
  reply,
  TAB_ARG,
  tabAddress,
  toolContext,
} from './context'
export type { RunningServer, ServerOptions } from './http'
export { DEFAULT_HOST, DEFAULT_PORT, startServer } from './http'
export {
  buildServer,
  CORE_SCHEMAS,
  registerCoreTools,
} from './tools'
