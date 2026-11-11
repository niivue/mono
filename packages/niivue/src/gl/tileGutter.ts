import {
  type GutterAt,
  type GutterCopy,
  gutterFit,
  gutterTextureBytes,
  syncGutters,
} from '@/slide/tileGutter'
import type { TileTextureCache } from '@/slide/tileTextureCache'
import { setTexParams } from './glUtil'

/** A slide tile texture: `width` x `height` interior plus a 1-texel gutter. */
export type TileTextureGL = {
  texture: WebGLTexture
  width: number
  height: number
  slide: object
}

/**
 * Uploads slide tiles with a 1-texel gutter (see slide/tileGutter.ts). The
 * border copies run on the GPU through a read framebuffer; a tile's own edge
 * goes through a scratch texture, since a texture level cannot be copied into
 * itself.
 */
export class TileGutterGL {
  private _fb: WebGLFramebuffer | null = null
  private _scratch: WebGLTexture | null = null
  private _scratchSize = 0

  /** Upload `bitmap` as tile `at` into `cache`, then sync its gutter there. */
  upload(
    gl: WebGL2RenderingContext,
    bitmap: ImageBitmap,
    at: GutterAt,
    cache: TileTextureCache<TileTextureGL>,
  ): TileTextureGL {
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    const [left, width] = gutterFit(bitmap.width, max)
    const [top, height] = gutterFit(bitmap.height, max)
    const { slide, level, col, row } = at
    const tile = { texture: gl.createTexture(), width, height, slide }
    gl.bindTexture(gl.TEXTURE_2D, tile.texture)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width + 2, height + 2)
    setTexParams(gl, gl.TEXTURE_2D, gl.LINEAR)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, left)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, top)
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      1,
      1,
      width,
      height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bitmap,
    )
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    cache.set(at.key, tile, gutterTextureBytes(width, height), bitmap)
    const neighbour = (key: string): TileTextureGL | undefined => {
      const n = cache.peek(key)
      return n?.slide === slide ? n : undefined
    }
    const size = Math.max(width, height) + 2
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
    // redundant ones, and stage the tile once for all of its own-edge slots.
    let attached: WebGLTexture | null = null
    let staged = false
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
    const whole = {
      x: 0,
      y: 0,
      srcX: 0,
      srcY: 0,
      width: width + 2,
      height: height + 2,
    }
    syncGutters(level, col, row, tile, neighbour, (src, dst, c) => {
      if (!src && !staged) copy(dst.texture, scratch, whole)
      staged ||= !src
      copy(src?.texture ?? scratch, dst.texture, c)
    })
    gl.framebufferTexture2D(
      gl.READ_FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      null,
      0,
    )
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read)
    return tile
  }

  destroy(gl: WebGL2RenderingContext | null): void {
    gl?.deleteTexture(this._scratch)
    gl?.deleteFramebuffer(this._fb)
    this._scratch = null
    this._fb = null
    this._scratchSize = 0
  }
}
