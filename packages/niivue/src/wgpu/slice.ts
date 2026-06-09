import type { NVImage } from '@/NVTypes'
import { NVRenderer } from '@/view/NVRenderer'
import {
  type ChunkPlan,
  type ChunkSampleTransform,
  identityChunkSampleTransform,
  type Vec3i,
} from '@/volume/chunking'
import { extractChunkBytes } from '@/volume/orientChunked'
import sliceShaderCode from './slice.wgsl?raw'

const UNIFORM_ALIGNMENT = 256 // WebGPU minimum uniform buffer offset alignment
// 2x mat4x4f (128) + scalars (44) + paqdUniforms vec4f (16, 16-aligned at 176)
// + 5x vec3f chunk transform (80, 16-aligned each) = 272 bytes.
const SLICE_UNIFORM_SIZE = 272
const alignedSliceSize =
  Math.ceil(SLICE_UNIFORM_SIZE / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT
const MAX_TILES = 128
// Max chunks one chunked volume may contribute to a single slice tile.
// Mirrors the 3D render path's per-tile chunk cap.
const MAX_CHUNKS_PER_TILE = 256

export class SliceRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  paramsBuffer: GPUBuffer | null
  placeholderOverlay: GPUTexture | null
  drawingTexture: GPUTexture | null
  // Per-chunk drawing textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the drawing layer is chunked.
  drawingChunks: GPUTexture[] | null
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
  // Per-chunk-texture bind group cache for chunked volumes. Keyed by the
  // chunk's volume texture; the linear/nearest pair reuses the shared
  // overlay/drawing/paqd/lut textures captured by updateBindGroup. Cleared
  // whenever updateBindGroup rebuilds (any bound texture changed).
  private _chunkBindGroups = new Map<
    GPUTexture,
    {
      linear: GPUBindGroup
      nearest: GPUBindGroup
      overlay: GPUTexture
      draw: GPUTexture
      paqd: GPUTexture
    }
  >()

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.paramsBuffer = null
    this.placeholderOverlay = null
    this.drawingTexture = null
    this.drawingChunks = null
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

    // Uniform buffer for slice params, addressed by dynamic offset.
    // Base region: one slot per tile (non-chunked draws).
    // Chunk region: tile i, chunk slot j uses
    //   chunkBase + (i * MAX_CHUNKS_PER_TILE + j) * alignedSliceSize.
    this.paramsBuffer = device.createBuffer({
      size: alignedSliceSize * MAX_TILES * (1 + MAX_CHUNKS_PER_TILE),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Create samplers (linear for smooth, nearest for blocky voxels)
    this.samplerLinear = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.samplerNearest = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    })

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = device.createTexture({
      size: [2, 2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    })
    // Initialize with zeros (WebGPU textures are zero-initialized by default)

    // Create placeholder 2x2x2 drawing texture (all zeros - transparent)
    this.placeholderDrawing = device.createTexture({
      size: [2, 2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    })

    // Create placeholder 2x2x2 PAQD texture (all zeros)
    this.placeholderPaqd = device.createTexture({
      size: [2, 2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    })

    // Create placeholder 1x1 2D LUT texture (transparent)
    this.placeholderLut2D = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })

    // Create bind group layout
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: SLICE_UNIFORM_SIZE,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '2d' },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'filtering' },
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
      vertex: { module: sliceModule, entryPoint: 'vertex_main' },
      fragment: {
        module: sliceModule,
        entryPoint: 'fragment_main',
        targets: [
          {
            format: format,
            blend: {
              color: {
                srcFactor: 'src-alpha',
                dstFactor: 'one-minus-src-alpha',
              },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
      primitive: { topology: 'triangle-strip' },
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

    // A bound texture changed; per-chunk bind groups built from the old
    // shared textures are now stale.
    this._chunkBindGroups.clear()

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

  /**
   * Build (or fetch a cached) bind group for one chunk of a chunked volume.
   * Reuses the shared overlay/drawing/paqd/lut textures last captured by
   * updateBindGroup; returns null if those have not been set yet.
   */
  private _chunkBindGroupFor(
    device: GPUDevice,
    chunkVolumeTexture: GPUTexture,
    isNearest: boolean,
    drawingTexture?: GPUTexture,
    overlayTexture?: GPUTexture,
    paqdTexture?: GPUTexture,
  ): GPUBindGroup | null {
    const bindLayout = this.bindLayout
    const paramsBuffer = this.paramsBuffer
    const samplerLinear = this.samplerLinear
    const samplerNearest = this.samplerNearest
    // Chunked overlay layer: binding 2 is the chunk's own overlay texture.
    // Falls back to the shared overlay texture when not chunked or absent.
    const overlay = overlayTexture ?? this._bindTexOverlay
    // Chunked drawing layer: binding 4 is the chunk's own drawing texture.
    // Falls back to the shared drawing texture when not chunked or absent.
    const drawTex = drawingTexture ?? this._bindTexDraw
    // Chunked PAQD layer: binding 5 is the chunk's own raw PAQD texture.
    // Falls back to the shared PAQD texture when not chunked or absent.
    const paqdTex = paqdTexture ?? this._bindTexPaqd
    const lutTex = this._bindTexLut
    if (
      !bindLayout ||
      !paramsBuffer ||
      !samplerLinear ||
      !samplerNearest ||
      !overlay ||
      !drawTex ||
      !paqdTex ||
      !lutTex
    )
      return null

    let pair = this._chunkBindGroups.get(chunkVolumeTexture)
    // Per-chunk overlay/drawing/paqd textures are rebuilt as fresh GPUTexture
    // objects when their layer changes; a cached pair built from stale
    // textures must be discarded.
    if (
      pair &&
      (pair.overlay !== overlay ||
        pair.draw !== drawTex ||
        pair.paqd !== paqdTex)
    ) {
      pair = undefined
    }
    if (!pair) {
      const volView = chunkVolumeTexture.createView()
      const ovlView = overlay.createView()
      const drawView = drawTex.createView()
      const paqdView = paqdTex.createView()
      const lutView = lutTex.createView()
      const make = (sampler: GPUSampler): GPUBindGroup =>
        device.createBindGroup({
          layout: bindLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: paramsBuffer, size: SLICE_UNIFORM_SIZE },
            },
            { binding: 1, resource: volView },
            { binding: 2, resource: ovlView },
            { binding: 3, resource: sampler },
            { binding: 4, resource: drawView },
            { binding: 5, resource: paqdView },
            { binding: 6, resource: lutView },
            { binding: 7, resource: samplerLinear },
          ],
        })
      pair = {
        linear: make(samplerLinear),
        nearest: make(samplerNearest),
        overlay,
        draw: drawTex,
        paqd: paqdTex,
      }
      this._chunkBindGroups.set(chunkVolumeTexture, pair)
    }
    return isNearest ? pair.nearest : pair.linear
  }

  updateDrawingTexture(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
    plan?: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    if (!this.isReady) return
    if (plan) {
      this._updateDrawingChunks(device, rgba, dims, plan, dirtyChunks)
      return
    }
    // Non-chunked path: switching back from a chunked volume frees the
    // per-chunk drawing textures so only one representation is live.
    this._destroyDrawingChunks()
    if (!this.drawingTexture) {
      this.drawingTexture = device.createTexture({
        size: dims,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        dimension: '3d',
      })
    }
    device.queue.writeTexture(
      { texture: this.drawingTexture },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] },
      dims,
    )
  }

  /**
   * Build (or refresh) one rgba8unorm drawing texture per chunk. The drawing
   * layer shares the background volume's ChunkPlan, so chunk indices and
   * texDims line up with the volume chunks the slice loop iterates.
   */
  private _updateDrawingChunks(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const reuse =
      this.drawingChunks !== null &&
      this.drawingChunks.length === plan.chunks.length
    if (!reuse) {
      this._destroyDrawingChunks()
      this.drawingChunks = []
    }
    const chunks = this.drawingChunks ?? []
    // Reusing textures: re-upload only the chunks a pen stroke dirtied.
    const indices =
      reuse && dirtyChunks
        ? dirtyChunks
        : Array.from({ length: plan.chunks.length }, (_, i) => i)
    for (const i of indices) {
      const desc = plan.chunks[i]
      const bytes = extractChunkBytes(
        rgba,
        volumeDims,
        4,
        desc.texOrigin,
        desc.texDims,
      )
      const [tx, ty, tz] = desc.texDims
      let tex = reuse ? chunks[i] : null
      if (!tex) {
        tex = device.createTexture({
          size: [tx, ty, tz],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          dimension: '3d',
        })
        chunks[i] = tex
      }
      device.queue.writeTexture(
        { texture: tex },
        bytes as Uint8Array<ArrayBuffer>,
        { bytesPerRow: tx * 4, rowsPerImage: ty },
        [tx, ty, tz],
      )
    }
    this.drawingChunks = chunks
    // New textures invalidate cached per-chunk bind groups (binding 4).
    if (!reuse) this._chunkBindGroups.clear()
  }

  /** Release all per-chunk drawing textures from a previous build. */
  private _destroyDrawingChunks(): void {
    if (!this.drawingChunks) return
    for (const tex of this.drawingChunks) tex.destroy()
    this.drawingChunks = null
  }

  destroyDrawing(): void {
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    this._destroyDrawingChunks()
    this._chunkBindGroups.clear()
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
    chunk?: {
      volumeTexture: GPUTexture
      transform: ChunkSampleTransform
      slot: number
      chunkIndex: number
      overlayTexture?: GPUTexture
      paqdTexture?: GPUTexture
      // Coarse-LOD floor draw: a whole-volume texture rendered as one full-
      // coverage quad behind the resident fine chunks so a deep-zoom slice
      // never blanks while finer chunks stream. Uses the per-tile base region
      // of the uniform buffer (unused by chunked base draws) instead of a chunk
      // slot, so it never collides with a real chunk's uniforms.
      useBaseSlot?: boolean
    },
  ): void {
    if (!this.isReady || !this.paramsBuffer || !this.pipeline) return
    if (!vol.frac2mm) return

    const chunkDrawTex =
      chunk && this.drawingChunks
        ? this.drawingChunks[chunk.chunkIndex]
        : undefined
    const bindGroup = chunk
      ? this._chunkBindGroupFor(
          device,
          chunk.volumeTexture,
          isNearest,
          chunkDrawTex,
          chunk.overlayTexture,
          chunk.paqdTexture,
        )
      : isNearest
        ? this.bindGroupNearest
        : this.bindGroupLinear
    if (!bindGroup) return

    // Chunked draws live in the chunk region of the buffer, one slot per
    // (tile, chunk); non-chunked draws (and the coarse floor) use the per-tile
    // base region.
    const dynamicOffset =
      chunk && !chunk.useBaseSlot
        ? MAX_TILES * alignedSliceSize +
          (tileIndex * MAX_CHUNKS_PER_TILE + chunk.slot) * alignedSliceSize
        : tileIndex * alignedSliceSize

    // Chunked volumes pass a per-chunk transform; non-chunked volumes use the
    // identity transform sized to the volume's full RAS dims.
    const ct =
      chunk?.transform ??
      identityChunkSampleTransform(
        vol.dimsRAS
          ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
          : [1, 1, 1],
      )

    // Write uniforms to buffer at the appropriate offset for this draw
    const uniformData = new Float32Array(SLICE_UNIFORM_SIZE / 4)
    uniformData.set(mvpMatrix, 0) // mat4x4f mvpMtx (16 floats)
    uniformData.set(vol.frac2mm as Float32Array, 16) // mat4x4f frac2mm (16 floats)
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

    // Chunk transform: 5x vec3f starting at byte 192 (float 48), each vec3f
    // padded to 16 bytes (4 floats). Identity for non-chunked volumes.
    uniformData[48] = ct.subOrigin[0]
    uniformData[49] = ct.subOrigin[1]
    uniformData[50] = ct.subOrigin[2]
    uniformData[52] = ct.subSize[0]
    uniformData[53] = ct.subSize[1]
    uniformData[54] = ct.subSize[2]
    uniformData[56] = ct.dataOrigin[0]
    uniformData[57] = ct.dataOrigin[1]
    uniformData[58] = ct.dataOrigin[2]
    uniformData[60] = ct.dataSize[0]
    uniformData[61] = ct.dataSize[1]
    uniformData[62] = ct.dataSize[2]
    uniformData[64] = ct.volumeDims[0]
    uniformData[65] = ct.volumeDims[1]
    uniformData[66] = ct.volumeDims[2]

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
    this._destroyDrawingChunks()
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    this.bindGroupLinear = null
    this.bindGroupNearest = null
    this._chunkBindGroups.clear()
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
