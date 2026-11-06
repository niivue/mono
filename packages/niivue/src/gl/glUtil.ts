import type { Shader } from './shader'

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

/** Delete a renderer's program, VAO and buffers. GL ignores null handles. */
export function deleteGLObjects(
  gl: WebGL2RenderingContext,
  shader: Shader | null,
  vao: WebGLVertexArrayObject | null,
  ...buffers: (WebGLBuffer | null)[]
): void {
  if (shader) gl.deleteProgram(shader.program)
  gl.deleteVertexArray(vao)
  for (const buffer of buffers) gl.deleteBuffer(buffer)
}

export type IndexedGeometry = {
  vao: WebGLVertexArrayObject
  vbo: WebGLBuffer
  ibo: WebGLBuffer
}

/** VAO over one interleaved float buffer: attribute i is `sizes[i]` floats at location i. */
export function createIndexedGeometry(
  gl: WebGL2RenderingContext,
  sizes: number[],
): IndexedGeometry {
  const vao = gl.createVertexArray()
  const vbo = gl.createBuffer()
  const ibo = gl.createBuffer()
  if (!vao || !vbo || !ibo) throw new Error('Failed to create indexed geometry')
  gl.bindVertexArray(vao)
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  const stride = sizes.reduce((sum, size) => sum + size, 0) * 4
  let offset = 0
  sizes.forEach((size, loc) => {
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset)
    offset += size * 4
  })
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo)
  gl.bindVertexArray(null)
  return { vao, vbo, ibo }
}

/** Re-upload an indexed geometry's vertices and indices. */
export function uploadIndexed(
  gl: WebGL2RenderingContext,
  geom: IndexedGeometry,
  vertices: Float32Array,
  indices: Uint32Array,
): void {
  gl.bindBuffer(gl.ARRAY_BUFFER, geom.vbo)
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW)
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geom.ibo)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW)
}
