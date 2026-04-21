// shader.js is taken from github user Twinklebear: https://github.com/Twinklebear/webgl-util
import { log } from '@/logger'

const compileShader = (
  gl: WebGL2RenderingContext,
  vert: string,
  frag: string,
): WebGLProgram => {
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
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    log.error('Shader link error:', gl.getProgramInfoLog(program))
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      log.error('Vertex shader compilation error:', gl.getShaderInfoLog(vs))
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      log.error('Fragment shader compilation error:', gl.getShaderInfoLog(fs))
    }
    throw new Error('Shader failed to link, see console for log')
  }
  return program
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
  ) {
    this.program = compileShader(gl, vertexSrc, fragmentSrc)
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
