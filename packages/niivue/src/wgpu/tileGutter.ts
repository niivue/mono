import {
  fitGutterSource,
  type GutterAt,
  gutterTextureBytes,
  syncGutters,
} from '@/slide/tileGutter'
import type { TileTextureCache } from '@/slide/tileTextureCache'

/** A slide tile texture: `width` x `height` interior plus a 1-texel gutter. */
export type TileTextureGPU = {
  texture: GPUTexture
  width: number
  height: number
  slide: object
}

/**
 * Uploads slide tiles with a 1-texel gutter (see slide/tileGutter.ts). The
 * border copies are texture-to-texture copies, submitted with the upload so
 * they run before the frame that draws the tile and never reference a texture
 * replaced later in the frame; a tile's own edge goes through a scratch
 * texture, since a texture level cannot be copied into itself. One
 * copyExternalImageToTexture per tile: each costs ~0.1 ms of CPU, so a strip
 * per border slot from the bitmaps would multiply the upload cost.
 */
export class TileGutterGPU {
  private _scratch: GPUTexture | null = null

  /** Upload `bitmap` as tile `at` into `cache`, then sync its gutter there. */
  upload(
    device: GPUDevice,
    bitmap: ImageBitmap,
    at: GutterAt,
    cache: TileTextureCache<TileTextureGPU>,
  ): TileTextureGPU {
    const source = fitGutterSource(bitmap, device.limits.maxTextureDimension2D)
    const { width, height } = source
    const { slide, level, col, row } = at
    const tile = {
      texture: device.createTexture({
        size: [width + 2, height + 2],
        format: 'rgba8unorm',
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      width,
      height,
      slide,
    }
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: tile.texture, origin: [1, 1] },
      [width, height],
    )
    cache.set(at.key, tile, gutterTextureBytes(width, height), bitmap)
    const neighbour = (key: string): TileTextureGPU | undefined => {
      const n = cache.peek(key)
      return n?.slide === slide ? n : undefined
    }
    const size = Math.max(width, height) + 2
    if (!this._scratch || this._scratch.width < size) {
      this._scratch?.destroy()
      this._scratch = device.createTexture({
        size: [size, size],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      })
    }
    const scratch = this._scratch
    const encoder = device.createCommandEncoder()
    // Staged once for all of the tile's own-edge slots.
    let staged = false
    syncGutters(level, col, row, tile, neighbour, (src, dst, c) => {
      if (!src && !staged)
        encoder.copyTextureToTexture(
          { texture: dst.texture },
          { texture: scratch },
          [width + 2, height + 2],
        )
      staged ||= !src
      encoder.copyTextureToTexture(
        { texture: src?.texture ?? scratch, origin: [c.srcX, c.srcY] },
        { texture: dst.texture, origin: [c.x, c.y] },
        [c.width, c.height],
      )
    })
    device.queue.submit([encoder.finish()])
    return tile
  }

  destroy(): void {
    this._scratch?.destroy()
    this._scratch = null
  }
}
