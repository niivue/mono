/**
 * gradient.js
 *
 * Computes volume gradients using diagonal sampling with linear interpolation.
 * Single-pass approach that combines Sobel-style edge detection with smoothing.
 * Uses WebGL2 slice-by-slice rendering (no compute shaders needed).
 */
import { log } from '@/logger'

// Shader program cache (one program per GL context)
const _programCache = new WeakMap<WebGL2RenderingContext, WebGLProgram>()

function getOrCreateProgram(gl: WebGL2RenderingContext): WebGLProgram {
  let program = _programCache.get(gl)
  if (program) return program
  program = createGradientProgram(gl)
  _programCache.set(gl, program)
  return program
}

// Vertex shader - renders a full-screen quad for each output slice
const vertShader = `#version 300 es
precision highp float;
in vec3 vPos;
out vec2 TexCoord;
void main() {
    TexCoord = vPos.xy;
    gl_Position = vec4((vPos.xy - vec2(0.5, 0.5)) * 2.0, 0.0, 1.0);
}`

// Fragment shader - computes gradients using diagonal sampling
const fragShader = `#version 300 es
precision highp float;
precision highp sampler3D;

in vec2 TexCoord;
out vec4 FragColor;

uniform sampler3D intensityVol;
uniform float coordZ;
uniform float dX;
uniform float dY;
uniform float dZ;

void main() {
    vec3 vPos = vec3(TexCoord.xy, coordZ);

    // Sample at diagonal offsets for gradient estimation
    // Using linear interpolation on the texture naturally smooths the result
    float dx = dX;
    float dy = dY;
    float dz = dZ;

    // Central differences with diagonal sampling
    // X gradient
    float gx = texture(intensityVol, vPos + vec3(dx, 0.0, 0.0)).a
             - texture(intensityVol, vPos - vec3(dx, 0.0, 0.0)).a;

    // Y gradient
    float gy = texture(intensityVol, vPos + vec3(0.0, dy, 0.0)).a
             - texture(intensityVol, vPos - vec3(0.0, dy, 0.0)).a;

    // Z gradient
    float gz = texture(intensityVol, vPos + vec3(0.0, 0.0, dz)).a
             - texture(intensityVol, vPos - vec3(0.0, 0.0, dz)).a;

    // Normalize gradient to [-1, 1] range, then map to [0, 1] for storage
    vec3 gradient = vec3(gx, gy, gz);
    float len = length(gradient);

    if (len > 0.0001) {
        gradient = gradient / len;
    } else {
        gradient = vec3(0.0);
    }

    // Map from [-1, 1] to [0, 1] for RGBA8 storage
    vec3 normalized = gradient * 0.5 + 0.5;

    // Store normalized gradient in RGB, alpha = 1.0
    FragColor = vec4(normalized, 1.0);
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

/**
 * Create the gradient computation shader program
 */
function createGradientProgram(gl: WebGL2RenderingContext): WebGLProgram {
  return createProgram(gl, vertShader, fragShader)
}

/**
 * Get uniform locations for the gradient shader
 */
function getUniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
) {
  return {
    coordZ: gl.getUniformLocation(program, 'coordZ'),
    intensityVol: gl.getUniformLocation(program, 'intensityVol'),
    dX: gl.getUniformLocation(program, 'dX'),
    dY: gl.getUniformLocation(program, 'dY'),
    dZ: gl.getUniformLocation(program, 'dZ'),
  }
}

/**
 * Create the full-screen quad geometry
 */
function createQuadGeometry(gl: WebGL2RenderingContext, program: WebGLProgram) {
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
  const posLoc = gl.getAttribLocation(program, 'vPos')
  gl.enableVertexAttribArray(posLoc)
  gl.vertexAttribPointer(posLoc, 3, gl.FLOAT, false, 0, 0)
  gl.bindVertexArray(null)
  return { vao, vbo }
}

/**
 * Compute volume gradients from an RGBA volume texture.
 * Uses diagonal sampling with linear interpolation for single-pass gradient computation.
 *
 * @param {WebGL2RenderingContext} gl - WebGL2 context
 * @param {WebGLTexture} textureRGBA - Input RGBA8 3D texture
 * @param {Array<number>} dims - Volume dimensions [width, height, depth]
 * @returns {WebGLTexture} Output RGBA8 3D texture with gradients in RGB channels
 */
export function volume2TextureGradientRGBA(
  gl: WebGL2RenderingContext,
  textureRGBA: WebGLTexture,
  dims: [number, number, number],
): WebGLTexture {
  if (dims.length < 3) {
    throw new Error('Gradient expects dims [width, height, depth]')
  }
  const [vx, vy, vz] = dims

  // Get or create cached shader program
  const program = getOrCreateProgram(gl)
  gl.useProgram(program)

  // Get uniform locations
  const uniforms = getUniformLocations(gl, program)

  // Create quad geometry
  const { vao, vbo } = createQuadGeometry(gl, program)

  // Set input texture to use LINEAR filtering for smooth gradient computation
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_3D, textureRGBA)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  // Create output gradient texture
  const outputTexture = gl.createTexture()
  if (!outputTexture) {
    gl.deleteBuffer(vbo)
    gl.deleteVertexArray(vao)
    throw new Error('Gradient output texture creation failed')
  }
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_3D, outputTexture)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, vx, vy, vz)

  // Set up framebuffer for render-to-texture
  const framebuffer = gl.createFramebuffer()
  if (!framebuffer) {
    gl.deleteTexture(outputTexture)
    gl.deleteBuffer(vbo)
    gl.deleteVertexArray(vao)
    throw new Error('Gradient framebuffer creation failed')
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)

  // Save current GL state
  const savedViewport = gl.getParameter(gl.VIEWPORT) as Int32Array
  const savedCullFace = gl.isEnabled(gl.CULL_FACE)
  const savedBlend = gl.isEnabled(gl.BLEND)
  const savedDepthTest = gl.isEnabled(gl.DEPTH_TEST)
  const savedActiveTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number
  const savedVAO = gl.getParameter(
    gl.VERTEX_ARRAY_BINDING,
  ) as WebGLVertexArrayObject | null

  // Set viewport to slice dimensions
  gl.viewport(0, 0, vx, vy)
  gl.disable(gl.CULL_FACE)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)

  // Bind VAO
  gl.bindVertexArray(vao)

  // Set uniforms
  if (
    !uniforms.intensityVol ||
    !uniforms.coordZ ||
    !uniforms.dX ||
    !uniforms.dY ||
    !uniforms.dZ
  ) {
    throw new Error('Gradient shader uniforms missing')
  }
  gl.uniform1i(uniforms.intensityVol, 0) // Input texture unit

  // Sobel radius for diagonal sampling (matches user's snippet)
  const sobelRadius = 0.7
  gl.uniform1f(uniforms.dX, sobelRadius / vx)
  gl.uniform1f(uniforms.dY, sobelRadius / vy)
  gl.uniform1f(uniforms.dZ, sobelRadius / vz)

  // Render each output slice
  for (let z = 0; z < vz; z++) {
    // Compute normalized z coordinate (center of voxel)
    const coordZ = (z + 0.5) / vz
    gl.uniform1f(uniforms.coordZ, coordZ)

    // Attach output texture slice to framebuffer
    gl.framebufferTextureLayer(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      outputTexture,
      0,
      z,
    )

    // Draw quad
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // Cleanup
  gl.bindVertexArray(null)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)

  // Restore viewport
  gl.viewport(
    savedViewport[0] ?? 0,
    savedViewport[1] ?? 0,
    savedViewport[2] ?? 0,
    savedViewport[3] ?? 0,
  )

  // Restore GL state
  if (savedCullFace) gl.enable(gl.CULL_FACE)
  else gl.disable(gl.CULL_FACE)
  if (savedBlend) gl.enable(gl.BLEND)
  else gl.disable(gl.BLEND)
  if (savedDepthTest) gl.enable(gl.DEPTH_TEST)
  else gl.disable(gl.DEPTH_TEST)
  gl.activeTexture(savedActiveTexture)
  gl.bindVertexArray(savedVAO)

  // Unbind textures
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_3D, null)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_3D, null)
  gl.activeTexture(savedActiveTexture)

  // Delete temporary resources
  gl.deleteBuffer(vbo)
  gl.deleteVertexArray(vao)
  gl.deleteFramebuffer(framebuffer)

  return outputTexture
}

/**
 * Clean up cached shader programs
 */
export function destroy(gl: WebGL2RenderingContext): void {
  const program = _programCache.get(gl)
  if (!program) return

  try {
    gl.deleteProgram(program)
  } catch (err) {
    log.warn('gradient.destroy: failed to delete program', err)
  }

  _programCache.delete(gl)
}
