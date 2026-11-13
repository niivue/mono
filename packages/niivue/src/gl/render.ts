import { ByteLru } from '@/byteLru'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVShapes from '@/mesh/NVShapes'
import {
  invGamma,
  isPaqd,
  lodGammaExponent,
  lodOpacityScale,
  OVERLAY_ALPHA_BLEND,
  OVERLAY_COLOR_BLEND,
  SCENE_DEFAULTS,
  VOLUME_DEFAULTS,
  VOLUME_RENDER_MODE,
} from '@/NVConstants'
import { loadImageElement } from '@/NVLoader'
import type { NVImage } from '@/NVTypes'
import {
  ChunkStackFuse,
  chunkRegions,
  stackGeneration,
  stackInputs,
  stackModes,
  stackWeights,
} from '@/view/chunkStackFuse'
import { loadMatcapOrDefault } from '@/view/matcapFallback'
import {
  GENERIC_RENDER_VARIANT,
  renderVariantDefines,
  renderVariantKey,
} from '@/view/NVRenderVariant'
import {
  isRgbaDatatype,
  preparePaqdOverlayData,
} from '@/view/NVRenderVolumeData'
import { isVolumeDrawn } from '@/view/NVVolumeVisibility'
import type { RgbaGrid } from '@/view/planeVisibility'
import { chunkExplodedMatRAS } from '@/volume/ChunkExplode'
import {
  ChunkResidencyManager,
  type RetiringChunk,
} from '@/volume/ChunkResidency'
import {
  ChunkStreamRenderer,
  DEFAULT_CHUNK_RESIDENCY_BYTES,
  MAX_CHUNK_UPLOADS_PER_FRAME,
  MAX_CHUNKS_PER_TILE,
  type StreamEntry,
} from '@/volume/ChunkStreamRenderer'
import { chunkDrawOrder } from '@/volume/ChunkVisibility'
import {
  bytesPerSourceVoxel,
  residentBytesForChunkDesc,
} from '@/volume/chunkBudget'
import {
  type ChunkPlan,
  chunkVolume,
  dimsDownsample,
  needsChunking,
  planSupportsCubic,
  type Vec3i,
  warnIfCubicUnsafe,
} from '@/volume/chunking'
import { chunkPlanMessage } from '@/volume/chunkPlanMessage'
import { ChunkTravelPredictor } from '@/volume/chunkPrediction'
import {
  type ChunkUniforms,
  chunkOffsetFor,
  chunkUniformsFor,
} from '@/volume/chunkRender'
import { decodedTierBudgetBytes } from '@/volume/decodedChunkCache'
import {
  buildModulationParams,
  type ModulationTextureParams,
  modulationFitsTextureLimit,
} from '@/volume/modulation'
import {
  chunkedDisplayKey,
  chunkModulationParams,
  chunkOverlayMatrix,
  coarseFloorKey,
  extractChunkBytes,
  volumeCacheKey,
  volumeSourceKey,
  wholeVolumeTextureKey,
} from '@/volume/orientChunked'
import { blendOverlayData, weightAlpha } from '@/volume/overlayBlend'
import { blendOverlaysGL, destroyBlendOverlaysGL } from './blendOverlays'
import * as depthPickShader from './depthPickShader'
import { blendOver } from './glUtil'
import * as gradient from './gradient'
import {
  type ChunkUploaderGL,
  createChunkUploaderGL,
  destroyVolumeChunksGL,
  type VolumeChunkGL,
} from './orientChunked'
import * as orientOverlay from './orientOverlay'
import * as renderShader from './renderShader'
import { compileShaderAsync, Shader } from './shader'

type Vec3f = [number, number, number]

/** Single-texture volume: fits within max3D on all axes. */
interface SingleTexEntry {
  kind: 'single'
  volumeTexture: WebGLTexture
  /**
   * Null when the volume was uploaded with no gradient consumer switched on --
   * the gradient pass is skipped entirely in that case. `_ensureSingleGradients`
   * fills it in on the first frame after one turns on.
   */
  volumeGradientTexture: WebGLTexture | null
  /**
   * Dims the gradient pass was (or will be) built with. Stored rather than
   * re-derived so a deferred build uses exactly the value its upload would
   * have, and WebGL cannot query a texture's size to recover it.
   */
  gradDims: Vec3f
  /** Full RAS volume dims — WebGL cannot query a texture's size. */
  dims: Vec3f
  /** Categorical volume: never smooth its baked label colors (see _cubicVolumeSafe). */
  isLabel: boolean
  /**
   * wholeVolumeTextureKey the texture was baked with: voxels, window, frame,
   * colormaps (with their addColormap revision), label LUT and modulation. A
   * mismatch rebuilds the entry.
   */
  textureKey: string
}

/** Chunked (tiled) volume: one or more axes exceed max3D. */
type ChunkedTexEntry = StreamEntry<VolumeChunkGL, ChunkUploaderGL>

type TexCacheEntry = SingleTexEntry | ChunkedTexEntry

const renderFragmentShader = (key: number): string =>
  renderShader.fragmentShader.replace(
    '#version 300 es\n',
    `#version 300 es\n${renderVariantDefines(key)}`,
  )

// The Shader class does not resolve uniform arrays.
function withClipPlanes(gl: WebGL2RenderingContext, shader: Shader): Shader {
  shader.uniforms.clipPlanes = gl.getUniformLocation(
    shader.program,
    'clipPlanes[0]',
  )
  return shader
}

// Chunk plans already explained in the log (see chunkPlanMessage): the same
// plan is re-bound on every update.
const loggedChunkPlans = new WeakSet<ChunkPlan>()

export class VolumeRenderer extends ChunkStreamRenderer<
  WebGL2RenderingContext,
  WebGLTexture,
  VolumeChunkGL,
  ChunkUploaderGL,
  ChunkedTexEntry,
  SingleTexEntry
> {
  // WebGL2 clip space has z in [-w, w]; chunksInFrustum culls against that
  // near plane.
  protected readonly clipSpaceZeroToOne = false
  private _gl: WebGL2RenderingContext | null
  // Generic volume program; chunked draws always use it.
  shader: Shader | null
  // Specialized single-volume programs by variant key (view/NVRenderVariant),
  // compiled in the background on first use; the generic program draws until
  // one is linked, and stands in for a variant that failed.
  private _variantShaders = new Map<
    number,
    Shader | ReturnType<typeof compileShaderAsync>
  >()
  depthPickShaderProgram: Shader | null
  matcapTexture: WebGLTexture | null
  private _matcapUrl: string | null
  /** The instance's default matcap, drawn when the requested one fails to load. */
  private readonly _defaultMatcap: string
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
  // The resliced PAQD voxels the paqd texture(s) were uploaded from, kept for
  // the chunked volume's CPU plane pick (view/planeVisibility.ts), which has no
  // single texture to sample. Null when no PAQD layer is bound.
  paqdPickGrid: RgbaGrid | null
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
  // Scene flag (set per-frame from md.scene): clip the overlay/PAQD/drawing passes
  // with the base volume instead of letting them ignore the clip plane.
  clipPlaneOverlay = false
  // Volume flag (set per-frame from md.volume.renderMode): 0 = composite (OVER),
  // 1 = maximum-intensity projection, 2 = orthogonal slices. See
  // VOLUME_RENDER_MODE.
  renderMode = 0
  // The three crosshair planes in the base volume's texture fraction (set
  // per-frame from model.getSliceTexFrac), read only in SLICES mode. 1 is
  // off-cube, so the default hits nothing.
  sliceFrac: number[] = [1, 1, 1]
  // Volume flag (set per-frame from md.volume.isAlphaClipDark): drop a voxel the
  // colormap made fully transparent instead of painting it. Read only in SLICES
  // mode, where it is what makes a plane a cutout rather than a solid slab; the
  // ray-march samples that alpha directly and needs no flag.
  isAlphaClipDark = false
  // Multi-overlay blend modes (set from md.volume before updateOverlays).
  // See OVERLAY_ALPHA_BLEND / OVERLAY_COLOR_BLEND.
  overlayAlphaBlend = OVERLAY_ALPHA_BLEND.MAX
  overlayColorBlend = OVERLAY_COLOR_BLEND.ADDITIVE
  // Stacked channels (isChannelStack) keep their colormap's alpha ramp in the
  // overlay bake; other overlays are made fully opaque above their threshold.
  overlayKeepsColormapAlpha = false
  // Scene display gamma (set per-frame from md.scene.gamma). Applied to the
  // classified RGB of every volume sample, never to alpha, so brightening does
  // not change how much a ray occludes. 1.0 is a strict no-op.
  gamma = SCENE_DEFAULTS.gamma
  // Coefficient for the per-level coarse-brick brightness compensation (from
  // md.volume.lodBrightnessCompensation). 0 disables it. Multiplies into the
  // same shader exponent as `gamma`, per chunk.
  lodBrightnessCompensation = VOLUME_DEFAULTS.lodBrightnessCompensation
  // Coefficient for the per-level coarse-brick OPACITY compensation (from
  // md.volume.lodOpacityCompensation). 0 disables it, which is the default:
  // it measures worse than the brightness compensation on dense structure.
  // Scales the step-size opacity exponent, per chunk.
  lodOpacityCompensation = VOLUME_DEFAULTS.lodOpacityCompensation
  // Samples per voxel along the ray in the 3D fine march (from md.volume.sampleRate).
  // Converges the ray integral at a proportional fragment cost. It does NOT remove
  // concentric banding on smooth structures (measured ring contrast is flat from 1
  // to 4) -- that banding is in the integrand, not in how densely it is sampled.
  sampleRate = VOLUME_DEFAULTS.sampleRate
  // Which stencil the overlay/drawing passes estimate their own gradient with
  // (from md.volume.layerGradientMode). The background volume reads a
  // precomputed gradient texture and is unaffected. See LAYER_GRADIENT_MODE.
  layerGradientMode = VOLUME_DEFAULTS.layerGradientMode
  // Step-size opacity correction for the overlay pass.
  isOverlayOpacityCorrected = VOLUME_DEFAULTS.isOverlayOpacityCorrected
  // Background-volume gradient opacity and silhouette (Fresnel rim), set by the
  // view each frame from md.volume. Both read the precomputed gradient
  // texture's magnitude/direction, so a non-zero value also means the gradient
  // pass must run even when the volume is unlit (see _needsGradient).
  gradientOpacity = VOLUME_DEFAULTS.gradientOpacity
  silhouette = VOLUME_DEFAULTS.silhouette
  // Coarse whole-volume "floor" texture for the active base, drawn behind the
  // resident fine chunks on 2D slices so a deep-zoom slice never blanks while
  // finer chunks stream. Oriented once from a coarse pyramid level the app
  // supplies (niivue stays LOD-agnostic). Null when unset.
  coarseFloorTexture: WebGLTexture | null = null
  /** Voxel dims of `coarseFloorTexture` (drives the floor cubes' step count). */
  coarseFloorDims: [number, number, number] | null = null
  // Gradient for the coarse floor, used by the 3D ray-march floor cubes for
  // matcap lighting consistent with the resident fine chunks. Null when unset.
  coarseFloorGradientTexture: WebGLTexture | null = null
  private _coarseFloorKey: string | null = null
  // Current volume gradient/illumination amount, set by the view each frame
  // BEFORE chunk work (request/pump). Chunk uploaders read this to skip the
  // (expensive, per-slice) gradient pass when the volume is unlit (== 0).
  gradientAmount = 0
  // Dims for the non-cached single-texture volume's deferred gradient build.
  // The single-texture analogue of _uploadedUnlit: non-null and paired with a
  // null volumeGradientTexture means "gradient skipped, build it if asked".
  private _singleGradDims: Vec3f | null = null
  // False when the active volume is categorical (colormapLabel): the ray march
  // samples an RGBA texture whose colors are already baked, so a smooth
  // reconstruction would blend two unrelated labels into a third label's colour.
  // Cubic is forced off for such a volume regardless of the global setting.
  private _cubicVolumeSafe = true
  // Full RAS dims of the active single-texture volume. WebGL cannot query a
  // texture's size, so the renderer tracks it for the volumeTexDimsFull
  // uniform on non-chunked draws and depth picks.
  private _activeDims: Vec3f = [0, 0, 0]
  private overlayOrientCache: orientOverlay.OverlayTextureCache | null = null
  private volumeOrientCache: orientOverlay.OverlayTextureCache | null = null
  // RGB/RGBA volumes skip the orient pass, so their textures are kept here
  // instead, and new voxels are written into them in place.
  private overlayRgbaCache: orientOverlay.RGBATextureCache | null = null
  private volumeRgbaCache: orientOverlay.RGBATextureCache | null = null

  constructor(defaultMatcap = '') {
    super()
    this._defaultMatcap = defaultMatcap
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
    this.paqdPickGrid = null
    this.drawingTexture = null
    this.drawingChunks = null
    this.drawingLinearSampler = null
    this.placeholderOverlay = null
    this.cubeVAO = null
    this.vertexBuffer = null
    this.indexBuffer = null
    this.cube = NVShapes.getCubeMesh()
    this.max3D = 0
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
    this._variantShaders = new Map()
    this.shader = withClipPlanes(
      gl,
      new Shader(
        gl,
        renderShader.vertexShader,
        renderFragmentShader(GENERIC_RENDER_VARIANT),
      ),
    )
    this._variantShaders.set(GENERIC_RENDER_VARIANT, this.shader)

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
    const image = await loadImageElement(imageSrc)
    const texture = gl.createTexture()
    if (!texture) throw new Error('Failed to create texture')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindTexture(gl.TEXTURE_2D, null)
    return texture
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
    allVolumes: NVImage[] = [vol],
    perVolumeCache = false,
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

    const cacheKey = volumeCacheKey(vol)

    if (forcedPlan || oversized) {
      // Same modulation the whole-volume path below resolves; the uploader
      // bakes it into every brick.
      const chunkedEntry = await this._ensureChunkedVolumeEntry(
        gl,
        vol,
        this._chunkResidencyBytes,
        buildModulationParams(vol, vol, allVolumes),
      )
      this._activeChunked = chunkedEntry
      this._cubicVolumeSafe = !vol.colormapLabel
      this._activeDims = [rasDims[0], rasDims[1], rasDims[2]]
      this._syncChunkedAliases(chunkedEntry)
      await this._ensureMatcap(gl, matcap)
      return
    }

    const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol)
    const modParams = buildModulationParams(vol, vol, allVolumes)
    // Leaving a cached volume (chunked, or a per-volume single bound by
    // bindCachedVolume): the aliases name textures a `_texCache` entry still
    // owns, and the single-volume paths that follow delete whatever they find
    // in them. Drop the pointers first so a later switch back to that volume
    // doesn't bind a freed texture.
    const cacheOwned = [...this._texCache.values()].some(
      (e) => e.kind === 'single' && e.volumeTexture === this.volumeTexture,
    )
    if (this._activeChunked || cacheOwned) {
      this.volumeTexture = null
      this.volumeGradientTexture = null
    }
    this._activeChunked = null
    this._cubicVolumeSafe = !vol.colormapLabel

    // This volume is not chunked any more: its plan was cleared, or the same
    // url was reloaded as a plain volume. Drop the chunked entry now, because
    // nothing downstream will. It would otherwise sit in `_texCache` for the
    // life of the renderer holding every brick texture, still driven by
    // `beginChunkFrame`, and still counted by `chunkStreamStats` -- which then
    // reports a brick stream for a single-texture volume. The `perVolumeCache`
    // branch below cleared it, but only multi-instance callers take that
    // branch, so the ordinary path leaked.
    const priorEntry = cacheKey ? this._texCache.get(cacheKey) : undefined
    if (priorEntry?.kind === 'chunked') {
      this._evictTexEntry(gl, cacheKey, priorEntry)
    }

    if (perVolumeCache) {
      // Multi-instance / global3d: cache each volume's texture by key so the
      // render loop can switch the active texture per tile via
      // bindCachedVolume. (volumeOrientCache is a single slot and cannot serve
      // per-tile volume switching.)
      // The chunked case was evicted above, so anything still here is single.
      // Narrowing on `kind` rather than asserting keeps that an invariant the
      // compiler checks.
      const prior = cacheKey ? this._texCache.get(cacheKey) : undefined
      let entry = prior?.kind === 'single' ? prior : undefined
      // Anything the texture bakes in changed (voxels, window, frame,
      // colormap, label LUT, modulation): rebuild the entry.
      // Computed before the awaits below: an edit landing during them must
      // leave this entry stale (rebuilt next time), not marked current.
      const textureKey = wholeVolumeTextureKey(vol, mtx, modParams)
      if (entry && entry.textureKey !== textureKey) {
        this._evictTexEntry(gl, cacheKey, entry)
        entry = undefined
      }
      if (!entry) {
        const volumeTexture = await orientOverlay.overlay2Texture(
          gl,
          vol,
          vol,
          mtx as Float32Array,
          0,
          undefined,
          modParams,
        )
        gl.bindTexture(gl.TEXTURE_3D, null)
        const gradDims = [
          vol.hdr.dims[1],
          vol.hdr.dims[2],
          vol.hdr.dims[3],
        ] as Vec3f
        // Skipped outright when nothing reads it. The pass is a per-z-slice
        // FBO render over the whole volume and the texture it produces is the
        // size of the volume, so an unlit scene pays neither.
        const volumeGradientTexture = this._needsGradient()
          ? gradient.volume2TextureGradientRGBA(gl, volumeTexture, gradDims)
          : null
        entry = {
          kind: 'single',
          volumeTexture,
          volumeGradientTexture,
          gradDims,
          dims: [rasDims[0], rasDims[1], rasDims[2]],
          isLabel: !!vol.colormapLabel,
          textureKey,
        }
        if (cacheKey) this._texCache.set(cacheKey, entry)
      }
      this.volumeTexture = entry.volumeTexture
      this.volumeGradientTexture = entry.volumeGradientTexture
      this._singleGradDims = entry.gradDims
      this._activeDims = entry.dims
    } else {
      // Normal single-volume path: orient-texture cache + modulation. Scalar
      // volumes go through the orient-texture cache so cal_min/max/colormap
      // tweaks only re-run the cheap orient pass.
      this.deleteNonCachedVolumeTexture(gl)
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        // RGB/RGBA volumes bypass the orient pass: their voxels go straight
        // into a kept texture, and only when they changed.
        orientOverlay.destroyOverlayTextureCache(gl, this.volumeOrientCache)
        this.volumeOrientCache = null
        this.volumeRgbaCache = orientOverlay.prepareRGBATextureCache(
          gl,
          vol,
          this.volumeRgbaCache,
        )
        this.volumeTexture = this.volumeRgbaCache.texture
      } else {
        orientOverlay.destroyRGBATextureCache(gl, this.volumeRgbaCache)
        this.volumeRgbaCache = null
        this.volumeOrientCache = orientOverlay.prepareOverlayTextureCache(
          gl,
          vol,
          vol,
          mtx as Float32Array,
          0,
          this.volumeOrientCache,
          modParams,
        )
        this.volumeTexture = this.volumeOrientCache.outputTexture
      }
      gl.bindTexture(gl.TEXTURE_3D, null)
      const gradDims = [
        vol.hdr.dims[1],
        vol.hdr.dims[2],
        vol.hdr.dims[3],
      ] as Vec3f
      if (this.volumeGradientTexture) {
        gl.deleteTexture(this.volumeGradientTexture)
      }
      // See the cached branch: skipped when nothing reads it, and remembered
      // (via _singleGradDims) so it can be filled in later without a reupload.
      this._singleGradDims = gradDims
      this.volumeGradientTexture = this._needsGradient()
        ? gradient.volume2TextureGradientRGBA(gl, this.volumeTexture, gradDims)
        : null
      this._activeDims = [rasDims[0], rasDims[1], rasDims[2]]
    }

    await this._ensureMatcap(gl, matcap)
  }

  /**
   * Build (or reuse from the texture cache) the chunked GL entry for an
   * oversized / forced-plan volume: compute the ChunkPlan against RAS dims,
   * log the budget, enforce MAX_CHUNKS_PER_TILE, create the uploader +
   * residency manager, and admit chunk 0 synchronously so the volume is
   * immediately present. The remaining chunks stream on demand once the view
   * computes a visibility-driven working set.
   *
   * Used for the base volume AND for an independently-streamed hi-res chunked
   * overlay — each gets its own cache entry + residency manager, keyed by its
   * own url/name, and the per-frame pump (pumpChunkUploads) drives them all.
   *
   * Halo is 3 (not the [1,1,1] default): each of the two gradient passes taps
   * +-0.7 voxel through a LINEAR sampler, so the Sobel reaches two voxels past
   * the chunk, and trilinear sampling at the data edge reaches one further --
   * 3 is the exact requirement, not a margin.
   */
  protected async _ensureChunkedVolumeEntry(
    gl: WebGL2RenderingContext,
    vol: NVImage,
    budgetBytes: number,
    modulation: ModulationTextureParams | null,
    // WebGPU invalidates bind groups on mirror residency; WebGL2 binds per draw.
    _onResidencyChange?: (chunkIndex: number) => void,
    basePlan?: ChunkPlan,
  ): Promise<ChunkedTexEntry> {
    const srcDims: Vec3i = [vol.hdr.dims[1], vol.hdr.dims[2], vol.hdr.dims[3]]
    const rasDims: Vec3i = vol.dimsRAS
      ? [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]]
      : srcDims
    const limit = this.max3D
    // A combined mirror streams on its base's grid (basePlan) without taking
    // it as its own: the overlay may later become the base or stream alone.
    let plan =
      basePlan ?? vol.chunkPlan ?? chunkVolume(rasDims, limit, [3, 3, 3])
    if (!basePlan) vol.chunkPlan = plan
    const bpv = bytesPerSourceVoxel(vol.hdr.datatypeCode) || 4
    if (!loggedChunkPlans.has(plan)) {
      loggedChunkPlans.add(plan)
      const message = chunkPlanMessage({
        name: vol.name,
        datatypeCode: vol.hdr.datatypeCode,
        rasDims,
        limit,
        limitName: 'MAX_3D_TEXTURE_SIZE',
        plan,
      })
      log[message.level](message.text)
    }
    if (plan.chunks.length > MAX_CHUNKS_PER_TILE) {
      throw new Error(
        `Volume ${vol.name} tiles into ${plan.chunks.length} chunks, ` +
          `exceeding the per-tile limit of ${MAX_CHUNKS_PER_TILE}. ` +
          `Use a coarser pyramid level or crop the volume.`,
      )
    }
    const cacheKey = volumeCacheKey(vol)
    const displayKey = chunkedDisplayKey(vol, modulation)
    const sourceKey = volumeSourceKey(vol)
    let existing = cacheKey ? this._texCache.get(cacheKey) : undefined
    // A swap to this very plan is in flight; let it land, then reuse it. A
    // later swap can supersede it before it runs: follow that one too, since
    // its plan is the one the volume streams on now.
    let waited = false
    while (
      existing?.kind === 'chunked' &&
      existing.plan !== plan &&
      existing.pendingSwap &&
      (waited || existing.pendingSwap.plan === plan)
    ) {
      plan = existing.pendingSwap.plan
      await existing.pendingSwap.done.catch(() => undefined)
      waited = true
      existing = cacheKey ? this._texCache.get(cacheKey) : undefined
    }
    // A cached entry built for a different plan object (the caller set a new
    // `vol.chunkPlan`, as setVolumeChunkGrid does) cannot be reused: its
    // uploader, manager and brick textures are laid out for the old grid.
    // Fall through to the eviction below and rebuild. In-place swaps via
    // swapChunkedVolumePlan keep `existing.plan` in step, so they still hit.
    if (
      existing &&
      existing.kind === 'chunked' &&
      existing.plan === plan &&
      existing.sourceKey === sourceKey
    ) {
      existing.volume = vol
      if (existing.displayKey !== displayKey) {
        // Colormap/window/frame changed after load. Resident chunk textures
        // bake the old state, so rebuild the uploader (recaptures the 4D frame
        // window) and re-stream: evict everything, then admit chunk 0 with the
        // new state so the volume stays present while the working set refills —
        // the same drop-and-refill mechanism as _refreshUnlitChunksForLighting.
        existing.displayKey = displayKey
        existing.modulation = modulation
        // The decoded tier is deliberately kept: it holds SOURCE bytes, and a
        // colormap or window change re-orients the same source. The re-stream
        // below therefore costs uploads, not fetches.
        const newUploader = createChunkUploaderGL(
          gl,
          vol,
          existing.plan,
          () => this._needsGradient(),
          existing.decoded,
          modulation,
        )
        existing.uploader.dispose()
        existing.uploader = newUploader
        existing.speculative.clear()
        existing.manager.remap(new Map(), existing.plan.chunks.length)
        const chunk0 = await existing.uploader.uploadChunk(0)
        if (!chunk0.hasGradient) this._uploadedUnlit = true
        existing.manager.admit(0, chunk0)
      }
      return existing
    }
    if (existing) this._evictTexEntry(gl, cacheKey, existing)
    // The entry holds the live uploader so an in-place plan swap can replace it;
    // the prefetch hook reads it off `entry` (not a creation closure) so it
    // always targets the current plan.
    const decoded = new ByteLru<number, Uint8Array>(
      decodedTierBudgetBytes(budgetBytes, bpv),
    )
    const entry: ChunkedTexEntry = {
      kind: 'chunked',
      volume: vol,
      manager: undefined as unknown as ChunkResidencyManager<VolumeChunkGL>,
      uploader: createChunkUploaderGL(
        gl,
        vol,
        plan,
        () => this._needsGradient(),
        decoded,
        modulation,
      ),
      plan,
      displayKey,
      sourceKey,
      modulation,
      cubicSafe: planSupportsCubic(plan),
      predictor: new ChunkTravelPredictor(),
      requestedThisFrame: [],
      speculative: new Set(),
      predictedCount: 0,
      decoded,
      sourceBytesPerVoxel: bpv,
    }
    warnIfCubicUnsafe(vol.name, entry.cubicSafe, this.isCubicInterpolation)
    entry.manager = new ChunkResidencyManager<VolumeChunkGL>(
      plan.chunks.length,
      budgetBytes,
      {
        bytesOf: (c) => residentBytesForChunkDesc(c.desc, c.hasGradient),
        destroy: (c) => destroyVolumeChunksGL(gl, [c]),
        prefetch: (ci) => entry.uploader.prefetchChunk(ci),
        cancel: (ci) => entry.uploader.cancelChunk(ci),
      },
    )
    const chunk0 = await entry.uploader.uploadChunk(0)
    if (!chunk0.hasGradient) this._uploadedUnlit = true
    entry.manager.admit(0, chunk0)
    if (cacheKey) this._texCache.set(cacheKey, entry)
    return entry
  }

  /**
   * Refresh the whole-volume texture aliases for a chunked entry.
   *
   * A chunked volume has no single volume texture: `volumeTexture` /
   * `volumeGradientTexture` are a best-effort alias of chunk 0. Chunk 0 is not
   * guaranteed resident (a refocus can evict it, and `remap` destroys every chunk
   * the new plan does not match), so re-derive them whenever residency changes --
   * otherwise they dangle at a texture that has already been deleted.
   */
  private _syncChunkedAliases(entry: ChunkedTexEntry): void {
    const chunk0 = entry.manager.getChunk(0)
    this.volumeTexture = chunk0?.volumeTexture ?? null
    this.volumeGradientTexture = chunk0?.volumeGradientTexture ?? null
  }

  /** Queue a plan swap on `entry` behind any swap already queued on it. */
  /** A chunk uploader for `plan`, baking the volume's current display state. */
  protected _newChunkUploader(
    gl: WebGL2RenderingContext,
    vol: NVImage,
    plan: ChunkPlan,
    decoded: ByteLru<number, Uint8Array>,
    modulation: ModulationTextureParams | null,
  ): ChunkUploaderGL {
    return createChunkUploaderGL(
      gl,
      vol,
      plan,
      () => this._needsGradient(),
      decoded,
      modulation,
    )
  }

  /** WebGL2 binds chunk textures per draw: no per-chunk binding to drop. */
  protected _resetChunkBindings(_entry: ChunkedTexEntry): void {}

  /** WebGL2 binds overlay textures per draw: no bind-group cache to drop. */
  protected _invalidateBindGroupCache(): void {}

  /** WebGL2 binds overlay textures per draw: nothing tracks mirror residency. */
  protected _invalidateBaseChunkBinding(_chunkIndex: number): void {}

  /**
   * remap() destroyed every chunk the new plan does not match, so the aliases
   * captured for the old plan may now name deleted textures.
   */
  protected _onPlanSwapped(entry: ChunkedTexEntry): void {
    if (this._activeChunked === entry) this._syncChunkedAliases(entry)
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
      const newTex = await loadMatcapOrDefault(
        matcap,
        this._defaultMatcap,
        (url) => this._loadTexture2DOrFallback(gl, url),
      )
      if (this.matcapTexture) gl.deleteTexture(this.matcapTexture)
      this.matcapTexture = newTex
      // The requested URL, even after a fallback, so a matcap that failed is
      // not fetched again on every update.
      this._matcapUrl = matcap
    }
  }

  /**
   * Switch the active volume/gradient textures to the cache entry for
   * `cacheKey` (from volumeCacheKey). Used per-tile by global3d rendering
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
      this._cubicVolumeSafe = !entry.volume.colormapLabel
      this._activeDims = entry.plan.volumeDims
      this._syncChunkedAliases(entry)
      return true
    }
    this._activeChunked = null
    this._cubicVolumeSafe = !entry.isLabel
    this.volumeTexture = entry.volumeTexture
    this.volumeGradientTexture = entry.volumeGradientTexture
    this._singleGradDims = entry.gradDims
    this._activeDims = entry.dims
    return true
  }

  /** 2D-slice working set for the independently-streamed hi-res overlay. */
  /**
   * Build any non-chunked gradient texture that the upload path deferred.
   *
   * The single-texture analogue of `_refreshUnlitChunksForLighting`: an unlit
   * volume skips the gradient pass at upload, so switching illumination,
   * gradient opacity or silhouette on has to fill it in. Called once per frame
   * before the tile loop; a no-op pointer test once the texture exists, and
   * the texture outlives the toggle so flipping the feature off and on again
   * does not rebuild it.
   */
  protected _ensureSingleGradients(): void {
    const gl = this._gl
    if (!gl || !this._needsGradient()) return
    for (const entry of this._texCache.values()) {
      if (entry.kind !== 'single' || entry.volumeGradientTexture) continue
      entry.volumeGradientTexture = gradient.volume2TextureGradientRGBA(
        gl,
        entry.volumeTexture,
        entry.gradDims,
      )
      // updateVolume / bindCachedVolume copied the then-null pointer into the
      // live slot, so re-point it at the texture just built.
      if (entry.volumeTexture === this.volumeTexture) {
        this.volumeGradientTexture = entry.volumeGradientTexture
      }
    }
    if (
      !this._activeChunked &&
      this.volumeTexture &&
      !this.volumeGradientTexture &&
      this._singleGradDims
    ) {
      this.volumeGradientTexture = gradient.volume2TextureGradientRGBA(
        gl,
        this.volumeTexture,
        this._singleGradDims,
      )
    }
  }

  /** The stack's channel entries, base first. */
  /** The stack's source generation (see ChunkStackFuse). */
  /**
   * Re-fuse stack chunks whose bricks or blend modes changed until `deadline`
   * (at least one per pump), on the GPU (blendOverlaysGL, as WebGPU's
   * blendOverlaysGPU), with the overlay modes the whole-volume stack uses; a
   * context without float render targets (WebGL2 does not require them; the
   * cinematic pass is the other optional user) reads back and blends on the
   * CPU. A fused chunk costs one RGBA8 brick (texDims x 4 bytes), outside the
   * residency budget. Returns whether any chunk changed.
   */
  protected async _fuseStackChunks(deadline: number): Promise<boolean> {
    const fuse = this._stackFuse
    const gl = this._gl
    const base = this._activeChunked
    if (!fuse || !gl || !base || this._stackRebuilding) return false
    const entries = this._stackEntries()
    const chunks = base.plan.chunks
    const alpha = this.overlayAlphaBlend
    const color = this.overlayColorBlend
    const weights = stackWeights(entries)
    return fuse.pump(
      chunkRegions(base.plan),
      stackGeneration(entries),
      stackModes(entries, alpha, color),
      (i) => stackInputs(entries, i),
      (inputs, i) => {
        const dims = chunks[i].texDims
        return (
          blendOverlaysGL(gl, inputs, dims, alpha, color, weights) ??
          this._createOverlayChunkTexture(
            gl,
            blendOverlayData(
              inputs.map((t, k) =>
                weightAlpha(
                  orientOverlay.readTexture3D(gl, t, dims),
                  weights[k],
                ),
              ),
              dims,
              alpha,
              color,
            ),
            [dims[0], dims[1], dims[2]],
          )
        )
      },
      deadline,
      MAX_CHUNK_UPLOADS_PER_FRAME,
      () => this._stackFuse === fuse && !this._stackRebuilding,
    )
  }

  /** Release the GPU textures backing a single cache entry. */
  private _destroyTexEntry(
    gl: WebGL2RenderingContext,
    entry: TexCacheEntry,
  ): void {
    if (entry.kind === 'chunked') {
      entry.manager.destroy()
      entry.uploader.dispose()
      entry.decoded.clear()
      if (this._activeChunked === entry) this._activeChunked = null
      if (this._activeOverlayChunked === entry)
        this._activeOverlayChunked = null
      const ci = this._combinedOverlayEntries.indexOf(entry)
      if (ci >= 0) this._combinedOverlayEntries.splice(ci, 1)
    } else {
      gl.deleteTexture(entry.volumeTexture)
      // Null when the volume was uploaded with no gradient consumer on.
      if (entry.volumeGradientTexture) {
        gl.deleteTexture(entry.volumeGradientTexture)
      }
    }
  }

  /**
   * Release an entry's GPU resources AND drop it from the cache.
   *
   * Destroying without deleting is the dangerous half: the entry stays in
   * `_texCache`, so every method that iterates the map -- `beginChunkFrame`,
   * the gradient refreshes, `chunkStreamStats` -- can still reach a destroyed
   * manager and a disposed uploader. The replace-in-place call sites only
   * re-`set` the key after an await, so a frame landing in that window sees the
   * dead entry. Always evict through here rather than pairing the two calls by
   * hand.
   */
  private _evictTexEntry(
    gl: WebGL2RenderingContext,
    key: string | undefined,
    entry: TexCacheEntry,
  ): void {
    this._destroyTexEntry(gl, entry)
    if (key) this._texCache.delete(key)
  }

  /** Release any cached volume textures whose key is not in `keepKeys`. */
  pruneVolumeCache(keepKeys: Set<string>): void {
    const gl = this._gl
    if (!gl) return
    for (const [key, entry] of this._texCache) {
      if (keepKeys.has(key)) continue
      this._evictTexEntry(gl, key, entry)
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

    // Drop hidden overlays (visible: false or zero opacity) before the bake:
    // an overlayOpacity of 0 means background semantics in the orient shader,
    // not transparency, so a hidden overlay must leave the list entirely.
    const visible = overlayVols.filter(isVolumeDrawn)
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
        this.paqdPickGrid = { data: paqdData, dims: dimsOut }
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

    // Independently-streamed hi-res overlays carry chunkOverlayOf: they have
    // their own ChunkPlan + residency and draw as their own chunk cubes over
    // the base, rather than being resliced onto the base grid. Split them out
    // from the base-grid-resliced overlays.
    const independentVols = standardVols.filter((v) => v.chunkOverlayOf)
    const reslicedVols = standardVols.filter((v) => !v.chunkOverlayOf)
    if (independentVols.length > 0) {
      await this._updateOverlayChunkedIndependent(gl, independentVols[0], [
        baseVol,
        ...overlayVols,
      ])
      if (independentVols.length > 1) {
        log.warn(
          'only one independently-chunked overlay is supported; ' +
            'extra ones are ignored',
        )
      }
    } else {
      this.clearOverlayChunked()
    }

    // Chunked (oversized) background: build per-chunk overlay textures and
    // skip the single-texture path entirely.
    if (baseVol.chunkPlan) {
      // Strategy A: a resliced overlay carrying a chunkSource and co-registered
      // at the base grid streams as a base-aligned chunked entry and feeds the
      // base block's overlay slot, instead of being resliced whole in memory.
      // A channel stack lists the base among its overlays: the base's own
      // entry is a fuse input, never its own mirror.
      const stack = overlayVols[0] === baseVol
      const streamable = (v: NVImage): boolean =>
        !!v.chunkSource && this._dimsMatchBase(v, baseVol)
      const others = reslicedVols.filter((v) => v !== baseVol)
      const streamedCombined = others.filter(streamable)
      const wholeReslice = others.filter((v) => !streamable(v))
      await this._updateCombinedOverlayChunked(gl, streamedCombined, [
        baseVol,
        ...overlayVols,
      ])
      if (stack)
        this._stackFuse ??= new ChunkStackFuse((t) => gl.deleteTexture(t))
      else this._clearStackFuse()
      this._updateOverlayChunks(
        gl,
        baseVol,
        baseVol.chunkPlan,
        wholeReslice,
        overlayVols,
      )
      return
    }
    // Non-chunked: drop any per-chunk overlay textures from a prior volume.
    this._clearCombinedOverlayChunked()
    this._destroyOverlayChunks(gl)

    // A streamed overlay (chunkSource, no in-memory `img`) can only render via
    // the chunked path above. It reaches here only transiently — e.g. an
    // overlay-option change fires loadVolumes() while a prior base load is still
    // in flight, so updateOverlays runs before the base's chunkPlan is set.
    // Reslicing it would call overlay2Texture/prepareOverlayTextureCache on a
    // null `img` and throw "image data missing"; skip it until the next update
    // (once the base is chunked) renders it through the combined path.
    const inMem = reslicedVols.filter((v) => v.img)
    if (inMem.length < reslicedVols.length) {
      log.warn(
        'updateOverlays: skipping streamed overlay(s) with no in-memory image ' +
          'until the base volume is chunked',
      )
    }

    // Upload standard overlays
    if (inMem.length === 0) {
      this.clearOverlay(gl)
    } else if (inMem.length === 1) {
      const vol = inMem[0]
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
      this.deleteNonCachedOverlayTexture(gl)
      if (isRgbaDatatype(vol.hdr.datatypeCode)) {
        // Like the background: rewritten only when its voxels changed, or
        // after background masking edited it (maskOverlayByBackground).
        orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
        this.overlayOrientCache = null
        this.overlayRgbaCache = orientOverlay.prepareRGBATextureCache(
          gl,
          vol,
          this.overlayRgbaCache,
        )
        this.overlayTexture = this.overlayRgbaCache.texture
        return
      }
      orientOverlay.destroyRGBATextureCache(gl, this.overlayRgbaCache)
      this.overlayRgbaCache = null
      this.overlayOrientCache = orientOverlay.prepareOverlayTextureCache(
        gl,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
        this.overlayOrientCache,
        buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
        this.overlayKeepsColormapAlpha,
      )
      this.overlayTexture = this.overlayOrientCache.outputTexture
      gl.bindTexture(gl.TEXTURE_3D, null)
    } else if (inMem.length > 1) {
      this.deleteNonCachedOverlayTexture(gl)
      orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
      this.overlayOrientCache = null
      orientOverlay.destroyRGBATextureCache(gl, this.overlayRgbaCache)
      this.overlayRgbaCache = null
      const overlayData: Uint8Array[] = []
      for (const vol of inMem) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol)
        const tex = orientOverlay.overlay2Texture(
          gl,
          vol,
          baseVol,
          mtx as Float32Array,
          vol.opacity ?? 1,
          undefined,
          buildModulationParams(vol, baseVol, [baseVol, ...overlayVols]),
          null,
          this.overlayKeepsColormapAlpha,
        )
        const data = orientOverlay.readTexture3D(gl, tex, dimsOut)
        gl.deleteTexture(tex)
        overlayData.push(data)
      }
      const blended = blendOverlayData(
        overlayData,
        dimsOut,
        this.overlayAlphaBlend,
        this.overlayColorBlend,
      )
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
      buildModulationParams(overlayVol, baseVol, [baseVol, overlayVol]),
      this.overlayKeepsColormapAlpha,
    )
    this.overlayTexture = this.overlayOrientCache.outputTexture
    return true
  }

  /**
   * Clip the overlay to the background's non-transparent voxels
   * (isBackgroundMasking), in place. A kept RGBA overlay texture then no
   * longer holds the volume's voxels, so its key is cleared and the next
   * overlay pass rewrites it.
   */
  maskOverlayByBackground(
    gl: WebGL2RenderingContext,
    dims: readonly number[],
  ): void {
    if (!this.overlayTexture || !this.volumeTexture) return
    orientOverlay.maskOverlayByBackground(
      gl,
      this.volumeTexture,
      this.overlayTexture,
      [dims[0], dims[1], dims[2]],
    )
    if (this.overlayTexture === this.overlayRgbaCache?.texture) {
      this.overlayRgbaCache.key = ''
    }
  }

  private deleteNonCachedVolumeTexture(gl: WebGL2RenderingContext): void {
    if (
      this.volumeTexture &&
      this.volumeTexture !== this.volumeOrientCache?.outputTexture &&
      this.volumeTexture !== this.volumeRgbaCache?.texture
    ) {
      gl.deleteTexture(this.volumeTexture)
    }
    // Always drop the reference: either we just deleted the texture, or a
    // cache (volumeOrientCache / volumeRgbaCache) still owns it. The caller
    // reassigns this.volumeTexture immediately after.
    this.volumeTexture = null
  }

  clearVolume(gl: WebGL2RenderingContext): void {
    this.deleteNonCachedVolumeTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.volumeOrientCache)
    this.volumeOrientCache = null
    orientOverlay.destroyRGBATextureCache(gl, this.volumeRgbaCache)
    this.volumeRgbaCache = null
  }

  private deleteNonCachedOverlayTexture(gl: WebGL2RenderingContext): void {
    if (
      this.overlayTexture &&
      this.overlayTexture !== this.overlayOrientCache?.outputTexture &&
      this.overlayTexture !== this.overlayRgbaCache?.texture
    ) {
      gl.deleteTexture(this.overlayTexture)
    }
    this.overlayTexture = null
  }

  clearOverlay(gl: WebGL2RenderingContext): void {
    this.deleteNonCachedOverlayTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
    this.overlayOrientCache = null
    orientOverlay.destroyRGBATextureCache(gl, this.overlayRgbaCache)
    this.overlayRgbaCache = null
    this._destroyOverlayChunks(gl)
    this.clearOverlayChunked()
    this._clearCombinedOverlayChunked()
  }

  /**
   * Set (or clear, with null) the coarse whole-volume floor texture for the
   * active base. `coarseVol` is a small in-memory pyramid level supplied by the
   * app; it is oriented once into a single RGBA texture (its own colormap /
   * calibration) that the 2D slice path samples behind the resident fine
   * chunks. Re-orients only when {@link coarseFloorKey} changes.
   */
  setCoarseFloor(gl: WebGL2RenderingContext, coarseVol: NVImage | null): void {
    if (!coarseVol) {
      if (this.coarseFloorTexture) gl.deleteTexture(this.coarseFloorTexture)
      if (this.coarseFloorGradientTexture)
        gl.deleteTexture(this.coarseFloorGradientTexture)
      this.coarseFloorTexture = null
      this.coarseFloorGradientTexture = null
      this.coarseFloorDims = null
      this._coarseFloorKey = null
      return
    }
    // Orient the coarse level into its own (small) RGBA grid. It shares the base
    // volume's mm box, so the slice samples it at the base's texture fraction.
    const mtx = NVTransforms.calculateOverlayTransformMatrix(
      coarseVol,
      coarseVol,
    )
    const key = coarseFloorKey(coarseVol, mtx)
    if (key === this._coarseFloorKey && this.coarseFloorTexture) return
    // overlayOpacity 0: the floor stands in for the BASE volume, so it must be
    // baked with base semantics (alpha straight from the colormap LUT). Passing
    // 1 selects the overlay path, which makes alpha binary (`step()`); every
    // voxel above threshold then reads fully opaque and a floor cube terminates
    // its ray on the first surface hit, rendering as a dark shell.
    const tex = orientOverlay.overlay2Texture(
      gl,
      coarseVol,
      coarseVol,
      mtx as Float32Array,
      0,
    )
    // Gradient for the 3D floor cubes' matcap lighting (matches base shading).
    const dims: [number, number, number] = coarseVol.dimsRAS
      ? [coarseVol.dimsRAS[1], coarseVol.dimsRAS[2], coarseVol.dimsRAS[3]]
      : [coarseVol.dims[1] ?? 1, coarseVol.dims[2] ?? 1, coarseVol.dims[3] ?? 1]
    const grad = gradient.volume2TextureGradientRGBA(gl, tex, dims)
    if (this.coarseFloorTexture) gl.deleteTexture(this.coarseFloorTexture)
    if (this.coarseFloorGradientTexture)
      gl.deleteTexture(this.coarseFloorGradientTexture)
    this.coarseFloorTexture = tex
    this.coarseFloorGradientTexture = grad
    this.coarseFloorDims = dims
    this._coarseFloorKey = key
  }

  /** Whether an overlay is co-registered at the base grid (same RAS dims). */
  /** Forget the streamed combined overlays; base reclaims the full budget. */
  /** The NVImage backing the active independent chunked overlay (or null). */
  /**
   * Build one RGBA8 overlay texture per chunk for a chunked oversized volume.
   * The overlay layer shares the background volume's ChunkPlan, so the chunk
   * textures align 1:1 with the volume chunks. A single overlay is oriented
   * directly per chunk; multiple overlays are oriented, read back, and blended
   * on the CPU per chunk (mirroring the non-chunked multi-overlay path).
   *
   * RGB/RGBA-datatype overlays are skipped on chunked volumes (the chunked
   * orient pass only supports scalar sources, matching the volume chunker).
   *
   * `overlayVols` is the full overlay list (not just the chunk-rendered subset)
   * so a modulator that is itself hidden or streamed can still be resolved.
   */
  private _updateOverlayChunks(
    gl: WebGL2RenderingContext,
    baseVol: NVImage,
    plan: ChunkPlan,
    standardVols: NVImage[],
    overlayVols: NVImage[],
  ): void {
    // Chunked overlay path: drop the single-texture representation.
    this.deleteNonCachedOverlayTexture(gl)
    orientOverlay.destroyOverlayTextureCache(gl, this.overlayOrientCache)
    this.overlayOrientCache = null
    orientOverlay.destroyRGBATextureCache(gl, this.overlayRgbaCache)
    this.overlayRgbaCache = null
    this._destroyOverlayChunks(gl)

    const supported = standardVols.filter(
      (v) => !isRgbaDatatype(v.hdr.datatypeCode) && v.img,
    )
    if (supported.length < standardVols.length) {
      log.warn(
        'chunked overlay: RGB/RGBA-datatype overlays are not yet supported ' +
          'on oversized volumes, and streamed overlays without an in-memory ' +
          'image cannot be resliced whole; skipped',
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
    // Same modulation the non-chunked path applies; re-targeted per chunk below.
    const mods = supported.map((v) =>
      buildModulationParams(v, baseVol, [baseVol, ...overlayVols]),
    )

    if (supported.length === 1) {
      this.overlayChunks = orientOverlay.overlay2TextureChunked(
        gl,
        supported[0],
        baseVol,
        mtxs[0],
        plan,
        supported[0].opacity ?? 1,
        mods[0],
      )
      return
    }

    // Multiple overlays: orient + read back + blend per chunk.
    const maxTextureDimension3D = gl.getParameter(
      gl.MAX_3D_TEXTURE_SIZE,
    ) as number
    const safeMods = mods.map((mod) => {
      if (modulationFitsTextureLimit(mod, maxTextureDimension3D)) return mod
      log.warn(
        `modulation disabled: grid ${mod?.dims.join('x')} exceeds WebGL max 3D texture size (${maxTextureDimension3D})`,
      )
      return null
    })
    const sharedModTextures = safeMods.map((mod) =>
      mod ? orientOverlay.createModTexture(gl, mod) : null,
    )
    const [dx, dy, dz] = plan.volumeDims
    const finals: WebGLTexture[] = []
    try {
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
            chunkModulationParams(safeMods[i], scale, offset),
            sharedModTextures[i],
          )
          layers.push(orientOverlay.readTexture3D(gl, tex, dims))
          gl.deleteTexture(tex)
        }
        finals.push(
          this._createOverlayChunkTexture(
            gl,
            blendOverlayData(
              layers,
              dims,
              this.overlayAlphaBlend,
              this.overlayColorBlend,
            ),
            [dims[0], dims[1], dims[2]],
          ),
        )
      }
    } finally {
      for (const texture of sharedModTextures) {
        if (texture) gl.deleteTexture(texture)
      }
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
    this.paqdPickGrid = null
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
    backOpacity = 1,
  ): void {
    if (!this.isReady || !this.shader || !this.cubeVAO || !this.indexBuffer)
      return
    if (!this.matcapTexture) return
    // A chunked volume binds its volume + gradient textures PER CHUNK below
    // (and its coarse-floor cubes bind the floor textures), so it must not be
    // gated on the whole-volume pointers: those are best-effort aliases of
    // chunk 0 and go null as soon as a refocus evicts that chunk (e.g. moving
    // the crosshair to the far face of a clipped volume), which silently
    // blanked the entire volume. WebGPU already branches on the chunked entry
    // before its equivalent guard.
    // Only the volume texture is required. volumeGradientTexture is legitimately
    // null on an unlit volume (the gradient pass is skipped at upload), and the
    // shader's needsGradient branch is false in exactly that case, so a
    // placeholder is bound below and never sampled.
    if (!this._activeChunked && !this.volumeTexture) return

    const shader = this._activeChunked
      ? this.shader
      : (this._variantShader(
          gl,
          renderVariantKey({
            clipPlanes,
            isClipCutaway,
            renderMode: this.renderMode,
            cubic: this.isCubicInterpolation && this._cubicVolumeSafe,
            gradientAmount,
            gradientOpacity: this.gradientOpacity,
            silhouette: this.silhouette,
            hasOverlay: !!this.overlayTexture,
            hasPaqd: !!this.paqdTexture,
            hasDrawing: !!this.drawingTexture,
          }),
        ) ?? this.shader)
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
    if (shader.uniforms.clipPlaneOverlay)
      gl.uniform1f(
        shader.uniforms.clipPlaneOverlay,
        this.clipPlaneOverlay ? 1.0 : 0.0,
      )
    if (shader.uniforms.overlayLayerMode)
      gl.uniform1f(shader.uniforms.overlayLayerMode, 0.0)
    if (shader.uniforms.renderMode)
      gl.uniform1f(shader.uniforms.renderMode, this.renderMode)
    if (shader.uniforms.sliceFrac)
      gl.uniform3fv(shader.uniforms.sliceFrac, this.sliceFrac)
    if (shader.uniforms.isAlphaClipDark)
      gl.uniform1f(
        shader.uniforms.isAlphaClipDark,
        this.isAlphaClipDark ? 1 : 0,
      )
    // Default fully present; the chunk loop overrides per fading chunk.
    if (shader.uniforms.fadeAlpha) gl.uniform1f(shader.uniforms.fadeAlpha, 1.0)
    if (shader.uniforms.paqdUniforms)
      gl.uniform4fv(shader.uniforms.paqdUniforms, paqdUniforms as number[])
    if (shader.uniforms.earlyTermination)
      gl.uniform1f(shader.uniforms.earlyTermination, earlyTermination)
    // The background volume's own opacity. Overlays bake theirs into the
    // overlay texture during the orient pass, so this is the only volume it
    // applies to -- and the only one it was missing from, since the 2D slice
    // shader has always taken it as a uniform.
    if (shader.uniforms.backOpacity)
      gl.uniform1f(shader.uniforms.backOpacity, backOpacity)

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
        this._activeChunked,
        false,
        backOpacity,
      )
    } else {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, this.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      // Placeholder when the volume is unlit: the sampler must have a complete
      // texture bound even though the shader never reads it.
      gl.bindTexture(
        gl.TEXTURE_3D,
        this.volumeGradientTexture || this.placeholderOverlay,
      )
      // Non-chunked: pass-through (identity) tiled-volume uniforms so the
      // cube renders as its own [0,1] tex space exactly as before.
      this._setChunkUniforms(gl, shader, {
        volumeTexDimsFull: this._activeDims,
        chunkSubOrigin: [0, 0, 0],
        chunkSubSize: [1, 1, 1],
        dataOriginTexFrac: [0, 0, 0],
        dataSizeTexFrac: [1, 1, 1],
        rayStepTexVox: this._activeDims,
      })
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    }
    blendOver(gl)

    // Cleanup
    gl.bindVertexArray(null)
  }

  /** The volume program specialized for `key`, or null while it compiles. */
  private _variantShader(
    gl: WebGL2RenderingContext,
    key: number,
  ): Shader | null {
    let entry = this._variantShaders.get(key)
    if (entry instanceof Shader) return entry
    if (!entry) {
      entry = compileShaderAsync(
        gl,
        renderShader.vertexShader,
        renderFragmentShader(key),
      )
      this._variantShaders.set(key, entry)
    }
    const polled = entry.poll()
    if (polled === undefined) return null
    const shader = polled ? withClipPlanes(gl, polled) : this.shader
    if (shader) this._variantShaders.set(key, shader)
    return shader
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
    if (shader.uniforms.rayStepTexVox)
      gl.uniform3fv(shader.uniforms.rayStepTexVox, u.rayStepTexVox)
    if (shader.uniforms.rayVoxSampleRate)
      gl.uniform1f(shader.uniforms.rayVoxSampleRate, this.sampleRate)
    if (shader.uniforms.layerGradMode)
      gl.uniform1f(shader.uniforms.layerGradMode, this.layerGradientMode)
    // Background-only alpha modulation from the precomputed gradient: 0 is a
    // no-op for both. Mirrors the offset-500/504 lanes in wgpu/render.ts.
    if (shader.uniforms.gradientOpacity)
      gl.uniform1f(shader.uniforms.gradientOpacity, this.gradientOpacity)
    if (shader.uniforms.silhouettePower)
      gl.uniform1f(shader.uniforms.silhouettePower, this.silhouette)
    if (shader.uniforms.overlayOpacityCorrection)
      gl.uniform1f(
        shader.uniforms.overlayOpacityCorrection,
        this.isOverlayOpacityCorrected ? 1 : 0,
      )
    const cubic =
      this.isCubicInterpolation &&
      this._cubicVolumeSafe &&
      u.cubicSafe !== false
    if (shader.uniforms.cubicFilter)
      gl.uniform1f(shader.uniforms.cubicFilter, cubic ? 1 : 0)
    // The shader raises the classified RGB to this power. Two exponents
    // compose here (pow is associative in the exponent): the reciprocal of the
    // user-facing display gamma, and this brick's per-level compensation for
    // the brightness a coarse pyramid level loses in the march. The latter is
    // 1 for every single-level and non-chunked draw -- and for SLICES, which
    // takes one sample per plane and so loses nothing to compensate for.
    // Without that gate a coarse floor brick's planes read brighter than the
    // resident fine ones beside them.
    if (shader.uniforms.invGamma)
      gl.uniform1f(
        shader.uniforms.invGamma,
        invGamma(this.gamma) *
          lodGammaExponent(
            u.lodDownsample ?? 1,
            // SLICES takes one sample per plane whatever the level, so there is
            // nothing to compensate; 0 makes lodGammaExponent an exact no-op.
            this.renderMode === VOLUME_RENDER_MODE.SLICES
              ? 0
              : this.lodBrightnessCompensation,
          ),
      )
    // Scales the step-size opacity exponent for a coarse brick. 1 for every
    // single-level and non-chunked draw, and for the default coefficient of 0.
    if (shader.uniforms.lodOpacityScale)
      gl.uniform1f(
        shader.uniforms.lodOpacityScale,
        lodOpacityScale(u.lodDownsample ?? 1, this.lodOpacityCompensation),
      )
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
    entry: ChunkedTexEntry | null,
    overlayMode: boolean,
    backOpacity = 1,
  ): void {
    if (!entry || entry.manager.chunkCount === 0) return
    const chunkCount = entry.manager.chunkCount
    // depthFunc ALWAYS (vs the global LESS): the per-chunk cube draws
    // composite back-to-front with OVER blending and must not depth-test
    // against each other, or a chunk behind an already-drawn chunk is
    // rejected and its contribution is lost. Restored to LESS after the loop.
    gl.depthFunc(gl.ALWAYS)
    // MIP: merge chunk draws (and the overlay entry's draws over the base) by
    // component-wise max instead of OVER — each cube emits its ray segment's
    // premultiplied maximum and the shader's own per-layer MIP rule is also
    // max, so MAX blending reconstructs the true full-ray maximum independent
    // of chunk draw order (OVER would let a high-alpha near chunk occlude a
    // brighter voxel in a farther chunk). Assumes a black tile behind the cube
    // (the classic MAX-blend MIP convention); non-chunked MIP composites OVER.
    // GL_MAX ignores the blend factors. Restored to FUNC_ADD after the loop.
    const mip = this.renderMode === VOLUME_RENDER_MODE.MAXIMUM
    if (mip) gl.blendEquation(gl.MAX)
    const explode = entry.volume.chunkExplode
    const brickOpacity = entry.volume.chunkBrickOpacity
    const offsets = chunkOffsetFor(entry.plan, explode)
    const order = chunkDrawOrder(
      entry.plan,
      entry.manager.retiringChunks,
      (i) => entry.manager.isCoveredByRetiring(i),
      rayDir,
      offsets,
      volScale,
    )
    // Per-chunk drawing/overlay/PAQD textures align 1:1 with the volume chunks
    // (shared ChunkPlan); when present, swap the matching texture unit so each
    // layer reads its own sub-texture. The overlay layer draws only its own
    // chunk volume, so these stay null (placeholders bound by the caller).
    const drawingChunks =
      !overlayMode &&
      this.drawingChunks &&
      this.drawingChunks.length === chunkCount
        ? this.drawingChunks
        : null
    const overlayChunks =
      !overlayMode &&
      this.overlayChunks &&
      this.overlayChunks.length === chunkCount
        ? this.overlayChunks
        : null
    const paqdChunks =
      !overlayMode && this.paqdChunks && this.paqdChunks.length === chunkCount
        ? this.paqdChunks
        : null
    // Streamed combined overlay (strategy A): for the base entry, base block i's
    // overlay unit is the streamed overlay's resident chunk i (placeholder until
    // it streams in). Takes precedence over the whole-reslice overlayChunks.
    const stackFuse =
      !overlayMode && entry === this._activeChunked ? this._stackFuse : null
    const stackRegions = stackFuse ? chunkRegions(entry.plan) : []
    const stackGen = stackFuse ? this._stackGen() : ''
    const combinedOverlay =
      !overlayMode &&
      entry === this._activeChunked &&
      this._combinedOverlayEntries.length === 1
        ? this._combinedOverlayEntries[0]
        : null
    // Coarse floor: draw a coarse-floor cube for each base chunk region whose
    // fine chunk has not streamed in (instead of skipping it), so the 3D view
    // shows coarse detail immediately and never pops in from blank. A freshly-
    // resident fine chunk cross-fades in over its floor cube so detail dissolves
    // in instead of popping. Once settled, each region is drawn once (fine if
    // faded in, else coarse) — no steady-state double-exposure.
    const floorActive =
      !overlayMode &&
      entry === this._activeChunked &&
      this.coarseFloorTexture !== null &&
      this.coarseFloorGradientTexture !== null
    // Draw the coarse-floor cube for one chunk region: bind the coarse texture +
    // its gradient (transparent placeholders for overlay/paqd/drawing, guarded
    // off in the shader), sample at the chunk's full-volume fraction
    // (data{Origin,Size} = chunkSub{Origin,Size} => identity into the halo-less
    // coarse texture), full strength (fadeAlpha = 1). Restores the shared
    // overlay/paqd/drawing bindings afterward so a following fine chunk that has
    // no per-chunk layer texture still reads the caller's shared layers.
    // Floor and retiring cubes are not plan chunks, so per-chunk layer textures
    // do not line up with them: they draw the volume alone, then the caller's
    // shared layer bindings go back for the chunks that follow.
    const bindLayerPlaceholders = (): void => {
      for (const unit of [gl.TEXTURE3, gl.TEXTURE4, gl.TEXTURE5, gl.TEXTURE7]) {
        gl.activeTexture(unit)
        gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
      }
    }
    const restoreSharedLayers = (): void => {
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(
        gl.TEXTURE_3D,
        this.overlayTexture || this.placeholderOverlay,
      )
      gl.activeTexture(gl.TEXTURE4)
      gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture || this.placeholderOverlay)
      const drawTex = this.drawingTexture || this.placeholderOverlay
      gl.activeTexture(gl.TEXTURE5)
      gl.bindTexture(gl.TEXTURE_3D, drawTex)
      gl.activeTexture(gl.TEXTURE7)
      gl.bindTexture(gl.TEXTURE_3D, drawTex)
    }
    const drawFloorCube = (chunkIndex: number): void => {
      const floorTex = this.coarseFloorTexture
      if (!floorTex) return
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, floorTex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, this.coarseFloorGradientTexture ?? floorTex)
      bindLayerPlaceholders()
      const cu = chunkUniformsFor(entry.plan, chunkIndex)
      this._setChunkUniforms(gl, shader, {
        volumeTexDimsFull: cu.volumeTexDimsFull,
        chunkSubOrigin: cu.chunkSubOrigin,
        chunkSubSize: cu.chunkSubSize,
        dataOriginTexFrac: cu.chunkSubOrigin,
        dataSizeTexFrac: cu.chunkSubSize,
        // March at the floor texture's OWN voxel density, not the fine common
        // grid: the step-size correction turns each step into an optical depth
        // of `fineVoxels / steps` reference steps, so oversampling a 64x coarser
        // texture drives the first in-tissue sample to alpha 1 and the cube
        // renders as a dark surface shell instead of an integrated backdrop.
        rayStepTexVox: this.coarseFloorDims ?? cu.volumeTexDimsFull,
        // The floor is not a member of `plan.chunks`, so its downsample
        // comes from its own dims. It is usually the coarsest data on
        // screen: uncompensated, it puts the scene's largest brightness
        // step right at the edge of the resident fine region.
        lodDownsample: this.coarseFloorDims
          ? dimsDownsample(entry.plan.volumeDims, this.coarseFloorDims)
          : 1,
        // The floor is one whole-volume texture, so the cubic kernel is always
        // safely fed here. It still follows the fine bricks' verdict: when their
        // halo is too thin and cubic is refused, a cubic floor under trilinear
        // bricks would put a reconstruction change exactly at the edge of the
        // resident region. One filter per volume, always.
        cubicSafe: entry.cubicSafe,
      })
      // The fine cube in front of this one carries the cross-fade weight; the
      // floor only takes the brick's own opacity (chunkBrickOpacity), so a
      // dimmed brick's backdrop dims with it.
      if (shader.uniforms.fadeAlpha)
        gl.uniform1f(shader.uniforms.fadeAlpha, brickOpacity?.[chunkIndex] ?? 1)
      if (shader.uniforms.matRAS) {
        gl.uniformMatrix4fv(
          shader.uniforms.matRAS,
          false,
          chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        )
      }
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
      restoreSharedLayers()
    }
    // A retiring brick from a make-before-break swap: its own texture, placed
    // by its own (older) plan, at full strength, without layers (as the floor
    // it stands in for).
    const drawRetiringCube = (ref: RetiringChunk<VolumeChunkGL>): void => {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, ref.chunk.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, ref.chunk.volumeGradientTexture)
      bindLayerPlaceholders()
      this._setChunkUniforms(gl, shader, {
        ...chunkUniformsFor(ref.plan, ref.index),
        // Its own plan's halo decides whether cubic sampling is safe.
        cubicSafe: entry.cubicSafe && planSupportsCubic(ref.plan),
      })
      if (shader.uniforms.fadeAlpha) gl.uniform1f(shader.uniforms.fadeAlpha, 1)
      if (shader.uniforms.backOpacity)
        gl.uniform1f(shader.uniforms.backOpacity, backOpacity)
      if (shader.uniforms.matRAS) {
        gl.uniformMatrix4fv(
          shader.uniforms.matRAS,
          false,
          chunkExplodedMatRAS(ref.plan, ref.index, matRAS, null),
        )
      }
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
      restoreSharedLayers()
    }
    for (const item of order) {
      if (item.retiring) {
        drawRetiringCube(item.retiring)
        continue
      }
      const chunkIndex = item.index
      const chunk = entry.manager.getChunk(chunkIndex)
      if (!chunk) {
        if (floorActive) drawFloorCube(chunkIndex)
        continue
      }
      // Cross-fade a freshly-resident fine chunk in over its coarse floor: draw
      // the floor cube first (full strength), then the fine cube over it with
      // premultiplied weight `fade`. Settled (fade === 1) => fine only.
      const fade = floorActive
        ? entry.manager.fadeFraction(
            chunkIndex,
            this._frameNow,
            this.chunkFadeMs,
          )
        : 1
      if (fade < 1) {
        drawFloorCube(chunkIndex)
        this._fadeActive = true
      }
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_3D, chunk.volumeTexture)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_3D, chunk.volumeGradientTexture)
      if (stackFuse) {
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(
          gl.TEXTURE_3D,
          stackFuse.get(chunkIndex, stackRegions[chunkIndex], stackGen) ??
            this.placeholderOverlay,
        )
      } else if (combinedOverlay) {
        gl.activeTexture(gl.TEXTURE3)
        gl.bindTexture(
          gl.TEXTURE_3D,
          combinedOverlay.manager.getChunk(chunkIndex)?.volumeTexture ??
            this.placeholderOverlay,
        )
      } else if (overlayChunks) {
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
      this._setChunkUniforms(gl, shader, {
        ...chunkUniformsFor(entry.plan, chunkIndex),
        cubicSafe: entry.cubicSafe,
      })
      // The brick's own opacity (chunkBrickOpacity) rides the fade lane, not
      // backOpacity: a chunked draw applies backOpacity per sample, where a
      // ray through solid tissue saturates whatever the value, so dimming
      // that way barely shows. Scaling the brick's premultiplied result fades
      // its presence and coverage together, and deeper bricks show through.
      if (shader.uniforms.fadeAlpha)
        gl.uniform1f(
          shader.uniforms.fadeAlpha,
          fade * (brickOpacity?.[chunkIndex] ?? 1),
        )
      if (shader.uniforms.backOpacity)
        gl.uniform1f(shader.uniforms.backOpacity, backOpacity)
      if (shader.uniforms.matRAS) {
        gl.uniformMatrix4fv(
          shader.uniforms.matRAS,
          false,
          chunkExplodedMatRAS(entry.plan, chunkIndex, matRAS, explode),
        )
      }
      gl.drawElements(gl.TRIANGLE_STRIP, indexCount, gl.UNSIGNED_SHORT, 0)
    }
    if (mip) gl.blendEquation(gl.FUNC_ADD)
    gl.depthFunc(gl.LESS)
  }

  /**
   * Draw the independently-streamed hi-res overlay as its own translucent
   * chunk cubes over the base, in the same pass. matRAS is the OVERLAY volume's
   * matRAS (its own grid); the camera (mvp/volScale/rayDir) is shared with the
   * base tile. No-op when no chunked overlay is active. Must be called after
   * draw() for the same tile so it composites over the base.
   *
   * Compositing-order limitation: the base and overlay cube sets are each
   * sorted back-to-front internally, but the overlay set is drawn entirely
   * after the base, so per-pixel the overlay always composites over the base
   * regardless of true depth (mirrors the per-chunk back-to-front approximation
   * between neighbouring base chunks). A globally-merged order is future work.
   */
  drawOverlayChunked(
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
    const entry = this._activeOverlayChunked
    if (!entry) return
    if (!this.isReady || !this.shader || !this.cubeVAO || !this.indexBuffer)
      return
    if (!this.matcapTexture || !this.placeholderOverlay) return

    const shader = this.shader
    const indexCount = this.cube.indices.length
    shader.use(gl)

    // Sampler unit assignments (volume + gradient bound per chunk in the loop).
    if (shader.uniforms.volume) gl.uniform1i(shader.uniforms.volume, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.matcapTexture)
    if (shader.uniforms.matcap) gl.uniform1i(shader.uniforms.matcap, 1)
    if (shader.uniforms.volumeGradient)
      gl.uniform1i(shader.uniforms.volumeGradient, 2)
    // The overlay layer draws only its own chunk volume — bind the transparent
    // placeholder to the optional overlay/paqd/drawing units so those shader
    // passes stay inert.
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.overlay) gl.uniform1i(shader.uniforms.overlay, 3)
    gl.activeTexture(gl.TEXTURE4)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.paqd) gl.uniform1i(shader.uniforms.paqd, 4)
    gl.activeTexture(gl.TEXTURE5)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.drawing) gl.uniform1i(shader.uniforms.drawing, 5)
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_3D, this.placeholderOverlay)
    if (shader.uniforms.drawingLinear)
      gl.uniform1i(shader.uniforms.drawingLinear, 7)
    gl.activeTexture(gl.TEXTURE6)
    gl.bindTexture(gl.TEXTURE_2D, null)
    if (shader.uniforms.paqdLut) gl.uniform1i(shader.uniforms.paqdLut, 6)

    // Scalar uniforms. overlayLayerMode=1 makes the shader skip the base
    // clip-surface/AO path and force flat (unlit) translucent compositing, so
    // gradientAmount is passed through but has no effect in overlay mode.
    if (shader.uniforms.mvpMtx)
      gl.uniformMatrix4fv(shader.uniforms.mvpMtx, false, mvpMatrix)
    if (shader.uniforms.normMtx)
      gl.uniformMatrix4fv(shader.uniforms.normMtx, false, normalMatrix)
    if (shader.uniforms.volScale)
      gl.uniform3fv(shader.uniforms.volScale, volScale as Float32Array)
    const rayDirVec = (rayDir ?? [0, 0, 1]) as number[]
    if (shader.uniforms.rayDir)
      gl.uniform3fv(shader.uniforms.rayDir, rayDirVec.slice(0, 3))
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
    if (shader.uniforms.clipPlaneOverlay)
      gl.uniform1f(
        shader.uniforms.clipPlaneOverlay,
        this.clipPlaneOverlay ? 1.0 : 0.0,
      )
    if (shader.uniforms.overlayLayerMode)
      gl.uniform1f(shader.uniforms.overlayLayerMode, 1.0)
    if (shader.uniforms.renderMode)
      gl.uniform1f(shader.uniforms.renderMode, this.renderMode)
    if (shader.uniforms.sliceFrac)
      gl.uniform3fv(shader.uniforms.sliceFrac, this.sliceFrac)
    if (shader.uniforms.isAlphaClipDark)
      gl.uniform1f(
        shader.uniforms.isAlphaClipDark,
        this.isAlphaClipDark ? 1 : 0,
      )
    if (shader.uniforms.paqdUniforms)
      gl.uniform4fv(shader.uniforms.paqdUniforms, paqdUniforms as number[])
    if (shader.uniforms.earlyTermination)
      gl.uniform1f(shader.uniforms.earlyTermination, earlyTermination)
    // Explicitly neutral, not merely omitted: these cubes share the program
    // with draw(), so an unset uniform would keep the base volume's opacity
    // from the previous draw. This layer's own opacity is already baked into
    // its chunk textures by rebakeChunkedOverlays.
    if (shader.uniforms.backOpacity)
      gl.uniform1f(shader.uniforms.backOpacity, 1.0)

    gl.bindVertexArray(this.cubeVAO)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this._drawChunkedVolume(
      gl,
      shader,
      indexCount,
      rayDirVec,
      matRAS,
      volScale,
      entry,
      true,
    )
    blendOver(gl)
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
    paqdUniforms: readonly number[] = [0, 0, 0, 0],
    backOpacity = 1,
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

    // The SLICES plane test also reads the PAQD and drawing layers (see
    // planeLayerVisible in the shader), nearest-filtered as the render binds
    // them. An unbound layer is the 2-voxel placeholder the shader skips.
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_3D, this.paqdTexture || this.placeholderOverlay)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (shader.uniforms.paqd) gl.uniform1i(shader.uniforms.paqd, 2)
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(
      gl.TEXTURE_3D,
      this.drawingTexture || this.placeholderOverlay,
    )
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    if (shader.uniforms.drawing) gl.uniform1i(shader.uniforms.drawing, 3)
    if (shader.uniforms.paqdUniforms)
      gl.uniform4fv(shader.uniforms.paqdUniforms, paqdUniforms as number[])
    // 0 skips the background march (a channel stack picks from the overlay).
    if (shader.uniforms.backOpacity)
      gl.uniform1f(shader.uniforms.backOpacity, backOpacity)

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
    if (shader.uniforms.clipPlaneOverlay)
      gl.uniform1f(
        shader.uniforms.clipPlaneOverlay,
        this.clipPlaneOverlay ? 1.0 : 0.0,
      )
    if (shader.uniforms.numVolumes)
      gl.uniform1f(shader.uniforms.numVolumes, volumeCount)
    // SLICES mode: the pick lands on a plane, not on the first opaque voxel.
    if (shader.uniforms.renderMode)
      gl.uniform1f(shader.uniforms.renderMode, this.renderMode)
    if (shader.uniforms.sliceFrac)
      gl.uniform3fv(shader.uniforms.sliceFrac, this.sliceFrac)
    if (shader.uniforms.isAlphaClipDark)
      gl.uniform1f(
        shader.uniforms.isAlphaClipDark,
        this.isAlphaClipDark ? 1 : 0,
      )
    // Depth pick uses a single volume texture; pass identity chunk uniforms
    // so the shared vertex shader / preamble run in non-chunked mode.
    this._setChunkUniforms(gl, shader, {
      volumeTexDimsFull: this._activeDims,
      chunkSubOrigin: [0, 0, 0],
      chunkSubSize: [1, 1, 1],
      dataOriginTexFrac: [0, 0, 0],
      dataSizeTexFrac: [1, 1, 1],
      rayStepTexVox: this._activeDims,
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

  /**
   * True when the active base volume is chunked (tiled / multi-LOD). Such a
   * volume has no single whole-volume texture, so the GPU depth-pick pass cannot
   * sample it; callers fall back to a CPU bounding-box ray pick.
   */
  get hasChunkedVolume(): boolean {
    return this._activeChunked !== null
  }

  hasOverlay(): boolean {
    return this.overlayTexture !== null
  }

  updateDrawingTexture(
    gl: WebGL2RenderingContext,
    rgba: Uint8Array,
    dims: number[],
    plan?: ChunkPlan,
    dirtyChunks?: readonly number[],
  ): void {
    if (!this.isReady) return
    if (plan) {
      this._updateDrawingChunks(gl, rgba, dims, plan, dirtyChunks)
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
    dirtyChunks?: readonly number[],
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
    // Reusing textures: a pen stroke only dirties a few chunks; re-upload just
    // those. A fresh build (!reuse) creates every chunk in ascending order.
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
    destroyBlendOverlaysGL(gl)
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
    this._matcapUrl = null
    // _texCache owns chunked + per-volume 'single' entry textures, so freeing
    // the cache covers any this.volumeTexture / this.volumeGradientTexture
    // pointers that alias cache entries.
    for (const entry of this._texCache.values()) {
      this._destroyTexEntry(gl, entry)
    }
    this._texCache.clear()
    this._activeChunked = null
    this._activeOverlayChunked = null
    this._combinedOverlayEntries = []
    this.volumeTexture = null
    if (this.volumeGradientTexture) gl.deleteTexture(this.volumeGradientTexture)
    this.volumeGradientTexture = null
    // Release the non-chunked orient-texture cache (normal single-volume path).
    this.clearVolume(gl)
    if (this.coarseFloorTexture) gl.deleteTexture(this.coarseFloorTexture)
    if (this.coarseFloorGradientTexture)
      gl.deleteTexture(this.coarseFloorGradientTexture)
    this.coarseFloorTexture = null
    this.coarseFloorGradientTexture = null
    this.coarseFloorDims = null
    this._coarseFloorKey = null
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
    // A failed variant maps to the generic program, so dedupe before deleting.
    for (const program of new Set(
      [...this._variantShaders.values()].map((v) => v.program),
    )) {
      gl.deleteProgram(program)
    }
    this._variantShaders.clear()
    this.shader = null

    // Destroy module resources
    orientOverlay.destroy(gl)
    gradient.destroy(gl)

    this.isReady = false
    this._gl = null
  }
}
