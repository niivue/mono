import {
  createSlideViewWith,
  type SlideView,
  type SlideViewOptions,
} from './slideView'
import { webgl2SlideBackend } from './slideViewWebGL2'
import { webgpuSlideBackend } from './slideViewWebGPU'

/**
 * Mount a slide view on `canvas`: WebGPU, falling back to WebGL2 (or the
 * reverse with `backend: 'webgl2'`). See {@link SlideViewOptions}.
 */
export const createSlideView = (
  canvas: HTMLCanvasElement,
  options?: SlideViewOptions,
): Promise<SlideView> =>
  createSlideViewWith([webgpuSlideBackend, webgl2SlideBackend], canvas, options)
