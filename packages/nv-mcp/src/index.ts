/**
 * @niivue/nv-mcp: an MCP server for a NiiVue page.
 *
 * This entry is the part both ends share and neither runtime needs: the
 * messages on the wire, the plane arithmetic, region matching and the AAL
 * name table. The server lives under `@niivue/nv-mcp/server` (Bun) and the
 * page's end under `@niivue/nv-mcp/browser` (DOM).
 */

// biome-ignore lint/performance/noBarrelFile: package entry point
export { SPOKEN_NAMES } from './names'
export {
  cameraForPlane,
  clipNormal,
  depthThrough,
  namePlane,
  PLANE_ALIASES,
  PLANE_ANGLES,
  PLANE_NONE,
  PLANE_OFF,
  planeDepthCuts,
  resolvePlane,
  samePlane,
  viewDirection,
} from './planes'
export type {
  AgentRequest,
  AgentResponse,
  Hello,
  PlaneState,
  RegionSummary,
  TabState,
  Welcome,
} from './protocol'
export {
  isHello,
  isWelcome,
  TAB_ID_MAX,
  TAB_PARAM,
  tabFromSearch,
} from './protocol'
export type { Nameable, RegionMatch } from './regions'
export {
  ambiguityMessage,
  findRegion,
  matchRegion,
  regionMentions,
} from './regions'
