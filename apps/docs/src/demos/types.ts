import type NiiVue from '@niivue/niivue'
import type { DemoUI } from './ui'

export type DemoContext = {
  /** Builds the control bar above the canvas. */
  ui: DemoUI
  /** Resolves a path such as `volumes/mni152.nii.gz` against the examples site. */
  asset: (path: string) => string
  /** Every canvas the page gave this demo; `canvases[0]` is `canvas`. */
  canvases: HTMLCanvasElement[]
}

/** A live demo: set up NiiVue on the canvas and return it so it can be destroyed. */
export type Demo = (
  canvas: HTMLCanvasElement,
  ctx: DemoContext,
) => Promise<NiiVue | NiiVue[]>
