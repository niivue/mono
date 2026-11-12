import { SlideRendererGPU } from '@/wgpu/slide'
import {
  createSlideViewWith,
  type SlideBackendFactory,
  type SlideView,
  type SlideViewOptions,
} from './slideView'

/** WebGPU renderer factory for `createSlideViewWith`. */
export const webgpuSlideBackend: SlideBackendFactory = {
  kind: 'webgpu',
  create: (canvas, { antialias, maxRawPoolBytes }) =>
    SlideRendererGPU.create(canvas, { antialias, maxRawPoolBytes }),
}

/** Mount a slide view on `canvas` (WebGPU). See {@link SlideViewOptions}. */
export const createSlideView = (
  canvas: HTMLCanvasElement,
  options?: SlideViewOptions,
): Promise<SlideView> =>
  createSlideViewWith([webgpuSlideBackend], canvas, options)
