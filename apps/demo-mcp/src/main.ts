/**
 * Demo: a NiiVue page an agent can drive over MCP.
 *
 * 1. Describes the page to `@niivue/nv-mcp` as a `NiiVueHost`: the NiiVue
 *    instance, the AAL atlas for `list_regions` and `go_to_region`, and how
 *    the page describes a place and tells the person about a move.
 * 2. Opens the client, which keeps a WebSocket to the MCP server started by
 *    `server/server.ts` and answers each tool call from the scene.
 * 3. Attaches NiiVue to the canvas and loads the MNI152 template in a
 *    render view. This comes last: both await an animation frame, which a
 *    tab in the background is not given, and the page should be reachable
 *    by an agent before then. Until it is, `where_am_i` says so.
 * 4. Draws the labels `set_labels` asks for with a `@niivue/uikit` point
 *    label overlay, projected onto the render each frame (through the
 *    volume's explode, so a label follows its brick when the volume is
 *    spread apart).
 */
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  AgentClient,
  type AtlasLike,
  type ControlState,
  coreHandlers,
  type Handlers,
  memoryControls,
  type NiiVueHost,
  type PointLabel,
  sceneState,
} from '@niivue/nv-mcp/browser'
import { loadDefaultFont, UIKitPointLabelOverlay } from '@niivue/uikit'
import { loadAtlas } from './atlas'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

const agentLine = $('agent')
const whereLine = $('where')
const announceLine = $('announce')
const controlsList = $('controls')
const status = $('status')

// The hint follows the server's address as vite.config.ts read it.
$('mcp').textContent = __NV_MCP_URL__
$('claude').textContent =
  `claude mcp add --transport http niivue ${__NV_MCP_URL__}`

const nv = new NiiVue()

// --- The page as the core sees it ---

/** Whether the loaded scan is in the atlas's space. The MNI152 template is. */
let isMni = true
/** One fetch of the atlas, shared by every call that asks. */
let atlas: Promise<AtlasLike> | null = null

function requireAtlas(): Promise<AtlasLike> {
  atlas ??= loadAtlas().catch((err) => {
    atlas = null
    throw new Error(
      `The atlas could not be fetched (${err instanceof Error ? err.message : String(err)}).`,
    )
  })
  return atlas
}

function mmText(mm: ArrayLike<number>): string {
  return `${mm[0].toFixed(0)}, ${mm[1].toFixed(0)}, ${mm[2].toFixed(0)} mm`
}

/** The place in words: the crosshair, and the region under it once the atlas is here. */
async function describe(): Promise<string> {
  if (!nv.volumes[0]) return 'No volume is loaded yet.'
  const mm = nv.getCrosshairPos()
  let place = `Crosshair at ${mmText(mm)} in ${nv.volumes[0].name}`
  if (isMni && atlas) {
    const region = (await atlas).regionAt(mm)
    place += region ? `, in the ${region}` : ', outside any labelled region'
  }
  return `${place}.`
}

/** Describes the place, and keeps the sidebar's line current while at it. */
async function refreshWhere(): Promise<string> {
  const described = await describe()
  whereLine.textContent = described
  return described
}

/** The labels an agent asked for, drawn once the font is here and NiiVue is up. */
let pins: UIKitPointLabelOverlay | null = null
let pendingLabels: PointLabel[] = []

function showLabels(labels: PointLabel[]): void {
  // The exploded-label film dims every brick except the ROI's, so an extra
  // twelve-edge box around that brick makes the scene needlessly busy.
  pendingLabels = labels.map(({ boxMM: _box, ...label }) => label)
  pins?.setLabels(pendingLabels)
  nv.drawScene()
}

const host: NiiVueHost = {
  view: nv,
  atlas: requireAtlas,
  labels: showLabels,
  atlasApplies: () => isMni,
  loaded: ({ mni }) => {
    isMni = mni
    void refreshWhere()
  },
  describe: refreshWhere,
  announce: (text) => {
    announceLine.textContent = text
    announceLine.classList.remove('quiet')
  },
  // The controls an agent adds are kept and listed here, not drawn: the
  // UIKit widgets that will draw them on the canvas are still landing.
  controls: memoryControls({ onChange: showControls }),
}

/** One line per control: its kind, id, label, value and what it drives. */
function showControls(controls: ControlState[]): void {
  controlsList.replaceChildren()
  controlsList.classList.toggle('quiet', controls.length === 0)
  if (controls.length === 0) {
    controlsList.textContent =
      'None yet. An agent can add_control a slider, toggle, menu or field.'
    return
  }
  for (const control of controls) {
    const li = document.createElement('li')
    const value =
      control.value === null ? '' : ` = ${JSON.stringify(control.value)}`
    const bound = control.bind ? ` -> ${control.bind}` : ''
    const state = control.enabled ? '' : ' (disabled)'
    li.textContent = `${control.kind} ${control.id}${control.label ? ` "${control.label}"` : ''}${value}${bound}${state}`
    controlsList.append(li)
  }
}

// --- The client ---

/** Every tool waits for NiiVue: a tab in the background does not finish starting until it is shown. */
let ready = false
const handlers: Handlers = Object.fromEntries(
  Object.entries(coreHandlers(host)).map(([name, handler]) => [
    name,
    (params: Record<string, unknown>) => {
      if (!ready) {
        throw new Error(
          'The page is still starting NiiVue. A tab in the background gets there once it is brought to the front.',
        )
      }
      return handler(params)
    },
  ]),
)

const client = new AgentClient(handlers, {
  state: () => sceneState(host),
  onStatus: (connected) => {
    agentLine.textContent = connected
      ? `agent server connected (tab ${client.id})`
      : 'agent server not reached'
    agentLine.classList.toggle('connected', connected)
  },
})
client.attach()

// --- The scene ---
status.textContent = 'Starting NiiVue'
await nv.attachTo('gl1')
nv.sliceType = SLICE_TYPE.RENDER
status.textContent = 'Loading volume'
await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
status.textContent = 'Ready.'
ready = true

// The label overlay: each frame it projects the labelled points onto the
// render tile, moved by the explode when the volume is spread apart.
const font = await loadDefaultFont()
pins = new UIKitPointLabelOverlay(font, (mm) =>
  nv.mmToRenderCanvas(nv.explodedMM([mm[0], mm[1], mm[2]])),
)
pins.setLabels(pendingLabels)
nv.registerOverlayRenderer(pins)

// Warm the atlas so the first `where_am_i` already names the region, and
// keep the readout current when the person moves the crosshair themselves.
void requireAtlas().then(refreshWhere, refreshWhere)
for (const type of ['pointerup', 'keyup', 'wheel'] as const) {
  nv.canvas?.addEventListener(type, () => void refreshWhere(), {
    passive: true,
  })
}
