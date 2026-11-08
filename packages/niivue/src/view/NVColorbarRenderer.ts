import { COLORBAR_GAP, type ColorbarLayout } from './NVColorbar'
import { NVRenderer } from './NVRenderer'

/** Colorbar settings a caller may change through `configure`. */
export type ColorbarOptions = {
  opacity?: number
  margin?: number
  heightRatio?: number
  borderColor?: [number, number, number, number]
}

/** Layout and style state shared by the WebGL2 and WebGPU colorbar renderers. */
export abstract class NVColorbarRenderer extends NVRenderer {
  protected _canvasWidth = 1
  protected _canvasHeight = 1
  protected _fontPx = 0
  /** [x, y, width, height] device px the colorbars lay out in; the whole canvas when null. */
  protected _content: number[] | null = null
  protected _opacity = 1
  protected _margin = 20
  protected _heightRatio = 1.2
  protected _borderColor: [number, number, number, number] = [0, 0, 0, 1]

  getLayout(): ColorbarLayout {
    return {
      margin: this._margin,
      heightRatio: this._heightRatio,
      gap: COLORBAR_GAP,
      canvasWidth: this._content?.[2] ?? this._canvasWidth,
      canvasHeight: this._content?.[3] ?? this._canvasHeight,
      borderColor: [...this._borderColor],
      fontPx: this._fontPx,
      originX: this._content?.[0] ?? 0,
      originY: this._content?.[1] ?? 0,
    }
  }

  protected applyOptions(options: ColorbarOptions): void {
    if (options.opacity !== undefined) this._opacity = options.opacity
    if (options.margin !== undefined) this._margin = options.margin
    if (options.heightRatio !== undefined)
      this._heightRatio = options.heightRatio
    if (options.borderColor !== undefined)
      this._borderColor = options.borderColor
  }
}
