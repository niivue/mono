/**
 * The demo's MCP server: the NiiVue core and nothing else.
 *
 * `startServer` serves the MCP endpoint, the page's WebSocket and a status
 * page from one port. An app with tools of its own passes them as
 * `extensions`; this one only names itself and says what to open when no
 * page is connected.
 */
import { startServer } from '@niivue/nv-mcp/server'

const PORT = Number(process.env.NV_MCP_PORT ?? 4242)
// Loopback only: an agent on this machine is the audience, not the LAN.
const HOST = process.env.NV_MCP_HOST ?? '127.0.0.1'
// Where the dev server puts the page, for the no-tab hint and for new_tab.
const PAGE = process.env.NV_MCP_PAGE ?? 'http://localhost:8091'

startServer({
  name: 'demo-mcp',
  version: '0.1.0',
  host: HOST,
  port: PORT,
  pageUrl: PAGE,
  bridge: {
    noTabHint: `Open ${PAGE} (bunx nx dev demo-mcp) and try again.`,
  },
})
