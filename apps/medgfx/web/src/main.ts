import NiiVue from '@niivue/niivue'
import { createBridge } from '@niivue/web-bridge/bridge'
import { wireNiiVueToBridge } from '@niivue/web-bridge/niivue-controller'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

const canvas = $<HTMLCanvasElement>('gl1')

const nv = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  isColorbarVisible: false,
})

// Bridge handler name + JS global default to 'niivue' / '__niivueBridge';
// medgfx uses the defaults and the matching Swift-side BridgeConfig.default.
const bridge = createBridge()
wireNiiVueToBridge(nv, bridge)

await nv.attachToCanvas(canvas)

// Tell the native host the webview is fully initialized. The Swift-side
// Bridge flushes any buffered calls on this event.
bridge.emit('ready', { backend: nv.backend })
