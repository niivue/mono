// GPU blend of RGBA8 3D textures into one, for the streamed channel-stack
// fuse. Mirrors wgpu/orient.ts blendOverlaysGPU in structure: accumulate
// passes over the overlays in order (eight per pass here, one there, so a
// 27-channel stack is 4 draws per slice, not 27), then a normalise pass. The
// accumulator is six floats per voxel, as there: P.rgb + alpha sum S in one
// RGBA32F target, max alpha M and union U in another, ping-ponged per pass
// and kept for one z slice at a time. Same math as the CPU
// blendOverlayData (volume/overlayBlend.ts). Needs EXT_color_buffer_float.

import { log } from '@/logger'

const vert = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

/** Overlays folded into the accumulator per pass (texture units 2..9). */
const PER_PASS = 8

// Overlays 0..count-1 of this pass, folded in order (colour OVER stays
// ordered), unrolled: GLSL ES 3.00 indexes sampler arrays by constants only.
const accumFrag = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D accA;
uniform sampler2D accB;
${Array.from({ length: PER_PASS }, (_, k) => `uniform sampler3D o${k};`).join('\n')}
uniform int count;
uniform int z;
uniform int colorBlend;
layout(location = 0) out vec4 outA;
layout(location = 1) out vec4 outB;
void add(vec4 c, inout vec4 A, inout vec4 B) {
  float a = c.a;
  if (a <= 0.0) return;
  if (colorBlend == 3) {
    A.rgb = max(A.rgb, c.rgb * a);
  } else {
    float keep = colorBlend == 2 ? 1.0 - a : 1.0;
    A.rgb = A.rgb * keep + c.rgb * a;
  }
  A.a += a;
  B.x = max(B.x, a);
  B.y = B.y + a - B.y * a;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(accA, p, 0);
  vec4 B = texelFetch(accB, p, 0);
  ivec3 v = ivec3(p, z);
${Array.from({ length: PER_PASS }, (_, k) => `  if (count > ${k}) add(texelFetch(o${k}, v, 0), A, B);`).join('\n')}
  outA = A;
  outB = B;
}`

const normFrag = `#version 300 es
precision highp float;
uniform sampler2D accA;
uniform sampler2D accB;
uniform int alphaBlend;
uniform int colorBlend;
out vec4 color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(accA, p, 0);
  vec4 B = texelFetch(accB, p, 0);
  float sum = A.a;
  if (sum <= 0.0) {
    color = vec4(0.0);
    return;
  }
  float a = alphaBlend == 1 ? min(sum, 1.0) : alphaBlend == 2 ? B.y : B.x;
  float norm = colorBlend == 1 ? sum : colorBlend == 2 ? B.y : a;
  color = vec4(clamp(A.rgb / norm, 0.0, 1.0), a);
}`

type Program = {
  program: WebGLProgram
  u: Record<string, WebGLUniformLocation | null>
}
type Cache = {
  accum: Program
  norm: Program
  vao: WebGLVertexArrayObject
  fbo: WebGLFramebuffer
}
const _cache = new WeakMap<WebGL2RenderingContext, Cache | null>()

function program(
  gl: WebGL2RenderingContext,
  frag: string,
  names: string[],
): Program {
  const p = gl.createProgram()
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag],
  ] as const) {
    const s = gl.createShader(type)
    if (!s) throw new Error('blendOverlaysGL: createShader failed')
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(`blendOverlaysGL: ${gl.getShaderInfoLog(s)}`)
    gl.attachShader(p, s)
    gl.deleteShader(s)
  }
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`blendOverlaysGL: ${gl.getProgramInfoLog(p)}`)
  return {
    program: p,
    u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)])),
  }
}

function cacheFor(gl: WebGL2RenderingContext): Cache | null {
  let c = _cache.get(gl)
  if (c === undefined) {
    try {
      c = build(gl)
    } catch (err) {
      // Once: every later call takes the CPU path without trying again.
      log.warn('blendOverlaysGL unavailable, blending on the CPU', err)
      c = null
    }
    _cache.set(gl, c)
  }
  return c
}

function build(gl: WebGL2RenderingContext): Cache | null {
  return gl.getExtension('EXT_color_buffer_float')
    ? {
        accum: program(gl, accumFrag, [
          'accA',
          'accB',
          'count',
          'z',
          'colorBlend',
          ...Array.from({ length: PER_PASS }, (_, k) => `o${k}`),
        ]),
        norm: program(gl, normFrag, [
          'accA',
          'accB',
          'alphaBlend',
          'colorBlend',
        ]),
        vao: gl.createVertexArray(),
        fbo: gl.createFramebuffer(),
      }
    : null
}

/** Release this context's blend programs, VAO and framebuffer. */
export function destroyBlendOverlaysGL(gl: WebGL2RenderingContext): void {
  const c = _cache.get(gl)
  _cache.delete(gl)
  if (!c) return
  gl.deleteProgram(c.accum.program)
  gl.deleteProgram(c.norm.program)
  gl.deleteVertexArray(c.vao)
  gl.deleteFramebuffer(c.fbo)
}

function floatTarget(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
): WebGLTexture {
  const t = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  return t
}

/**
 * Blend `overlays` (RGBA8 3D textures of size `dims`) into a new RGBA8 3D
 * texture with the overlay alpha and colour modes, entirely on the GPU.
 * Restores the GL state it touches. Null when this context cannot (no float
 * render targets, a shader or framebuffer the driver rejects): blend on the
 * CPU then; after one rejection every later call returns null at once.
 */
export function blendOverlaysGL(
  gl: WebGL2RenderingContext,
  overlays: WebGLTexture[],
  dims: readonly number[],
  alphaBlend: number,
  colorBlend: number,
): WebGLTexture | null {
  const c = cacheFor(gl)
  if (!c) return null
  const [w, h, d] = dims
  const saved = {
    fbo: gl.getParameter(gl.FRAMEBUFFER_BINDING),
    viewport: gl.getParameter(gl.VIEWPORT) as Int32Array,
    program: gl.getParameter(gl.CURRENT_PROGRAM),
    vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    active: gl.getParameter(gl.ACTIVE_TEXTURE) as number,
    blend: gl.isEnabled(gl.BLEND),
    depth: gl.isEnabled(gl.DEPTH_TEST),
    cull: gl.isEnabled(gl.CULL_FACE),
    scissor: gl.isEnabled(gl.SCISSOR_TEST),
  }
  const out = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_3D, out)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, w, h, d)
  // [A, B] ping and pong.
  const acc = [
    [floatTarget(gl, w, h), floatTarget(gl, w, h)],
    [floatTarget(gl, w, h), floatTarget(gl, w, h)],
  ]
  gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo)
  gl.bindVertexArray(c.vao)
  gl.viewport(0, 0, w, h)
  gl.disable(gl.BLEND)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)
  gl.disable(gl.SCISSOR_TEST)
  const attach = (a: WebGLTexture, b: WebGLTexture | null): void => {
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      a,
      0,
    )
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      b,
      0,
    )
    gl.drawBuffers(
      b ? [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1] : [gl.COLOR_ATTACHMENT0],
    )
  }
  const bindAcc = (pair: WebGLTexture[]): void => {
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, pair[0])
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, pair[1])
  }
  gl.useProgram(c.accum.program)
  gl.uniform1i(c.accum.u.accA, 0)
  gl.uniform1i(c.accum.u.accB, 1)
  for (let k = 0; k < PER_PASS; k++) gl.uniform1i(c.accum.u[`o${k}`], 2 + k)
  gl.uniform1i(c.accum.u.colorBlend, colorBlend)
  gl.useProgram(c.norm.program)
  gl.uniform1i(c.norm.u.accA, 0)
  gl.uniform1i(c.norm.u.accB, 1)
  gl.uniform1i(c.norm.u.alphaBlend, alphaBlend)
  gl.uniform1i(c.norm.u.colorBlend, colorBlend)
  const zero = new Float32Array(4)
  attach(acc[0][0], acc[0][1])
  const complete =
    gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  for (let z = 0; complete && z < d; z++) {
    let cur = 0
    attach(acc[cur][0], acc[cur][1])
    gl.clearBufferfv(gl.COLOR, 0, zero)
    gl.clearBufferfv(gl.COLOR, 1, zero)
    gl.useProgram(c.accum.program)
    gl.uniform1i(c.accum.u.z, z)
    // Passes run in overlay order, as does each one (colour OVER).
    for (let first = 0; first < overlays.length; first += PER_PASS) {
      const batch = overlays.slice(first, first + PER_PASS)
      bindAcc(acc[cur])
      batch.forEach((tex, k) => {
        gl.activeTexture(gl.TEXTURE2 + k)
        gl.bindTexture(gl.TEXTURE_3D, tex)
      })
      gl.uniform1i(c.accum.u.count, batch.length)
      attach(acc[1 - cur][0], acc[1 - cur][1])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      cur = 1 - cur
    }
    gl.useProgram(c.norm.program)
    bindAcc(acc[cur])
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, out, 0, z)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      null,
      0,
    )
    gl.drawBuffers([gl.COLOR_ATTACHMENT0])
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  for (const pair of acc) for (const t of pair) gl.deleteTexture(t)
  if (!complete) {
    // The driver rejects float targets here: the CPU blend from now on.
    log.warn('blendOverlaysGL: framebuffer incomplete, blending on the CPU')
    gl.deleteTexture(out)
    destroyBlendOverlaysGL(gl)
    _cache.set(gl, null)
  }
  for (let k = 0; k < PER_PASS; k++) {
    gl.activeTexture(gl.TEXTURE2 + k)
    gl.bindTexture(gl.TEXTURE_3D, null)
  }
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, null)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, null)
  gl.bindTexture(gl.TEXTURE_3D, null)
  gl.bindFramebuffer(gl.FRAMEBUFFER, saved.fbo)
  gl.viewport(
    saved.viewport[0],
    saved.viewport[1],
    saved.viewport[2],
    saved.viewport[3],
  )
  gl.useProgram(saved.program)
  gl.bindVertexArray(saved.vao)
  gl.activeTexture(saved.active)
  if (saved.blend) gl.enable(gl.BLEND)
  if (saved.depth) gl.enable(gl.DEPTH_TEST)
  if (saved.cull) gl.enable(gl.CULL_FACE)
  if (saved.scissor) gl.enable(gl.SCISSOR_TEST)
  return complete ? out : null
}
