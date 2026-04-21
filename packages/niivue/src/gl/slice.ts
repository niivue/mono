import type { NVImage } from "@/NVTypes"
import { NVRenderer } from "@/view/NVRenderer"
import { Shader } from "./shader"
import { sliceFragShader, sliceVertShader } from "./sliceShader"

type SliceModel = {
  overlayAlphaShader?: number
  overlayOutlineWidth?: number
  isAlphaClipDark?: boolean
  drawRimOpacity?: number
  isV1SliceShader?: boolean
}

export class SliceRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null = null
  private _shader: Shader | null = null
  private _vao: WebGLVertexArrayObject | null = null
  private _vertexBuffer: WebGLBuffer | null = null
  private _placeholderOverlay: WebGLTexture | null = null
  private _drawingTexture: WebGLTexture | null = null
  private _placeholderDrawing: WebGLTexture | null = null
  private _placeholderPaqd: WebGLTexture | null = null
  private _placeholderLut2D: WebGLTexture | null = null

  init(gl: WebGL2RenderingContext): void {
    if (this.isReady) return
    this._gl = gl

    // Create shader program
    this._shader = new Shader(gl, sliceVertShader, sliceFragShader)

    // Create VAO and vertex buffer for a unit quad
    this._vao = gl.createVertexArray()
    if (!this._vao) {
      throw new Error("Failed to create slice VAO")
    }
    gl.bindVertexArray(this._vao)

    // Quad vertices in 0-1 range (triangle strip order)
    const quadVertices = new Float32Array([
      0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0,
    ])

    this._vertexBuffer = gl.createBuffer()
    if (!this._vertexBuffer) {
      gl.bindVertexArray(null)
      throw new Error("Failed to create slice vertex buffer")
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW)

    // Position attribute at location 0
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0)

    gl.bindVertexArray(null)

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros)
    this._placeholderOverlay = gl.createTexture()
    if (!this._placeholderOverlay) {
      gl.bindVertexArray(null)
      throw new Error("Failed to create slice placeholder texture")
    }
    gl.bindTexture(gl.TEXTURE_3D, this._placeholderOverlay)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)

    const emptyData = new Uint8Array(2 * 2 * 2 * 4)
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

    // Create placeholder 2x2x2 drawing texture (all zeros - nearest filter)
    this._placeholderDrawing = gl.createTexture()
    if (this._placeholderDrawing) {
      gl.bindTexture(gl.TEXTURE_3D, this._placeholderDrawing)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
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
        new Uint8Array(2 * 2 * 2 * 4),
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }

    // Create placeholder 2x2x2 PAQD texture (all zeros - nearest filter)
    this._placeholderPaqd = gl.createTexture()
    if (this._placeholderPaqd) {
      gl.bindTexture(gl.TEXTURE_3D, this._placeholderPaqd)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
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
        new Uint8Array(2 * 2 * 2 * 4),
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
    }

    // Create placeholder 1x1 2D LUT texture (transparent - nearest filter)
    this._placeholderLut2D = gl.createTexture()
    if (this._placeholderLut2D) {
      gl.bindTexture(gl.TEXTURE_2D, this._placeholderLut2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(4),
      )
      gl.bindTexture(gl.TEXTURE_2D, null)
    }

    this.isReady = true
  }

  getPlaceholderOverlay(): WebGLTexture | null {
    return this._placeholderOverlay
  }

  draw(
    gl: WebGL2RenderingContext,
    volumeTexture: WebGLTexture | null,
    overlayTexture: WebGLTexture | null,
    vol: NVImage,
    md: SliceModel,
    mvpMatrix: Float32Array,
    axCorSag: number,
    sliceFrac: number,
    numVolumes = 1,
    isNearest = false,
    overlayOpacity = 1,
    paqdTexture: WebGLTexture | null = null,
    paqdLutTexture: WebGLTexture | null = null,
    numPaqd = 0,
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
    isV1SliceShader = false,
  ): void {
    if (
      !this.isReady ||
      !volumeTexture ||
      !this._shader ||
      !this._vao ||
      !vol.frac2mm
    )
      return

    this._shader.use(gl)

    const filter = isNearest ? gl.NEAREST : gl.LINEAR

    // Bind volume texture to unit 0
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, volumeTexture)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter)
    gl.uniform1i(this._shader.uniforms.volume, 0)

    // Bind overlay texture to unit 1 (use placeholder if none provided)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, overlayTexture || this._placeholderOverlay)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, filter)
    gl.uniform1i(this._shader.uniforms.overlay, 1)

    // Bind drawing texture to unit 2 (nearest-neighbor)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this._drawingTexture || this._placeholderDrawing,
    )
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (this._shader.uniforms.drawing)
      gl.uniform1i(this._shader.uniforms.drawing, 2)

    // Bind PAQD 3D texture to unit 3 (linear for smooth probability interpolation;
    // label indices use texelFetch which bypasses the sampler)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, paqdTexture || this._placeholderPaqd)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    if (this._shader.uniforms.paqd) gl.uniform1i(this._shader.uniforms.paqd, 3)

    // Bind PAQD LUT 2D texture to unit 4 (nearest-neighbor)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_2D, paqdLutTexture || this._placeholderLut2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (this._shader.uniforms.paqdLut)
      gl.uniform1i(this._shader.uniforms.paqdLut, 4)

    // Set uniforms
    if (this._shader.uniforms.axCorSag)
      gl.uniform1i(this._shader.uniforms.axCorSag, axCorSag)
    if (this._shader.uniforms.slice)
      gl.uniform1f(this._shader.uniforms.slice, sliceFrac)
    if (this._shader.uniforms.opacity)
      gl.uniform1f(this._shader.uniforms.opacity, vol.opacity ?? 1)
    if (this._shader.uniforms.overlayAlphaShader)
      gl.uniform1f(
        this._shader.uniforms.overlayAlphaShader,
        md.overlayAlphaShader ?? 1.0,
      )
    if (this._shader.uniforms.overlayOpacity)
      gl.uniform1f(this._shader.uniforms.overlayOpacity, overlayOpacity)
    if (this._shader.uniforms.isAlphaClipDark)
      gl.uniform1i(
        this._shader.uniforms.isAlphaClipDark,
        md.isAlphaClipDark ? 1 : 0,
      )
    if (this._shader.uniforms.numVolumes)
      gl.uniform1f(this._shader.uniforms.numVolumes, numVolumes)
    if (this._shader.uniforms.drawRimOpacity)
      gl.uniform1f(
        this._shader.uniforms.drawRimOpacity,
        md.drawRimOpacity ?? -1,
      )
    if (this._shader.uniforms.numPaqd)
      gl.uniform1f(this._shader.uniforms.numPaqd, numPaqd)
    if (this._shader.uniforms.paqdUniforms)
      gl.uniform4f(
        this._shader.uniforms.paqdUniforms,
        paqdUniforms[0],
        paqdUniforms[1],
        paqdUniforms[2],
        paqdUniforms[3],
      )
    if (this._shader.uniforms.isV1SliceShader)
      gl.uniform1i(
        this._shader.uniforms.isV1SliceShader,
        isV1SliceShader ? 1 : 0,
      )
    if (this._shader.uniforms.overlayOutlineWidth)
      gl.uniform1f(
        this._shader.uniforms.overlayOutlineWidth,
        md.overlayOutlineWidth ?? 0,
      )

    // Transform matrices
    if (this._shader.uniforms.frac2mm)
      gl.uniformMatrix4fv(this._shader.uniforms.frac2mm, false, vol.frac2mm)
    if (this._shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(this._shader.uniforms.mvpMtx, false, mvpMatrix)

    // Set up rendering state
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Enable depth writing so slices correctly interact with meshes in 2D views
    gl.depthMask(true)

    // Disable face culling for the quad
    gl.disable(gl.CULL_FACE)

    // Draw the quad
    gl.bindVertexArray(this._vao)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindVertexArray(null)

    // Restore state
    gl.enable(gl.CULL_FACE)
  }

  updateDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
  ): void {
    if (!this.isReady) return
    if (this._drawingTexture) {
      gl.bindTexture(gl.TEXTURE_3D, this._drawingTexture)
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
      this._drawingTexture = gl.createTexture()
      if (!this._drawingTexture) return
      gl.bindTexture(gl.TEXTURE_3D, this._drawingTexture)
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

  destroyDrawing(): void {
    const gl = this._gl
    if (!gl) return
    if (this._drawingTexture) {
      gl.deleteTexture(this._drawingTexture)
      this._drawingTexture = null
    }
  }

  destroy(): void {
    const gl = this._gl
    if (!gl) return
    if (this._vao) gl.deleteVertexArray(this._vao)
    if (this._vertexBuffer) gl.deleteBuffer(this._vertexBuffer)
    if (this._placeholderOverlay) gl.deleteTexture(this._placeholderOverlay)
    if (this._placeholderDrawing) gl.deleteTexture(this._placeholderDrawing)
    if (this._placeholderPaqd) gl.deleteTexture(this._placeholderPaqd)
    if (this._placeholderLut2D) gl.deleteTexture(this._placeholderLut2D)
    if (this._drawingTexture) gl.deleteTexture(this._drawingTexture)
    if (this._shader?.program) gl.deleteProgram(this._shader.program)

    this._vao = null
    this._vertexBuffer = null
    this._placeholderOverlay = null
    this._placeholderDrawing = null
    this._placeholderPaqd = null
    this._placeholderLut2D = null
    this._drawingTexture = null
    this._shader = null
    this.isReady = false
    this._gl = null
  }
}
