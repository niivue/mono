import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import { isPaqd } from '@/NVConstants'
import { applyCORS } from '@/NVLoader'
import type { NVImage } from '@/NVTypes'
import { blendOverlayData } from '@/view/NVMeshView'
import { NVRenderer } from '@/view/NVRenderer'
import { buildPaqdLut256, paqdResampleRaw, reorientRGBA } from '@/volume/utils'
import * as depthPickShader from './depthPickShader'
import * as gradient from './gradient'
import * as orientOverlay from './orientOverlay'
import * as renderShader from './renderShader'
import { Shader } from './shader'

export class VolumeRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null
  shader: Shader | null
  depthPickShaderProgram: Shader | null
  matcapTexture: WebGLTexture | null
  volumeTexture: WebGLTexture | null
  volumeGradientTexture: WebGLTexture | null
  overlayTexture: WebGLTexture | null
  paqdTexture: WebGLTexture | null
  paqdLutTexture: WebGLTexture | null
  drawingTexture: WebGLTexture | null
  drawingLinearSampler: WebGLSampler | null
  placeholderOverlay: WebGLTexture | null
  cubeVAO: WebGLVertexArrayObject | null
  vertexBuffer: WebGLBuffer | null
  indexBuffer: WebGLBuffer | null
  cube: { vertices: number[]; indices: number[] }
  max3D: number

  constructor() {
    super()
    this._gl = null
    this.shader = null
    this.depthPickShaderProgram = null
    this.matcapTexture = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.paqdTexture = null
    this.paqdLutTexture = null
    this.drawingTexture = null
    this.drawingLinearSampler = null
    this.placeholderOverlay = null
    this.cubeVAO = null
    this.vertexBuffer = null
    this.indexBuffer = null
    this.cube = NVShapes.getCubeMesh()
    this.max3D = 0
  }

  async init(gl: WebGL2RenderingContext, max3D: number): Promise<void> {
    if (this.isReady) return
    this._gl = gl

    this.max3D = max3D

    // Create cube VAO
    this.cubeVAO = gl.createVertexArray()
    gl.bindVertexArray(this.cubeVAO)

    // Vertex buffer
    this.vertexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array(this.cube.vertices),
      gl.STATIC_DRAW,
    )

    // Position attrib at location 0
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

    // Index buffer
    this.indexBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array(this.cube.indices),
      gl.STATIC_DRAW,
    )

    gl.bindVertexArray(null)

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = gl.createTexture()
    if (this.placeholderOverlay) {
      gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      const emptyData = new Uint8Array(2 * 2 * 2 * 4) // 32 bytes, all zeros
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA,
        2,
        2,
        2,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        emptyData,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }

    // Compile volume rendering shader
    this.shader = new Shader(
      gl,
      renderShader.vertexShader,
      renderShader.fragmentShader,
    )
    // Fix uniform array locations (Shader class doesn't handle arrays correctly)
    this.shader.uniforms.clipPlanes = gl.getUniformLocation(
      this.shader.program,
      'clipPlanes[0]',
    )

    // Compile depth-pick shader for depth picking
    this.depthPickShaderProgram = new Shader(
      gl,
      depthPickShader.depthPickVertexShader,
      depthPickShader.depthPickFragmentShader,
    )
    this.depthPickShaderProgram.uniforms.clipPlanes = gl.getUniformLocation(
      this.depthPickShaderProgram.program,
      'clipPlanes[0]',
    )

    this.isReady = true
  }

  private _createFallbackTexture2D(gl: WebGL2RenderingContext): WebGLTexture {
    const texture = gl.createTexture() as WebGLTexture
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
  }

  private async _loadTexture2D(
    gl: WebGL2RenderingContext,
    imageSrc: string,
  ): Promise<WebGLTexture> {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const texture = gl.createTexture()
        if (!texture) {
          reject(new Error('Failed to create texture'))
          return
        }
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          image,
        )
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.bindTexture(gl.TEXTURE_2D, null)
        resolve(texture)
      }
      image.onerror = reject
      applyCORS(image)
      image.src = imageSrc
    })
  }

  private async _loadTexture2DOrFallback(
    gl: WebGL2RenderingContext,
    imageSrc: string,
  ): Promise<WebGLTexture> {
    if (!imageSrc) return this._createFallbackTexture2D(gl)
    return this._loadTexture2D(gl, imageSrc)
  }

  async updateVolume(
    gl: WebGL2RenderingContext,
    vol: NVImage,
    matcap: string = '',
  ): Promise<void> {
    if (!this.isReady) return

    const dimMax = Math.max(
      Math.max(vol.hdr.dims[1], vol.hdr.dims[2]),
      vol.hdr.dims[3],
    )
    if (dimMax > this.max3D) {
      log.warn(
        `${dimMax} exceeds the max3D (${this.max3D}) of this WebGL2 context`,
      )
    }

    // Create volumeTexture using orientOverlay
    const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
    if (this.volumeTexture) {
      gl.deleteTexture(this.volumeTexture)
    }
    this.volumeTexture = await orientOverlay.overlay2Texture(
      gl,
      vol,
      vol,
      mtx as Float32Array,
      0,
    )
    gl.bindTexture(gl.TEXTURE_3D, null)

    // Load matcap texture
    if (this.matcapTexture) {
      gl.deleteTexture(this.matcapTexture)
    }
    this.matcapTexture = await this._loadTexture2DOrFallback(gl, matcap)

    // Create gradient texture from volume
    const dims = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    if (this.volumeGradientTexture) {
      gl.deleteTexture(this.volumeGradientTexture)
    }
    this.volumeGradientTexture = gradient.volume2TextureGradientRGBA(
      gl,
      this.volumeTexture,
      dims as [number, number, number],
    )
  }

  async updateOverlays(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    overlayVols: NVImage[],
    _paqdUniforms: readonly number[] = [0, 0, 0, 0],
  ): Promise<void> {
    if (!this.isReady) return
    this.clearOverlay(gl)
    this.clearPaqd(gl)

    if (!baseVol.dimsRAS) return
    const dimsOut = [baseVol.dimsRAS[1], baseVol.dimsRAS[2], baseVol.dimsRAS[3]]

    // Filter out overlays with zero opacity
    const visible = overlayVols.filter((v) => (v.opacity ?? 1) > 0)
    if (visible.length === 0) return

    // Separate PAQD from standard overlays
    const paqdVols = visible.filter((v) => isPaqd(v.hdr) && v.colormapLabel)
    const standardVols = visible.filter((v) => !isPaqd(v.hdr))

    // Upload first PAQD as raw data + LUT texture (GPU shaders do LUT lookup + easing)
    if (paqdVols.length > 0) {
      const vol = paqdVols[0]
      if (
        vol.img &&
        vol.dimsRAS &&
        vol.img2RASstep &&
        vol.img2RASstart &&
        vol.colormapLabel
      ) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
        const isRAS =
          vol.img2RASstep[0] === 1 &&
          vol.img2RASstep[1] === vol.dimsRAS[1] &&
          vol.img2RASstep[2] === vol.dimsRAS[1] * vol.dimsRAS[2]
        let raw = new Uint8Array(
          vol.img.buffer,
          vol.img.byteOffset,
          vol.img.byteLength,
        )
        if (!isRAS) {
          raw = reorientRGBA(
            raw,
            4,
            vol.dimsRAS,
            vol.img2RASstart,
            vol.img2RASstep,
          )
        }
        const ovDims = [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
        const paqdData = paqdResampleRaw(
          raw,
          dimsOut,
          ovDims,
          mtx as Float32Array,
        )
        // Upload raw PAQD 3D texture (nearest-neighbor)
        this.paqdTexture = gl.createTexture()
        if (this.paqdTexture) {
          gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture)
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
          gl.texImage3D(
            gl.TEXTURE_3D,
            0,
            gl.RGBA8,
            dimsOut[0],
            dimsOut[1],
            dimsOut[2],
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            paqdData,
          )
          gl.bindTexture(gl.TEXTURE_3D, null)
        }
        // Upload 256-entry padded LUT as 2D texture (nearest-neighbor)
        const lutMin = vol.colormapLabel.min ?? 0
        const lut256 = buildPaqdLut256(vol.colormapLabel.lut, lutMin)
        this.paqdLutTexture = gl.createTexture()
        if (this.paqdLutTexture) {
          gl.bindTexture(gl.TEXTURE_2D, this.paqdLutTexture)
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            256,
            1,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            lut256,
          )
          gl.bindTexture(gl.TEXTURE_2D, null)
        }
      }
    }

    // Upload standard overlays
    if (standardVols.length === 1) {
      const vol = standardVols[0]
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
      this.overlayTexture = orientOverlay.overlay2Texture(
        gl,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    } else if (standardVols.length > 1) {
      const overlayData: Uint8Array[] = []
      for (const vol of standardVols) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
        const tex = orientOverlay.overlay2Texture(
          gl,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
        )
        const data = orientOverlay.readTexture3D(gl, tex, dimsOut)
        gl.deleteTexture(tex)
        overlayData.push(data)
      }
      const blended = blendOverlayData(overlayData, dimsOut)
      this.overlayTexture = gl.createTexture()
      if (!this.overlayTexture) return
      gl.bindTexture(gl.TEXTURE_3D, this.overlayTexture)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA8,
        dimsOut[0],
        dimsOut[1],
        dimsOut[2],
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        blended,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }
  }

  clearOverlay(gl: WebGL2RenderingContext): void {
    if (this.overlayTexture) {
      gl.deleteTexture(this.overlayTexture)
      this.overlayTexture = null
    }
  }

  clearPaqd(gl: WebGL2RenderingContext): void {
    if (this.paqdTexture) {
      gl.deleteTexture(this.paqdTexture)
      this.paqdTexture = null
    }
    if (this.paqdLutTexture) {
      gl.deleteTexture(this.paqdLutTexture)
      this.paqdLutTexture = null
    }
  }

  draw(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    normalMatrix: Float32Array,
    matRAS: Float32Array,
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway = false,
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
  ): void {
    if (!this.isReady || !this.shader || !this.cubeVAO || !this.indexBuffer)
      return
    if (
      !this.volumeTexture ||
      !this.matcapTexture ||
      !this.volumeGradientTexture
    )
      return

    const shader = this.shader
    const indexCount = this.cube.indices.length

    // 1. Use the program
    shader.use(gl)

    // 2. Bind the Textures
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture)
    if (shader.uniforms.volume) {
      gl.uniform1i(shader.uniforms.volume, 0)
    }

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.matcapTexture)
    if (shader.uniforms.matcap) {
      gl.uniform1i(shader.uniforms.matcap, 1)
    }

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_3D, this.volumeGradientTexture)
    if (shader.uniforms.volumeGradient) {
      gl.uniform1i(shader.uniforms.volumeGradient, 2)
    }

    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.overlayTexture || this.placeholderOverlay,
    )
    if (shader.uniforms.overlay) {
      gl.uniform1i(shader.uniforms.overlay, 3)
    }

    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture || this.placeholderOverlay)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (shader.uniforms.paqd) {
      gl.uniform1i(shader.uniforms.paqd, 4)
    }

    // Bind drawing texture to unit 5 (nearest-neighbor)
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.drawingTexture || this.placeholderOverlay,
    )
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (shader.uniforms.drawing) {
      gl.uniform1i(shader.uniforms.drawing, 5)
    }

    // Bind drawing texture a second time at unit 7, via a LINEAR sampler
    // object so we can take trilinearly-filtered samples of the same
    // texture for smooth gradient computation at first-hit (unit 5 keeps
    // NEAREST filtering for the categorical ray-march).
    if (!this.drawingLinearSampler) {
      const s = gl.createSampler()
      if (s) {
        gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        gl.samplerParameteri(s, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
        this.drawingLinearSampler = s
      }
    }
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.drawingTexture || this.placeholderOverlay,
    )
    gl.bindSampler(7, this.drawingLinearSampler)
    if (shader.uniforms.drawingLinear) {
      gl.uniform1i(shader.uniforms.drawingLinear, 7)
    }

    // Bind PAQD LUT to unit 6 (nearest-neighbor 2D texture)
    gl.activeTexture(gl.TEXTURE6)
    if (this.paqdLutTexture) {
      gl.bindTexture(gl.TEXTURE_2D, this.paqdLutTexture)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, null)
    }
    if (shader.uniforms.paqdLut) {
      gl.uniform1i(shader.uniforms.paqdLut, 6)
    }

    // 3. Upload Uniforms
    if (shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    if (shader.uniforms.normMtx)
      gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
    if (shader.uniforms.matRAS)
      gl.uniformMatrix4fv(shader.uniforms.matRAS, false, matRAS)
    if (shader.uniforms.volScale)
      gl.uniform3fv(shader.uniforms.volScale, volScale as Float32Array)
    const rayDirVec = rayDir ?? [0, 0, 1]
    if (shader.uniforms.rayDir)
      gl.uniform3fv(shader.uniforms.rayDir, (rayDirVec as number[]).slice(0, 3))
    if (shader.uniforms.gradientAmount)
      gl.uniform1f(shader.uniforms.gradientAmount, gradientAmount)
    if (shader.uniforms.numVolumes)
      gl.uniform1f(shader.uniforms.numVolumes, volumeCount)
    if (shader.uniforms.clipPlanes)
      gl.uniform4fv(shader.uniforms.clipPlanes, clipPlanes)
    if (shader.uniforms.clipPlaneColor)
      gl.uniform4fv(shader.uniforms.clipPlaneColor, clipPlaneColor)
    if (shader.uniforms.isClipCutaway)
      gl.uniform1f(shader.uniforms.isClipCutaway, isClipCutaway ? 1.0 : 0.0)
    if (shader.uniforms.numPaqd) gl.uniform1f(shader.uniforms.numPaqd, 0.0)
    if (shader.uniforms.paqdUniforms)
      gl.uniform4fv(shader.uniforms.paqdUniforms, paqdUniforms as number[])

    // 4. Bind Geometry
    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)

    // 5. Draw with premultiplied alpha blending (shader outputs premultiplied colors)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Cleanup
    gl.bindVertexArray(null)
  }

  drawDepthPick(
    gl: WebGL2RenderingContext,
    mvpMatrix: Float32Array,
    matRAS: Float32Array,
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    clipPlanes: number[],
    isClipCutaway = false,
    volumeCount = 1,
  ): void {
    if (
      !this.isReady ||
      !this.depthPickShaderProgram ||
      !this.cubeVAO ||
      !this.indexBuffer
    )
      return
    if (!this.volumeTexture) return

    const shader = this.depthPickShaderProgram
    const indexCount = this.cube.indices.length

    shader.use(gl)

    // Bind volume texture
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture)
    if (shader.uniforms.volume) gl.uniform1i(shader.uniforms.volume, 0)

    // Bind overlay texture
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.overlayTexture || this.placeholderOverlay,
    )
    if (shader.uniforms.overlay) gl.uniform1i(shader.uniforms.overlay, 1)

    // Upload uniforms
    if (shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    if (shader.uniforms.matRAS)
      gl.uniformMatrix4fv(shader.uniforms.matRAS, false, matRAS)
    if (shader.uniforms.volScale)
      gl.uniform3fv(shader.uniforms.volScale, volScale as Float32Array)
    const rayDirVec = rayDir ?? [0, 0, 1]
    if (shader.uniforms.rayDir)
      gl.uniform3fv(shader.uniforms.rayDir, (rayDirVec as number[]).slice(0, 3))
    if (shader.uniforms.clipPlanes)
      gl.uniform4fv(shader.uniforms.clipPlanes, clipPlanes)
    if (shader.uniforms.isClipCutaway)
      gl.uniform1f(shader.uniforms.isClipCutaway, isClipCutaway ? 1.0 : 0.0)
    if (shader.uniforms.numVolumes)
      gl.uniform1f(shader.uniforms.numVolumes, volumeCount)

    // Draw
    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    gl.bindVertexArray(null)
  }

  async loadMatcap(
    gl: WebGL2RenderingContext,
    matcapUrl: string,
  ): Promise<void> {
    if (!this.isReady) return

    try {
      const newTex = await this._loadTexture2DOrFallback(gl, matcapUrl)
      if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
      this.matcapTexture = newTex
    } catch (e) {
      log.warn('Matcap load failed', e)
    }
  }

  hasVolume(): boolean {
    return this.volumeTexture !== null
  }

  hasOverlay(): boolean {
    return this.overlayTexture !== null
  }

  updateDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
  ): void {
    if (!this.isReady) return
    if (this.drawingTexture) {
      gl.bindTexture(gl.TEXTURE_3D, this.drawingTexture)
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        0,
        dims[0],
        dims[1],
        dims[2],
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgba,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    } else {
      this.drawingTexture = gl.createTexture()
      if (!this.drawingTexture) return
      gl.bindTexture(gl.TEXTURE_3D, this.drawingTexture)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.RGBA8,
        dims[0],
        dims[1],
        dims[2],
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        rgba,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }
  }

  destroyDrawing(gl: WebGL2RenderingContext): void {
    if (this.drawingTexture) {
      gl.deleteTexture(this.drawingTexture)
      this.drawingTexture = null
    }
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    // Delete VAO
    if (this.cubeVAO) gl.deleteVertexArray(this.cubeVAO)
    this.cubeVAO = null

    // Delete buffers
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer)
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer)
    this.vertexBuffer = null
    this.indexBuffer = null

    // Delete textures
    if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
    if (this.volumeTexture) gl.deleteTexture(this.volumeTexture)
    if (this.volumeGradientTexture) gl.deleteTexture(this.volumeGradientTexture)
    if (this.overlayTexture) gl.deleteTexture(this.overlayTexture)
    if (this.paqdTexture) gl.deleteTexture(this.paqdTexture)
    if (this.drawingTexture) gl.deleteTexture(this.drawingTexture)
    if (this.drawingLinearSampler) gl.deleteSampler(this.drawingLinearSampler)
    if (this.placeholderOverlay) gl.deleteTexture(this.placeholderOverlay)
    this.matcapTexture = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.paqdTexture = null
    this.drawingTexture = null
    this.drawingLinearSampler = null
    this.placeholderOverlay = null

    // Delete shader program
    if (this.shader?.program) gl.deleteProgram(this.shader.program)
    this.shader = null

    // Destroy module resources
    orientOverlay.destroy(gl)
    gradient.destroy(gl)

    this.isReady = false
    this._gl = null
  }
}
