import {
  fitGutterSource,
  type GutterAt,
  type GutterCopyOf,
  gutterTextureBytes,
  TileGutterBase,
  type TileTexture,
} from '@/slide/tileGutter'
import type { TileTextureCache } from '@/slide/tileTextureCache'

/** A slide tile texture (see `TileTexture`). */
export type TileTextureGPU = TileTexture<GPUTexture>

/**
 * Uploads slide tiles with a 1-texel gutter (see slide/tileGutter.ts). The
 * border copies are texture-to-texture copies, submitted with the upload so
 * they run before the frame that draws the tile and never reference a texture
 * replaced later in the frame; a tile's own edge goes through a scratch
 * texture, since a texture level cannot be copied into itself. One
 * copyExternalImageToTexture per tile: each costs ~0.1 ms of CPU, so a strip
 * per border slot from the bitmaps would multiply the upload cost.
 */
export class TileGutterGPU extends TileGutterBase<GPUTexture> {
  /** The device tiles are created on; the renderer sets it. */
  device: GPUDevice | null = null
  private _scratch: GPUTexture | null = null

  /** An empty `width` x `height` tile texture (plus gutter) for tile `at`. */
  create(
    width: number,
    height: number,
    { slide, level, col, row }: GutterAt,
  ): TileTextureGPU {
    return {
      texture: (this.device as GPUDevice).createTexture({
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
      level,
      col,
      row,
    }
  }

  /**
   * Upload `bitmap` as tile `at` into `cache`, then sync its gutter there
   * unless `sync` is false (nearest filtering: `resync` before linear).
   */
  upload(
    bitmap: ImageBitmap,
    at: GutterAt,
    cache: TileTextureCache<TileTextureGPU>,
    sync = true,
  ): TileTextureGPU | null {
    const device = this.device as GPUDevice
    const source = fitGutterSource(bitmap, device.limits.maxTextureDimension2D)
    if (!source) return null
    const { width, height } = source
    // Over the frame's texture budget: defer (ENG-11), the tile retries next frame.
    if (!cache.reserve(gutterTextureBytes(width, height))) return null
    const tile = this.create(width, height, at)
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: tile.texture, origin: [1, 1] },
      [width, height],
    )
    cache.set(at.key, tile, gutterTextureBytes(width, height), bitmap)
    this.sync([tile], cache, sync)
    return tile
  }

  protected _copy(copies: GutterCopyOf<GPUTexture>[]): void {
    const device = this.device as GPUDevice
    // At least 1: a texture cannot be empty.
    let size = 1
    for (const [src, dst] of copies)
      if (!src) size = Math.max(size, dst.width + 2, dst.height + 2)
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
    // Staged once for all of a tile's own-edge slots.
    let staged: TileTextureGPU | null = null
    for (const [src, dst, c] of copies) {
      if (!src && dst !== staged) {
        encoder.copyTextureToTexture(
          { texture: dst.texture },
          { texture: scratch },
          [dst.width + 2, dst.height + 2],
        )
        staged = dst
      }
      encoder.copyTextureToTexture(
        { texture: src?.texture ?? scratch, origin: [c.srcX, c.srcY] },
        { texture: dst.texture, origin: [c.x, c.y] },
        [c.width, c.height],
      )
    }
    device.queue.submit([encoder.finish()])
  }

  destroy(): void {
    super.destroy()
    this._scratch?.destroy()
    this._scratch = null
  }
}
