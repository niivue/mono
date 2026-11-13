// <nv-demo data-name="…">: runs src/demos/<name>.ts on the element's canvases.
// NiiVue loads only in the browser, from the demo module the page names.
import type { Demo } from '../demos/types'
import { DemoUI } from '../demos/ui'

const demos = import.meta.glob<{ default: Demo }>([
  '../demos/*.ts',
  '!../demos/types.ts',
  '!../demos/ui.ts',
])

class NvDemo extends HTMLElement {
  async connectedCallback() {
    const { name = '', examplesBase = '' } = this.dataset
    const bar = this.querySelector<HTMLElement>('.nv-viewer-bar')
    const canvases = Array.from(this.querySelectorAll('canvas'))
    const load = demos[`../demos/${name}.ts`]
    if (!bar || !load) return
    const asset = (path: string) => new URL(path, examplesBase).href
    try {
      const demo = (await load()).default
      await demo(canvases[0], { ui: new DemoUI(bar), asset, canvases })
    } catch (e) {
      const error = this.querySelector<HTMLElement>('.error')
      if (!error) return
      error.textContent = `Demo failed: ${e instanceof Error ? e.message : e}`
      error.hidden = false
    }
  }
}

customElements.define('nv-demo', NvDemo)
