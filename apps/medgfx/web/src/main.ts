import NiiVue from '@niivue/niivue'
import { createBridge } from '@niivue/web-bridge/bridge'
import {
  loadDroppedFiles,
  wireNiiVueToBridge,
} from '@niivue/web-bridge/niivue-controller'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

const canvas = $<HTMLCanvasElement>('gl1')

const nv = new NiiVue({
  backend: 'webgl2',
  // NiiVue defaults to 4x MSAA. Safari's WebGPU then runs the volume ray-march
  // fragment shader per sample rather than per pixel, making 3D renders ~4-5x
  // slower than WebGL2 (measured on iPad and in macOS Safari). medgfx always
  // renders in a WKWebView, i.e. Safari's engine, so MSAA is off everywhere.
  // At a Retina DPR the edge smoothing MSAA buys is barely visible.
  isAntiAlias: false,
  backgroundColor: [0, 0, 0, 1],
  isColorbarVisible: false,
  // Cyan rather than NiiVue's red, which vanishes into warm statistical overlays.
  crosshairColor: [0.35, 0.78, 0.98, 1],
  // On by default. NiiVue's own default is 0; this is the value the Chrome
  // panel's checkbox restores, and it must match `NiiVueModel.meshXRayOnValue`
  // so the cell hydrates to `true` on ready instead of flipping the box off.
  meshXRay: 0.05,
  // NiiVue's own drop replaces per file and ignores modifiers; see the drop
  // listener below.
  isDragDropEnabled: false,
})

// A drop replaces the scene; holding Cmd or Ctrl adds to it, matching the
// native drop target. Drops run one at a time so a second cannot replace the
// scene halfway through the first. NiiVue still calls preventDefault on the
// canvas, so WebKit never navigates to the file.
let drops = Promise.resolve()
document.addEventListener('drop', (event) => {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return
  const add = event.metaKey || event.ctrlKey
  drops = drops
    .then(() => loadDroppedFiles(nv, files, add))
    .catch((err) => console.error('drop failed', err))
})

// Bridge handler name + JS global default to 'niivue' / '__niivueBridge';
// medgfx uses the defaults and the matching Swift-side BridgeConfig.default.
const bridge = createBridge()
wireNiiVueToBridge(nv, bridge)

await nv.attachToCanvas(canvas)

// Tell the native host the webview is fully initialized. The Swift-side
// Bridge flushes any buffered calls on this event.
bridge.emit('ready', { backend: nv.backend })
