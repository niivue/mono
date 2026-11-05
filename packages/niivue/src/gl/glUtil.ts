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
