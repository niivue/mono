import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import { isPaqd } from '@/NVConstants'
import type { NVImage } from '@/NVTypes'
import { NVRenderer } from '@/view/NVRenderer'
import {
  isRgbaDatatype,
  preparePaqdOverlayData,
} from '@/view/NVRenderVolumeData'
import { ChunkResidencyManager } from '@/volume/ChunkResidency'
import {
  bytesPerSourceVoxel,
  estimateChunkedBytes,
  formatBytes,
} from '@/volume/chunkBudget'
import {
  type ChunkPlan,
  chunkVolume,
  needsChunking,
  type Vec3i,
} from '@/volume/chunking'
import { chunkOverlayMatrix, extractChunkBytes } from '@/volume/orientChunked'
import { MAX_TILES, UNIFORM_ALIGNMENT } from './mesh'
import * as orient from './orient'
import {
  destroyVolumeChunksGPU,
  type VolumeChunkGPU,
  volume2TextureChunked,
} from './orientChunked'
import renderFragment from './render.wgsl?raw'
import { volumeShaderPreamble } from './volumeShaderLib'
import * as wgpu from './wgpu'

/**
 * Hard cap on total GPU bytes per chunked volume (scalar + RGBA + gradient
 * across all chunks). Picked to fit comfortably below a typical 4 GiB
 * discrete-GPU budget while leaving headroom for overlays, fonts, and
 * other resident textures. Volumes over this cap fail fast with a clear
 * error instead of crashing the WebGPU context mid-upload.
 */
const CHUNKED_VOLUME_BYTE_CAP = 1_500_000_000

/**
 * Maximum chunks a single chunked volume may draw per 3D-render tile. Bounds
 * the per-chunk uniform-buffer slot allocation. A volume that tiles into more
 * chunks than this fails fast in updateVolume with a clear error. 32 covers
 * realistic chunk grids under CHUNKED_VOLUME_BYTE_CAP (a 1.5 GiB budget caps
 * grids well below 32 chunks even with a 2048 device limit).
 */
const MAX_CHUNKS_PER_TILE = 32

type Vec3f = [number, number, number]

/**
 * Per-chunk uniform values for one cube draw of a chunked volume. The renderer
 * computes these from the ChunkPlan; the shader uses them to scale the unit
 * cube into the chunk's sub-region and remap sample positions into the chunk
 * texture (including halo). Non-chunked draws use identity pass-through values.
 */
interface ChunkUniforms {
  /** Full volume RAS dims (used for ray step size and frac2ndc). */
  volumeTexDimsFull: Vec3f
  /** Chunk's sub-cube origin in the full-volume [0,1] cube. */
  chunkSubOrigin: Vec3f
  /** Chunk's sub-cube size in the full-volume [0,1] cube. */
  chunkSubSize: Vec3f
  /** Halo offset in the chunk's local texture (skips low-side halo). */
  dataOriginTexFrac: Vec3f
  /** Data extent in the chunk's local texture (excludes halo on both sides). */
  dataSizeTexFrac: Vec3f
}

/** Single-texture volume: fits within maxTextureDimension3D on all axes. */
interface SingleTexEntry {
  kind: 'single'
  volumeTexture: GPUTexture
  volumeGradientTexture: GPUTexture
}

/** Chunked (tiled) volume: one or more axes exceed maxTextureDimension3D. */
interface ChunkedTexEntry {
  kind: 'chunked'
  /** GPU residency bookkeeping for the volume's chunks. */
  manager: ChunkResidencyManager<VolumeChunkGPU>
  plan: ChunkPlan
  /** Per-chunk data-region center in the full-volume [0,1] cube (for sort). */
  centers: Vec3f[]
  /** Per-chunk cached bind group; null until built or after invalidation. */
  bindGroups: (GPUBindGroup | null)[]
}

type TexCacheEntry = SingleTexEntry | ChunkedTexEntry

// 480 bytes = 120 floats:
//   16 mvp + 16 norm + 16 matRAS + 4 volScale + 4 rayDir + 4 (gradient/numVol/cutaway/pad)
//   + 4 clipPlaneColor + 24 clipPlanes + 4 paqd + 1 earlyTermination + 7 _pad0 (vec3 align)
//   + 4 volumeTexDimsFull + 4 chunkSubOrigin + 4 chunkSubSize
//   + 4 dataOriginTexFrac + 4 dataSizeTexFrac
const renderParamsSize = 480
export const alignedRenderSize =
  Math.ceil(renderParamsSize / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT

/**
 * Per-chunk data-region center in the full-volume [0,1] cube. Used to depth-
 * sort chunks back-to-front before compositing. Centers exclude halo voxels.
 */
function computeChunkCenters(plan: ChunkPlan): Vec3f[] {
  const [vx, vy, vz] = plan.volumeDims
  return plan.chunks.map((c) => [
    (c.voxelOrigin[0] + c.voxelDims[0] / 2) / vx,
    (c.voxelOrigin[1] + c.voxelDims[1] / 2) / vy,
    (c.voxelOrigin[2] + c.voxelDims[2] / 2) / vz,
  ])
}

/**
 * Steady-state GPU bytes one resident chunk occupies. The scalar source
 * texture is destroyed after the orient pass, so only the RGBA color texture
 * and the gradient texture persist — both rgba8unorm (4 bytes/voxel) over the
 * chunk's padded `texDims`.
 */
function chunkResidentBytes(chunk: VolumeChunkGPU): number {
  const [tx, ty, tz] = chunk.desc.texDims
  return tx * ty * tz * 8
}

/** Per-chunk uniform values derived from a chunk descriptor and its plan. */
function chunkUniformsFor(plan: ChunkPlan, chunkIndex: number): ChunkUniforms {
  const desc = plan.chunks[chunkIndex]
  const [vx, vy, vz] = plan.volumeDims
  const [tx, ty, tz] = desc.texDims
  return {
    volumeTexDimsFull: [vx, vy, vz],
    chunkSubOrigin: [
      desc.voxelOrigin[0] / vx,
      desc.voxelOrigin[1] / vy,
      desc.voxelOrigin[2] / vz,
    ],
    chunkSubSize: [
      desc.voxelDims[0] / vx,
      desc.voxelDims[1] / vy,
      desc.voxelDims[2] / vz,
    ],
    dataOriginTexFrac: [
      desc.haloLow[0] / tx,
      desc.haloLow[1] / ty,
      desc.haloLow[2] / tz,
    ],
    dataSizeTexFrac: [
      desc.voxelDims[0] / tx,
      desc.voxelDims[1] / ty,
      desc.voxelDims[2] / tz,
    ],
  }
}

export class VolumeRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  bindGroup: GPUBindGroup | null
  matcapTexture: GPUTexture | null
  volumeTexture: GPUTexture | null
  volumeGradientTexture: GPUTexture | null
  overlayTexture: GPUTexture | null
  // Per-chunk overlay textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the overlay layer is chunked; the
  // single-texture overlayTexture stays null in that case (and vice versa).
  overlayChunks: GPUTexture[] | null
  paqdTexture: GPUTexture | null
  // Per-chunk raw PAQD textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the PAQD layer is chunked; the
  // single-texture paqdTexture stays null in that case (and vice versa).
  paqdChunks: GPUTexture[] | null
  paqdLutTexture: GPUTexture | null
  drawingTexture: GPUTexture | null
  // Per-chunk drawing textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the drawing layer is chunked; the
  // single-texture drawingTexture stays null in that case (and vice versa).
  drawingChunks: GPUTexture[] | null
  placeholderOverlay: GPUTexture | null
  placeholderLut2D: GPUTexture | null
  sampler: GPUSampler | null
  samplerNearest: GPUSampler | null
  paramsBuffer: GPUBuffer | null
  vertexBuffer: GPUBuffer | null
  indexBuffer: GPUBuffer | null
  cube: { vertices: number[]; indices: number[] }
  maxTextureDimension3D: number
  depthFormat: GPUTextureFormat
  private _device: GPUDevice | null
  private _matcapUrl: string | null = null
  private _bindTexVol: GPUTexture | null = null
  private _bindTexGrad: GPUTexture | null = null
  private _bindTexMatcap: GPUTexture | null = null
  private _bindTexOverlay: GPUTexture | null = null
  private _bindTexPaqd: GPUTexture | null = null
  private _bindTexDraw: GPUTexture | null = null
  private _bindTexLut: GPUTexture | null = null
  private overlayOrientCache: orient.OrientTextureCache | null = null
  // Per-volume GPU texture cache. Populated by updateVolume; consumed by
  // bindCachedVolume to switch the active volume/gradient texture per tile
  // when rendering multi-instance global3d scenes.
  private _texCache: Map<string, TexCacheEntry> = new Map()
  // Per-volume cached bind groups so multi-volume tile loops can swap
  // textures without rebuilding the bind group every frame. Keyed by the
  // same cacheKey as _texCache. Invalidated whenever any non-volume
  // texture (overlay/paqd/draw/matcap/lut) changes. Single-texture entries
  // only — chunked entries cache per-chunk bind groups on the entry itself.
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map()
  private _activeVolKey: string | null = null
  // Set when bindCachedVolume selects a chunked entry; null for single
  // entries. draw() branches on this to run the multi-chunk loop.
  private _activeChunked: ChunkedTexEntry | null = null
  private _bindGroupSharedKey: {
    matcap: GPUTexture | null
    overlay: GPUTexture | null
    paqd: GPUTexture | null
    draw: GPUTexture | null
    lut: GPUTexture | null
  } = { matcap: null, overlay: null, paqd: null, draw: null, lut: null }

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.bindGroup = null
    this.matcapTexture = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.overlayChunks = null
    this.paqdTexture = null
    this.paqdChunks = null
    this.paqdLutTexture = null
    this.drawingTexture = null
    this.drawingChunks = null
    this.placeholderOverlay = null
    this.placeholderLut2D = null
    this.sampler = null
    this.samplerNearest = null
    this.paramsBuffer = null
    this.vertexBuffer = null
    this.indexBuffer = null
    this.cube = NVShapes.getCubeMesh()
    this.maxTextureDimension3D = 0
    this.depthFormat = 'depth24plus'
    this._device = null
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    maxTextureDimension3D: number,
    depthFormat: GPUTextureFormat = 'depth24plus',
  ): Promise<void> {
    this._device = device
    this.depthFormat = depthFormat
    if (this.isReady) return

    this.maxTextureDimension3D = maxTextureDimension3D

    // Create samplers
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.samplerNearest = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
    })

    // Create vertex buffer for cube
    this.vertexBuffer = device.createBuffer({
      size: this.cube.vertices.length * 4,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    })
    new Float32Array(this.vertexBuffer.getMappedRange()).set(this.cube.vertices)
    this.vertexBuffer.unmap()

    // Create index buffer for cube
    this.indexBuffer = device.createBuffer({
      size: this.cube.indices.length * 2,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    })
    new Uint16Array(this.indexBuffer.getMappedRange()).set(this.cube.indices)
    this.indexBuffer.unmap()

    // Create uniform buffer. The first MAX_TILES slots hold one set of render
    // params per tile (non-chunked draws). The remaining slots hold per-chunk
    // params: tile i, chunk j uses slot MAX_TILES + i * MAX_CHUNKS_PER_TILE + j.
    this.paramsBuffer = device.createBuffer({
      size: alignedRenderSize * MAX_TILES * (1 + MAX_CHUNKS_PER_TILE),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = device.createTexture({
      size: [2, 2, 2],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: '3d',
    })

    // Create placeholder 1x1 2D texture for PAQD LUT (transparent)
    this.placeholderLut2D = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })

    this.matcapTexture = null

    // Create bind group layout
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: {
            type: 'uniform',
            hasDynamicOffset: true,
            minBindingSize: renderParamsSize,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '2d' },
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
          texture: { viewDimension: '3d' },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '3d' },
        },
        {
          binding: 8,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: 'non-filtering' },
        },
        {
          binding: 9,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: '2d' },
        },
      ],
    })

    // Create render pipeline
    const shaderModule = device.createShaderModule({
      code: volumeShaderPreamble + renderFragment,
    })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: msaaCount },
      vertex: {
        module: shaderModule,
        entryPoint: 'vertex_main',
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ format: 'float32x3', offset: 0, shaderLocation: 0 }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fragment_main',
        targets: [
          {
            format: format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: this.depthFormat,
      },
      primitive: {
        topology: 'triangle-strip',
        stripIndexFormat: 'uint16',
        cullMode: 'back',
      },
    })

    this.isReady = true
  }

  async updateVolume(
    device: GPUDevice,
    vol: NVImage,
    matcap: string = '',
  ): Promise<void> {
    if (!this.isReady) return

    // Check both source and target (RAS) dims against the device limit.
    // Source dims drive scalar texture upload; RAS dims drive the RGBA
    // output texture. Either can exceed the cap on real-world OME-Zarr
    // L0 levels or microscopy / WSI data.
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.maxTextureDimension3D
    const oversized =
      needsChunking(srcDims, limit) || needsChunking(rasDims, limit)

    const cacheKey = vol.url || vol.name

    if (oversized) {
      // Compute the chunk plan against RAS dims (output texture dimensions)
      // and stash it on the volume so the data model carries the tiling
      // metadata.
      const plan = chunkVolume(rasDims, limit)
      vol.chunkPlan = plan
      const bpv = bytesPerSourceVoxel(vol.hdr.datatypeCode) || 4
      const budget = estimateChunkedBytes(plan, bpv)
      log.warn(
        `Volume ${vol.name} (${rasDims.join('x')}) exceeds ` +
          `maxTextureDimension3D=${limit}. Chunk plan: ` +
          `${plan.gridDims.join('x')} = ${budget.chunkCount} chunks, ` +
          `~${formatBytes(budget.totalBytes)} GPU memory ` +
          `(${formatBytes(budget.scalarBytes)} scalar + ` +
          `${formatBytes(budget.rgbaBytes)} RGBA + ` +
          `${formatBytes(budget.gradientBytes)} gradient).`,
      )
      if (budget.totalBytes > CHUNKED_VOLUME_BYTE_CAP) {
        throw new Error(
          `Volume ${vol.name} too large to render: ` +
            `~${formatBytes(budget.totalBytes)} required, ` +
            `${formatBytes(CHUNKED_VOLUME_BYTE_CAP)} cap. ` +
            `Use a coarser pyramid level or crop the volume.`,
        )
      }
      if (plan.chunks.length > MAX_CHUNKS_PER_TILE) {
        throw new Error(
          `Volume ${vol.name} tiles into ${plan.chunks.length} chunks, ` +
            `exceeding the per-tile limit of ${MAX_CHUNKS_PER_TILE}. ` +
            `Use a coarser pyramid level or crop the volume.`,
        )
      }
      const existing = cacheKey ? this._texCache.get(cacheKey) : undefined
      let chunkedEntry: ChunkedTexEntry
      if (existing && existing.kind === 'chunked') {
        chunkedEntry = existing
      } else {
        if (existing) this._destroyTexEntry(existing)
        const chunks = await volume2TextureChunked(device, vol, plan)
        // Phase 3a: every chunk is uploaded up front and admitted, so the
        // resident set is always complete. The manager owns chunk lifetime
        // and byte accounting; streaming/eviction arrive in 3c/3d.
        const manager = new ChunkResidencyManager<VolumeChunkGPU>(
          plan.chunks.length,
          CHUNKED_VOLUME_BYTE_CAP,
          {
            bytesOf: chunkResidentBytes,
            destroy: (c) => destroyVolumeChunksGPU([c]),
          },
        )
        for (let i = 0; i < chunks.length; i++) manager.admit(i, chunks[i])
        chunkedEntry = {
          kind: 'chunked',
          manager,
          plan,
          centers: computeChunkCenters(plan),
          bindGroups: chunks.map(() => null),
        }
        if (cacheKey) this._texCache.set(cacheKey, chunkedEntry)
      }
      this._activeChunked = chunkedEntry
      this._activeVolKey = cacheKey || null
      this.volumeTexture =
        chunkedEntry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        chunkedEntry.manager.getChunk(0)?.volumeGradientTexture ?? null
      await this._ensureMatcap(device, matcap)
      return
    }

    let entry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (entry && entry.kind !== 'single') {
      this._destroyTexEntry(entry)
      entry = undefined
    }
    if (!entry) {
      const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
      const volumeTexture = await orient.volume2Texture(
        device,
        vol,
        vol,
        mtx as Float32Array,
        0,
      )
      const volumeGradientTexture = await wgpu.volume2TextureGradientRGBA(
        device,
        volumeTexture,
      )
      entry = { kind: 'single', volumeTexture, volumeGradientTexture }
      if (cacheKey) this._texCache.set(cacheKey, entry)
    }
    this._activeChunked = null
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    this._activeVolKey = cacheKey || null

    await this._ensureMatcap(device, matcap)
  }

  /**
   * Reload the matcap texture when the URL changes so that opts.matcap
   * updates take effect — otherwise the first loaded matcap sticks for the
   * lifetime of the renderer. Matcap is independent of the per-volume cache.
   */
  private async _ensureMatcap(
    device: GPUDevice,
    matcap: string,
  ): Promise<void> {
    if (this.matcapTexture == null || this._matcapUrl !== matcap) {
      const newTex = await wgpu.bitmap2textureOrFallback(device, matcap)
      if (this.matcapTexture) this.matcapTexture.destroy()
      this.matcapTexture = newTex
      this._matcapUrl = matcap
      this._invalidateBindGroupCache()
    }
  }

  /**
   * Switch the active volume/gradient textures to the cache entry for
   * `cacheKey` (a volume url or name). Used per-tile by global3d rendering
   * to draw distinct volumes without re-uploading their data each frame.
   * Returns true if the cache hit.
   */
  bindCachedVolume(cacheKey: string | undefined): boolean {
    if (!cacheKey) return false
    const entry = this._texCache.get(cacheKey)
    if (!entry) return false
    this._activeVolKey = cacheKey
    if (entry.kind === 'chunked') {
      // Chunked draws build per-chunk bind groups in draw(); the active
      // single-texture state is set only so hasVolume()/guards pass.
      this._activeChunked = entry
      this.volumeTexture = entry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        entry.manager.getChunk(0)?.volumeGradientTexture ?? null
      return true
    }
    this._activeChunked = null
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    const cached = this._bindGroupCache.get(cacheKey)
    if (cached) {
      this.bindGroup = cached
      this._bindTexVol = entry.volumeTexture
      this._bindTexGrad = entry.volumeGradientTexture
    }
    return true
  }

  /**
   * When the active volume is chunked, expose its plan and per-chunk color
   * textures so the 2D slice renderer can draw one in-plane-restricted quad
   * per chunk. Returns null for single-texture volumes.
   */
  getActiveChunkedSlice(): {
    plan: ChunkPlan
    chunkTextures: GPUTexture[]
    overlayChunks: GPUTexture[] | null
    paqdChunks: GPUTexture[] | null
  } | null {
    if (!this._activeChunked) return null
    const { manager } = this._activeChunked
    const chunkCount = manager.chunkCount
    const chunkTextures: GPUTexture[] = []
    for (let i = 0; i < chunkCount; i++) {
      const c = manager.getChunk(i)
      if (c) chunkTextures.push(c.volumeTexture)
    }
    return {
      plan: this._activeChunked.plan,
      chunkTextures,
      overlayChunks:
        this.overlayChunks && this.overlayChunks.length === chunkCount
          ? this.overlayChunks
          : null,
      paqdChunks:
        this.paqdChunks && this.paqdChunks.length === chunkCount
          ? this.paqdChunks
          : null,
    }
  }

  /** Release the GPU textures backing a single cache entry. */
  private _destroyTexEntry(entry: TexCacheEntry): void {
    if (entry.kind === 'chunked') {
      entry.manager.destroy()
      if (this._activeChunked === entry) this._activeChunked = null
    } else {
      entry.volumeTexture.destroy()
      entry.volumeGradientTexture.destroy()
    }
  }

  /** Release any cached volume textures whose key is not in `keepKeys`. */
  pruneVolumeCache(keepKeys: Set<string>): void {
    for (const [key, entry] of this._texCache) {
      if (keepKeys.has(key)) continue
      this._destroyTexEntry(entry)
      this._texCache.delete(key)
      this._bindGroupCache.delete(key)
    }
  }

  private _invalidateBindGroupCache(): void {
    this._bindGroupCache.clear()
    for (const entry of this._texCache.values()) {
      if (entry.kind === 'chunked') {
        for (let i = 0; i < entry.bindGroups.length; i++) {
          entry.bindGroups[i] = null
        }
      }
    }
  }

  async updateOverlays(
    device: GPUDevice,
    baseVol: NVImage,
    overlayVols: NVImage[],
    _paqdUniforms: readonly number[],
  ): Promise<void> {
    if (!this.isReady) return
    this.clearPaqd()

    if (!baseVol.dimsRAS) {
      this.clearOverlay()
      return
    }
    const dimsOut = [baseVol.dimsRAS[1], baseVol.dimsRAS[2], baseVol.dimsRAS[3]]

    // Filter out overlays with zero opacity
    const visible = overlayVols.filter((v) => (v.opacity ?? 1) > 0)
    if (visible.length === 0) {
      this.clearOverlay()
      return
    }

    // Separate PAQD from standard overlays
    const paqdVols = visible.filter((v) => isPaqd(v.hdr) && v.colormapLabel)
    const standardVols = visible.filter((v) => !isPaqd(v.hdr))

    // Upload first PAQD as raw data + LUT texture (GPU shaders do LUT lookup + easing)
    if (paqdVols.length > 0) {
      const vol = paqdVols[0]
      const prepared = preparePaqdOverlayData(baseVol, vol, dimsOut)
      if (prepared) {
        const { paqdData, lut256 } = prepared
        // Chunked (oversized) background: split the raw PAQD volume into one
        // 3D sub-texture per chunk, sharing the volume's ChunkPlan. The single
        // paqdTexture stays null in that case.
        if (baseVol.chunkPlan) {
          this._updatePaqdChunks(device, paqdData, dimsOut, baseVol.chunkPlan)
        } else {
          this.paqdTexture = device.createTexture({
            size: dimsOut,
            format: 'rgba8unorm',
            dimension: '3d',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
          })
          device.queue.writeTexture(
            { texture: this.paqdTexture },
            paqdData.buffer as ArrayBuffer,
            { bytesPerRow: dimsOut[0] * 4, rowsPerImage: dimsOut[1] },
            dimsOut,
          )
        }
        // Upload 256-entry padded LUT as 2D texture
        this.paqdLutTexture = device.createTexture({
          size: [256, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        })
        device.queue.writeTexture(
          { texture: this.paqdLutTexture },
          lut256.buffer as ArrayBuffer,
          { bytesPerRow: 256 * 4, rowsPerImage: 1 },
          [256, 1],
        )
      }
    }

    // Chunked (oversized) background: build per-chunk overlay textures and
    // skip the single-texture path entirely.
    if (baseVol.chunkPlan) {
      await this._updateOverlayChunks(
        device,
        baseVol,
        baseVol.chunkPlan,
        standardVols,
      )
      return
    }
    // Non-chunked: drop any per-chunk overlay textures from a prior volume.
    this._destroyOverlayChunks()

    // Upload standard overlays
    if (standardVols.length === 0) {
      this.clearOverlay()
    } else if (standardVols.length === 1) {
      const vol = standardVols[0]
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        this.clearOverlay()
        this.overlayTexture = await orient.volume2Texture(
          device,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
        )
        return
      }
      this.destroyNonCachedOverlayTexture()
      this.overlayOrientCache = await orient.prepareOrientTextureCache(
        device,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
        this.overlayOrientCache,
      )
      orient.dispatchOrient(device, this.overlayOrientCache)
      this.overlayTexture = this.overlayOrientCache.outputTexture
    } else if (standardVols.length > 1) {
      this.destroyNonCachedOverlayTexture()
      orient.destroyOrientTextureCache(this.overlayOrientCache)
      this.overlayOrientCache = null
      const overlayTextures: GPUTexture[] = []
      for (const vol of standardVols) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
        overlayTextures.push(
          await orient.volume2Texture(
            device,
            vol,
            baseVol,
            mtx as Float32Array,
            vol.opacity ?? 1,
          ),
        )
      }
      this.destroyNonCachedOverlayTexture()
      this.overlayTexture = await orient.blendOverlaysGPU(
        device,
        overlayTextures,
        dimsOut,
      )
      for (const tex of overlayTextures) tex.destroy()
    }
  }

  async updateAffineOverlay(
    device: GPUDevice,
    baseVol: NVImage,
    overlayVol: NVImage,
  ): Promise<boolean> {
    if (!this.isReady || !this.overlayOrientCache) return false
    if (!baseVol.dimsRAS || isPaqd(overlayVol.hdr)) return false
    if (isRgbaDatatype(overlayVol.hdr.datatypeCode)) {
      return false
    }
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      baseVol,
      overlayVol,
    )
    this.overlayOrientCache = await orient.prepareOrientTextureCache(
      device,
      overlayVol,
      baseVol,
      mtx as Float32Array,
      overlayVol.opacity ?? 1,
      this.overlayOrientCache,
    )
    orient.dispatchOrient(device, this.overlayOrientCache)
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  private destroyNonCachedOverlayTexture(): void {
    if (
      this.overlayTexture &&
      this.overlayTexture !== this.overlayOrientCache?.outputTexture
    ) {
      this.overlayTexture.destroy()
    }
    this.overlayTexture = null
  }

  clearOverlay(): void {
    this.destroyNonCachedOverlayTexture()
    orient.destroyOrientTextureCache(this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks()
    this._invalidateBindGroupCache()
  }

  /**
   * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
   * The overlay layer shares the background volume's ChunkPlan, so the chunk
   * textures align 1:1 with the volume chunks. A single overlay is oriented
   * directly per chunk; multiple overlays are oriented per chunk and blended
   * on the GPU (mirroring the non-chunked multi-overlay path).
   *
   * RGB/RGBA-datatype overlays are skipped on chunked volumes (the chunked
   * orient pass only supports scalar sources, matching the volume chunker).
   */
  private async _updateOverlayChunks(
    device: GPUDevice,
    baseVol: NVImage,
    plan: ChunkPlan,
    standardVols: NVImage[],
  ): Promise<void> {
    // Chunked overlay path: drop the single-texture representation.
    this.destroyNonCachedOverlayTexture()
    orient.destroyOrientTextureCache(this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks()

    const supported = standardVols.filter(
      (v) => !isRgbaDatatype(v.hdr.datatypeCode),
    )
    if (supported.length < standardVols.length) {
      log.warn(
        'chunked overlay: RGB/RGBA-datatype overlays are not yet supported ' +
          'on oversized volumes; skipped',
      )
    }
    if (supported.length === 0) {
      this._invalidateBindGroupCache()
      return
    }

    const mtxs = supported.map(
      (v) =>
        NVTransforms.calculateOverlayTransformMatrix(
          baseVol,
          v,
        ) as Float32Array,
    )

    if (supported.length === 1) {
      this.overlayChunks = await orient.overlay2TextureChunked(
        device,
        supported[0],
        baseVol,
        mtxs[0],
        plan,
        supported[0].opacity ?? 1,
      )
      this._invalidateBindGroupCache()
      return
    }

    // Multiple overlays: orient + GPU-blend per chunk.
    const [dx, dy, dz] = plan.volumeDims
    const finals: GPUTexture[] = []
    for (const desc of plan.chunks) {
      const dims = desc.texDims
      const [ox, oy, oz] = desc.texOrigin
      const scale = [dims[0] / dx, dims[1] / dy, dims[2] / dz]
      const offset = [ox / dx, oy / dy, oz / dz]
      const layers: GPUTexture[] = []
      for (let i = 0; i < supported.length; i++) {
        const chunkMtx = chunkOverlayMatrix(mtxs[i], scale, offset)
        layers.push(
          await orient.volume2Texture(
            device,
            supported[i],
            baseVol,
            chunkMtx,
            supported[i].opacity ?? 1,
            dims,
          ),
        )
      }
      finals.push(
        await orient.blendOverlaysGPU(device, layers, [
          dims[0],
          dims[1],
          dims[2],
        ]),
      )
      for (const tex of layers) tex.destroy()
    }
    this.overlayChunks = finals
    this._invalidateBindGroupCache()
  }

  /** Release all per-chunk overlay textures from a previous build. */
  private _destroyOverlayChunks(): void {
    if (!this.overlayChunks) return
    for (const tex of this.overlayChunks) tex.destroy()
    this.overlayChunks = null
  }

  clearPaqd(): void {
    if (this.paqdTexture) {
      this.paqdTexture.destroy()
      this.paqdTexture = null
    }
    this._destroyPaqdChunks()
    if (this.paqdLutTexture) {
      this.paqdLutTexture.destroy()
      this.paqdLutTexture = null
    }
    this._invalidateBindGroupCache()
  }

  /**
   * Build one raw rgba8unorm PAQD texture per chunk. The PAQD layer shares the
   * background volume's ChunkPlan, so chunk indices and texDims line up with
   * the volume chunks. Each chunk's halo+data region is sliced out of the
   * full-volume PAQD buffer with extractChunkBytes (4 bytes/voxel).
   */
  private _updatePaqdChunks(
    device: GPUDevice,
    paqdData: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
  ): void {
    this._destroyPaqdChunks()
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const chunks: GPUTexture[] = []
    for (const desc of plan.chunks) {
      const bytes = extractChunkBytes(
        paqdData,
        volumeDims,
        4,
        desc.texOrigin,
        desc.texDims,
      )
      const [tx, ty, tz] = desc.texDims
      const tex = device.createTexture({
        size: [tx, ty, tz],
        format: 'rgba8unorm',
        dimension: '3d',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture(
        { texture: tex },
        bytes as Uint8Array<ArrayBuffer>,
        { bytesPerRow: tx * 4, rowsPerImage: ty },
        [tx, ty, tz],
      )
      chunks.push(tex)
    }
    this.paqdChunks = chunks
    this._invalidateBindGroupCache()
  }

  /** Release all per-chunk PAQD textures from a previous build. */
  private _destroyPaqdChunks(): void {
    if (!this.paqdChunks) return
    for (const tex of this.paqdChunks) tex.destroy()
    this.paqdChunks = null
  }

  updateBindGroup(device: GPUDevice): void {
    if (
      !this.isReady ||
      !this.bindLayout ||
      !this.paramsBuffer ||
      !this.sampler ||
      !this.samplerNearest
    )
      return
    if (
      !this.matcapTexture ||
      !this.placeholderOverlay ||
      !this.placeholderLut2D
    )
      return

    const overlayTex = this.overlayTexture || this.placeholderOverlay
    const paqdTex = this.paqdTexture || this.placeholderOverlay
    const drawTex = this.drawingTexture || this.placeholderOverlay
    const paqdLutTex = this.paqdLutTexture || this.placeholderLut2D

    // If any shared (non-volume) texture changed since the cache was
    // populated, drop the per-volume bind group cache — its entries
    // reference stale views. This must run for chunked entries too so
    // their per-chunk bind groups get invalidated.
    const shared = this._bindGroupSharedKey
    if (
      shared.matcap !== this.matcapTexture ||
      shared.overlay !== overlayTex ||
      shared.paqd !== paqdTex ||
      shared.draw !== drawTex ||
      shared.lut !== paqdLutTex
    ) {
      this._invalidateBindGroupCache()
      this._bindGroupSharedKey = {
        matcap: this.matcapTexture,
        overlay: overlayTex,
        paqd: paqdTex,
        draw: drawTex,
        lut: paqdLutTex,
      }
    }

    // Chunked volumes build one bind group per chunk inside draw(); there is
    // no single volume bind group to maintain here.
    if (this._activeChunked) return

    if (!this.volumeTexture || !this.volumeGradientTexture) return

    if (
      this.bindGroup &&
      this._bindTexVol === this.volumeTexture &&
      this._bindTexGrad === this.volumeGradientTexture &&
      this._bindTexMatcap === this.matcapTexture &&
      this._bindTexOverlay === overlayTex &&
      this._bindTexPaqd === paqdTex &&
      this._bindTexDraw === drawTex &&
      this._bindTexLut === paqdLutTex
    ) {
      return
    }

    this.bindGroup = device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.paramsBuffer, size: renderParamsSize },
        },
        { binding: 1, resource: this.volumeTexture.createView() },
        { binding: 2, resource: this.matcapTexture.createView() },
        { binding: 3, resource: this.sampler },
        { binding: 4, resource: this.volumeGradientTexture.createView() },
        { binding: 5, resource: overlayTex.createView() },
        { binding: 6, resource: paqdTex.createView() },
        { binding: 7, resource: drawTex.createView() },
        { binding: 8, resource: this.samplerNearest },
        { binding: 9, resource: paqdLutTex.createView() },
      ],
    })
    this._bindTexVol = this.volumeTexture
    this._bindTexGrad = this.volumeGradientTexture
    this._bindTexMatcap = this.matcapTexture
    this._bindTexOverlay = overlayTex
    this._bindTexPaqd = paqdTex
    this._bindTexDraw = drawTex
    this._bindTexLut = paqdLutTex
    if (this._activeVolKey) {
      this._bindGroupCache.set(this._activeVolKey, this.bindGroup)
    }
  }

  updateDrawingTexture(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
    plan?: ChunkPlan,
  ): void {
    if (!this.isReady) return
    if (plan) {
      this._updateDrawingChunks(device, rgba, dims, plan)
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
      this._invalidateBindGroupCache()
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
   * texDims line up with the volume chunks. Each chunk's halo+data region is
   * sliced out of the full-volume RGBA buffer with extractChunkBytes.
   */
  private _updateDrawingChunks(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
  ): void {
    // Switching to chunked frees the single-texture representation.
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
    for (let i = 0; i < plan.chunks.length; i++) {
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
    // New textures invalidate cached per-chunk bind groups (binding 7).
    if (!reuse) this._invalidateBindGroupCache()
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
    this._invalidateBindGroupCache()
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    tileIndex: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway = false,
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
    earlyTermination = 0.95,
  ): void {
    if (
      !this.isReady ||
      !this.pipeline ||
      !this.paramsBuffer ||
      !this.vertexBuffer ||
      !this.indexBuffer
    )
      return

    if (this._activeChunked) {
      this._drawChunked(
        device,
        pass,
        tileIndex,
        mvpMatrix,
        normalMatrix,
        matRAS,
        volScale,
        rayDir,
        gradientAmount,
        volumeCount,
        clipPlaneColor,
        clipPlanes,
        isClipCutaway,
        paqdUniforms,
        earlyTermination,
      )
      return
    }

    if (!this.bindGroup || !this.volumeTexture) return

    const renderOffset = Math.trunc(tileIndex * alignedRenderSize)
    if (!Number.isFinite(renderOffset)) return

    // Non-chunked: pass-through (identity) tiled-volume uniforms so the cube
    // renders as its own [0,1] tex space exactly as before.
    this._writeRenderParams(
      device,
      this.paramsBuffer,
      renderOffset,
      mvpMatrix,
      normalMatrix,
      matRAS,
      volScale,
      rayDir,
      gradientAmount,
      volumeCount,
      isClipCutaway,
      paqdUniforms,
      earlyTermination,
      clipPlaneColor,
      clipPlanes,
      {
        volumeTexDimsFull: [
          this.volumeTexture.width,
          this.volumeTexture.height,
          this.volumeTexture.depthOrArrayLayers,
        ],
        chunkSubOrigin: [0, 0, 0],
        chunkSubSize: [1, 1, 1],
        dataOriginTexFrac: [0, 0, 0],
        dataSizeTexFrac: [1, 1, 1],
      },
    )

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this.bindGroup, [renderOffset])
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint16')
    pass.drawIndexed(this.cube.indices.length)
  }

  /**
   * Draw one chunked volume into a 3D-render tile: one cube draw per chunk,
   * composited back-to-front. Each chunk gets its own bind group (distinct
   * volume + gradient textures) and its own uniform slot. Back-to-front order
   * is required for the premultiplied-alpha framebuffer blend to composite
   * overlapping chunk contributions correctly.
   */
  private _drawChunked(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    tileIndex: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    isClipCutaway: boolean,
    paqdUniforms: readonly number[],
    earlyTermination: number,
  ): void {
    const entry = this._activeChunked
    if (
      !entry ||
      !this.pipeline ||
      !this.paramsBuffer ||
      !this.vertexBuffer ||
      !this.indexBuffer ||
      !this.bindLayout ||
      !this.sampler ||
      !this.samplerNearest ||
      !this.matcapTexture ||
      !this.placeholderOverlay ||
      !this.placeholderLut2D
    )
      return
    if (entry.manager.chunkCount === 0) return
    if (tileIndex < 0 || tileIndex >= MAX_TILES) return

    const overlayTex = this.overlayTexture || this.placeholderOverlay
    const paqdTex = this.paqdTexture || this.placeholderOverlay
    const drawTex = this.drawingTexture || this.placeholderOverlay
    const paqdLutTex = this.paqdLutTexture || this.placeholderLut2D
    // Per-chunk drawing textures align 1:1 with the volume chunks (shared
    // ChunkPlan); fall back to the shared drawTex when the drawing layer is
    // not chunked or absent.
    const chunkCount = entry.manager.chunkCount
    const drawingChunks =
      this.drawingChunks && this.drawingChunks.length === chunkCount
        ? this.drawingChunks
        : null
    // Per-chunk overlay textures, likewise 1:1 with the volume chunks; fall
    // back to the shared overlayTex when the overlay layer is not chunked.
    const overlayChunks =
      this.overlayChunks && this.overlayChunks.length === chunkCount
        ? this.overlayChunks
        : null
    // Per-chunk raw PAQD textures, likewise 1:1 with the volume chunks; fall
    // back to the shared paqdTex when the PAQD layer is not chunked.
    const paqdChunks =
      this.paqdChunks && this.paqdChunks.length === chunkCount
        ? this.paqdChunks
        : null

    // Back-to-front order: farthest chunk first. dot(rayDir, center) grows
    // along the ray-march direction (start -> back), so descending dot puts
    // the chunk whose center is deepest along the ray first.
    const [rx, ry, rz] = [rayDir[0], rayDir[1], rayDir[2]]
    const order = entry.centers.map((_, i) => i)
    const depth = entry.centers.map((c) => c[0] * rx + c[1] * ry + c[2] * rz)
    order.sort((a, b) => depth[b] - depth[a])

    const chunkBase = MAX_TILES * alignedRenderSize

    pass.setPipeline(this.pipeline)
    pass.setVertexBuffer(0, this.vertexBuffer)
    pass.setIndexBuffer(this.indexBuffer, 'uint16')

    for (let slot = 0; slot < order.length; slot++) {
      const chunkIndex = order[slot]
      const chunk = entry.manager.getChunk(chunkIndex)
      if (!chunk) continue
      let bindGroup = entry.bindGroups[chunkIndex]
      if (!bindGroup) {
        bindGroup = device.createBindGroup({
          layout: this.bindLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: this.paramsBuffer, size: renderParamsSize },
            },
            { binding: 1, resource: chunk.volumeTexture.createView() },
            { binding: 2, resource: this.matcapTexture.createView() },
            { binding: 3, resource: this.sampler },
            {
              binding: 4,
              resource: chunk.volumeGradientTexture.createView(),
            },
            {
              binding: 5,
              resource: (overlayChunks
                ? overlayChunks[chunkIndex]
                : overlayTex
              ).createView(),
            },
            {
              binding: 6,
              resource: (paqdChunks
                ? paqdChunks[chunkIndex]
                : paqdTex
              ).createView(),
            },
            {
              binding: 7,
              resource: (drawingChunks
                ? drawingChunks[chunkIndex]
                : drawTex
              ).createView(),
            },
            { binding: 8, resource: this.samplerNearest },
            { binding: 9, resource: paqdLutTex.createView() },
          ],
        })
        entry.bindGroups[chunkIndex] = bindGroup
      }

      const renderOffset =
        chunkBase + (tileIndex * MAX_CHUNKS_PER_TILE + slot) * alignedRenderSize
      this._writeRenderParams(
        device,
        this.paramsBuffer,
        renderOffset,
        mvpMatrix,
        normalMatrix,
        matRAS,
        volScale,
        rayDir,
        gradientAmount,
        volumeCount,
        isClipCutaway,
        paqdUniforms,
        earlyTermination,
        clipPlaneColor,
        clipPlanes,
        chunkUniformsFor(entry.plan, chunkIndex),
      )

      pass.setBindGroup(0, bindGroup, [renderOffset])
      pass.drawIndexed(this.cube.indices.length)
    }
  }

  private _writeRenderParams(
    device: GPUDevice,
    paramsBuffer: GPUBuffer,
    offset: number,
    mvpMatrix: Float32Array | number[],
    normalMatrix: Float32Array | number[],
    matRAS: Float32Array | number[],
    volScale: Float32Array | number[],
    rayDir: Float32Array | number[],
    gradientAmount: number,
    volumeCount: number,
    isClipCutaway: boolean,
    paqdUniforms: readonly number[],
    earlyTermination: number,
    clipPlaneColor: number[],
    clipPlanes: number[],
    chunkUniforms: ChunkUniforms,
  ): void {
    device.queue.writeBuffer(
      paramsBuffer,
      offset,
      new Float32Array([
        ...mvpMatrix,
        ...normalMatrix,
        ...matRAS,
        ...volScale,
        1.0,
        ...rayDir,
        1.0,
        gradientAmount,
        volumeCount,
        isClipCutaway ? 1.0 : 0.0,
        0.0,
        ...clipPlaneColor,
        ...clipPlanes,
        ...paqdUniforms,
        earlyTermination,
        // _pad0: vec3f starts at WGSL offset 384 (after earlyTermination at
        // 368-372). Write 7 zero floats to advance the byte cursor from
        // 372 → 400 (12 bytes _pad0 + 16 bytes alignment to next vec4f).
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...chunkUniforms.volumeTexDimsFull,
        1,
        ...chunkUniforms.chunkSubOrigin,
        1,
        ...chunkUniforms.chunkSubSize,
        1,
        ...chunkUniforms.dataOriginTexFrac,
        1,
        ...chunkUniforms.dataSizeTexFrac,
        1,
      ]),
    )
  }

  async loadMatcap(device: GPUDevice, matcapUrl: string): Promise<void> {
    if (!this.isReady) return

    try {
      const newTex = await wgpu.bitmap2textureOrFallback(device, matcapUrl)
      if (this.matcapTexture) this.matcapTexture.destroy()
      this.matcapTexture = newTex
      this._matcapUrl = matcapUrl
      this._invalidateBindGroupCache()
      // Wait for GPU to finish upload
      await device.queue.onSubmittedWorkDone()
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

  destroy(): void {
    // Destroy textures
    if (this.matcapTexture) {
      this.matcapTexture.destroy()
      this.matcapTexture = null
      this._matcapUrl = null
    }
    // Destroy all cached per-volume textures (covers the currently active
    // volumeTexture/volumeGradientTexture, which alias an entry).
    for (const entry of this._texCache.values()) {
      this._destroyTexEntry(entry)
    }
    this._texCache.clear()
    this._bindGroupCache.clear()
    this._activeChunked = null
    this._activeVolKey = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.clearOverlay()
    if (this.paqdTexture) {
      this.paqdTexture.destroy()
      this.paqdTexture = null
    }
    this._destroyPaqdChunks()
    if (this.drawingTexture) {
      this.drawingTexture.destroy()
      this.drawingTexture = null
    }
    this._destroyDrawingChunks()
    if (this.placeholderOverlay) {
      this.placeholderOverlay.destroy()
      this.placeholderOverlay = null
    }

    // Destroy buffers
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy()
      this.vertexBuffer = null
    }
    if (this.indexBuffer) {
      this.indexBuffer.destroy()
      this.indexBuffer = null
    }

    // Clear references
    this.bindGroup = null
    this.sampler = null
    this.samplerNearest = null
    this.pipeline = null
    this.bindLayout = null
    this._bindTexVol = null
    this._bindTexGrad = null
    this._bindTexMatcap = null
    this._bindTexOverlay = null
    this._bindTexPaqd = null
    this._bindTexDraw = null
    this._bindTexLut = null
    this.isReady = false

    // Destroy per-device cached pipelines
    if (this._device) {
      orient.destroy(this._device)
      this._device = null
    }
  }
}
