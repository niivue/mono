import type { NVSlideLevelManifest } from '@/slide/NVSlide'
import {
  fillGutter,
  fitGutterSource,
  type GutterAt,
  type GutterCopy,
  type GutterSlide,
  gutterEdgesAt,
  gutterKeyAt,
  gutterTextureBytes,
  slideNeighbour,
  syncGutters,
} from '@/slide/tileGutter'
import type { TileTextureCache } from '@/slide/tileTextureCache'

/**
 * A slide tile texture: `width` x `height` interior plus a 1-texel gutter, at
 * tile `col`, `row` of level `level`.
 */
export type TileTextureGPU = {
  texture: GPUTexture
  width: number
  height: number
  slide: GutterSlide
  level: NVSlideLevelManifest
  col: number
  row: number
  /** A fused scalar tile: the slide's displayGeneration it was fused for. */
  fused?: number
  /** Draw with nearest filtering (a fused tile of label channels only). */
  nearest?: boolean
  /**
   * A fused tile's label channels when it also shows intensity channels: no
   * gutter, read nearest and combined with `texture` as the channel blend.
   */
  labels?: GPUTexture
}

type Copy = [src: TileTextureGPU | null, dst: TileTextureGPU, c: GutterCopy]

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
  // An upload skipped its gutter copies since the last resync.
  private _stale = false

  /** An empty `width` x `height` tile texture (plus gutter) for tile `at`. */
  create(
    device: GPUDevice,
    width: number,
    height: number,
    { slide, level, col, row }: GutterAt,
  ): TileTextureGPU {
    return {
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
    device: GPUDevice,
    bitmap: ImageBitmap,
    at: GutterAt,
    cache: TileTextureCache<TileTextureGPU>,
    sync = true,
  ): TileTextureGPU | null {
    const source = fitGutterSource(bitmap, device.limits.maxTextureDimension2D)
    if (!source) return null
    const { width, height } = source
    // Over the frame's texture budget: defer (ENG-11), the tile retries next frame.
    if (!cache.reserve(gutterTextureBytes(width, height))) return null
    const tile = this.create(device, width, height, at)
    device.queue.copyExternalImageToTexture(
      { source },
      { texture: tile.texture, origin: [1, 1] },
      [width, height],
    )
    cache.set(at.key, tile, gutterTextureBytes(width, height), bitmap)
    this.sync(device, [tile], cache, sync)
    return tile
  }

  /**
   * Fill the gutters of `tiles` (already in `cache`) and refresh the resident
   * neighbours' slots that read from them; with `sync` false, defer to `resync`.
   */
  sync(
    device: GPUDevice,
    tiles: readonly TileTextureGPU[],
    cache: TileTextureCache<TileTextureGPU>,
    sync = true,
  ): void {
    if (!sync) {
      this._stale ||= tiles.length > 0
      return
    }
    const copies: Copy[] = []
    for (const t of tiles)
      syncGutters(
        gutterKeyAt(t),
        t.col,
        t.row,
        t,
        slideNeighbour(cache),
        (...c) => copies.push(c),
        gutterEdgesAt(t),
      )
    if (copies.length) this._copy(device, copies)
  }

  /** Refill every resident tile's gutter if an upload skipped its own. */
  resync(device: GPUDevice, cache: TileTextureCache<TileTextureGPU>): void {
    if (!this._stale) return
    this._stale = false
    const copies: Copy[] = []
    for (const t of cache.values())
      fillGutter(
        gutterKeyAt(t),
        t.col,
        t.row,
        t,
        slideNeighbour(cache),
        (...c) => copies.push(c),
        gutterEdgesAt(t),
      )
    this._copy(device, copies)
  }

  private _copy(device: GPUDevice, copies: Copy[]): void {
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
    this._scratch?.destroy()
    this._scratch = null
    this._stale = false
  }
}
