import { log } from '@/logger'
import {
  CLUSTER_SIZE,
  clustersCrossingPlanes,
  meshClusters,
  sortedIndices,
  type TriangleClusters,
} from '@/mesh/triangleClusters'
import { BYTES_PER_VERTEX, packMeshVertices } from '@/mesh/vertexFormat'
import type { NVMesh, WebGLMeshGPU } from '@/NVTypes'
import {
  meshDepthPickFragmentShader,
  meshDepthPickVertexShader,
} from './depthPickShader'
import {
  fragmentShaders,
  meshVertCrosscut2,
  meshVertShader,
  meshVertShaderFlat,
} from './meshShader'
import { Shader } from './shader'

type ShaderMap = Record<string, Shader>

interface MeshShaderCache {
  shaders: ShaderMap
  depthPickShader: Shader
}

const _contextCache = new WeakMap<WebGL2RenderingContext, MeshShaderCache>()

export function init(gl: WebGL2RenderingContext): void {
  if (_contextCache.has(gl)) return
  const shaders: ShaderMap = {}
  for (const [name, fragSrc] of Object.entries(fragmentShaders)) {
    const vertSrc =
      name === 'flat'
        ? meshVertShaderFlat
        : name === 'crosscut2'
          ? meshVertCrosscut2
          : meshVertShader
    shaders[name] = new Shader(gl, vertSrc, fragSrc)
  }
  const depthPickShader = new Shader(
    gl,
    meshDepthPickVertexShader,
    meshDepthPickFragmentShader,
  )
  _contextCache.set(gl, { shaders, depthPickShader })
}

export function getAttributeLocations(
  gl: WebGL2RenderingContext,
  shaderType = 'phong',
): { aPosition: number; aNormal: number; aColor: number } {
  const cache = _contextCache.get(gl)
  if (!cache) throw new Error('mesh.init() not called for this context')
  const shader = cache.shaders[shaderType] || cache.shaders.phong
  if (!shader) {
    throw new Error(`Shader ${shaderType} not initialized`)
  }
  return {
    aPosition: gl.getAttribLocation(shader.program, 'position'),
    aNormal: gl.getAttribLocation(shader.program, 'normal'),
    aColor: gl.getAttribLocation(shader.program, 'color'),
  }
}

function createMeshGpu(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  shaderType: string,
): WebGLMeshGPU {
  const vertexData = packMeshVertices(meshData)
  // Create VAO
  const vao = gl.createVertexArray()
  if (!vao) {
    throw new Error('Failed to create mesh VAO')
  }
  gl.bindVertexArray(vao)
  // Create and upload vertex buffer
  const vertexBuffer = gl.createBuffer()
  if (!vertexBuffer) {
    gl.bindVertexArray(null)
    throw new Error('Failed to create mesh vertex buffer')
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW)
  // Get attribute locations from the selected shader (all shaders share same vertex layout)
  const cache = _contextCache.get(gl)
  if (!cache) throw new Error('mesh.init() not called for this context')
  // crosscut2 has no per-vertex attributes; locations are pinned, so any
  // triangle shader reports the same ones.
  const shader =
    (shaderType !== 'crosscut2' && cache.shaders[shaderType]) ||
    cache.shaders.phong
  if (!shader) {
    throw new Error(`Missing shader for type ${shaderType}`)
  }
  const aPosition = gl.getAttribLocation(shader.program, 'position')
  const aNormal = gl.getAttribLocation(shader.program, 'normal')
  const aColor = gl.getAttribLocation(shader.program, 'color')
  // Set up vertex attributes (interleaved, 28 bytes stride)
  // position: vec3 at offset 0
  gl.enableVertexAttribArray(aPosition)
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 28, 0)
  // normal: vec3 at offset 12
  gl.enableVertexAttribArray(aNormal)
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 28, 12)
  // color: vec4 (unorm8x4) at offset 24
  gl.enableVertexAttribArray(aColor)
  gl.vertexAttribPointer(aColor, 4, gl.UNSIGNED_BYTE, true, 28, 24)
  // Create and upload index buffer
  const indexBuffer = gl.createBuffer()
  if (!indexBuffer) {
    gl.bindVertexArray(null)
    throw new Error('Failed to create mesh index buffer')
  }
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, meshData.indices, gl.STATIC_DRAW)
  gl.bindVertexArray(null)
  return {
    vao,
    vertexBuffer,
    indexBuffer,
    indexCount: meshData.indices.length,
    vertexBytes: vertexData.byteLength,
  }
}

export function uploadMeshGPU(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  options: Record<string, unknown> = {},
): WebGLMeshGPU & { shaderType?: string; sliceShaderType?: string } {
  const { shaderType = 'phong', sliceShaderType = '' } = options as {
    shaderType?: string
    sliceShaderType?: string
  }
  const gpu = createMeshGpu(gl, meshData, shaderType)
  return { ...gpu, shaderType, sliceShaderType }
}

// Per-mesh staging buffer for live vertex updates, so animating a mesh does
// not allocate a fresh interleaved buffer every frame. Safe to reuse: the
// upload copies the data before returning.
const _staging = new WeakMap<WebGLMeshGPU, ArrayBuffer>()

function stagingFor(gpu: WebGLMeshGPU, meshData: NVMesh): ArrayBuffer {
  const packed = packMeshVertices(meshData, _staging.get(gpu))
  _staging.set(gpu, packed)
  return packed
}

/**
 * Rewrite an existing mesh's vertex buffer in place from `meshData`. Used for
 * live vertex updates, which would otherwise rebuild every mesh's GPU
 * resources. Returns false (nothing written) when the vertex count no longer
 * matches the buffer, so the caller can fall back to a full rebuild.
 */
export function writeMeshVertices(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  gpu: WebGLMeshGPU,
): boolean {
  if (!gpu.vertexBuffer) return false
  const bytes = (meshData.positions.length / 3) * BYTES_PER_VERTEX
  if (gpu.vertexBytes !== bytes) return false
  gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vertexBuffer)
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, stagingFor(gpu, meshData))
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  const cc = _crosscut2.get(gpu)
  if (cc) cc.isStale = true
  return true
}

// crosscut2 reads vertices by index, which WebGL2 can only do from a texture.
// Built on first use, so meshes never drawn with crosscut2 pay nothing.
type Crosscut2Gpu = {
  vertWords: WebGLTexture
  /** Triangle indices in cluster order, read by triangle number. */
  triWords: WebGLTexture
  /** Per-draw cluster list: one uint per CLUSTER_SIZE instances. */
  listBuffer: WebGLBuffer
  vao: WebGLVertexArrayObject
  isStale: boolean
  /** The cluster build `triWords` holds. */
  clusters: TriangleClusters | null
}
const _crosscut2 = new WeakMap<WebGLMeshGPU, Crosscut2Gpu>()
// Meshes too large for the textures: warned once, then skipped.
const _tooLarge = new WeakSet<WebGLMeshGPU>()

// Fill an R32UI texture (up to MAX_TEXTURE_SIZE wide) with `count` words from
// a GL buffer (copied on the GPU, no CPU readback) or an array. Full rows go
// in one upload and the partial last row in another, so neither source is
// read past its end.
function uploadWordTexture(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  count: number,
  src: WebGLBuffer | Uint32Array,
): boolean {
  const maxW = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
  const width = Math.max(1, Math.min(count, maxW))
  const rows = Math.ceil(count / width)
  if (rows > maxW) return false
  const fullRows = Math.floor(count / width)
  const rest = count - fullRows * width
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32UI,
    width,
    rows,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_INT,
    null,
  )
  // Integer textures are incomplete (texelFetch reads 0) unless unfiltered.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  const fromArray = src instanceof Uint32Array
  if (!fromArray) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, src)
  const upload = (y: number, w: number, h: number, word: number) => {
    if (fromArray) {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        y,
        w,
        h,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        src,
        word,
      )
    } else {
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        y,
        w,
        h,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        word * 4,
      )
    }
  }
  if (fullRows > 0) upload(0, width, fullRows, 0)
  if (rest > 0) upload(fullRows, rest, 1, fullRows * width)
  if (!fromArray) gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null)
  return true
}

function crosscut2Gpu(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  gpu: WebGLMeshGPU,
): Crosscut2Gpu | null {
  if (_tooLarge.has(gpu)) return null
  let cc = _crosscut2.get(gpu)
  if (!cc) {
    const vertWords = gl.createTexture()
    const triWords = gl.createTexture()
    const listBuffer = gl.createBuffer()
    const vao = gl.createVertexArray()
    if (!vertWords || !triWords || !listBuffer || !vao) return null
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, listBuffer)
    // Location 0: drawing with attribute 0 disabled is emulated (slowly) on
    // desktop GL. Divisor CLUSTER_SIZE: one list entry per cluster of
    // instances, so instance k draws triangle k % CLUSTER_SIZE of its cluster.
    gl.enableVertexAttribArray(0)
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0)
    gl.vertexAttribDivisor(0, CLUSTER_SIZE)
    gl.bindVertexArray(null)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    cc = { vertWords, triWords, listBuffer, vao, isStale: true, clusters: null }
    _crosscut2.set(gpu, cc)
  }
  if (cc.isStale) {
    const words = (gpu.vertexBytes ?? 0) / 4
    if (
      !gpu.vertexBuffer ||
      !uploadWordTexture(gl, cc.vertWords, words, gpu.vertexBuffer)
    ) {
      log.warn('crosscut2: mesh too large for a vertex texture')
      _tooLarge.add(gpu)
      return null
    }
    cc.isStale = false
  }
  const clusters = meshClusters(meshData)
  if (cc.clusters !== clusters) {
    // The main index buffer keeps the file's order: crosscut2 reads its
    // triangles from this texture, so other shaders are left untouched.
    const sorted = sortedIndices(meshData.indices, clusters.order)
    if (!uploadWordTexture(gl, cc.triWords, sorted.length, sorted)) {
      log.warn('crosscut2: mesh too large for an index texture')
      _tooLarge.add(gpu)
      return null
    }
    cc.clusters = clusters
  }
  return cc
}

function destroyCrosscut2(gl: WebGL2RenderingContext, gpu: WebGLMeshGPU): void {
  const cc = _crosscut2.get(gpu)
  if (!cc) return
  gl.deleteTexture(cc.vertWords)
  gl.deleteTexture(cc.triWords)
  gl.deleteBuffer(cc.listBuffer)
  gl.deleteVertexArray(cc.vao)
  _crosscut2.delete(gpu)
}

/**
 * Draw the mesh's outline where it meets the cut planes in `ccPlanes` (see
 * `crosscutPlanes`). Only clusters whose bounds cross a plane are drawn: one
 * instance per triangle of those clusters, six vertices each.
 */
function drawCrosscut2(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  gpu: WebGLMeshGPU,
  shader: Shader,
  ccPlanes: Float32Array,
): void {
  if (ccPlanes[14] <= 0) return // zero width: draw nothing, like crosscut
  const cc = crosscut2Gpu(gl, meshData, gpu)
  if (!cc?.clusters) return
  const entries = clustersCrossingPlanes(cc.clusters, ccPlanes)
  if (entries.length === 0) return
  gl.bindBuffer(gl.ARRAY_BUFFER, cc.listBuffer)
  gl.bufferData(gl.ARRAY_BUFFER, entries, gl.STREAM_DRAW)
  gl.bindBuffer(gl.ARRAY_BUFFER, null)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, cc.vertWords)
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, cc.triWords)
  gl.activeTexture(gl.TEXTURE0)
  if (shader.uniforms.vertWords) gl.uniform1i(shader.uniforms.vertWords, 0)
  if (shader.uniforms.triWords) gl.uniform1i(shader.uniforms.triWords, 1)
  gl.disable(gl.DEPTH_TEST)
  gl.disable(gl.CULL_FACE)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.bindVertexArray(cc.vao)
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, entries.length * CLUSTER_SIZE)
  gl.bindVertexArray(null)
  gl.enable(gl.DEPTH_TEST)
  gl.enable(gl.CULL_FACE)
}

export function useShader(
  gl: WebGL2RenderingContext,
  shaderType: string,
  mvpMatrix: Float32Array,
  normalMatrix: Float32Array,
  opacity = 1.0,
): void {
  const cache = _contextCache.get(gl)
  if (!cache) return
  const shader = cache.shaders[shaderType]
  if (!shader) return
  shader.use(gl)
  if (shader.uniforms.mvpMtx)
    gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
  if (shader.uniforms.normMtx)
    gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
  if (shader.uniforms.opacity) gl.uniform1f(shader.uniforms.opacity, opacity)
}

export function drawWithGpu(
  gl: WebGL2RenderingContext,
  mesh: NVMesh,
  gpu: WebGLMeshGPU,
  mvpMatrix: Float32Array,
  normalMatrix: Float32Array,
  opacity = 1.0,
  shaderTypeOverride?: string,
  crosscutMM?: number[],
  ccPlanes?: Float32Array,
): void {
  const cache = _contextCache.get(gl)
  if (!cache) return
  const shaderType = shaderTypeOverride || mesh.shaderType || 'phong'
  const shader = cache.shaders[shaderType]
  if (!shader) {
    log.warn(`Unknown mesh shader type: ${shaderType}`)
    return
  }
  shader.use(gl)
  // Set uniforms
  if (shader.uniforms.mvpMtx)
    gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
  if (shader.uniforms.normMtx)
    gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
  if (shader.uniforms.opacity) gl.uniform1f(shader.uniforms.opacity, opacity)
  if (shader.uniforms.crosscutMM && crosscutMM)
    gl.uniform4fv(shader.uniforms.crosscutMM, crosscutMM)
  if (shader.uniforms.ccPlanes && ccPlanes)
    gl.uniformMatrix4fv(shader.uniforms.ccPlanes, false, ccPlanes)
  if (shaderType === 'crosscut2') {
    if (ccPlanes) drawCrosscut2(gl, mesh, gpu, shader, ccPlanes)
    return
  }
  // Set up state for mesh rendering
  const isCrosscut = shaderType === 'crosscut'
  if (isCrosscut) {
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
  } else {
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
  }
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  // Draw
  gl.bindVertexArray(gpu.vao)
  gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0)
  gl.bindVertexArray(null)
  if (isCrosscut) {
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
  }
}

export function drawXRay(
  gl: WebGL2RenderingContext,
  mesh: NVMesh,
  gpu: WebGLMeshGPU,
  mvpMatrix: Float32Array,
  normalMatrix: Float32Array,
  opacity = 1.0,
  shaderTypeOverride?: string,
  crosscutMM?: number[],
  ccPlanes?: Float32Array,
): void {
  const cache = _contextCache.get(gl)
  if (!cache) return
  const shaderType = shaderTypeOverride || mesh.shaderType || 'phong'
  // crosscut2 ignores depth, so the main pass already drew all of it.
  if (shaderType === 'crosscut2') return
  const shader = cache.shaders[shaderType]
  if (!shader) return
  shader.use(gl)
  if (shader.uniforms.mvpMtx)
    gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
  if (shader.uniforms.normMtx)
    gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
  if (shader.uniforms.opacity) gl.uniform1f(shader.uniforms.opacity, opacity)
  if (shader.uniforms.crosscutMM && crosscutMM)
    gl.uniform4fv(shader.uniforms.crosscutMM, crosscutMM)
  if (shader.uniforms.ccPlanes && ccPlanes)
    gl.uniformMatrix4fv(shader.uniforms.ccPlanes, false, ccPlanes)
  const isCrosscut = shaderType === 'crosscut'
  if (isCrosscut) {
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
  } else {
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.GREATER)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
  }
  gl.depthMask(false)
  gl.enable(gl.BLEND)
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
  gl.bindVertexArray(gpu.vao)
  gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0)
  gl.bindVertexArray(null)
  gl.depthFunc(gl.LESS)
  gl.depthMask(true)
  if (isCrosscut) {
    gl.enable(gl.DEPTH_TEST)
    gl.enable(gl.CULL_FACE)
  }
}

export function drawDepthPick(
  gl: WebGL2RenderingContext,
  gpu: WebGLMeshGPU,
  mvpMatrix: Float32Array,
): void {
  const cache = _contextCache.get(gl)
  if (!cache) return
  cache.depthPickShader.use(gl)
  if (cache.depthPickShader.uniforms.mvpMtx)
    gl.uniformMatrix4fv(cache.depthPickShader.uniforms.mvpMtx, false, mvpMatrix)
  gl.disable(gl.BLEND)
  gl.enable(gl.DEPTH_TEST)
  gl.depthFunc(gl.LESS)
  gl.enable(gl.CULL_FACE)
  gl.cullFace(gl.BACK)
  gl.bindVertexArray(gpu.vao)
  gl.drawElements(gl.TRIANGLES, gpu.indexCount, gl.UNSIGNED_INT, 0)
  gl.bindVertexArray(null)
}

export function destroyMeshGpu(
  gl: WebGL2RenderingContext,
  gpu: WebGLMeshGPU,
): void {
  destroyCrosscut2(gl, gpu)
  if (gpu.vao) {
    gl.deleteVertexArray(gpu.vao)
  }
  if (gpu.vertexBuffer) {
    gl.deleteBuffer(gpu.vertexBuffer)
  }
  if (gpu.indexBuffer) {
    gl.deleteBuffer(gpu.indexBuffer)
  }
}

export function destroy(gl: WebGL2RenderingContext): void {
  const cache = _contextCache.get(gl)
  if (!cache) return
  for (const shader of Object.values(cache.shaders)) {
    if (shader?.program) {
      gl.deleteProgram(shader.program)
    }
  }
  if (cache.depthPickShader?.program) {
    gl.deleteProgram(cache.depthPickShader.program)
  }
  _contextCache.delete(gl)
}
