// The slide colour tables (NVSlide.displayColorLut) as WebGL2 3D textures.
import type { NVSlideColorLut } from '@/slide/NVSlide'
import { setTexParams } from './glUtil'

const MAX_COLOR_LUTS = 8

/** One 3D texture per slide colour table, uploaded on first use; `clear` deletes them. */
export class ColorLutTexturesGL {
  private readonly _textures = new Map<NVSlideColorLut, WebGLTexture>()

  // Uploads on the active unit: only bind() calls it, with unit 1 active.
  private get(
    gl: WebGL2RenderingContext,
    lut: NVSlideColorLut,
  ): WebGLTexture | null {
    const existing = this._textures.get(lut)
    if (existing) {
      // Least recently used goes first: re-insert on every hit.
      this._textures.delete(lut)
      this._textures.set(lut, existing)
      return existing
    }
    // A few slides at a time: drop the least recently used table (renderers
    // without a clearTextures hook would otherwise keep one per slide shown).
    if (this._textures.size >= MAX_COLOR_LUTS) {
      const [oldest, tex] = this._textures.entries().next().value as [
        NVSlideColorLut,
        WebGLTexture,
      ]
      gl.deleteTexture(tex)
      this._textures.delete(oldest)
    }
    const texture = gl.createTexture()
    if (!texture) return null
    gl.bindTexture(gl.TEXTURE_3D, texture)
    setTexParams(gl, gl.TEXTURE_3D, gl.LINEAR)
    const n = lut.size
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      n,
      n,
      n,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      lut.data,
    )
    this._textures.set(lut, texture)
    return texture
  }

  /** Bind `lut` (or nothing) on texture unit 1, the shaders' `colorLut`, leaving unit 0 active. */
  bind(gl: WebGL2RenderingContext, lut: NVSlideColorLut | null): void {
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, lut ? this.get(gl, lut) : null)
    gl.activeTexture(gl.TEXTURE0)
  }

  clear(gl: WebGL2RenderingContext | null): void {
    for (const texture of this._textures.values()) gl?.deleteTexture(texture)
    this._textures.clear()
  }
}
