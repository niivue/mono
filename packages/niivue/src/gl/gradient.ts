/**
 * Precomputed gradient volume on WebGL2: two fragment passes rendered one
 * z-slice at a time through an FBO (no compute shaders). Pass 1 box-blurs the
 * colormapped alpha into an R8 temp, pass 2 takes an 8-corner Sobel of it.
 * wgpu/sobel.wgsl mirrors both statement for statement; see view/NVGradient.ts.
 */
import { log } from '@/logger'
import {
  GRAD_EPS,
  GRAD_SCALE,
  GRAD_SHIFT,
  SOBEL_RADIUS,
} from '@/view/NVGradient'

interface Programs {
  blur: WebGLProgram
  sobel: WebGLProgram
}
const _programCache = new WeakMap<WebGL2RenderingContext, Programs>()

function getOrCreatePrograms(gl: WebGL2RenderingContext): Programs {
  let programs = _programCache.get(gl)
  if (programs) return programs
  programs = {
    blur: createProgram(gl, vertShader, blurFragShader),
    sobel: createProgram(gl, vertShader, sobelFragShader),
  }
  _programCache.set(gl, programs)
  return programs
}

// Vertex shader - renders a full-screen quad for each output slice
const vertShader = `#version 300 es
precision highp float;
layout(location = 0) in vec3 vPos;
out vec2 TexCoord;
void main() {
    TexCoord = vPos.xy;
    gl_Position = vec4((vPos.xy - vec2(0.5, 0.5)) * 2.0, 0.0, 1.0);
}`

// Both passes tap the 8 corners (+-d) of the fragment's voxel; the loop order
// is the summation order and wgpu/sobel.wgsl uses the same one, since the two
// backends must produce a bit-identical texture.
const fragHeader = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 TexCoord;
out vec4 FragColor;
uniform sampler3D intensityVol;
uniform float coordZ;
uniform vec3 d;
vec3 corner(int i) {
    return vec3(float(i & 1), float((i >> 1) & 1), float(i >> 2)) * 2.0 - 1.0;
}`

// Pass 1: 8-corner box blur of the colormapped ALPHA (monotonic in intensity
// for every LUT, unlike the colour channels) into an R8 temp.
const blurFragShader = `${fragHeader}
void main() {
    vec3 vPos = vec3(TexCoord.xy, coordZ);
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
        sum += texture(intensityVol, vPos + d * corner(i)).a;
    }
    FragColor = vec4(sum * 0.125, 0.0, 0.0, 1.0);
}`

// Pass 2: 8-corner Sobel of the blurred temp. The shared constants come from
// view/NVGradient.ts; the WGSL side takes the same values as overrides.
const sobelFragShader = `${fragHeader}
void main() {
    vec3 vPos = vec3(TexCoord.xy, coordZ);
    vec3 grad = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        vec3 s = corner(i);
        grad += s * texture(intensityVol, vPos + d * s).r;
    }
    // Four taps per side: 0.25 gives the gain of one central difference at
    // this radius, which is what the magnitude encoding was tuned against.
    grad *= 0.25;

    // Guarded normalize; a flat voxel stores vec3(0.0) (encoded 0.5), which
    // the render shaders' own guarded normalize turns back into "no normal".
    float len = length(grad);
    vec3 dir = len > 0.0001 ? grad / len : vec3(0.0);

    // Alpha carries the gradient MAGNITUDE, LOGARITHMIC in the squared
    // gradient; see view/NVGradient.ts for why a linear one is useless.
    float g2 = dot(grad, grad);
    float magnitude = (log2(g2 + float(${GRAD_EPS})) + float(${GRAD_SHIFT})) * float(${GRAD_SCALE});

    FragColor = vec4(dir * 0.5 + 0.5, magnitude);
}`

/**
 * Compile a WebGL shader
 */
function compileShader(
  gl: WebGL2RenderingContext,
  source: string,
  type: number,
): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error('Gradient shader creation failed')
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`Gradient shader compile error: ${info}`)
  }
  return shader
}

/**
 * Create a shader program from vertex and fragment shaders
 */
function createProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): WebGLProgram {
  const vertShader = compileShader(gl, vertSrc, gl.VERTEX_SHADER)
  const fragShader = compileShader(gl, fragSrc, gl.FRAGMENT_SHADER)
  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertShader)
    gl.deleteShader(fragShader)
    throw new Error('Gradient program creation failed')
  }
  gl.attachShader(program, vertShader)
  gl.attachShader(program, fragShader)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program)
    gl.deleteProgram(program)
    gl.deleteShader(vertShader)
    gl.deleteShader(fragShader)
    throw new Error(`Gradient program link error: ${info}`)
  }
  gl.deleteShader(vertShader)
  gl.deleteShader(fragShader)
  return program
}

function createTexture3D(
  gl: WebGL2RenderingContext,
  format: number,
  dims: [number, number, number],
): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('Gradient texture creation failed')
  gl.bindTexture(gl.TEXTURE_3D, tex)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texStorage3D(gl.TEXTURE_3D, 1, format, ...dims)
  return tex
}

/** Run one pass: `input` on unit 0, one full-screen quad per z-slice of `output`. */
function renderSlices(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  input: WebGLTexture,
  output: WebGLTexture,
  [vx, vy, vz]: [number, number, number],
): void {
  gl.useProgram(program)
  gl.uniform1i(gl.getUniformLocation(program, 'intensityVol'), 0)
  gl.uniform3f(
    gl.getUniformLocation(program, 'd'),
    SOBEL_RADIUS / vx,
    SOBEL_RADIUS / vy,
    SOBEL_RADIUS / vz,
  )
  const coordZ = gl.getUniformLocation(program, 'coordZ')
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_3D, input)
  for (let z = 0; z < vz; z++) {
    gl.uniform1f(coordZ, (z + 0.5) / vz)
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      output,
      0,
      z,
    )
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

/**
 * Create the full-screen quad geometry
 */
function createQuadGeometry(gl: WebGL2RenderingContext) {
  const vertices = new Float32Array([
    0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0,
  ])
  const vao = gl.createVertexArray()
  if (!vao) {
    throw new Error('Gradient VAO creation failed')
  }
  gl.bindVertexArray(vao)
  const vbo = gl.createBuffer()
  if (!vbo) {
    gl.bindVertexArray(null)
    throw new Error('Gradient VBO creation failed')
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW)
  // vPos is pinned to location 0 in vertShader, so one VAO serves both programs.
  gl.enableVertexAttribArray(0)
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return { vao, vbo }
}

/**
 * Compute the gradient texture of an RGBA8 volume texture: RGB = unit normal
 * encoded to [0, 1], A = log-encoded magnitude. See view/NVGradient.ts.
 */
export function volume2TextureGradientRGBA(
  gl: WebGL2RenderingContext,
  textureRGBA: WebGLTexture,
  dims: [number, number, number],
): WebGLTexture {
  const [vx, vy] = dims
  const programs = getOrCreatePrograms(gl)
  const { vao, vbo } = createQuadGeometry(gl)

  // LINEAR + clamp-to-edge on the INPUT, matching the sampler wgpu/wgpu.ts
  // hands to sobel.wgsl. The wrap decides what a tap reads outside the volume:
  // with REPEAT the boundary face would take its gradient from the opposite
  // face. Every caller already sets both; stating them here makes the two
  // backends agree by construction rather than by the caller's good behaviour.
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_3D, textureRGBA)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)

  const blurred = createTexture3D(gl, gl.R8, dims)
  const outputTexture = createTexture3D(gl, gl.RGBA8, dims)

  const framebuffer = gl.createFramebuffer()
  if (!framebuffer) throw new Error('Gradient framebuffer creation failed')
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)

  const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array
  const savedCullFace = gl.isEnabled(gl.CULL_FACE)
  const savedBlend = gl.isEnabled(gl.BLEND)
  const savedDepthTest = gl.isEnabled(gl.DEPTH_TEST)
  const savedActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number
  const savedVAO = gl.getParameter(
    gl.VERTEX_ARRAY_BINDING,
  ) as WebGLVertexArrayObject | null

  gl.viewport(0, 0, vx, vy)
  gl.disable(gl.CULL_FACE)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)
  gl.bindVertexArray(vao)

  renderSlices(gl, programs.blur, textureRGBA, blurred, dims)
  renderSlices(gl, programs.sobel, blurred, outputTexture, dims)

  gl.bindVertexArray(null)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.viewport(
    savedViewport[0] ?? 0,
    savedViewport[1] ?? 0,
    savedViewport[2] ?? 0,
    savedViewport[3] ?? 0,
  )
  if (savedCullFace) gl.enable(gl.CULL_FACE)
  else gl.disable(gl.CULL_FACE)
  if (savedBlend) gl.enable(gl.BLEND)
  else gl.disable(gl.BLEND)
  if (savedDepthTest) gl.enable(gl.DEPTH_TEST)
  else gl.disable(gl.DEPTH_TEST)
  gl.bindVertexArray(savedVAO)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_3D, null)
  gl.activeTexture(savedActiveTexture)

  gl.deleteTexture(blurred)
  gl.deleteBuffer(vbo)
  gl.deleteVertexArray(vao)
  gl.deleteFramebuffer(framebuffer)

  return outputTexture
}

/**
 * Clean up cached shader programs
 */
export function destroy(gl: WebGL2RenderingContext): void {
  const programs = _programCache.get(gl)
  if (!programs) return

  try {
    gl.deleteProgram(programs.blur)
    gl.deleteProgram(programs.sobel)
  } catch (err) {
    log.warn('gradient.destroy: failed to delete program', err)
  }

  _programCache.delete(gl)
}
