import type { NVSlideColorLut } from '@/slide/NVSlide'
/** Set filtering and clamp-to-edge wrapping on the texture bound to `target`. */
export function setTexParams(
  gl: WebGL2RenderingContext,
  target: number,
  minFilter: number,
  magFilter = minFilter,
): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, minFilter)
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, magFilter)
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  if (target === gl.TEXTURE_3D)
    gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
}

/** Unit quad (0-1, triangle strip, vec3 at location 0) in its own VAO. */
export function createUnitQuad(gl: WebGL2RenderingContext): {
  vao: WebGLVertexArrayObject
  vbo: WebGLBuffer
} {
  const vao = gl.createVertexArray()
  if (!vao) throw new Error('Failed to create unit quad VAO')
  const vbo = gl.createBuffer()
  if (!vbo) {
    gl.deleteVertexArray(vao)
    throw new Error('Failed to create unit quad buffer')
  }
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    gl.STATIC_DRAW,
  )
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return { vao, vbo }
}

/** One 3D texture per slide colour table, uploaded on first use; `clear` deletes them. */
export class ColorLutTexturesGL {
  private readonly _textures = new Map<NVSlideColorLut, WebGLTexture>()

  get(gl: WebGL2RenderingContext, lut: NVSlideColorLut): WebGLTexture | null {
    const existing = this._textures.get(lut)
    if (existing) return existing
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

  /** Bind `lut` on texture unit 1 (the shaders' `colorLut`), leaving unit 0 active. */
  bind(gl: WebGL2RenderingContext, lut: NVSlideColorLut): void {
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.get(gl, lut))
    gl.activeTexture(gl.TEXTURE0)
  }

  clear(gl: WebGL2RenderingContext | null): void {
    for (const texture of this._textures.values()) gl?.deleteTexture(texture)
    this._textures.clear()
  }
}
