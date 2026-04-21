import { log } from '@/logger'
import * as NVMeshUtils from '@/mesh/NVMesh'
import type { NVMesh, WebGLMeshGPU } from '@/NVTypes'
import { BYTES_PER_VERTEX } from '@/view/NVCrosshair'
import { buildCylinderMeshData, buildSphereMeshData } from '@/view/NVMeshView'
import {
  meshDepthPickFragmentShader,
  meshDepthPickVertexShader,
} from './depthPickShader'
import {
  fragmentShaders,
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
    const vertSrc = name === 'flat' ? meshVertShaderFlat : meshVertShader
    shaders[name] = new Shader(gl, vertSrc, fragSrc)
  }
  const depthPickShader = new Shader(
    gl,
    meshDepthPickVertexShader,
    meshDepthPickFragmentShader,
  )
  _contextCache.set(gl, { shaders, depthPickShader })
}

export function isReady(gl: WebGL2RenderingContext): boolean {
  return _contextCache.has(gl)
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

export function loadSphereMesh(
  gl: WebGL2RenderingContext,
  origin: number[] = [1, 1, 1],
  radius = 1,
  color: number[] = [1, 1, 1, 1],
  subdivisions = 2,
): NVMesh {
  return createMeshBuffers(
    gl,
    buildSphereMeshData(origin, radius, color, subdivisions),
  )
}

export function loadCylinderMesh(
  gl: WebGL2RenderingContext,
  start: number[],
  dest: number[],
  radius: number,
  color: number[] = [1, 1, 1, 1],
  sides = 20,
  endcaps = true,
): NVMesh {
  return createMeshBuffers(
    gl,
    buildCylinderMeshData(start, dest, radius, color, sides, endcaps),
  )
}

function createMeshGpu(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  shaderType: string,
): WebGLMeshGPU {
  const normals = NVMeshUtils.generateNormals(
    meshData.positions,
    meshData.indices,
  )
  const numVerts = meshData.positions.length / 3
  // Interleaved vertex data: pos(3) + norm(3) + color(1 as u32) = 28 bytes per vertex
  const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX)
  const f32 = new Float32Array(vertexData)
  const u32 = new Uint32Array(vertexData)
  for (let i = 0; i < numVerts; i++) {
    const offset = (i * 28) / 4 // offset in 4-byte units
    f32[offset] = meshData.positions[i * 3] ?? 0
    f32[offset + 1] = meshData.positions[i * 3 + 1] ?? 0
    f32[offset + 2] = meshData.positions[i * 3 + 2] ?? 0
    f32[offset + 3] = normals[i * 3] ?? 0
    f32[offset + 4] = normals[i * 3 + 1] ?? 0
    f32[offset + 5] = normals[i * 3 + 2] ?? 0
    u32[offset + 6] =
      meshData.colors instanceof Uint32Array
        ? meshData.colors[i]
        : meshData.colors
  }
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
  const shader = cache.shaders[shaderType] || cache.shaders.phong
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
  }
}

export function createMeshBuffers(
  _gl: WebGL2RenderingContext,
  meshData: Omit<NVMesh, 'layers' | 'perVertexColors'> &
    Partial<Pick<NVMesh, 'layers' | 'perVertexColors'>>,
  options: Record<string, unknown> = {},
): NVMesh {
  const { shaderType = 'phong' } = options as { shaderType?: string }
  const mesh = meshData as NVMesh
  mesh.opacity = mesh.opacity ?? 1
  mesh.shaderType = shaderType
  mesh.layers ??= []
  mesh.perVertexColors ??= null
  Object.assign(mesh, options)
  return mesh
}

export function uploadMeshGPU(
  gl: WebGL2RenderingContext,
  meshData: NVMesh,
  options: Record<string, unknown> = {},
): WebGLMeshGPU & { shaderType?: string } {
  const { shaderType = 'phong' } = options as { shaderType?: string }
  const gpu = createMeshGpu(gl, meshData, shaderType)
  return { ...gpu, shaderType }
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
): void {
  const cache = _contextCache.get(gl)
  if (!cache) return
  const shaderType = shaderTypeOverride || mesh.shaderType || 'phong'
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
