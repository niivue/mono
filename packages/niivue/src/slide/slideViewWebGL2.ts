import { SlideRenderer } from '@/gl/slide'
import { log } from '@/logger'
import {
  createSlideViewWith,
  type SlideBackendFactory,
  type SlideView,
  type SlideViewOptions,
} from './slideView'

/** WebGL2 renderer factory for `createSlideViewWith`. */
export const webgl2SlideBackend: SlideBackendFactory = {
  kind: 'webgl2',
  async create(canvas, { antialias, preserveDrawingBuffer, maxRawPoolBytes }) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias,
      preserveDrawingBuffer,
    })
    if (!gl) return null
    const renderer = new SlideRenderer({ maxRawPoolBytes })
    try {
      renderer.init(gl)
    } catch (err) {
      // Free what init allocated; a teardown failure must not hide why.
      try {
        renderer.destroy()
      } catch (cleanup) {
        log.warn('slide renderer teardown after a failed init threw', cleanup)
      }
      throw err
    }
    return renderer
  },
}

/** Mount a slide view on `canvas` (WebGL2). See {@link SlideViewOptions}. */
export const createSlideView = (
  canvas: HTMLCanvasElement,
  options?: SlideViewOptions,
): Promise<SlideView> =>
  createSlideViewWith([webgl2SlideBackend], canvas, options)
