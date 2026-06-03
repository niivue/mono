import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import { isPaqd } from '@/NVConstants'
import { applyCORS } from '@/NVLoader'
import type { NVImage, VolumeChunkExplode } from '@/NVTypes'
import { blendOverlayData } from '@/view/NVMeshView'
import { NVRenderer } from '@/view/NVRenderer'
import {
  isRgbaDatatype,
  preparePaqdOverlayData,
} from '@/view/NVRenderVolumeData'
import {
  chunkExplodedMatRAS,
  chunkExplodeEnabled,
  chunkExplodeOffsetFrac,
} from '@/volume/ChunkExplode'
import { ChunkResidencyManager } from '@/volume/ChunkResidency'
import {
  chunksBackToFront,
  chunksInFrustum,
  chunksNotClippedOut,
  orderByViewCenter,
} from '@/volume/ChunkVisibility'
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
import * as depthPickShader from './depthPickShader'
import * as gradient from './gradient'
import {
  type ChunkUploaderGL,
  createChunkUploaderGL,
  destroyVolumeChunksGL,
  type VolumeChunkGL,
} from './orientChunked'
import * as orientOverlay from './orientOverlay'
import * as renderShader from './renderShader'
import { Shader } from './shader'

/**
 * Default GPU memory budget, in bytes, for a chunked volume's resident chunk
 * set. Mirrors the WebGPU backend; overridable per instance via the
 * `maxChunkResidencyBytes` option. The ChunkResidencyManager evicts
 * least-recently-visible chunks to keep the resident set within budget.
 */
const DEFAULT_CHUNK_RESIDENCY_BYTES = 1_500_000_000

/**
 * Maximum chunks a single chunked volume may tile into. Bounds the per-chunk
 * uniform-buffer slot allocation. Mirrors the WebGPU backend's structural
 * limit so cross-backend error behavior stays identical.
 */
const MAX_CHUNKS_PER_TILE = 256

/**
 * Chunks uploaded per frame by the streaming pump. Mirrors the WebGPU
 * backend: a chunked volume's chunks are uploaded one (orient + gradient) at a
 * time so each frame's main-thread cost is bounded, streaming the volume in
 * over `chunkCount` frames instead of stalling at load.
 */
const CHUNK_UPLOADS_PER_FRAME = 1

/**
 * Near-plane depth convention for this backend's clip space. WebGL2 clip space
 * has z in [-w, w]; `chunksInFrustum` uses this to cull against the near plane.
 */
const CLIP_SPACE_ZERO_TO_ONE = false

type Vec3f = [number, number, number]

/**
 * Per-chunk uniform values for one cube draw of a chunked volume. The shader
 * uses them to scale the unit cube into the chunk's sub-region and remap
 * sample positions into the chunk texture. Non-chunked draws use identity
 * pass-through values.
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

/** Single-texture volume: fits within max3D on all axes. */
interface SingleTexEntry {
  kind: 'single'
  volumeTexture: WebGLTexture
  volumeGradientTexture: WebGLTexture
  /** Full RAS volume dims — WebGL cannot query a texture's size. */
  dims: Vec3f
}

/** Chunked (tiled) volume: one or more axes exceed max3D. */
interface ChunkedTexEntry {
  kind: 'chunked'
  /** Volume object that owns mutable per-volume render options. */
  volume: NVImage
  /** GPU residency bookkeeping for the volume's chunks. */
  manager: ChunkResidencyManager<VolumeChunkGL>
  /** On-demand uploader the streaming pump drives to fill the manager. */
  uploader: ChunkUploaderGL
  plan: ChunkPlan
}

type TexCacheEntry = SingleTexEntry | ChunkedTexEntry

/**
 * Steady-state GPU bytes one resident chunk occupies. The scalar source
 * texture is destroyed after the orient pass, so only the RGBA color texture
 * and the gradient texture persist — both rgba8 (4 bytes/voxel) over the
 * chunk's padded `texDims`.
 */
function chunkResidentBytes(chunk: VolumeChunkGL): number {
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

function chunkOffsetFor(
  plan: ChunkPlan,
  explode: VolumeChunkExplode | undefined,
): ((chunkIndex: number) => Vec3f) | undefined {
  if (!chunkExplodeEnabled(explode)) return undefined
  return (chunkIndex: number) =>
    chunkExplodeOffsetFrac(plan, chunkIndex, explode)
}

export class VolumeRenderer extends NVRenderer {
  private _gl: WebGL2RenderingContext | null
  shader: Shader | null
  depthPickShaderProgram: Shader | null
  matcapTexture: WebGLTexture | null
  private _matcapUrl: string | null
  volumeTexture: WebGLTexture | null
  volumeGradientTexture: WebGLTexture | null
  overlayTexture: WebGLTexture | null
  // Per-chunk overlay textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the overlay layer is chunked; the
  // single-texture overlayTexture stays null in that case (and vice versa).
  overlayChunks: WebGLTexture[] | null
  paqdTexture: WebGLTexture | null
  // Per-chunk raw PAQD textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the PAQD layer is chunked; the
  // single-texture paqdTexture stays null in that case (and vice versa).
  paqdChunks: WebGLTexture[] | null
  paqdLutTexture: WebGLTexture | null
  drawingTexture: WebGLTexture | null
  // Per-chunk drawing textures, parallel to the active chunked volume's
  // plan.chunks. Non-null only when the drawing layer is chunked; the
  // single-texture drawingTexture stays null in that case (and vice versa).
  drawingChunks: WebGLTexture[] | null
  drawingLinearSampler: WebGLSampler | null
  placeholderOverlay: WebGLTexture | null
  cubeVAO: WebGLVertexArrayObject | null
  vertexBuffer: WebGLBuffer | null
  indexBuffer: WebGLBuffer | null
  cube: { vertices: number[]; indices: number[] }
  max3D: number
  // GPU memory budget for a chunked volume's resident chunk set. Set from the
  // maxChunkResidencyBytes option in init; passed to each ChunkResidencyManager.
  private _chunkResidencyBytes = DEFAULT_CHUNK_RESIDENCY_BYTES
  // Per-volume GPU texture cache. Populated by updateVolume; consumed by
  // bindCachedVolume to switch the active volume/gradient texture per tile
  // when rendering multi-instance global3d scenes.
  private _texCache: Map<string, TexCacheEntry>
  // Set when the active volume is chunked; null for single-texture volumes.
  // draw() branches on this to run the multi-chunk loop.
  private _activeChunked: ChunkedTexEntry | null = null
  // Full RAS dims of the active single-texture volume. WebGL cannot query a
  // texture's size, so the renderer tracks it for the volumeTexDimsFull
  // uniform on non-chunked draws and depth picks.
  private _activeDims: Vec3f = [0, 0, 0]
  private _pumpInFlight = false
  private overlayOrientCache: orientOverlay.OverlayTextureCache | null = null

  constructor() {
    super()
    this._gl = null
    this.shader = null
    this.depthPickShaderProgram = null
    this.matcapTexture = null
    this._matcapUrl = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.overlayTexture = null
    this.overlayChunks = null
    this.paqdTexture = null
    this.paqdChunks = null
    this.paqdLutTexture = null
    this.drawingTexture = null
    this.drawingChunks = null
    this.drawingLinearSampler = null
    this.placeholderOverlay = null
    this.cubeVAO = null
    this.vertexBuffer = null
    this.indexBuffer = null
    this.cube = NVShapes.getCubeMesh()
    this.max3D = 0
    this._texCache = new Map()
  }

  async init(
    gl: WebGL2RenderingContext,
    max3D: number,
    chunkResidencyBytes: number = DEFAULT_CHUNK_RESIDENCY_BYTES,
  ): Promise<void> {
    if (this.isReady) return
    this._gl = gl

    this.max3D = max3D
    this._chunkResidencyBytes = chunkResidencyBytes

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

    // Check both source and target (RAS) dims against the device limit.
    // Source dims drive scalar texture upload; RAS dims drive the RGBA
    // output texture. Either can exceed the cap on real-world OME-Zarr
    // L0 levels or microscopy / WSI data.
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.max3D
    const forcedPlan = vol.chunkPlan
    const oversized =
      needsChunking(srcDims, limit) || needsChunking(rasDims, limit)

    const cacheKey = vol.url || vol.name

    if (forcedPlan || oversized) {
      // Halo is 3 (not the [1,1,1] default): the per-chunk gradient runs a
      // sobel (radius 1) + blur (radius 1) stencil, and trilinear sampling
      // at the data edge reaches one voxel further, so the gradient is only
      // seam-free between chunks with a 3-voxel halo.
      const plan = forcedPlan ?? chunkVolume(rasDims, limit, [3, 3, 3])
      vol.chunkPlan = plan
      const bpv = bytesPerSourceVoxel(vol.hdr.datatypeCode) || 4
      const budget = estimateChunkedBytes(plan, bpv)
      log.warn(
        `Volume ${vol.name} (${rasDims.join('x')}) exceeds ` +
          `max3D=${limit}. Chunk plan: ` +
          `${plan.gridDims.join('x')} = ${budget.chunkCount} chunks, ` +
          `~${formatBytes(budget.totalBytes)} GPU memory ` +
          `(${formatBytes(budget.scalarBytes)} scalar + ` +
          `${formatBytes(budget.rgbaBytes)} RGBA + ` +
          `${formatBytes(budget.gradientBytes)} gradient).`,
      )
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
        chunkedEntry.volume = vol
      } else {
        if (existing) this._destroyTexEntry(gl, existing)
        const uploader = createChunkUploaderGL(gl, vol, plan)
        const manager = new ChunkResidencyManager<VolumeChunkGL>(
          plan.chunks.length,
          this._chunkResidencyBytes,
          {
            bytesOf: chunkResidentBytes,
            destroy: (c) => destroyVolumeChunksGL(gl, [c]),
          },
        )
        // Phase 3c: upload only the first chunk synchronously so the volume
        // is immediately present (hasVolume/volumeTexture guards pass). The
        // remaining chunks are not queued here — the view computes a
        // visibility-driven working set each frame and calls
        // requestVisibleChunks / requestChunksInFrustum, so only chunks a
        // tile actually needs stream in.
        manager.admit(0, await uploader.uploadChunk(0))
        chunkedEntry = {
          kind: 'chunked',
          volume: vol,
          manager,
          uploader,
          plan,
        }
        if (cacheKey) this._texCache.set(cacheKey, chunkedEntry)
      }
      this._activeChunked = chunkedEntry
      this._activeDims = [rasDims[0], rasDims[1], rasDims[2]]
      this.volumeTexture =
        chunkedEntry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        chunkedEntry.manager.getChunk(0)?.volumeGradientTexture ?? null
      await this._ensureMatcap(gl, matcap)
      return
    }

    let entry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (entry && entry.kind !== 'single') {
      this._destroyTexEntry(gl, entry)
      entry = undefined
    }
    if (!entry) {
      const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
      const volumeTexture = await orientOverlay.overlay2Texture(
        gl,
        vol,
        vol,
        mtx as Float32Array,
        0,
      )
      gl.bindTexture(gl.TEXTURE_3D, null)
      const dims = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
      const volumeGradientTexture = gradient.volume2TextureGradientRGBA(
        gl,
        volumeTexture,
        dims as [number, number, number],
      )
      entry = {
        kind: 'single',
        volumeTexture,
        volumeGradientTexture,
        dims: [rasDims[0], rasDims[1], rasDims[2]],
      }
      if (cacheKey) this._texCache.set(cacheKey, entry)
    }
    this._activeChunked = null
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    this._activeDims = entry.dims

    await this._ensureMatcap(gl, matcap)
  }

  /**
   * Reload the matcap texture when the URL changes so that opts.matcap
   * updates take effect. Matcap is independent of the per-volume cache.
   */
  private async _ensureMatcap(
    gl: WebGL2RenderingContext,
    matcap: string,
  ): Promise<void> {
    // Matcap is independent of per-volume cache. Reload when the URL
    // changes so that opts.matcap updates take effect — otherwise the
    // first loaded matcap sticks for the lifetime of the renderer.
    if (this.matcapTexture == null || this._matcapUrl !== matcap) {
      const newTex = await this._loadTexture2DOrFallback(gl, matcap)
      if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
      this.matcapTexture = newTex
      this._matcapUrl = matcap
    }
  }

  /**
   * Switch the active volume/gradient textures to the cache entry for
   * `cacheKey` (a volume url or name). Used per-tile by global3d rendering
   * to draw distinct volumes without re-uploading their data each frame.
   * Returns true if the cache hit and textures were rebound.
   */
  bindCachedVolume(cacheKey: string | undefined): boolean {
    if (!cacheKey) return false
    const entry = this._texCache.get(cacheKey)
    if (!entry) return false
    if (entry.kind === 'chunked') {
      // Chunked draws run the multi-chunk loop in draw(); these legacy
      // single-texture pointers are best-effort aliases for callers that
      // inspect them, not the chunked volume's readiness signal.
      this._activeChunked = entry
      this._activeDims = entry.plan.volumeDims
      this.volumeTexture = entry.manager.getChunk(0)?.volumeTexture ?? null
      this.volumeGradientTexture =
        entry.manager.getChunk(0)?.volumeGradientTexture ?? null
      return true
    }
    this._activeChunked = null
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    this._activeDims = entry.dims
    return true
  }

  /**
   * When the active volume is chunked, expose its plan and per-chunk color
   * textures so the 2D slice renderer can draw one in-plane-restricted quad
   * per chunk. Returns null for single-texture volumes.
   */
  getActiveChunkedSlice(): {
    plan: ChunkPlan
    chunkTextures: (WebGLTexture | null)[]
    overlayChunks: WebGLTexture[] | null
    paqdChunks: WebGLTexture[] | null
  } | null {
    if (!this._activeChunked) return null
    const { manager } = this._activeChunked
    const chunkCount = manager.chunkCount
    // Indexed by chunk index; null for chunks not yet streamed in. The slice
    // loop skips nulls — a transient gap rather than a hole, since the pump
    // fills them within a few frames.
    const chunkTextures: (WebGLTexture | null)[] = []
    for (let i = 0; i < chunkCount; i++) {
      chunkTextures.push(manager.getChunk(i)?.volumeTexture ?? null)
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

  /**
   * Phase 3c: queue the active chunked volume's chunks for streaming upload.
   * `requestUpload` is idempotent — already-resident or already-queued chunks
   * are skipped — so the view may call this every frame with a tile's working
   * set. No-op when the active volume is not chunked.
   */
  requestVisibleChunks(chunkIndices: readonly number[]): void {
    const entry = this._activeChunked
    if (!entry) return
    for (const ci of chunkIndices) entry.manager.requestUpload(ci)
  }

  /**
   * Phase 3c: frustum-cull the active chunked volume against a 3D render
   * tile's MVP and queue the visible chunks for streaming. No-op when the
   * active volume is not chunked.
   */
  requestChunksInFrustum(
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
    clipPlanes: number[],
    isCutaway: boolean,
  ): void {
    const entry = this._activeChunked
    if (!entry) return
    // Exploded view: the whole plan is the working set. Explode spreads the
    // blocks apart (often beyond the framed extent), so a frustum cull would
    // drop the blocks that pan off the viewport edges during a rotate; the LRU
    // would then evict them and the 1-chunk/frame pump cannot refill them
    // before the next drag frame, so they visibly blink out. Stamping every
    // chunk each frame keeps them all resident (eviction never drops a chunk
    // touched this frame) so the separated blocks stay put while the camera
    // moves. An exploded render is a deliberate "show all blocks" view, so
    // requesting them all matches intent.
    if (chunkExplodeEnabled(entry.volume.chunkExplode)) {
      for (let ci = 0; ci < entry.plan.chunks.length; ci++) {
        entry.manager.requestUpload(ci)
      }
      return
    }
    const offset = chunkOffsetFor(entry.plan, entry.volume.chunkExplode)
    const visible = chunksInFrustum(
      entry.plan,
      mvp,
      CLIP_SPACE_ZERO_TO_ONE,
      matRAS,
      offset,
    )
    // Drop chunks a clip plane removes entirely from the cutaway, so we never
    // stream blocks the 3D render hides.
    const unclipped = chunksNotClippedOut(
      entry.plan,
      visible,
      clipPlanes,
      isCutaway,
      offset,
    )
    // Stream the centre of the view first, then spiral outward.
    for (const ci of orderByViewCenter(
      entry.plan,
      unclipped,
      mvp,
      matRAS,
      offset,
    ))
      entry.manager.requestUpload(ci)
  }

  /**
   * Queue a 2D-slice working set, viewport-bounded: of the chunks the slice
   * plane crosses (`crossing`), request only those also inside the slice tile's
   * ortho frustum. Without this, a depth-1 volume (every chunk crosses the one
   * axial plane) would stream the whole level; with it, only the on-screen
   * tiles stream — so a gigapixel slide pans at full resolution within budget.
   * Falls back to all `crossing` for an exploded view (intent: show all blocks).
   */
  requestVisibleChunksInView(
    crossing: readonly number[],
    mvp: Float32Array | number[],
    matRAS: Float32Array | number[],
  ): void {
    const entry = this._activeChunked
    if (!entry) return
    if (chunkExplodeEnabled(entry.volume.chunkExplode)) {
      for (const ci of crossing) entry.manager.requestUpload(ci)
      return
    }
    const offset = chunkOffsetFor(entry.plan, entry.volume.chunkExplode)
    const inView = new Set(
      chunksInFrustum(entry.plan, mvp, CLIP_SPACE_ZERO_TO_ONE, matRAS, offset),
    )
    const visible = crossing.filter((ci) => inView.has(ci))
    // Stream the centre of the view first, then spiral outward.
    for (const ci of orderByViewCenter(
      entry.plan,
      visible,
      mvp,
      matRAS,
      offset,
    ))
      entry.manager.requestUpload(ci)
  }

  /**
   * Phase 3d: advance every chunked volume's LRU clock. Must be called once at
   * the start of each frame, before the view requests its working set, so
   * working-set `requestUpload` calls stamp the current frame and a same-frame
   * eviction in `pumpChunkUploads` cannot drop a visible chunk.
   */
  beginChunkFrame(): void {
    for (const entry of this._texCache.values()) {
      if (entry.kind === 'chunked') entry.manager.beginFrame()
    }
  }

  /**
   * Stream in queued chunks for every cached chunked volume — the per-frame
   * upload pump. Uploads at most `CHUNK_UPLOADS_PER_FRAME` chunks total, then
   * `admit`s them. Returns true if any chunk was admitted, so the view can
   * schedule a follow-up frame to show the newly-resident data. A single pump
   * runs at a time so source-backed chunk fetches cannot overlap the next
   * frame's drain.
   */
  async pumpChunkUploads(): Promise<boolean> {
    if (this._pumpInFlight) return false
    let budget = CHUNK_UPLOADS_PER_FRAME
    this._pumpInFlight = true
    let admitted = false
    try {
      for (const entry of this._texCache.values()) {
        if (entry.kind !== 'chunked') continue
        if (budget <= 0) continue
        const indices = entry.manager.takePendingUploads(budget)
        for (const i of indices) {
          try {
            entry.manager.admit(i, await entry.uploader.uploadChunk(i))
          } catch (err) {
            entry.manager.failUpload(i)
            throw err
          }
          admitted = true
          budget--
        }
      }
    } finally {
      this._pumpInFlight = false
    }
    return admitted
  }

  /** Release the GPU textures backing a single cache entry. */
  private _destroyTexEntry(
    gl: WebGL2RenderingContext,
    entry: TexCacheEntry,
  ): void {
    if (entry.kind === 'chunked') {
      entry.manager.destroy()
      entry.uploader.dispose()
      if (this._activeChunked === entry) this._activeChunked = null
    } else {
      gl.deleteTexture(entry.volumeTexture)
      gl.deleteTexture(entry.volumeGradientTexture)
    }
  }

  /** Release any cached volume textures whose key is not in `keepKeys`. */
  pruneVolumeCache(keepKeys: Set<string>): void {
    const gl = this._gl
    if (!gl) return
    for (const [key, entry] of this._texCache) {
      if (keepKeys.has(key)) continue
      this._destroyTexEntry(gl, entry)
      this._texCache.delete(key)
    }
  }

  async updateOverlays(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    overlayVols: NVImage[],
    _paqdUniforms: readonly number[] = [0, 0, 0, 0],
  ): Promise<void> {
    if (!this.isReady) return
    this.clearPaqd(gl)

    if (!baseVol.dimsRAS) {
      this.clearOverlay(gl)
      return
    }
    const dimsOut = [baseVol.dimsRAS[1], baseVol.dimsRAS[2], baseVol.dimsRAS[3]]

    // Filter out overlays with zero opacity
    const visible = overlayVols.filter((v) => (v.opacity ?? 1) > 0)
    if (visible.length === 0) {
      this.clearOverlay(gl)
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
          this._updatePaqdChunks(gl, paqdData, dimsOut, baseVol.chunkPlan)
        } else {
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
        }
        // Upload 256-entry padded LUT as 2D texture (nearest-neighbor)
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

    // Chunked (oversized) background: build per-chunk overlay textures and
    // skip the single-texture path entirely.
    if (baseVol.chunkPlan) {
      this._updateOverlayChunks(gl, baseVol, baseVol.chunkPlan, standardVols)
      return
    }
    // Non-chunked: drop any per-chunk overlay textures from a prior volume.
    this._destroyOverlayChunks(gl)

    // Upload standard overlays
    if (standardVols.length === 0) {
      this.clearOverlay(gl)
    } else if (standardVols.length === 1) {
      const vol = standardVols[0]
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        this.clearOverlay(gl)
        this.overlayTexture = orientOverlay.overlay2Texture(
          gl,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
        return
      }
      this.deleteNonCachedOverlayTexture(gl)
      this.overlayOrientCache = orientOverlay.prepareOverlayTextureCache(
        gl,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
        this.overlayOrientCache,
      )
      this.overlayTexture = this.overlayOrientCache.outputTexture
      gl.bindTexture(gl.TEXTURE_3D, null)
    } else if (standardVols.length > 1) {
      this.deleteNonCachedOverlayTexture(gl)
      orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
      this.overlayOrientCache = null
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
      this.deleteNonCachedOverlayTexture(gl)
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

  updateAffineOverlay(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    overlayVol: NVImage,
  ): boolean {
    if (!this.isReady || !this.overlayOrientCache) return false
    if (!baseVol.dimsRAS || isPaqd(overlayVol.hdr)) return false
    if (isRgbaDatatype(overlayVol.hdr.datatypeCode)) {
      return false
    }
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      baseVol,
      overlayVol,
    )
    this.overlayOrientCache = orientOverlay.prepareOverlayTextureCache(
      gl,
      overlayVol,
      baseVol,
      mtx as Float32Array,
      overlayVol.opacity ?? 1,
      this.overlayOrientCache,
    )
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  private deleteNonCachedOverlayTexture(gl: WebGL2RenderingContext): void {
    if (
      this.overlayTexture &&
      this.overlayTexture !== this.overlayOrientCache?.outputTexture
    ) {
      gl.deleteTexture(this.overlayTexture)
    }
    this.overlayTexture = null
  }

  clearOverlay(gl: WebGL2RenderingContext): void {
    this.deleteNonCachedOverlayTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks(gl)
  }

  /**
   * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
   * The overlay layer shares the background volume's ChunkPlan, so the chunk
   * textures align 1:1 with the volume chunks. A single overlay is oriented
   * directly per chunk; multiple overlays are oriented, read back, and blended
   * on the CPU per chunk (mirroring the non-chunked multi-overlay path).
   *
   * RGB/RGBA-datatype overlays are skipped on chunked volumes (the chunked
   * orient pass only supports scalar sources, matching the volume chunker).
   */
  private _updateOverlayChunks(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    plan: ChunkPlan,
    standardVols: NVImage[],
  ): void {
    // Chunked overlay path: drop the single-texture representation.
    this.deleteNonCachedOverlayTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
    this.overlayOrientCache = null
    this._destroyOverlayChunks(gl)

    const supported = standardVols.filter(
      (v) => !isRgbaDatatype(v.hdr.datatypeCode),
    )
    if (supported.length < standardVols.length) {
      log.warn(
        'chunked overlay: RGB/RGBA-datatype overlays are not yet supported ' +
          'on oversized volumes; skipped',
      )
    }
    if (supported.length === 0) return

    const mtxs = supported.map(
      (v) =>
        NVTransforms.calculateOverlayTransformMatrix(
          baseVol,
          v,
        ) as Float32Array,
    )

    if (supported.length === 1) {
      this.overlayChunks = orientOverlay.overlay2TextureChunked(
        gl,
        supported[0],
        baseVol,
        mtxs[0],
        plan,
        supported[0].opacity ?? 1,
      )
      return
    }

    // Multiple overlays: orient + read back + blend per chunk.
    const [dx, dy, dz] = plan.volumeDims
    const finals: WebGLTexture[] = []
    for (const desc of plan.chunks) {
      const dims = desc.texDims
      const [ox, oy, oz] = desc.texOrigin
      const scale = [dims[0] / dx, dims[1] / dy, dims[2] / dz]
      const offset = [ox / dx, oy / dy, oz / dz]
      const layers: Uint8Array[] = []
      for (let i = 0; i < supported.length; i++) {
        const chunkMtx = chunkOverlayMatrix(mtxs[i], scale, offset)
        const tex = orientOverlay.overlay2Texture(
          gl,
          supported[i],
          baseVol,
          chunkMtx,
          supported[i].opacity ?? 1,
          dims,
        )
        layers.push(orientOverlay.readTexture3D(gl, tex, dims))
        gl.deleteTexture(tex)
      }
      finals.push(
        this._createOverlayChunkTexture(gl, blendOverlayData(layers, dims), [
          dims[0],
          dims[1],
          dims[2],
        ]),
      )
    }
    this.overlayChunks = finals
  }

  /** Upload one blended RGBA8 chunk as a LINEAR-filtered 3D texture. */
  private _createOverlayChunkTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
  ): WebGLTexture {
    const tex = gl.createTexture()
    if (!tex)
      throw new Error('_createOverlayChunkTexture: createTexture failed')
    gl.bindTexture(gl.TEXTURE_3D, tex)
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
      dims[0],
      dims[1],
      dims[2],
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
    return tex
  }

  /** Release all per-chunk overlay textures from a previous build. */
  private _destroyOverlayChunks(gl: WebGL2RenderingContext): void {
    if (!this.overlayChunks) return
    for (const tex of this.overlayChunks) gl.deleteTexture(tex)
    this.overlayChunks = null
  }

  clearPaqd(gl: WebGL2RenderingContext): void {
    if (this.paqdTexture) {
      gl.deleteTexture(this.paqdTexture)
      this.paqdTexture = null
    }
    this._destroyPaqdChunks(gl)
    if (this.paqdLutTexture) {
      gl.deleteTexture(this.paqdLutTexture)
      this.paqdLutTexture = null
    }
  }

  /**
   * Build one raw RGBA8 PAQD texture per chunk. The PAQD layer shares the
   * background volume's ChunkPlan, so chunk indices and texDims line up with
   * the volume chunks. Each chunk's halo+data region is sliced out of the
   * full-volume PAQD buffer with extractChunkBytes (4 bytes/voxel). Textures
   * are NEAREST-filtered like the single-texture PAQD path.
   */
  private _updatePaqdChunks(
    gl: WebGL2RenderingContext,
    paqdData: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
  ): void {
    this._destroyPaqdChunks(gl)
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const chunks: WebGLTexture[] = []
    for (const desc of plan.chunks) {
      const bytes = extractChunkBytes(
        paqdData,
        volumeDims,
        4,
        desc.texOrigin,
        desc.texDims,
      )
      const [tx, ty, tz] = desc.texDims
      const tex = this._createDrawingTexture(gl, bytes, tx, ty, tz)
      if (tex) chunks.push(tex)
    }
    this.paqdChunks = chunks
  }

  /** Release all per-chunk PAQD textures from a previous build. */
  private _destroyPaqdChunks(gl: WebGL2RenderingContext): void {
    if (!this.paqdChunks) return
    for (const tex of this.paqdChunks) gl.deleteTexture(tex)
    this.paqdChunks = null
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
    earlyTermination = 0.95,
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
    // Volume (unit 0) + gradient (unit 2) are bound per-chunk in step 5;
    // here only their sampler unit assignments are set.
    if (shader.uniforms.volume) {
      gl.uniform1i(shader.uniforms.volume, 0)
    }

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.matcapTexture)
    if (shader.uniforms.matcap) {
      gl.uniform1i(shader.uniforms.matcap, 1)
    }

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
    if (shader.uniforms.earlyTermination)
      gl.uniform1f(shader.uniforms.earlyTermination, earlyTermination)

    // 4. Bind Geometry
    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)

    // 5. Draw with premultiplied alpha blending (shader outputs premultiplied colors)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    if (this._activeChunked) {
      this._drawChunkedVolume(
        gl,
        shader,
        indexCount,
        rayDirVec as number[],
        matRAS,
        volScale,
      )
    } else {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, this.volumeGradientTexture)
      // Non-chunked: pass-through (identity) tiled-volume uniforms so the
      // cube renders as its own [0,1] tex space exactly as before.
      this._setChunkUniforms(gl, shader, {
        volumeTexDimsFull: this._activeDims,
        chunkSubOrigin: [0, 0, 0],
        chunkSubSize: [1, 1, 1],
        dataOriginTexFrac: [0, 0, 0],
        dataSizeTexFrac: [1, 1, 1],
      })
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Cleanup
    gl.bindVertexArray(null)
  }

  /** Set the five per-chunk tiled-volume uniforms on the active shader. */
  private _setChunkUniforms(
    gl: WebGL2RenderingContext,
    shader: Shader,
    u: ChunkUniforms,
  ): void {
    if (shader.uniforms.volumeTexDimsFull)
      gl.uniform3fv(shader.uniforms.volumeTexDimsFull, u.volumeTexDimsFull)
    if (shader.uniforms.chunkSubOrigin)
      gl.uniform3fv(shader.uniforms.chunkSubOrigin, u.chunkSubOrigin)
    if (shader.uniforms.chunkSubSize)
      gl.uniform3fv(shader.uniforms.chunkSubSize, u.chunkSubSize)
    if (shader.uniforms.dataOriginTexFrac)
      gl.uniform3fv(shader.uniforms.dataOriginTexFrac, u.dataOriginTexFrac)
    if (shader.uniforms.dataSizeTexFrac)
      gl.uniform3fv(shader.uniforms.dataSizeTexFrac, u.dataSizeTexFrac)
  }

  /**
   * Draw one chunked volume: one cube draw per chunk, composited back-to-
   * front. Each chunk binds its own volume + gradient textures and its own
   * chunk uniforms. Back-to-front order is required for the premultiplied-
   * alpha framebuffer blend to composite overlapping chunks correctly.
   */
  private _drawChunkedVolume(
    gl: WebGL2RenderingContext,
    shader: Shader,
    indexCount: number,
    rayDir: number[],
    matRAS: Float32Array,
    volScale: Float32Array | number[],
  ): void {
    const entry = this._activeChunked
    if (!entry || entry.manager.chunkCount === 0) return
    const chunkCount = entry.manager.chunkCount
    // depthFunc ALWAYS (vs the global LESS): the per-chunk cube draws
    // composite back-to-front with OVER blending and must not depth-test
    // against each other, or a chunk behind an already-drawn chunk is
    // rejected and its contribution is lost. Restored to LESS after the loop.
    gl.depthFunc(gl.ALWAYS)
    const explode = entry.volume.chunkExplode
    const order = chunksBackToFront(
      entry.plan,
      rayDir,
      chunkOffsetFor(entry.plan, explode),
      volScale,
    )
    // Per-chunk drawing textures align 1:1 with the volume chunks (shared
    // ChunkPlan). When present, swap units 5 (nearest) and 7 (linear) to the
    // matching chunk so the drawing layer reads its own sub-texture; the
    // linear sampler object bound to unit 7 outside this loop is unaffected.
    const drawingChunks =
      this.drawingChunks && this.drawingChunks.length === chunkCount
        ? this.drawingChunks
        : null
    // Per-chunk overlay textures, likewise 1:1 with the volume chunks. When
    // present, swap unit 3 to the matching chunk so the overlay layer reads
    // its own sub-texture.
    const overlayChunks =
      this.overlayChunks && this.overlayChunks.length === chunkCount
        ? this.overlayChunks
        : null
    // Per-chunk raw PAQD textures, likewise 1:1 with the volume chunks. When
    // present, swap unit 4 to the matching chunk so the PAQD layer reads its
    // own sub-texture.
    const paqdChunks =
      this.paqdChunks && this.paqdChunks.length === chunkCount
        ? this.paqdChunks
        : null
    for (const chunkIndex of order) {
      const chunk = entry.manager.getChunk(chunkIndex)
      if (!chunk) continue
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, chunk.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, chunk.volumeGradientTexture)
      if (overlayChunks) {
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(gl.TEXTURE_3D, overlayChunks[chunkIndex])
      }
      if (paqdChunks) {
        gl.activeTexture(gl.TEXTURE4)
        gl.bindTexture(gl.TEXTURE_3D, paqdChunks[chunkIndex])
      }
      if (drawingChunks) {
        gl.activeTexture(gl.TEXTURE5)
        gl.bindTexture(gl.TEXTURE_3D, drawingChunks[chunkIndex])
        gl.activeTexture(gl.TEXTURE7)
        gl.bindTexture(gl.TEXTURE_3D, drawingChunks[chunkIndex])
      }
      this._setChunkUniforms(
        gl,
        shader,
        chunkUniformsFor(entry.plan, chunkIndex),
      )
      if (shader.uniforms.matRAS) {
        gl.uniformMatrix4fv(
          shader.uniforms.matRAS,
          false,
          chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        )
      }
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    }
    gl.depthFunc(gl.LESS)
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
    // Depth pick uses a single volume texture; pass identity chunk uniforms
    // so the shared vertex shader / preamble run in non-chunked mode.
    this._setChunkUniforms(gl, shader, {
      volumeTexDimsFull: this._activeDims,
      chunkSubOrigin: [0, 0, 0],
      chunkSubSize: [1, 1, 1],
      dataOriginTexFrac: [0, 0, 0],
      dataSizeTexFrac: [1, 1, 1],
    })

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
      this._matcapUrl = matcapUrl
    } catch (e) {
      log.warn('Matcap load failed', e)
    }
  }

  hasVolume(): boolean {
    return this._activeChunked !== null || this.volumeTexture !== null
  }

  hasOverlay(): boolean {
    return this.overlayTexture !== null
  }

  updateDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
    plan?: ChunkPlan,
  ): void {
    if (!this.isReady) return
    if (plan) {
      this._updateDrawingChunks(gl, rgba, dims, plan)
      return
    }
    // Non-chunked path: switching back from a chunked volume frees the
    // per-chunk drawing textures so only one representation is live.
    this._destroyDrawingChunks(gl)
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
      this.drawingTexture = this._createDrawingTexture(
        gl,
        rgba,
        dims[0],
        dims[1],
        dims[2],
      )
    }
  }

  /**
   * Build (or refresh) one RGBA8 drawing texture per chunk. The drawing layer
   * shares the background volume's ChunkPlan, so chunk indices and texDims
   * line up with the volume chunks. Each chunk's halo+data region is sliced
   * out of the full-volume RGBA buffer with extractChunkBytes (4 bytes/voxel).
   */
  private _updateDrawingChunks(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
    plan: ChunkPlan,
  ): void {
    // Switching to chunked frees the single-texture representation.
    if (this.drawingTexture) {
      gl.deleteTexture(this.drawingTexture)
      this.drawingTexture = null
    }
    const volumeDims: Vec3i = [dims[0], dims[1], dims[2]]
    const reuse =
      this.drawingChunks !== null &&
      this.drawingChunks.length === plan.chunks.length
    if (!reuse) this._destroyDrawingChunks(gl)
    const chunks: WebGLTexture[] = reuse ? (this.drawingChunks ?? []) : []
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
      if (reuse) {
        gl.bindTexture(gl.TEXTURE_3D, chunks[i])
        gl.texSubImage3D(
          gl.TEXTURE_3D,
          0,
          0,
          0,
          0,
          tx,
          ty,
          tz,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bytes,
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
      } else {
        const tex = this._createDrawingTexture(gl, bytes, tx, ty, tz)
        if (tex) chunks.push(tex)
      }
    }
    this.drawingChunks = chunks
  }

  /** Create an RGBA8 3D drawing texture (NEAREST filter, clamp-to-edge). */
  private _createDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    width: number,
    height: number,
    depth: number,
  ): WebGLTexture | null {
    const tex = gl.createTexture()
    if (!tex) return null
    gl.bindTexture(gl.TEXTURE_3D, tex)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA8,
      width,
      height,
      depth,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      rgba,
    )
    gl.bindTexture(gl.TEXTURE_3D, null)
    return tex
  }

  destroyDrawing(gl: WebGL2RenderingContext): void {
    if (this.drawingTexture) {
      gl.deleteTexture(this.drawingTexture)
      this.drawingTexture = null
    }
    this._destroyDrawingChunks(gl)
  }

  /** Release all per-chunk drawing textures from a previous build. */
  private _destroyDrawingChunks(gl: WebGL2RenderingContext): void {
    if (!this.drawingChunks) return
    for (const tex of this.drawingChunks) gl.deleteTexture(tex)
    this.drawingChunks = null
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

    // Delete textures (cache owns volume + gradient textures)
    if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
    // _texCache owns the volume + gradient textures, so freeing the cache
    // covers the legacy this.volumeTexture / this.volumeGradientTexture
    // handles too (those are just pointers into the cache entries).
    for (const entry of this._texCache.values()) {
      this._destroyTexEntry(gl, entry)
    }
    this._texCache.clear()
    this._activeChunked = null
    this.volumeTexture = null
    this.volumeGradientTexture = null
    this.clearOverlay(gl)
    if (this.paqdTexture) gl.deleteTexture(this.paqdTexture)
    this._destroyPaqdChunks(gl)
    if (this.drawingTexture) gl.deleteTexture(this.drawingTexture)
    this._destroyDrawingChunks(gl)
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
