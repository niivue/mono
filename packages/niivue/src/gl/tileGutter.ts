import {
  fitGutterSource,
  type GutterAt,
  type GutterCopy,
  type GutterCopyOf,
  gutterTextureBytes,
  TileGutterBase,
  type TileTexture,
} from '@/slide/tileGutter'
import type { TileTextureCache } from '@/slide/tileTextureCache'
import { setTexParams } from './glUtil'

/** A slide tile texture (see `TileTexture`). */
export type TileTextureGL = TileTexture<WebGLTexture>

/**
 * Uploads slide tiles with a 1-texel gutter (see slide/tileGutter.ts). The
 * border copies run on the GPU through a read framebuffer; a tile's own edge
 * goes through a scratch texture, since a texture level cannot be copied into
 * itself.
 */
export class TileGutterGL extends TileGutterBase<WebGLTexture> {
  /** The context tiles are created in; the renderer sets it in `init`. */
  gl: WebGL2RenderingContext | null = null
  private _fb: WebGLFramebuffer | null = null
  private _scratch: WebGLTexture | null = null
  private _scratchSize = 0

  /** An empty `width` x `height` tile texture (plus gutter) for tile `at`. */
  create(
    width: number,
    height: number,
    { slide, level, col, row }: GutterAt,
  ): TileTextureGL {
    const gl = this.gl as WebGL2RenderingContext
    const tile = {
      texture: gl.createTexture(),
      width,
      height,
      slide,
      level,
      col,
      row,
    }
    gl.bindTexture(gl.TEXTURE_2D, tile.texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width + 2, height + 2)
    setTexParams(gl, gl.TEXTURE_2D, gl.LINEAR)
    return tile
  }

  /**
   * Upload `bitmap` as tile `at` into `cache`, then sync its gutter there
   * unless `sync` is false (nearest filtering: `resync` before linear).
   */
  upload(
    bitmap: ImageBitmap,
    at: GutterAt,
    cache: TileTextureCache<TileTextureGL>,
    sync = true,
  ): TileTextureGL | null {
    const gl = this.gl as WebGL2RenderingContext
    const source = fitGutterSource(
      bitmap,
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    )
    if (!source) return null
    const { width, height } = source
    // Over the frame's texture budget: defer (ENG-11), the tile retries next frame.
    if (!cache.reserve(gutterTextureBytes(width, height))) return null
    const tile = this.create(width, height, at)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      1,
      1,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source,
    )
    cache.set(at.key, tile, gutterTextureBytes(width, height), bitmap)
    this.sync([tile], cache, sync)
    return tile
  }

  protected _copy(copies: GutterCopyOf<WebGLTexture>[]): void {
    const gl = this.gl as WebGL2RenderingContext
    let size = 0
    for (const [src, dst] of copies)
      if (!src) size = Math.max(size, dst.width + 2, dst.height + 2)
    if (size > this._scratchSize) {
      gl.deleteTexture(this._scratch)
      this._scratch = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this._scratch)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size)
      this._scratchSize = size
    }
    const scratch = this._scratch
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING)
    this._fb ??= gl.createFramebuffer()
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this._fb)
    // Attachment changes dominate the cost of these tiny copies: skip
    // redundant ones, and stage a tile once for all of its own-edge slots.
    let attached: WebGLTexture | null = null
    let staged: TileTextureGL | null = null
    const copy = (
      src: WebGLTexture | null,
      dst: WebGLTexture | null,
      c: GutterCopy,
    ): void => {
      if (src !== attached)
        gl.framebufferTexture2D(
          gl.READ_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.TEXTURE_2D,
          src,
          0,
        )
      attached = src
      gl.bindTexture(gl.TEXTURE_2D, dst)
      gl.copyTexSubImage2D(
        gl.TEXTURE_2D,
        0,
        c.x,
        c.y,
        c.srcX,
        c.srcY,
        c.width,
        c.height,
      )
    }
    for (const [src, dst, c] of copies) {
      if (!src && dst !== staged) {
        const { width, height } = dst
        copy(dst.texture, scratch, {
          x: 0,
          y: 0,
          srcX: 0,
          srcY: 0,
          width: width + 2,
          height: height + 2,
        })
        staged = dst
      }
      copy(src?.texture ?? scratch, dst.texture, c)
    }
    gl.framebufferTexture2D(
      gl.READ_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      null,
      0,
    )
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
  }

  destroy(): void {
    super.destroy()
    this.gl?.deleteTexture(this._scratch)
    this.gl?.deleteFramebuffer(this._fb)
    this._scratch = null
    this._fb = null
    this._scratchSize = 0
  }
}
