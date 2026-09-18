// shader.js is taken from github user Twinklebear: https://github.com/Twinklebear/webgl-util
import { log } from '@/logger'

type ProgramJob = {
  program: WebGLProgram
  vs: WebGLShader
  fs: WebGLShader
}

const startProgram = (
  gl: WebGL2RenderingContext,
  vert: string,
  frag: string,
): ProgramJob => {
  const vs = gl.createShader(gl.VERTEX_SHADER)
  if (!vs) {
    throw new Error('Vertex shader creation failed')
  }
  gl.shaderSource(vs, vert)
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  if (!fs) {
    gl.deleteShader(vs)
    throw new Error('Fragment shader creation failed')
  }
  gl.shaderSource(fs, frag)
  gl.compileShader(fs)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    throw new Error('Program creation failed')
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  return { program, vs, fs }
}

const finishProgram = (
  gl: WebGL2RenderingContext,
  { program, vs, fs }: ProgramJob,
): WebGLProgram => {
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    log.error('Shader link error:', gl.getProgramInfoLog(program))
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      log.error('Vertex shader compilation error:', gl.getShaderInfoLog(vs))
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      log.error('Fragment shader compilation error:', gl.getShaderInfoLog(fs))
    }
    gl.deleteProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    throw new Error('Shader failed to link, see console for log')
  }
  // Flagged shaders are freed with the program.
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return program
}

/**
 * Start compiling a program without blocking. `poll` returns undefined while
 * the driver is still compiling (KHR_parallel_shader_compile), then the
 * Shader, or null if it failed to link. Without the extension the first poll
 * blocks until the program is linked.
 */
export function compileShaderAsync(
  gl: WebGL2RenderingContext,
  vertexSrc: string,
  fragmentSrc: string,
): { program: WebGLProgram; poll: () => Shader | null | undefined } {
  const ext = gl.getExtension('KHR_parallel_shader_compile')
  const job = startProgram(gl, vertexSrc, fragmentSrc)
  const poll = (): Shader | null | undefined => {
    if (ext && !gl.getProgramParameter(job.program, ext.COMPLETION_STATUS_KHR))
      return undefined
    try {
      return new Shader(gl, vertexSrc, fragmentSrc, finishProgram(gl, job))
    } catch {
      return null
    }
  }
  return { program: job.program, poll }
}

export class Shader {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
  isMatcap?: boolean
  isCrosscut?: boolean

  constructor(
    gl: WebGL2RenderingContext,
    vertexSrc: string,
    fragmentSrc: string,
    program?: WebGLProgram,
  ) {
    this.program =
      program ?? finishProgram(gl, startProgram(gl, vertexSrc, fragmentSrc))
    this.uniforms = {}
    this.isMatcap = undefined
    this.isCrosscut = undefined

    const regexUniform = /uniform[^;]+[ ](\w+);/g
    const matchUniformName = /uniform[^;]+[ ](\w+);/

    const vertexUnifs = vertexSrc.match(regexUniform)
    const fragUnifs = fragmentSrc.match(regexUniform)

    if (vertexUnifs) {
      vertexUnifs.forEach((unif) => {
        const m = unif.match(matchUniformName)
        const name = m?.[1]
        if (name) {
          this.uniforms[name] = null
        }
      })
    }
    if (fragUnifs) {
      fragUnifs.forEach((unif) => {
        const m = unif.match(matchUniformName)
        const name = m?.[1]
        if (name) {
          this.uniforms[name] = null
        }
      })
    }

    for (const unif in this.uniforms) {
      this.uniforms[unif] = gl.getUniformLocation(this.program, unif)
    }
  }

  use(gl: WebGL2RenderingContext): void {
    gl.useProgram(this.program)
  }
}
