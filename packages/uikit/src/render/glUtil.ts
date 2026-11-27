// Shared WebGL2 plumbing for uikit's renderers.

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  src: string,
  what: string,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(`UIKit: failed to create ${what} shader`)
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`UIKit: ${what} shader compile failed: ${info}`)
  }
  return shader
}

/** Compile and link a program from vertex and fragment source. */
export function linkProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
  what: string,
): WebGLProgram {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc, what)
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc, what)
  const program = gl.createProgram()
  if (!program) throw new Error(`UIKit: failed to create ${what} program`)
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    throw new Error(`UIKit: ${what} program link failed: ${info}`)
  }
  return program
}

/** Alpha "over" blending (alpha src ONE, as the WebGPU blend state). */
export function blendOver(gl: WebGL2RenderingContext): void {
  gl.enable(gl.BLEND)
  gl.blendFuncSeparate(
    gl.SRC_ALPHA,
    gl.ONE_MINUS_SRC_ALPHA,
    gl.ONE,
    gl.ONE_MINUS_SRC_ALPHA,
  )
}
