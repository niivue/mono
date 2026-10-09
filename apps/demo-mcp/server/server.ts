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
// Where the dev server serves @niivue/dev-images from, for the agent to name.
const VOLUMES = new URL('/volumes/', PAGE).href

startServer({
  name: 'demo-mcp',
  version: '0.1.0',
  host: HOST,
  port: PORT,
  pageUrl: PAGE,
  bridge: {
    noTabHint: `Open ${PAGE} (bunx nx dev demo-mcp) and try again.`,
  },
  // What only this app knows: the volumes its dev server serves, so an
  // agent asks for these rather than guessing at a public address.
  instructions:
    `The page opens with the MNI152 template, ${VOLUMES}mni152.nii.gz, in MNI space, so the ` +
    'AAL atlas applies: list_regions and go_to_region know its regions. The same server serves ' +
    `more for load_volume and add_overlay, each at the same address as the template: ` +
    'aal.nii.gz, the AAL atlas as a label map, drawn with its own names and colours when ' +
    `${VOLUMES}aal.json is passed as labels; mni152_gm.nii.gz, mni152_wm.nii.gz and ` +
    "mni152_csf.nii.gz, tissue maps on the template's grid; spmMotor.nii.gz, a whole-brain " +
    't-map of right against left finger tapping in MNI space; hippo.nii.gz, a small map of the ' +
    "left hippocampus in MNI space; and chris_t1.nii.gz, one person's T1 scan in its own " +
    'space, where no atlas applies. The page hosts controls: add_control draws a button, slider, ' +
    'toggle, select, field, dialog or other widget on the canvas, in a grid by row and col, and ' +
    'lists it in the Controls panel; bind ties it to what it drives.',
})
