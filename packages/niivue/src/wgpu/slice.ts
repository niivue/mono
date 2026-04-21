import type { NVImage } from "@/NVTypes"
import { NVRenderer } from "@/view/NVRenderer"
import sliceShaderCode from "./slice.wgsl?raw"

const UNIFORM_ALIGNMENT = 256 // WebGPU minimum uniform buffer offset alignment
const SLICE_UNIFORM_SIZE = 192 // 2x mat4x4f (128) + scalars (36) + numPaqd (4) + pad (12) + paqdUniforms vec4f (16) = 192 bytes
const alignedSliceSize =
  Math.ceil(SLICE_UNIFORM_SIZE / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT
const MAX_TILES = 128

export class SliceRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  paramsBuffer: GPUBuffer | null
  placeholderOverlay: GPUTexture | null
  drawingTexture: GPUTexture | null
  placeholderDrawing: GPUTexture | null
  placeholderPaqd: GPUTexture | null
  placeholderLut2D: GPUTexture | null
  samplerLinear: GPUSampler | null
  samplerNearest: GPUSampler | null
  bindGroupLinear: GPUBindGroup | null
  bindGroupNearest: GPUBindGroup | null
  private _bindTexVol: GPUTexture | null = null
  private _bindTexOverlay: GPUTexture | null = null
  private _bindTexDraw: GPUTexture | null = null
  private _bindTexPaqd: GPUTexture | null = null
  private _bindTexLut: GPUTexture | null = null

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.paramsBuffer = null
    this.placeholderOverlay = null
    this.drawingTexture = null
    this.placeholderDrawing = null
    this.placeholderPaqd = null
    this.placeholderLut2D = null
    this.samplerLinear = null
    this.samplerNearest = null
    this.bindGroupLinear = null
    this.bindGroupNearest = null
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return

    // Create uniform buffer for slice params (sized for multiple tiles with dynamic offsets)
    this.paramsBuffer = device.createBuffer({
      size: alignedSliceSize * MAX_TILES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Create samplers (linear for smooth, nearest for blocky voxels)
    this.samplerLinear = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    })
    this.samplerNearest = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    })

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = device.createTexture({
      size: [2, 2, 2],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "3d",
    })
    // Initialize with zeros (WebGPU textures are zero-initialized by default)

    // Create placeholder 2x2x2 drawing texture (all zeros - transparent)
    this.placeholderDrawing = device.createTexture({
      size: [2, 2, 2],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "3d",
    })

    // Create placeholder 2x2x2 PAQD texture (all zeros)
    this.placeholderPaqd = device.createTexture({
      size: [2, 2, 2],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "3d",
    })

    // Create placeholder 1x1 2D LUT texture (transparent)
    this.placeholderLut2D = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })

    // Create bind group layout
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: SLICE_UNIFORM_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "2d" },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
      ],
    })

    // Create pipeline
    const sliceModule = device.createShaderModule({ code: sliceShaderCode })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: msaaCount },
      vertex: { module: sliceModule, entryPoint: "vertex_main" },
      fragment: {
        module: sliceModule,
        entryPoint: "fragment_main",
        targets: [
          {
            format: format,
            blend: {
              color: {
                srcFactor: "src-alpha",
                dstFactor: "one-minus-src-alpha",
              },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: "less",
        format: "depth24plus",
      },
      primitive: { topology: "triangle-strip" },
    })

    this.isReady = true
  }

  /**
   * Get the placeholder overlay texture
   * @returns {GPUTexture}
   */
  getPlaceholderOverlay(): GPUTexture | null {
    return this.placeholderOverlay
  }

  /**
   * Create or update the bind group with volume, overlay, and PAQD textures
   */
  updateBindGroup(
    device: GPUDevice,
    volumeTexture: GPUTexture | null,
    overlayTexture: GPUTexture | null,
    paqdTexture: GPUTexture | null = null,
    paqdLutTexture: GPUTexture | null = null,
  ): void {
    if (
      !this.isReady ||
      !volumeTexture ||
      !this.bindLayout ||
      !this.paramsBuffer ||
      !this.samplerLinear ||
      !this.samplerNearest
    )
      return

    const overlay = overlayTexture || this.placeholderOverlay
    if (!overlay) return
    const drawTex = this.drawingTexture || this.placeholderDrawing
    if (!drawTex) return
    const paqdTex = paqdTexture || this.placeholderPaqd
    const lutTex = paqdLutTexture || this.placeholderLut2D
    if (!paqdTex || !lutTex) return

    if (
      this.bindGroupLinear &&
      this.bindGroupNearest &&
      this._bindTexVol === volumeTexture &&
      this._bindTexOverlay === overlay &&
      this._bindTexDraw === drawTex &&
      this._bindTexPaqd === paqdTex &&
      this._bindTexLut === lutTex
    ) {
      return
    }

    const volView = volumeTexture.createView()
    const ovlView = overlay.createView()
    const drawView = drawTex.createView()
    const paqdView = paqdTex.createView()
    const lutView = lutTex.createView()
    this.bindGroupLinear = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.paramsBuffer, size: SLICE_UNIFORM_SIZE },
        },
        { binding: 1, resource: volView },
        { binding: 2, resource: ovlView },
        { binding: 3, resource: this.samplerLinear },
        { binding: 4, resource: drawView },
        { binding: 5, resource: paqdView },
        { binding: 6, resource: lutView },
        { binding: 7, resource: this.samplerLinear },
      ],
    })
    this.bindGroupNearest = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.paramsBuffer, size: SLICE_UNIFORM_SIZE },
        },
        { binding: 1, resource: volView },
        { binding: 2, resource: ovlView },
        { binding: 3, resource: this.samplerNearest },
        { binding: 4, resource: drawView },
        { binding: 5, resource: paqdView },
        { binding: 6, resource: lutView },
        { binding: 7, resource: this.samplerLinear },
      ],
    })
    this._bindTexVol = volumeTexture
    this._bindTexOverlay = overlay
    this._bindTexDraw = drawTex
    this._bindTexPaqd = paqdTex
    this._bindTexLut = lutTex
  }

  updateDrawingTexture(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
  ): void {
    if (!this.isReady) return
    if (!this.drawingTexture) {
      this.drawingTexture = device.createTexture({
        size: dims,
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        dimension: "3d",
      })
    }
    device.queue.writeTexture(
      { texture: this.drawingTexture },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] },
      dims,
    )
  }

  destroyDrawing(): void {
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
  }

  /**
   * Draw a 2D orthogonal slice
   * @param {GPUDevice} device
   * @param {GPURenderPassEncoder} pass
   * @param {Object} vol - Volume object with frac2mm matrix
   * @param {Object} md - Model with slice rendering options
   * @param {Float32Array} mvpMatrix - Model-view-projection matrix
   * @param {number} axCorSag - Slice type (0=axial, 1=coronal, 2=sagittal)
   * @param {number} sliceFrac - Fractional slice position (0-1)
   * @param {number} tileIndex - Index for dynamic offset (for multiple viewports)
   * @param {number} numVolumes - Number of loaded volumes (1 = no overlay, 2+ = has overlay)
   */
  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    vol: NVImage,
    md: {
      overlayAlphaShader?: number
      overlayOutlineWidth?: number
      isAlphaClipDark?: boolean
      drawRimOpacity?: number
      isV1SliceShader?: boolean
    },
    mvpMatrix: Float32Array,
    axCorSag: number,
    sliceFrac: number,
    tileIndex = 0,
    numVolumes = 1,
    isNearest = false,
    overlayOpacity = 1,
    numPaqd = 0,
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
    isV1SliceShader = false,
  ): void {
    const bindGroup = isNearest ? this.bindGroupNearest : this.bindGroupLinear
    if (!this.isReady || !bindGroup || !this.paramsBuffer || !this.pipeline)
      return
    if (!vol.frac2mm) return

    // Write uniforms to buffer at the appropriate offset for this tile
    const dynamicOffset = tileIndex * alignedSliceSize
    const uniformData = new Float32Array(SLICE_UNIFORM_SIZE / 4)
    uniformData.set(mvpMatrix, 0) // mat4x4f mvpMtx (16 floats)
    uniformData.set(vol.frac2mm!, 16) // mat4x4f frac2mm (16 floats)
    uniformData[32] = vol.opacity ?? 1 // f32 opacity
    uniformData[33] = md.overlayAlphaShader ?? 1.0 // f32 overlayAlphaShader
    uniformData[34] = sliceFrac // f32 slice
    uniformData[35] = overlayOpacity // f32 overlayOpacity
    // [36..37] written as i32 below
    uniformData[38] = numVolumes // f32 numVolumes
    uniformData[39] = md.drawRimOpacity ?? -1 // f32 drawRimOpacity
    uniformData[40] = numPaqd // f32 numPaqd
    // paqdUniforms vec4f at float index 44 (byte offset 176, 16-byte aligned)
    uniformData[44] = paqdUniforms[0]
    uniformData[45] = paqdUniforms[1]
    uniformData[46] = paqdUniforms[2]
    uniformData[47] = paqdUniforms[3]
    // Write i32 values using a separate view
    const intView = new Int32Array(uniformData.buffer)
    intView[36] = axCorSag // i32 axCorSag
    intView[37] = md.isAlphaClipDark ? 1 : 0 // i32 isAlphaClipDark
    intView[41] = isV1SliceShader ? 1 : 0 // i32 isV1SliceShader
    uniformData[42] = md.overlayOutlineWidth ?? 0 // f32 overlayOutlineWidth

    device.queue.writeBuffer(this.paramsBuffer, dynamicOffset, uniformData)

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup, [dynamicOffset])
    pass.draw(4)
  }

  destroy(): void {
    if (this.placeholderOverlay) {
      this.placeholderOverlay.destroy()
      this.placeholderOverlay = null
    }
    if (this.placeholderDrawing) {
      this.placeholderDrawing.destroy()
      this.placeholderDrawing = null
    }
    if (this.placeholderPaqd) {
      this.placeholderPaqd.destroy()
      this.placeholderPaqd = null
    }
    if (this.placeholderLut2D) {
      this.placeholderLut2D.destroy()
      this.placeholderLut2D = null
    }
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    this.bindGroupLinear = null
    this.bindGroupNearest = null
    this.samplerLinear = null
    this.samplerNearest = null
    this.pipeline = null
    this.bindLayout = null
    this._bindTexVol = null
    this._bindTexOverlay = null
    this._bindTexDraw = null
    this._bindTexPaqd = null
    this._bindTexLut = null
    this.isReady = false
  }
}
