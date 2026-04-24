import NiiVue from '@niivue/niivue'
import { bridge } from './bridge'
import { wireNiiVueToBridge } from './niivue-controller'

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

wireNiiVueToBridge(nv, bridge)

await nv.attachToCanvas(canvas)

// Tell the native host the webview is fully initialized and ready to
// receive commands. The Swift-side Bridge flushes buffered calls on this.
bridge.emit('ready', { backend: nv.backend })
