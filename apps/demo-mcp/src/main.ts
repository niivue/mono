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
 * 5. Gives the agent a control surface: UIKit widgets drawn on the canvas,
 *    bound to NiiVue settings, the view, volume and mesh properties, dialogs,
 *    the data palette and the page's actions, so an agent can lay out a
 *    demo's controls and the person can use them.
 */
import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import {
  AgentClient,
  type AtlasLike,
  bindControls,
  type ControlEvent,
  type ControlState,
  coreHandlers,
  type DataEntry,
  dataPalette,
  type Handlers,
  type NiiVueHost,
  type PageAction,
  type PointLabel,
  sceneState,
} from '@niivue/nv-mcp/browser'
import { uikitControls } from '@niivue/nv-mcp/uikit'
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
  // The faded bricks (dim_others) already set the ROI's brick apart, and an
  // extra twelve-edge box around it makes the scene needlessly busy.
  pendingLabels = labels.map(({ boxMM: _box, ...label }) => label)
  pins?.setLabels(pendingLabels)
  nv.drawScene()
}

/**
 * The sample data the page offers in its data palette, by id: an agent
 * binds a button to `data.<id>` to load one, and add_data puts more there.
 */
const CATALOG: DataEntry[] = [
  {
    id: 'mni152',
    label: 'MNI152',
    description: 'The MNI152 T1 template, the base the atlas applies to.',
    tool: 'load_volume',
    args: { url: '/volumes/mni152.nii.gz', mni: true },
  },
  {
    id: 'aal',
    label: 'AAL atlas',
    description: 'The AAL atlas as labels, over an MNI152 base.',
    tool: 'add_overlay',
    args: { url: '/volumes/aal.nii.gz', labels: '/volumes/aal.json' },
  },
  {
    id: 'spm_motor',
    label: 'Motor map',
    description: 'An SPM motor task statistical map, over an MNI152 base.',
    tool: 'add_overlay',
    args: {
      url: '/volumes/spmMotor.nii.gz',
      colormap: 'warm',
      cal_min: 2,
      cal_max: 8,
    },
  },
  {
    id: 'pial_lh',
    label: 'Left pial',
    description: 'The left hemisphere pial surface of ICBM152.',
    tool: 'load_mesh',
    args: { url: '/meshes/BrainMesh_ICBM152.lh.mz3' },
  },
  {
    id: 'cit168',
    label: 'CIT168',
    description: 'The CIT168 subcortical atlas as meshes.',
    tool: 'load_mesh',
    args: { url: '/meshes/CIT168.mz3' },
  },
  {
    id: 'yeh2022',
    label: 'Yeh 2022 tracts',
    description: 'The Yeh 2022 tractography atlas (TRX), in MNI space.',
    tool: 'load_mesh',
    args: { url: '/meshes/yeh2022.trx' },
  },
  {
    id: 'dpsv',
    label: 'DPSV tracts',
    description: 'Tracts with per-streamline values (TRX).',
    tool: 'load_mesh',
    args: { url: '/meshes/dpsv.trx' },
  },
  {
    id: 'connectome',
    label: 'Connectome',
    description: 'A connectome of nodes and edges (JCON).',
    tool: 'load_mesh',
    args: { url: '/meshes/connectome.jcon' },
  },
]

const host: NiiVueHost = {
  view: nv,
  data: dataPalette(CATALOG),
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
  // The control surface needs the canvas, so it is set once NiiVue is
  // attached (see the end). Until then every tool says NiiVue is starting.
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
await loadTemplate()

// --- The controls ---

/** Loads the template again, in the atlas's space. */
async function loadTemplate(): Promise<void> {
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  isMni = true
  void refreshWhere()
}

/** What a control bound to `action.<name>` can do on this page. */
const actions: Record<string, PageAction> = {
  open_files: {
    description:
      'Loads the files picked (bind a file control), replacing what is shown. The atlas no longer applies.',
    async run(event: ControlEvent) {
      const files = event.files ?? []
      if (files.length === 0) return
      await nv.loadVolumes(files.map((file) => ({ url: file })))
      isMni = false
      void refreshWhere()
    },
  },
  load_template: {
    description: 'Loads the MNI152 template again, replacing what is shown.',
    run: loadTemplate,
  },
  save_bitmap: {
    description: 'Saves what the canvas shows as a PNG the person downloads.',
    run: () => nv.saveBitmap('niivue.png'),
  },
  save_document: {
    description:
      'Saves the scene (volumes, meshes, settings and drawing) as a NiiVue document the person downloads.',
    run: () => nv.saveDocument('scene.nvd'),
  },
  save_drawing: {
    description: 'Saves the drawing as a NIfTI file the person downloads.',
    async run() {
      if (!nv.drawingVolume) throw new Error('There is no drawing to save.')
      await nv.saveDrawing('drawing.nii')
    },
  },
  undo_drawing: {
    description: 'Takes back the last pen stroke or fill of the drawing.',
    run: () => nv.drawUndo(),
  },
  next_frame: {
    description:
      'Shows the next frame of the first volume with several (a 4D series), wrapping to the first after the last.',
    run: () => stepFrame(1),
  },
  previous_frame: {
    description:
      'Shows the previous frame of the first volume with several (a 4D series), wrapping to the last before the first.',
    run: () => stepFrame(-1),
  },
  play_frames: {
    description:
      'Starts or stops stepping through the frames of the first volume with several, one frame every 100 ms, looping.',
    run: () => {
      if (playing) {
        clearInterval(playing)
        playing = undefined
        return
      }
      seriesVolume()
      playing = setInterval(() => {
        stepFrame(1).catch(() => {
          clearInterval(playing)
          playing = undefined
        })
      }, 100)
    },
  },
  remove_overlays: {
    description:
      'Removes every volume but the base, keeping the base as it is.',
    async run() {
      for (let i = nv.volumes.length - 1; i > 0; i--) await nv.removeVolume(i)
    },
  },
  reset_view: {
    description:
      'Turns the camera, zoom, pan and crosshair back to where they were when the page started.',
    run: () => {
      nv.azimuth = start.azimuth
      nv.elevation = start.elevation
      nv.scaleMultiplier = start.scaleMultiplier
      nv.pan2Dxyzmm = [...start.pan2Dxyzmm]
      nv.crosshairPos = [...start.crosshairPos]
      nv.drawScene()
    },
  },
}

/** The first loaded volume with more than one frame, or a throw saying there is none. */
function seriesVolume(): (typeof nv.volumes)[number] {
  const volume = nv.volumes.find((v) => (v.nFrame4D ?? 1) > 1)
  if (!volume)
    throw new Error('No loaded volume has more than one frame to step through.')
  return volume
}

/** Moves the series volume `by` frames, wrapping at either end. */
async function stepFrame(by: number): Promise<void> {
  const volume = seriesVolume()
  const frames = volume.nFrame4D ?? 1
  const frame = ((volume.frame4D ?? 0) + by + frames) % frames
  if (volume.id === undefined) throw new Error(`${volume.name} has no id.`)
  await nv.setFrame4D(volume.id, frame)
}

/** The timer stepping the frames while play_frames runs. */
let playing: ReturnType<typeof setInterval> | undefined

/** The camera and crosshair as the page started, which reset_view returns to. */
const start = {
  azimuth: nv.azimuth,
  elevation: nv.elevation,
  scaleMultiplier: nv.scaleMultiplier,
  pan2Dxyzmm: [...nv.pan2Dxyzmm] as [number, number, number, number],
  crosshairPos: [...nv.crosshairPos] as [number, number, number],
}

// One font for the controls and the labels.
const font = await loadDefaultFont()
host.controls = bindControls(
  uikitControls(nv, { font, onChange: showControls }),
  {
    view: nv,
    actions,
    data: host.data,
    onError: (error, event) => host.announce?.(`${event.id}: ${error.message}`),
  },
)
status.textContent = 'Ready.'
ready = true

// The label overlay: each frame it projects the labelled points onto the
// render tile, moved by the explode when the volume is spread apart.
pins = new UIKitPointLabelOverlay(font, (mm) =>
  nv.mmToRenderCanvas(nv.explodedMM([mm[0], mm[1], mm[2]])),
)
pins.setLabels(pendingLabels)
nv.registerOverlayRenderer(pins)

// Warm the atlas so the first `where_am_i` already names the region, and
// keep the readout current however the crosshair moves: a click, a key, a
// tool call, or an animation, which moves it every frame. One refresh runs
// at a time; moves made during it are read by one more once it ends.
void requireAtlas().then(refreshWhere, refreshWhere)
let whereBusy = false
let whereAgain = false
function refreshWhereSoon(): void {
  if (whereBusy) {
    whereAgain = true
    return
  }
  whereBusy = true
  whereAgain = false
  void refreshWhere()
    .catch(() => undefined)
    .finally(() => {
      whereBusy = false
      if (whereAgain) refreshWhereSoon()
    })
}
nv.addEventListener('locationChange', refreshWhereSoon)
