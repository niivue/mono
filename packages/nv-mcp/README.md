# @niivue/nv-mcp

An [MCP](https://modelcontextprotocol.io) server for a [NiiVue](https://github.com/niivue) page, so an agent can load volumes, move the crosshair, cut planes, find atlas regions and take screenshots of a scene a person is looking at.

An agent connects to the server over streamable HTTP; the page keeps a WebSocket open to the same server; each tool call is written to the page as one JSON request and answered with one JSON response. The server holds no anatomy and no scene of its own, so it stays small and the page stays the one place the state lives.

The package has four entry points, and nothing in it knows about the app that hosts it:

| Entry | Runs in | Holds |
|---|---|---|
| `@niivue/nv-mcp` | both | The wire messages, the plane arithmetic, region matching and the AAL spoken-name table |
| `@niivue/nv-mcp/server` | Bun | The bridge that knows tabs by id, the core tools, `startServer` |
| `@niivue/nv-mcp/browser` | the page | The client that keeps the socket open, the handlers that answer the core tools from a NiiVue instance, and `bindControls` |
| `@niivue/nv-mcp/uikit` | the page | `uikitControls`, a control surface that draws an agent's controls on the canvas with `@niivue/uikit` |

An app adds its own tools as an *extension* without touching the core. `apps/demo-mcp` in this repository is a complete page and server.

## Installation

```bash
bun add @niivue/nv-mcp
```

The server side runs under [Bun](https://bun.sh), because it uses `Bun.serve` for the HTTP and WebSocket ends together. The browser side is plain DOM and WebSocket. `@niivue/niivue` is an optional peer dependency: the browser entry is written against its 1.0 API but imports nothing from it, so any object with the same member names will do (see `View` in `browser/scene.ts`). `@niivue/uikit` is an optional peer dependency too, needed only by the `uikit` entry.

## Usage

### The server

```ts
import { startServer } from '@niivue/nv-mcp/server'

startServer({
  name: 'my-niivue-app',
  version: '0.1.0',
  pageUrl: 'http://localhost:8091',
  bridge: { noTabHint: 'Open http://localhost:8091 in a browser.' },
})
```

That listens on `127.0.0.1:4242` (both configurable) and serves three paths:

| Path | What |
|---|---|
| `/mcp` | The streamable HTTP endpoint an agent's client connects to. Stateless: each request gets its own `McpServer`, all sharing one bridge. |
| `/app` | The WebSocket the page keeps open |
| `/` | A plain-text status page listing the connected tabs, with `*` on the one that answers |

`startServer` returns the running server with its `bridge`, `url`, `appUrl` and a `stop()`. Pass `log` to route its lines somewhere other than the console, `bridge` options to tune timeouts or the message an agent reads when no page is connected, `pageUrl` so `new_tab` can hand out the address that opens the page as a named tab, `instructions` for what an agent reads when it connects (what the page shows and can fetch, which the tools cannot know), and a `Bridge` of your own if you wire the HTTP yourself.

Loopback keeps the network out but not other web pages: any site open in the same browser can ask it to open a socket to `127.0.0.1`, and a hostname an attacker controls can resolve there. So `/app` refuses a page whose `Origin` is not loopback (`localhost`, `127.0.0.1` or `[::1]` on any port; a client that sends no `Origin`, which is not a browser, is let in), and `/mcp` refuses a request whose `Host` header does not name this server. A page served from elsewhere goes in `allowedOrigins`; a name for the server other than loopback goes in `allowedHosts`, with its port:

```ts
startServer({
  allowedOrigins: ['https://viewer.example.org'],
  allowedHosts: ['niivue.local:4242'],
})
```

Calls to one tab go one at a time, in the order they were made. The page's handlers all change the one scene, so an agent that fires several tools together gets each answered against the scene the one before left rather than racing them.

### The page

```ts
import NiiVue from '@niivue/niivue'
import {
  AgentClient,
  coreHandlers,
  type NiiVueHost,
  sceneState,
} from '@niivue/nv-mcp/browser'

const nv = new NiiVue()
await nv.attachTo('gl1')
await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

const host: NiiVueHost = { view: nv }
const client = new AgentClient(coreHandlers(host), {
  state: () => sceneState(host),
  onStatus: (connected) => {
    status.textContent = connected ? `agent connected (tab ${client.id})` : 'no agent server'
  },
})
client.attach()
```

Only `view` is required. The core works on a plain NiiVue with no atlas, with `list_regions` and `go_to_region` declining politely. The other hooks are where an app adds what NiiVue does not know:

```ts
const host: NiiVueHost = {
  view: nv,
  atlas: () => loadAtlas(),          // regions, regionAt, valueAt, nearestIn over millimetres
  atlasApplies: () => isMni,         // false on a scan the atlas does not fit
  beforeAnswer: () => fitCanvas(),   // anything to do before reading the scene
  moved: (frac) => sample(frac),     // called after a navigation lands
  describe: () => whereWeAre(),      // the prose for where_am_i and the announcement
  announce: (text) => say(text),     // how the page tells the person
  loaded: ({ mni }) => { isMni = mni },
  extraState: () => ({ light }),     // state the server should watch across a reload
  planeName: () => currentCutName(), // the page's own name for the plane
  labels: (labels) => pins.setLabels(labels), // draws set_labels' labels, an empty list clears
  controls: memoryControls(),        // where add_control puts its widgets
  data: dataPalette(catalog),         // the data an agent can load by id
}
```

`controls` is a `ControlSurface`: `add`, `update`, `remove`, `clear` and `list` over the controls an agent asks for, each a `ControlSpec` of one of the `CONTROL_KINDS` (button, toggle, slider, menu, select, segmented, number, text, textarea, dialog, color, file) in a grid cell or at a position on the canvas, with a `bind` naming what it drives. A page without `controls` declines the control tools. Two surfaces come with the package:

- **`memoryControls()`** keeps the controls and draws nothing. It is enough to list them in the page and to run the tools in a test.
- **`uikitControls(nv, { font })`** from `@niivue/nv-mcp/uikit` draws each control on the NiiVue canvas with the `@niivue/uikit` widget for its kind. It registers its own overlay renderer, so it needs a NiiVue that is attached, and a font such as `await loadDefaultFont()`.

Either surface can be wrapped in `bindControls` so the controls drive the page:

```ts
import { bindControls } from '@niivue/nv-mcp/browser'
import { uikitControls } from '@niivue/nv-mcp/uikit'
import { loadDefaultFont } from '@niivue/uikit'

host.controls = bindControls(uikitControls(nv, { font: await loadDefaultFont() }), {
  view: nv,
  actions: {
    reload: { description: 'Loads the template again.', run: () => loadTemplate() },
  },
  onError: (error, event) => say(`${event.id}: ${error.message}`),
})
```

A `bind` names one of these:

| Bind | Drives |
|---|---|
| a setting, such as `gamma` or `crosshairColor` | That NiiVue setting, as `get_options` names it. A slider takes the setting's bounds, a select its choices, a color control its colour |
| `view.slice`, `view.layout`, `view.radiological` | The slice type, the multiplanar layout and the radiological flag, by the names `set_view` uses |
| `volume.<i>.<prop>` | A property of the volume at index `i`: `opacity`, `colormap`, `colormap_negative`, `cal_min`, `cal_max`, `cal_min_neg`, `cal_max_neg`, `frame`, `invert`, `colorbar`, `nearest`, `transparent_below_cal_min`, `atlas_outline` or `modulate_alpha` |
| `mesh.<i>.<prop>` | A property of the mesh at index `i`, by the names `set_mesh` takes: `opacity`, `shader`, `visible`, `colorbar`, `legend` |
| `mesh.<i>.tract.<option>` | An option of the tract at index `i`, as `set_mesh` takes it: `fiberRadius`, `fiberSides`, `minLength`, `decimation`, `colormap`, `colormapNegative`, `colorBy`, `calMin`, `calMax`, `calMinNeg`, `calMaxNeg`, `fixedColor`. A select bound to `colorBy` takes `direction`, `global`, `fixed` and the tract's scalars (`dpv:<name>`, `dps:<name>`); one bound to `group` takes `all` or one of the tract's groups, shown alone |
| `mesh.<i>.connectome.<option>` | An option of the connectome at index `i`: `nodeColormap`, `nodeColormapNegative`, `nodeMinColor`, `nodeMaxColor`, `nodeScale`, `edgeColormap`, `edgeColormapNegative`, `edgeMin`, `edgeMax`, `edgeScale` |
| `dialog.<id>` | Opens that dialog when a button or menu item is pressed. Add the dialog first with `open: false`, so it waits hidden |
| `data.<id>` | Loads that entry of the page's data palette when a button or menu item is pressed. Pass the palette to `bindControls` as `data` |
| `action.<name>` | One of the page's `actions`. A button or menu runs it when pressed, a value control when its value is committed, a file picker with the files, a dialog with the button that closed it |

The binding works both ways. A control the person moves writes its target: a slider or colour control as it moves, any other once the value is committed. A value changed elsewhere, by the person in NiiVue or by an agent's `set_options`, is read back before the next frame and shown on the control. A control bound with no range or choices takes them from its target, and starts at the target's value. `capabilities` lists the bind forms and the page's actions as `controlBindings`.

`urls` defaults to `agentUrls()`: `/agent` on the page's own origin, then the server directly on port 4242. The client retries with a backoff that settles at half a minute, so the order the two are started in does not matter. An address that neither opens nor refuses within five seconds is closed and the next one tried, so a proxy that hangs cannot keep the page from the server.

### Connecting an agent

For Claude Code:

```bash
claude mcp add --transport http my-niivue-app http://127.0.0.1:4242/mcp
```

[docs/connecting-agents.md](docs/connecting-agents.md) has the same for the Claude desktop app, Codex CLI, Gemini CLI, VS Code, Cursor, Windsurf, stdio-only clients through `mcp-remote`, and a program of your own with the TypeScript or Python SDK, plus how to check the connection with the MCP Inspector and what the common failures mean.

The page's first address, `/agent` on its own origin, is for browsers that let a page reach one origin only, such as the pane inside Claude's desktop app. It needs the dev server to proxy it. In Vite:

```ts
server: {
  proxy: {
    '/agent': {
      target: 'ws://127.0.0.1:4242',
      ws: true,
      rewrite: (path) => path.replace(/^\/agent/, '/app'),
    },
  },
},
```

A page served over HTTPS cannot open `ws://127.0.0.1` at all; the proxy is the way through for that too.

Run Vite under Node for this (`bunx vite`, not `bunx --bun vite`). Vite's WebSocket proxy goes through http-proxy's upgrade path, which hangs under Bun's `node:http`: the socket neither opens nor closes, and the page only reaches the server through its second address. Building with `--bun` is fine; only the dev server is affected.

## The core tools

| Tool | Input | What it does |
|---|---|---|
| `list_tabs` | | The connected tabs: id, title, address, when each connected and which one answers |
| `use_tab` | `id` | Makes one tab the one that answers every later call |
| `new_tab` | | Makes up an id for a tab that is not open yet and gives the address that opens the page as that tab, `pageUrl` with `?tab=<id>` on it |
| `load_volume` | `url`, `name?`, `colormap?`, `mni?` | Loads a volume from an address the page can fetch, replacing what is shown. `mni` says whether the atlas applies; guessed from the name when left out. Reports the name and the volume's bounds in millimetres |
| `add_overlay` | `url`, `name?`, `labels?`, `colormap?`, `opacity?`, `cal_min?`, `cal_max?`, `colormap_negative?`, `cal_min_neg?`, `cal_max_neg?`, `colorbar?` | Draws another volume over whatever the page shows, keeping it, whether the page opened with it or `load_volume` brought it. `labels: freesurfer` draws a segmentation with FreeSurfer's names and colours, and `labels` as the address of a label table JSON (`R`, `G`, `B` and `labels` arrays, as NiiVue reads them) draws any other atlas with its own; otherwise a colormap with a display window (`cal_min`, `cal_max`), a second colormap and window for negative values, and a colorbar. A label map has no window, so `cal_min` and `cal_max` are refused with `labels`. A new `load_volume` clears the overlays |
| `where_am_i` | | The crosshair in millimetres and fractions, the volumes shown and how each is drawn, the plane cut, the camera, the view layout, the page's description of the place, and whatever state the app adds. Says which tab answered |
| `list_regions` | `query?` | The atlas regions the page can navigate to: label, spoken name, centroid in millimetres, voxel count. `query` filters by label or name |
| `go_to_region` | `region`, `plane?` | Moves the crosshair to a region's centroid, turns the camera to face the cut, cuts a plane through the point, and announces the place. `plane` is a side, a slice name or `current`. An ambiguous name fails and lists the candidates |
| `go_to_point` | `mm?`, `vox?`, `plane?`, `label?` | Moves the crosshair to a point in the volume's world millimetres, or to a voxel of the base volume, cuts a plane through it facing the camera, and announces it, prefixed with `label` when given. The same move as `go_to_region`, for any space |
| `set_clip_plane` | `plane?`, `depth?`, `azimuth?`, `elevation?`, `index?`, `planes?`, `face?` | Cuts the volume with a whole plane named for the side it takes off, or `off`; or at any `azimuth` and `elevation`; or several planes at once with `planes`, each `[depth, azimuth, elevation]`. `depth` is NiiVue's, clamped to plus or minus 1.5; `index` picks one of the six planes; `face` turns the camera to look at the cut, on by default |
| `set_camera` | `azimuth?`, `elevation?`, `pan_2d?`, `render_pan?`, `pivot?`, `center_on?`, `global?` | Points the render camera, pans the slices (`pan_2d`, NiiVue's `[x, y, z, zoom]`) or the render, sets or clears the point the render turns about, centres the render on a point in millimetres, or places the camera outright with `global` (`position`, `yaw`, `pitch`, `fov`, `near`, `far`). Only what is given changes |
| `set_volume` | `volume?`, `colormap?`, `colormap_negative?`, `opacity?`, `cal_min?`, `cal_max?`, `cal_min_neg?`, `cal_max_neg?`, `colormap_type?`, `transparent_below_cal_min?`, `frame?`, `invert?`, `colorbar?`, `nearest?`, `atlas_outline?`, `modulate_alpha?`, `labels?`, `modulate?`, `load_all_frames?`, `auto_window?`, `affine?`, `reset_affine?`, `transform?`, `chunk_grid?`, `spread?` | Changes how one loaded volume is drawn, leaving the rest: the colormaps for positive and negative values, the opacity, the display windows, how the window is drawn below its minimum, the frame of a 4D volume, an inverted colormap, its colorbar, nearest-neighbour sampling, an atlas outline, a label table (`labels`, as `add_overlay` takes it), modulation by another volume, loading every frame of a deferred 4D volume, a recomputed window, its voxel-to-world affine set outright or reset, or a translation, rotation and scale applied to it, or its tiling into bricks and how far they are spread apart in the 3D render (`spread`, an exploded view; a volume not yet chunked is tiled 3 by 3 by 3 first). `volume` is an index as `where_am_i` lists them or a name; the base otherwise. Reports the volume as drawn now, with `chunkGrid` and `spread` when it is tiled |
| `set_labels` | `labels?`, `dim_others?`, `clear?` | Draws text labels tied by a line to a point each: an atlas region (its centroid, its spoken name as the text unless `text` is given) or a point in `mm` with its own `text`. On a volume tiled into bricks each label outlines the brick holding its point (the page gets the corners as `boxMM`), and `dim_others` sets the opacity of the bricks holding no label. Each call replaces the labels before it, and the dimming; `clear` takes them down. Needs the page's `labels` hook; a page without one declines |
| `set_view` | `slice?`, `layout?`, `mosaic?`, `show_render?`, `radiological?`, `colorbar?` | Sets what the canvas shows: one slice orientation, all three with the render (`multiplanar`), the render alone, or `none`, which draws no slice and gives the whole canvas to the signal graph; how the multiplanar tiles are arranged and whether the render tile joins them; a NiiVue mosaic string; radiological convention; the colorbar. Only what is given changes. Reports the whole layout |
| `screenshot` | `max_width?` | Draws the scene now and returns the canvas as a PNG, scaled down to fit. On a volume tiled into bricks it waits for the bricks to arrive first, up to 8 seconds, so the picture is never a part of the volume; and it waits, up to 4 seconds, for the render backend to finish an upload such as a 4D frame change, which would otherwise leave the frame blank. Refuses while the tab is in the background, where the browser draws nothing |

Every tool below `new_tab` also takes `tab?`, the id of the tab to ask; without it the answering tab is asked, as the Tabs section explains.

Every reply is a line of prose for the agent to read, then the JSON the page returned. Failures are tool errors with the page's own message.

### More on volumes

| Tool | Input | What it does |
|---|---|---|
| `nudge_crosshair` | `vox` | Steps the crosshair a whole number of voxels along each of the base volume's axes and reports where it lands |
| `transform_volume` | `name`, `volume?`, `options?`, `replace?` | Runs one of NiiVue's registered volume transforms (`capabilities` lists them with their options) on a loaded volume and adds the result on top of the stack, removing the source when `replace` is set |
| `remove_volume` | `volume?`, `all?` | Unloads one volume, or every volume with `all`. Reports the volumes that remain |
| `reorder_volume` | `volume`, `move` | Moves a volume `up`, `down`, to the `top` or to the `bottom` of the stack. The bottom volume is the base that sets the space |
| `describe_volume` | `volume?`, `stats?`, `mask?`, `mask_labels?`, `drawing?`, `affine?` | One volume in full: how it is drawn, its dimensions, its label table, its voxel statistics (over the whole volume, within a mask volume, its labels, or the drawing), and its affine when asked |

### Settings and capabilities

| Tool | Input | What it does |
|---|---|---|
| `get_options` | `names?`, `describe?` | Reads NiiVue's settings by their own names: crosshair, colours, fonts, 3D rendering, drawing pen, drag behaviour and the rest. Without `names` it describes every setting the page has, with its kind, its choices or bounds and what it does |
| `set_options` | `options` | Changes any of those settings, several at once. A choice is given by its word (a drag mode, a pen shape, a render mode), a colour as `[r, g, b, a]` 0 to 1. Every value is checked before any is set |
| `capabilities` | | What this page's NiiVue offers: its backend, which tool features it supports by group, which settings it has, its colormaps, drawing colormaps and mesh shaders, its volume transforms with their options, and the file types it reads and writes. With controls, it also lists the control kinds and what they can bind to, and with a data palette its entries as `data`. A page whose NiiVue lacks a feature refuses that tool in words and answers every other |
| `add_colormap` | `name?`, `R?`, `G?`, `B?`, `A?`, `I?`, `labels?`, `url?` | Adds a colormap from its stops, or fetches one from an address as a NiiVue colormap JSON |
| `set_font` | `atlas`, `metrics` | Loads the font NiiVue draws its text with, from an atlas PNG and a metrics JSON |
| `set_custom_layout` | `tiles?`, `clear?` | Places tiles on the canvas by hand, each a slice orientation or the render at `[left, top, width, height]` as fractions, in place of the ordinary layout; `clear` goes back to it |

### Meshes

| Tool | Input | What it does |
|---|---|---|
| `load_mesh` | `url`, `name?`, `replace?`, `opacity?`, `color?`, `shader?`, `slice_shader?`, `visible?`, `colorbar?`, `legend?`, `layers?` | Loads a surface, tract or connectome over the volumes, with overlay layers when given; `replace` drops the meshes shown once it has loaded |
| `list_meshes` | | The meshes shown, each with how it is drawn and its layers, a tract's `groups` and `scalars` (each as `colorBy` names it, with its range), and the shaders the page knows |
| `set_mesh` | `mesh?`, `name?`, `opacity?`, `color?`, `shader?`, `slice_shader?`, `visible?`, `colorbar?`, `legend?`, `tract?`, `connectome?` | Changes how a mesh is drawn, leaving the rest. `tract` takes NiiVue's tract options (`fiberRadius`, `fiberSides`, `minLength`, `decimation`, `colormap`, `colormapNegative`, `colorBy`, `calMin`, `calMax`, `calMinNeg`, `calMaxNeg`, `fixedColor`, `groupColors`) and reports the tract's groups; `connectome` takes the connectome options (`nodeColormap`, `nodeColormapNegative`, `nodeMinColor`, `nodeMaxColor`, `nodeScale`, `edgeColormap`, `edgeColormapNegative`, `edgeMin`, `edgeMax`, `edgeScale`). Any other key, or an empty object, is refused |
| `remove_mesh` | `mesh?`, `all?` | Unloads one mesh, or every mesh |
| `add_mesh_layer` | `url`, `mesh?`, `name?`, `colormap?`, `colormap_negative?`, `cal_min?`, `cal_max?`, `cal_min_neg?`, `cal_max_neg?`, `opacity?`, `colorbar?`, `invert?`, `transparent_below_cal_min?`, `additive?`, `outline_width?` | Draws a per-vertex overlay (a curvature, a thickness, a statistic) on a mesh |
| `set_mesh_layer` | `mesh?`, `layer?`, the layer fields above, `frame?` | Changes how a layer is drawn, or the frame of a 4D layer |
| `remove_mesh_layer` | `mesh?`, `layer?` | Takes a layer off a mesh |

### Signals and the graph

| Tool | Input | What it does |
|---|---|---|
| `load_signal` | `url`, `name?`, `replace?`, `as_signal?`, `display?`, `attach_to?`, `annotations?` | Loads a physiological trace or a spectroscopy voxel for the graph, drawn as `display` says (`mode`, `ppm_range`, `ppm_ref`, `use_hz`, `apodize_hz`, `phase0`, `phase1_ms`, `columns`, `average`, `legend`), attached to a volume, with notes on the graph. A page that starts with the graph hidden has it shown, so the signal is seen |
| `list_signals` | | The signals shown and the graph's range |
| `set_signal` | `signal?`, `display?`, `attach_to?`, `annotations?` | Changes how a signal is drawn, what it is attached to, or its notes |
| `remove_signal` | `signal?`, `all?` | Unloads one signal, or every signal |
| `set_graph` | `cursor?`, `step?`, `zoom?`, `pan?`, `range?`, `reset?` | Moves the graph cursor to a fraction or steps it, zooms and pans the graph, windows its range or clears the window, or resets the view. When the graph is hidden, the report says so (`graphHidden`) and names the option that shows it, as `list_signals` does too |

### The drawing, annotations and measurements

| Tool | Input | What it does |
|---|---|---|
| `edit_drawing` | `action`, `url?`, `slice?`, `slice_index?` | Works on the voxel drawing over the base volume: `create` an empty one, `load` one from an address, `undo` the last stroke, `close` it, or trace a slice of it as `svg`. Strokes are made by hand on the page; the pen settings are in `set_options` |
| `list_annotations` | `polygons?`, `json?`, `svg?`, `slice?`, `slice_position?` | The vector annotations drawn on the slices, with their polygons, as JSON, or traced as SVG when asked |
| `edit_annotations` | `action`, `id?`, `text?`, `annotation?`, `json?` | `add` a NiiVue VectorAnnotation (`id`; `sliceType` 0 axial, 1 coronal or 2 sagittal; `slicePosition`, where the slice is in mm along its own axis; `polygons`, each at least three `[x, y]` points in mm on the slice plane or `{outer, holes}`; and, if wanted, `label`, `group`, `text` and `style` with `fillColor`, `strokeColor` and `strokeWidth`, red otherwise), `remove` or `select` one by id, `set_text` on one, `clear` them, `undo`, `redo`, or `load` a set from JSON |
| `list_measurements` | | The distance measurements drawn on the slices, each with its ends in millimetres and its length |
| `edit_measurements` | `action`, `start_mm?`, `end_mm?`, `slice?`, `slice_index?`, `slice_position?`, `index?` | `add` a distance between two points, `remove` one by index, or `clear` them all, the angles (`clear_angles`) or the distances (`clear_distances`) |

### Controls

| Tool | Input | What it does |
|---|---|---|
| `add_control` | `id`, `kind`, `row?`, `col?`, `x?`, `y?`, `label?`, `width?`, `value?`, `min?`, `max?`, `step?`, `options?`, `placeholder?`, `max_length?`, `rows?`, `accept?`, `multiple?`, `alpha?`, `palette?`, `message?`, `open?`, `enabled?`, `bind?` | Puts a control on the canvas: a `button`, `toggle`, `slider`, `menu`, `select`, `segmented` row, `number` or `text` field, `textarea`, `dialog`, `color` control or `file` picker, with the fields its kind takes. It goes in the grid, at `row` and `col` from 0 at the top left (`col` left out is 0, `row` left out is the one under the rest of that column); each column is as wide as its widest widget and each row as tall as its tallest, so controls in the grid never overlap; a cell holds one control. `x` and `y` together (canvas pixels) place it at an exact spot instead, never with a `row` or `col`; a dialog takes no cell and is centred unless given `x` and `y`. The reply carries the `box` it was drawn in, in canvas pixels, when the surface draws; `bind` names what it drives, and an empty `bind` unbinds. A dialog opens when added unless `open` is false, and closes when the person picks one of its buttons; `set_control` with `open: true` shows it again. A value left out takes the kind's start: off, the low end of the range, empty, the first option, white |
| `list_controls` | | The controls there, each with its kind, grid cell or position, drawn `box`, value, options and binding; their ids also ride in every reply's state |
| `set_control` | `id`, and any of the fields above | Changes what is given on a control: a `row` or `col` moves it into the grid and `x` and `y` out of it; its value is checked and clamped as it was when added, and a range that moves takes the value with it. A value set on a bound control is written to its target |
| `remove_control` | `id?`, `all?` | Takes one control away, or all of them |

### The data palette

A page that sets `host.data = dataPalette(catalog)` offers data by id. An entry is a load held for later: one of the loading tools (`load_volume`, `add_overlay`, `load_mesh`, `add_mesh_layer`, `load_signal`, `load_document`) with the arguments it takes, so loading an entry does exactly what that call would. The page seeds the palette with its own sample data (`source: 'page'`), which stays; an agent adds more (`source: 'agent'`). A button or menu item bound to `data.<id>` loads the entry when pressed. The ids ride in every reply's state, and `capabilities` lists the entries as `data`.

```ts
host.data = dataPalette([
  { id: 'mni152', label: 'MNI152', tool: 'load_volume', args: { url: '/volumes/mni152.nii.gz', mni: true } },
  { id: 'aal', label: 'AAL atlas', tool: 'add_overlay', args: { url: '/volumes/aal.nii.gz', labels: '/volumes/aal.json' } },
])
host.controls = bindControls(surface, { view: nv, actions, data: host.data })
```

| Tool | Input | What it does |
|---|---|---|
| `list_data` | | The entries, each with its `id`, `label`, `description`, `tool`, `args` and `source` |
| `add_data` | `id`, `tool?`, `args?`, `label?`, `description?`, `from?` | Adds an entry: a call to one of the loading tools with its arguments (`url` at least), held for later; nothing loads now. `from` starts from an entry already there, `tool` and `args` laid over its own, such as a sample with another colormap. A `tab` among the arguments is dropped: an entry loads where it is pressed |
| `remove_data` | `id` | Takes an agent's entry away; the page's own stay |
| `load_data` | `id` | Loads the entry and reports what its loading tool reports |

### The canvas, the slide plane, chunks and files

| Tool | Input | What it does |
|---|---|---|
| `set_viewport` | `pan?`, `zoom?`, `bounds?`, `reset?` | Pans and zooms the canvas in 2D, bounds where NiiVue draws to a box of fractions (or `null` to clear it), or resets |
| `map_point` | `canvas?`, `mm?`, `vox?` | What is under a canvas pixel (the tile, the slice, the point in millimetres), or where a point in millimetres or a voxel lands on the canvas |
| `set_slide` | `level?`, `clear_plane?`, `drawing?`, `max_raster?` | For a whole-slide image: the level the slide plane shows (or `null` for automatic), clearing the plane, and the slide drawing (`create`, `clear`, `undo`, `end`) |
| `chunk_stats` | `rebake?`, `reset_timing?` | For a chunked (OME-Zarr, IIIF) volume: the streaming, timing and level-of-detail statistics; rebakes the chunked overlays or resets the timing when asked |
| `save` | `what`, `filename?`, `volume?`, `drawing?`, `mesh?`, `quality?`, `format?`, `settings_never_saved?`, `settings_always_saved?` | Has the browser download the scene as a NiiVue document, a volume (with the drawing when asked), a mesh, the canvas as a picture, or the drawing |
| `load_document` | `url`, `fill?` | Loads a NiiVue document from an address, replacing the scene; `fill` says whether settings the document leaves out take their defaults or stay as they are |

What is left out is what an MCP tool cannot carry: the members of NiiVue that take a DOM node, a canvas, a `File`, a callback or another object rather than a value. Attaching to a canvas, resizing, the draw and refresh methods, the event listeners, loaders and custom overlay renderers are registered by the page (so are volume transforms, but once registered they take a name and options, so `transform_volume` runs them and `capabilities` lists them); pointer-driven picking (`slideDrawAt`, `slidePlanePick`, `pickMeasurement`, `pickExplodedBlock`) belongs to the pointer; `loadChunkedVolume`, `setSlidePlane`, `swapVolumeChunkPlan` and `addMrsiSignal` take live source objects a page builds; `setFont` takes decoded font data, so `set_font` takes the addresses instead; `broadcastTo` and `setInstances` link instances on one page, which the page does. Every one of those is a page concern, not a scene state, and the page an agent drives is free to expose any of them through its own extension tools.

### Planes and cameras

A plane is named for the side it takes off: `left`, `right`, `posterior`, `anterior`, `inferior`, `superior`, with `sagittal`, `coronal` and `axial` as aliases for the first of each pair. NiiVue keeps a clip plane as `[depth, azimuth, elevation]`, with the shader keeping the side the plane's normal points to; the camera that sees the exposed face square on looks along the normal, which works out to the plane's own elevation and its azimuth turned half a turn. `cameraForPlane` does that sum and `depthThrough` finds the depth that puts the plane through a point, both checked for all six sides in `planes.test.ts`.

### Regions

`findRegion` matches a query against each region's label and spoken name: exactly first, then by containment with case and underscores ignored. One hit is a match; several hits are an ambiguity, reported with the candidate names, unless one of them is exact. `SPOKEN_NAMES` is the AAL table in anatomical English (`Frontal_Inf_Tri_L` is `left inferior frontal gyrus, triangular part`), with a name generated from the label's parts for any label not in it.

## Tabs

Every page that connects says hello with an id, a title, its address and its state, and the server welcomes it with the id it will list the tab under. The id is kept in the tab's `sessionStorage`, which a browser scopes to one tab and keeps across reloads, so a reload arrives as the same id on a new socket and a second tab arrives as a new id. A duplicated tab is the exception: the browser copies its `sessionStorage`, so the copy arrives with the original's id while the original is still connected. The bridge keeps the original as it is and welcomes the copy with a spare id, the original's with `-2` on the end, which the copy keeps for its own reloads; both are then listed, and a call with neither chosen asks, as with any two tabs.

A page opened with `?tab=<id>` in its address takes that id instead, and keeps it in `sessionStorage` too, so its reloads and a later address without the parameter still arrive as it. A duplicate of such a tab is renamed by the server as any duplicate is, and keeps the spare id across its own reloads although its address still names the original. That is how an agent names a tab before it exists: `new_tab` makes up a UUID and returns it with the address to open, the person opens it, and every later call in the conversation passes the id as `tab` and reaches that tab whatever else is connected or chosen. An agent may make up any id itself and put it in the address the same way; `new_tab` only spares it the guessing and knows where the page is.

Which tab answers a call:

- **The call names a `tab`**: that one, if it is connected, else the call fails and lists the tabs. The choice made with `use_tab` is left as it was.
- **One tab connected**: that one.
- **A tab chosen with `use_tab`**: that one, for as long as it is connected.
- **Several connected and none chosen**: the one that answered last, if it is still connected; otherwise the call fails and lists the tabs, so the agent can call `use_tab` rather than drive a tab nobody is looking at.
- **The tab reloads mid-call**: the call fails saying so. On the next call the bridge waits a few seconds for the same id to come back, then answers from it and puts a note at the top of the reply saying the tab reloaded and what its state was before and is now, so the agent knows the crosshair, plane and anything the app adds started over. The note is said once. A page that comes back on a new socket without reloading, after the server restarted or the socket dropped, says so in its hello and gets no note, since its scene is as it was.
- **No tab connected**: the call fails with `NO_APP` plus the server's `noTabHint`, so the agent can tell the person what to open.

Every answer carries `tab: {id, title}` in `where_am_i`, and `list_tabs` marks the one that is answering.

## Adding tools

Extra handlers on the page are more entries in the object passed to `AgentClient`; they receive the tool's arguments and return the JSON the agent sees, or throw to fail the call. Add their state to what the `state` callback returns and the reload note will cover it.

On the server, an `Extension` is a name and a `register(server, context)` that calls `server.registerTool` for each tool, answering through `context.answer(method, params, options)`, which forwards to the bound tab, or to the one `options.tab` names, and wraps the reply. Spread `TAB_ARG` into the tool's schema so an agent can name the tab for it as it does for the core tools:

```ts
import { z } from 'zod'
import { type Extension, TAB_ARG } from '@niivue/nv-mcp/server'

const light: Extension = {
  name: 'light',
  register(server, context) {
    server.registerTool(
      'set_light',
      { description: 'Turns the room light on or off.', inputSchema: { ...TAB_ARG, on: z.boolean() } },
      ({ tab, ...params }) => context.answer('set_light', params, { tab, lead: () => 'Done.' }),
    )
  },
}

startServer({ name: 'my-niivue-app', extensions: [light] })
```

`src/server/http.test.ts` drives a server with exactly that extension against `src/testing/fake-page.ts`, a page with no browser at all.

## Development

```bash
bunx nx build nv-mcp       # Build
bunx nx test nv-mcp        # Run the tests (bun test)
bunx nx typecheck nv-mcp   # Type-check
bunx nx lint nv-mcp        # Biome
bunx nx dev demo-mcp       # The demo page and its server together
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
