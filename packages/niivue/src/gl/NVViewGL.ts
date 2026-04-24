import { mat4 } from 'gl-matrix'
import { log } from '@/logger'
import * as NVTransforms from '@/math/NVTransforms'
import { deg2rad } from '@/math/NVTransforms'
import { generateNormals } from '@/mesh/NVMesh'
import * as NVShapes from '@/mesh/NVShapes'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type {
  NVMesh,
  NVViewOptions,
  ViewHitTest,
  WebGLMeshGPU,
} from '@/NVTypes'
import * as NVAnnotation from '@/view/NVAnnotation'
import { buildColorbarLabels, colorbarTotalHeight } from '@/view/NVColorbar'
import { crosscutMM } from '@/view/NVCrosscut'
import { BYTES_PER_VERTEX } from '@/view/NVCrosshair'
import { resolveHeaderLabel } from '@/view/NVFont'
import * as NVGraph from '@/view/NVGraph'
import * as NVLegend from '@/view/NVLegend'
import { buildLine } from '@/view/NVLine'
import * as NVMeasurement from '@/view/NVMeasurement'
import * as NVRuler from '@/view/NVRuler'
import type { SliceTile } from '@/view/NVSliceLayout'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import * as NVUILayout from '@/view/NVUILayout'
import { GLBench } from './bench'
import { ColorbarRenderer } from './colorbar'
import { CrosshairRenderer } from './crosshair'
import { FontRenderer } from './font'
import { LineRenderer } from './line'
import * as mesh from './mesh'
import { maskOverlayByBackground } from './orientOverlay'
import { PolygonRenderer } from './polygon'
import { Polygon3DRenderer } from './polygon3d'
import { VolumeRenderer } from './render'
import { SliceRenderer } from './slice'
import { ThumbnailRenderer } from './thumbnail'

type MeshGpuWithShader = WebGLMeshGPU & { shaderType?: string }

export default class NVGlview {
  canvas: HTMLCanvasElement
  model: NVModel
  options: NVViewOptions
  isAntiAlias: boolean
  forceDevicePixelRatio: number
  gl: WebGL2RenderingContext | null
  max2D: number
  max3D: number
  fontTexture: WebGLTexture | null
  crosshairRenderer: CrosshairRenderer
  screenSlices: SliceTile[]
  legendLayout: import('@/view/NVLegend').LegendLayout | null
  graphLayout: NVGraph.GraphLayout | null
  isBusy: boolean
  maxLines: number
  maxGlyphs: number
  meshPipelines: Record<string, boolean>
  volumeRenderer: VolumeRenderer
  lineRenderer: LineRenderer
  polygonRenderer: PolygonRenderer
  polygon3DRenderer: Polygon3DRenderer
  fontRenderer: FontRenderer
  colorbarRenderer: ColorbarRenderer
  thumbnailRenderer: ThumbnailRenderer
  sliceRenderer: SliceRenderer
  meshResources: Map<NVMesh, MeshGpuWithShader>
  orientCubeGpu: WebGLMeshGPU | null
  // Bounds: pixel rect for sub-canvas rendering
  private _boundsWidth = 0
  private _boundsHeight = 0
  private _boundsOffsetX = 0
  private _boundsOffsetY = 0
  private _isSubCanvasBounds = false
  // Narrow public getters for bench.ts to read current render-area size
  // without making the backing fields public or mutable.
  get boundsWidth(): number {
    return this._boundsWidth
  }
  get boundsHeight(): number {
    return this._boundsHeight
  }
  // Lazily created on first `view.bench` access; see ./bench.ts.
  private _bench: GLBench | null = null

  constructor(
    canvas: HTMLCanvasElement,
    model: NVModel,
    options: NVViewOptions = {},
  ) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error('NVGlview requires a valid HTMLCanvasElement')
    }
    this.canvas = canvas
    this.model = model
    this.options = options
    this.isAntiAlias = options.isAntiAlias ?? false
    this.forceDevicePixelRatio = options.devicePixelRatio ?? -1
    this.gl = null
    this.max2D = 0
    this.max3D = 0
    this.fontTexture = null
    this.crosshairRenderer = new CrosshairRenderer()
    // Screen layout state (for hit testing)
    this.screenSlices = []
    this.legendLayout = null
    this.graphLayout = null
    // State
    this.isBusy = false
    this.maxLines = 1024
    this.maxGlyphs = 2048 // Increased for legends with many entries
    // Expose mesh shader types (matches WebGPU meshPipelines keys)
    this.meshPipelines = {
      phong: true,
      flat: true,
      silhouette: true,
      rim: true,
      crevice: true,
      crosscut: true,
      matte: true,
      toon: true,
      outline: true,
      vertexColor: true,
    }
    // Render layer instances
    this.volumeRenderer = new VolumeRenderer()
    this.lineRenderer = new LineRenderer()
    this.polygonRenderer = new PolygonRenderer()
    this.polygon3DRenderer = new Polygon3DRenderer()
    this.fontRenderer = new FontRenderer()
    this.colorbarRenderer = new ColorbarRenderer()
    this.thumbnailRenderer = new ThumbnailRenderer()
    this.sliceRenderer = new SliceRenderer()
    this.meshResources = new Map()
    this.orientCubeGpu = null
  }

  async init(): Promise<void> {
    await this._initWebGL2()
    await this._createResources()
    await this._createPipelines()
    await this._updateBindings()
  }

  _initGL(
    canvas: HTMLCanvasElement,
    isAntiAlias: boolean,
  ): { gl: WebGL2RenderingContext; max2D: number; max3D: number } {
    const bounds = this.options.bounds
    const isSubCanvas =
      !!bounds &&
      !(
        bounds[0][0] === 0 &&
        bounds[0][1] === 0 &&
        bounds[1][0] === 1 &&
        bounds[1][1] === 1
      )
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: isAntiAlias,
      preserveDrawingBuffer: isSubCanvas,
    })

    if (!gl) {
      throw new Error(
        'Unable to initialize WebGL2. Your browser may not support it.',
      )
    }

    return {
      gl,
      max2D: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      max3D: gl.getParameter(gl.MAX_3D_TEXTURE_SIZE),
    }
  }

  async _initWebGL2(): Promise<void> {
    const result = this._initGL(this.canvas, this.isAntiAlias)
    this.gl = result.gl
    const gl = this.gl
    this.max2D = result.max2D
    this.max3D = result.max3D
    let renderer = ''
    let vendor = ''
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (rendererInfo) {
      vendor = gl.getParameter(rendererInfo.UNMASKED_VENDOR_WEBGL)
      renderer = gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
    }
    log.info(
      `WebGL2 ${renderer} :: ${vendor} - maxTexture 2D:${this.max2D} 3D:${this.max3D} antiAlias:${this.isAntiAlias}`,
    )
    this.lineRenderer.init(gl)
    this.polygonRenderer.init(gl)
    this.polygon3DRenderer.init(gl)
    this.colorbarRenderer.init(gl)
    this.thumbnailRenderer.init(gl)
    await this.fontRenderer.init(gl, this.options.font)
    mesh.init(gl)
    this.sliceRenderer.init(gl)
    // Enable required extensions

    // Enable depth testing with standard convention
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LESS)
    gl.clearDepth(1.0)

    gl.frontFace(gl.CCW)
    // Enable blending
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    // Enable backface culling
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
  }

  async _createResources(): Promise<void> {
    const gl = this.gl
    if (!gl) return
    // Initialize volume renderer
    await this.volumeRenderer.init(gl, this.max3D)
    // Initialize crosshair renderer with pre-allocated buffers
    const attrs = mesh.getAttributeLocations(gl, 'phong')
    this.crosshairRenderer.init(
      gl,
      attrs.aPosition,
      attrs.aNormal,
      attrs.aColor,
    )
    // Create orientation cube mesh
    this._createOrientCube(gl)
  }

  _createOrientCube(gl: WebGL2RenderingContext): void {
    const cubeData = NVShapes.createOrientCube()
    const positions = new Float32Array(cubeData.positions)
    const indices = new Uint32Array(cubeData.indices)
    const normals = generateNormals(positions, indices)
    const numVerts = positions.length / 3
    const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX)
    const f32 = new Float32Array(vertexData)
    const u32 = new Uint32Array(vertexData)
    for (let v = 0; v < numVerts; v++) {
      const off = (v * BYTES_PER_VERTEX) / 4
      f32[off] = positions[v * 3]
      f32[off + 1] = positions[v * 3 + 1]
      f32[off + 2] = positions[v * 3 + 2]
      f32[off + 3] = normals[v * 3]
      f32[off + 4] = normals[v * 3 + 1]
      f32[off + 5] = normals[v * 3 + 2]
      u32[off + 6] = cubeData.colors[v]
    }
    const vao = gl.createVertexArray()
    if (!vao) return
    gl.bindVertexArray(vao)
    const vertexBuffer = gl.createBuffer()
    if (!vertexBuffer) {
      gl.bindVertexArray(null)
      return
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, vertexData, gl.STATIC_DRAW)
    const shaderAttrs = mesh.getAttributeLocations(gl, 'vertexColor')
    gl.enableVertexAttribArray(shaderAttrs.aPosition)
    gl.vertexAttribPointer(shaderAttrs.aPosition, 3, gl.FLOAT, false, 28, 0)
    gl.enableVertexAttribArray(shaderAttrs.aNormal)
    gl.vertexAttribPointer(shaderAttrs.aNormal, 3, gl.FLOAT, false, 28, 12)
    gl.enableVertexAttribArray(shaderAttrs.aColor)
    gl.vertexAttribPointer(
      shaderAttrs.aColor,
      4,
      gl.UNSIGNED_BYTE,
      true,
      28,
      24,
    )
    const indexBuffer = gl.createBuffer()
    if (!indexBuffer) {
      gl.bindVertexArray(null)
      return
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    gl.bindVertexArray(null)
    this.orientCubeGpu = {
      vao,
      vertexBuffer,
      indexBuffer,
      indexCount: indices.length,
    }
  }

  async _createPipelines(): Promise<void> {
    // Volume rendering shader is now managed by VolumeRenderer
    // Mesh pipelines are statically defined
  }

  async _updateBindings(): Promise<void> {
    this.isBusy = true
    const gl = this.gl
    if (!gl) {
      this.isBusy = false
      return
    }
    const vols = this.model.getVolumes()
    this.colorbarRenderer.buildColorbars(
      gl,
      this.model.collectColorbars(),
      this.model.scene.backgroundColor,
    )
    if (vols.length > 0) {
      await this.volumeRenderer.updateVolume(
        gl,
        vols[0],
        this.model.volume.matcap,
      )
    }

    // Handle overlays (all volumes after the first)
    if (vols.length > 1) {
      await this.volumeRenderer.updateOverlays(
        gl,
        vols[0],
        vols.slice(1),
        this.model.volume.paqdUniforms,
      )
      if (
        this.model.volume.isBackgroundMasking &&
        this.volumeRenderer.overlayTexture &&
        this.volumeRenderer.volumeTexture &&
        vols[0].dimsRAS
      ) {
        const dims = [
          vols[0].dimsRAS[1],
          vols[0].dimsRAS[2],
          vols[0].dimsRAS[3],
        ]
        maskOverlayByBackground(
          gl,
          this.volumeRenderer.volumeTexture,
          this.volumeRenderer.overlayTexture,
          dims,
        )
      }
    } else {
      this.volumeRenderer.clearOverlay(gl)
    }
    this._rebuildMeshResources()
    this.isBusy = false
  }

  updateBindGroups(): Promise<void> {
    return this._updateBindings()
  }

  render(): void {
    const gl = this.gl
    const md = this.model
    if (!gl) return
    if (this.isBusy) {
      requestAnimationFrame(() => this.render())
      return
    }
    // Bounds pixel rect (sub-canvas or full canvas)
    const bx = this._boundsOffsetX
    const by = this._boundsOffsetY
    const bw = this._boundsWidth
    const bh = this._boundsHeight
    const fullCanvasH = this.canvas.height
    // GL scissor/viewport Y uses bottom-left origin
    const glBoundsY = fullCanvasH - by - bh
    // Thumbnail mode: draw only the thumbnail image and return
    if (md.ui.isThumbnailVisible && this.thumbnailRenderer.hasTexture()) {
      if (this._isSubCanvasBounds) {
        gl.enable(gl.SCISSOR_TEST)
        gl.scissor(bx, glBoundsY, bw, bh)
      }
      gl.viewport(bx, glBoundsY, bw, bh)
      const bg = md.scene.backgroundColor
      gl.clearColor(bg[0], bg[1], bg[2], bg[3])
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      this.thumbnailRenderer.draw(gl)
      if (this._isSubCanvasBounds) gl.disable(gl.SCISSOR_TEST)
      return
    }
    // Clear labels at start of each render
    const labels: ReturnType<typeof this.fontRenderer.buildText>[] = []
    const labelColor = md.ui.fontColor
    // Use bounds dimensions as effective canvas size
    const canvasWidth = bw
    const canvasHeight = bh
    // Enable scissor to constrain clearing and rendering to bounds region
    if (this._isSubCanvasBounds) {
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(bx, glBoundsY, bw, bh)
    }
    // Set viewport to bounds region
    gl.viewport(bx, glBoundsY, bw, bh)
    // Clear with background color from model
    const bg = md.scene.backgroundColor
    gl.clearColor(bg[0], bg[1], bg[2], bg[3])
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    // Get volumes
    const volumes = md.getVolumes()
    // Reserve vertical space for colorbars so tiles don't overlap them
    const cbHeight = md.ui.isColorbarVisible
      ? colorbarTotalHeight(
          this.colorbarRenderer.getColorbarInfos(),
          this.colorbarRenderer.getLayout(),
        )
      : 0
    // Reserve horizontal space for legend and graph on the right side
    const legendEntries = md.collectLegendEntries()
    const legendWidth =
      md.ui.isLegendVisible && legendEntries.length > 0
        ? NVLegend.legendTotalWidth(legendEntries, canvasWidth, canvasHeight)
        : 0
    const graphData = md.collectGraphData()
    const graphWidth = graphData
      ? NVGraph.graphTotalWidth(graphData, canvasWidth, canvasHeight)
      : 0
    const screenSlices = NVSliceLayout.screenSlicesLayout({
      canvasWH: [
        canvasWidth - legendWidth - graphWidth,
        canvasHeight - cbHeight,
      ],
      sliceType: md.layout.sliceType,
      tileMargin: md.layout.margin,
      extentsMin: md.extentsMin,
      extentsMax: md.extentsMax,
      isRadiologicalConvention: md.layout.isRadiological,
      multiplanarLayout: md.layout.multiplanarType,
      multiplanarShowRender: md.layout.showRender,
      sliceMosaicString: md.layout.mosaicString,
      heroImageFraction: md.layout.heroFraction,
      heroSliceType: md.layout.heroSliceType,
      isMultiplanarEqualSize: md.layout.isEqualSize,
      isCrossLines: md.ui.isCrossLinesVisible,
      isCenterMosaic: md.layout.isMosaicCentered,
      customLayout: md.layout.customLayout,
    })
    this.screenSlices = screenSlices
    // Update crosshair geometry based on current model state
    if (this.crosshairRenderer.isReady) {
      this.crosshairRenderer.update(md)
    }
    const ann3DData = md.annotation.isVisibleIn3D
      ? NVAnnotation.buildAnnotation3DRenderData(md)
      : null
    const crossLinesList: ReturnType<typeof buildLine>[] = []
    // Render each tile
    for (let i = 0; i < screenSlices.length; i++) {
      const tile = screenSlices[i]
      if (!tile) continue
      const ltwh = tile.leftTopWidthHeight as number[]
      // Calculate MVP matrix
      let [mvpMatrix, , normalMatrix, rayDir] = NVTransforms.calculateMvpMatrix(
        ltwh,
        md.scene.azimuth,
        md.scene.elevation,
        md.pivot3D,
        md.furthestFromPivot,
        md.scene.scaleMultiplier,
        md.volumes[0]?.obliqueRAS,
      )
      if (tile.axCorSag === undefined) {
        continue
      }
      if (tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER) {
        const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
        const pan = NVSliceLayout.slicePanUV(md.scene.pan2Dxyzmm, tile.axCorSag)
        ;[mvpMatrix, , normalMatrix, rayDir] =
          NVTransforms.calculateMvpMatrix2D(
            ltwh,
            screen.mnMM,
            screen.mxMM,
            Infinity,
            undefined,
            tile.azimuth as number,
            tile.elevation as number,
            md.layout.isRadiological,
            md.volumes[0]?.obliqueRAS,
            undefined,
            pan,
            false,
          )
        // Cache MVP and plane equation for fast interactive picking
        tile.mvpMatrix = mat4.clone(mvpMatrix as mat4)
        if (md.tex2mm) {
          const sliceDim = NVConstants.sliceTypeDim(tile.axCorSag)
          const sf =
            tile.sliceMM !== undefined
              ? md.getSliceTexFracAtMM(sliceDim, tile.sliceMM)
              : md.getSliceTexFrac(sliceDim)
          const plane = NVTransforms.slicePlaneEquation(
            md.tex2mm,
            tile.axCorSag,
            sf,
          )
          if (plane) {
            tile.planeNormal = plane.normal
            tile.planePoint = plane.point
          }
        }
      } else if (tile.screen) {
        // Mosaic render tile: use screen bounds with origin centering for rotation stability
        const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
        ;[mvpMatrix, , normalMatrix, rayDir] =
          NVTransforms.calculateMvpMatrix2D(
            ltwh,
            screen.mnMM,
            screen.mxMM,
            Infinity,
            undefined,
            tile.azimuth as number,
            tile.elevation as number,
            md.layout.isRadiological,
            md.volumes[0]?.obliqueRAS,
            md.pivot3D,
            undefined,
            false,
          )
        // Cross-lines on mosaic render tiles
        if (tile.crossLines) {
          crossLinesList.push(
            ...NVSliceLayout.buildCrossLines(
              tile,
              mvpMatrix,
              md.extentsMin,
              md.extentsMax,
              Math.max(1, md.ui.crosshairWidth),
              md.ui.crosshairColor,
              buildLine,
            ),
          )
        }
      }
      gl.viewport(
        bx + ltwh[0],
        fullCanvasH - by - ltwh[1] - ltwh[3],
        ltwh[2],
        ltwh[3],
      )
      // Layer 1: Volume rendering
      if (this.volumeRenderer.hasVolume() && volumes.length > 0) {
        const vol = volumes[0]
        if (!vol) continue
        const matRAS = vol.matRAS
        if (!matRAS || !vol.volScale) {
          continue
        }
        if (tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER) {
          const sliceDim = NVConstants.sliceTypeDim(tile.axCorSag)
          const sliceFrac =
            tile.sliceMM !== undefined
              ? md.getSliceTexFracAtMM(sliceDim, tile.sliceMM)
              : md.getSliceTexFrac(sliceDim)
          this.sliceRenderer.draw(
            gl,
            this.volumeRenderer.volumeTexture as WebGLTexture,
            this.volumeRenderer.overlayTexture,
            vol,
            {
              overlayAlphaShader: md.volume.alphaShader,
              overlayOutlineWidth: md.volume.outlineWidth,
              isAlphaClipDark: md.volume.isAlphaClipDark,
              drawRimOpacity: md.draw.rimOpacity,
              isV1SliceShader: md.volume.isV1SliceShader,
            },
            mvpMatrix as Float32Array,
            tile.axCorSag,
            sliceFrac,
            Math.min(volumes.length, 2),
            md.volume.isNearestInterpolation,
            1,
            this.volumeRenderer.paqdTexture,
            this.volumeRenderer.paqdLutTexture,
            this.volumeRenderer.paqdTexture ? 1 : 0,
            md.volume.paqdUniforms,
            md.volume.isV1SliceShader,
          )
        } else {
          this.volumeRenderer.draw(
            gl,
            mvpMatrix as Float32Array,
            normalMatrix as Float32Array,
            matRAS as Float32Array,
            vol.volScale,
            rayDir as Float32Array,
            md.volume.illumination,
            Math.min(volumes.length, 2),
            md.scene.clipPlaneColor,
            md.clipPlanes,
            md.scene.isClipPlaneCutaway,
            md.volume.paqdUniforms,
          )
        }
      }
      // Layer 2a: Crosshairs (skip on all mosaic tiles)
      const isMosaicTile =
        tile.renderOrientation !== undefined || tile.sliceMM !== undefined
      if (
        md.ui.is3DCrosshairVisible &&
        !isMosaicTile &&
        this.crosshairRenderer.isReady
      ) {
        this.crosshairRenderer.draw(
          gl,
          mvpMatrix as Float32Array,
          normalMatrix as Float32Array,
          tile.axCorSag,
        )
      }
      // Layer 2b: Meshes
      const meshes = (md.getMeshes() as NVMesh[]).filter(
        (m) => (m.opacity ?? 1.0) > 0.0,
      )
      const ccMM = crosscutMM(md, tile.axCorSag)
      // Mesh-specific MVP: constrain near/far to meshThicknessOn2D around slice plane
      let meshMvp = mvpMatrix
      let meshNorm = normalMatrix
      if (
        tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER &&
        md.mesh.thicknessOn2D !== Infinity
      ) {
        const clipMM = md.scene2mm(md.scene.crosshairPos)
        if (tile.sliceMM !== undefined) {
          clipMM[NVConstants.sliceTypeDim(tile.axCorSag)] = tile.sliceMM
        }
        const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
        const pan = NVSliceLayout.slicePanUV(md.scene.pan2Dxyzmm, tile.axCorSag)
        ;[meshMvp, , meshNorm] = NVTransforms.calculateMvpMatrix2D(
          ltwh,
          screen.mnMM,
          screen.mxMM,
          md.mesh.thicknessOn2D,
          clipMM,
          tile.azimuth as number,
          tile.elevation as number,
          md.layout.isRadiological,
          md.volumes[0]?.obliqueRAS,
          undefined,
          pan,
          false,
        )
      }
      if (meshes.length > 0) {
        for (const m of meshes) {
          const mGpu = this._getMeshGpu(m)
          if (!mGpu) continue
          const opacity = m.opacity ?? 1.0
          mesh.drawWithGpu(
            gl,
            m,
            mGpu,
            meshMvp as Float32Array,
            meshNorm as Float32Array,
            opacity,
            mGpu.shaderType,
            ccMM,
          )
        }
      }
      // Layer 2b-xray: Mesh X-ray pass (depth disabled, reduced opacity)
      const xrayAlpha = md.mesh.xRay
      if (xrayAlpha > 0) {
        // Re-draw crosshairs with xray (skip on all mosaic tiles)
        if (
          md.ui.is3DCrosshairVisible &&
          !isMosaicTile &&
          this.crosshairRenderer.isReady
        ) {
          this.crosshairRenderer.drawXRay(
            gl,
            mvpMatrix as Float32Array,
            normalMatrix as Float32Array,
            tile.axCorSag,
            xrayAlpha,
          )
        }
        // Re-draw meshes with xray
        if (meshes.length > 0) {
          for (const m of meshes) {
            const mGpu = this._getMeshGpu(m)
            if (!mGpu) continue
            const opacity = (m.opacity ?? 1.0) * xrayAlpha
            mesh.drawXRay(
              gl,
              m,
              mGpu,
              meshMvp as Float32Array,
              meshNorm as Float32Array,
              opacity,
              mGpu.shaderType,
              ccMM,
            )
          }
        }
      }
      // Layer 2b-ann: 3D annotations (RENDER tiles only)
      if (
        tile.axCorSag === NVConstants.SLICE_TYPE.RENDER &&
        ann3DData &&
        this.polygon3DRenderer.isReady
      ) {
        this.polygon3DRenderer.draw(gl, ann3DData, mvpMatrix as Float32Array)
        this.polygon3DRenderer.drawXRay(
          gl,
          ann3DData,
          mvpMatrix as Float32Array,
          0.5,
        )
        this.polygon3DRenderer.endPasses(gl)
      }
      // Layer 2c: Orientation cube (RENDER tiles only, skip mosaic renders)
      if (
        tile.axCorSag === NVConstants.SLICE_TYPE.RENDER &&
        tile.renderOrientation === undefined &&
        md.ui.isOrientCubeVisible &&
        this.orientCubeGpu
      ) {
        const cubePos = NVUILayout.orientCubePosition(ltwh)
        if (cubePos) {
          const { x, y, sz } = cubePos
          const proj = mat4.create()
          mat4.ortho(proj, 0, ltwh[2], 0, ltwh[3], -10 * sz, 10 * sz)
          const model = mat4.create()
          mat4.translate(model, model, [x, y, 0])
          mat4.scale(model, model, [sz, sz, sz])
          mat4.rotateX(model, model, deg2rad(270 - md.scene.elevation))
          mat4.rotateZ(model, model, deg2rad(-md.scene.azimuth))
          const cubeMVP = mat4.create()
          mat4.multiply(cubeMVP, proj, model)
          const identNorm = mat4.create()
          mesh.useShader(
            gl,
            'vertexColor',
            cubeMVP as Float32Array,
            identNorm as Float32Array,
            1.0,
          )
          gl.disable(gl.DEPTH_TEST)
          gl.enable(gl.CULL_FACE)
          gl.cullFace(gl.BACK)
          gl.bindVertexArray(this.orientCubeGpu.vao)
          gl.drawElements(
            gl.TRIANGLES,
            this.orientCubeGpu.indexCount,
            gl.UNSIGNED_INT,
            0,
          )
          gl.bindVertexArray(null)
          gl.enable(gl.DEPTH_TEST)
        }
      }
      // Orientation labels for this tile
      // In mosaic mode, labels are off by default; L tag enables, L- disables
      if (
        tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER &&
        (tile.showLabels ?? md.ui.isOrientationTextVisible)
      ) {
        const isRadio = md.layout.isRadiological
        const tileLeft = ltwh[0]
        const tileTop = ltwh[1]
        const tileWidth = ltwh[2]
        const tileHeight = ltwh[3]
        const labelScale = 1.0
        const labelMargin = 4
        if (
          tile.axCorSag === NVConstants.SLICE_TYPE.AXIAL ||
          tile.axCorSag === NVConstants.SLICE_TYPE.CORONAL
        ) {
          const leftLabel = isRadio ? 'R' : 'L'
          labels.push(
            this.fontRenderer.buildText(
              leftLabel,
              tileLeft + labelMargin,
              tileTop + tileHeight / 2,
              labelScale,
              labelColor,
              0,
              0.5,
            ),
          )
        } else if (tile.axCorSag === NVConstants.SLICE_TYPE.SAGITTAL) {
          const leftLabel = isRadio ? 'A' : 'P'
          labels.push(
            this.fontRenderer.buildText(
              leftLabel,
              tileLeft + labelMargin,
              tileTop + tileHeight / 2,
              labelScale,
              labelColor,
              0,
              0.5,
            ),
          )
        }
        if (tile.axCorSag === NVConstants.SLICE_TYPE.AXIAL) {
          labels.push(
            this.fontRenderer.buildText(
              'A',
              tileLeft + tileWidth / 2,
              tileTop + labelMargin,
              labelScale,
              labelColor,
              0.5,
              0,
            ),
          )
        } else if (
          tile.axCorSag === NVConstants.SLICE_TYPE.CORONAL ||
          tile.axCorSag === NVConstants.SLICE_TYPE.SAGITTAL
        ) {
          labels.push(
            this.fontRenderer.buildText(
              'S',
              tileLeft + tileWidth / 2,
              tileTop + labelMargin,
              labelScale,
              labelColor,
              0.5,
              0,
            ),
          )
        }
      }
    }
    // Reset viewport to bounds region for colormaps/overlays
    gl.viewport(bx, glBoundsY, canvasWidth, canvasHeight)
    // Layer 3: Colormap bars
    if (this.model.ui.isColorbarVisible) {
      this.colorbarRenderer.draw(gl, null)
    }
    // Layer 4: Lines — used by graph
    let graphLines: ReturnType<typeof buildLine>[] = []
    // Layer 5: Font/text
    const hasContent = this.model.getMeshes().length > 0 || volumes.length > 0
    const headerStr = resolveHeaderLabel(
      this.model.ui.placeholderText,
      hasContent,
      'WebGL2',
      log.level === 'debug',
    )
    if (this.fontRenderer.isReady) {
      if (headerStr !== '') {
        labels.push(
          this.fontRenderer.buildText(
            headerStr,
            canvasWidth * 0.5,
            0,
            1.5,
            [0, 0, 0, 1],
            0.5,
            -0.2,
            [0.3, 0.2, 0.8, 0.8],
          ),
        )
      }
      // Colorbar labels and tick marks
      if (this.model.ui.isColorbarVisible) {
        const colorbarLabels = buildColorbarLabels(
          this.colorbarRenderer.getColorbarInfos(),
          (s, x, y, sc, c, ax, ay, bc) =>
            this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
          this.colorbarRenderer.getLayout(),
        )
        labels.push(...colorbarLabels)
      }
      // Legend labels for label colormaps
      if (md.ui.isLegendVisible && legendEntries.length > 0) {
        this.legendLayout = NVLegend.computeLegendLayout(
          legendEntries,
          canvasWidth,
          canvasHeight,
          cbHeight,
          canvasWidth - legendWidth - graphWidth,
        )
        if (this.legendLayout) {
          const legendLabels = NVLegend.buildLegendLabels(
            this.legendLayout,
            (s, x, y, sc, c, ax, ay, bc) =>
              this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
            md.scene.backgroundColor,
          )
          labels.push(...legendLabels)
        }
      } else {
        this.legendLayout = null
      }
      // Graph labels and lines for 4D frame intensity
      if (graphData && graphWidth > 0) {
        const graphDpr =
          this.forceDevicePixelRatio > 0
            ? this.forceDevicePixelRatio
            : window.devicePixelRatio || 1
        this.graphLayout = NVGraph.computeGraphLayout(
          graphData,
          canvasWidth,
          canvasHeight,
          cbHeight,
          graphDpr,
        )
        if (this.graphLayout) {
          const graphElements = NVGraph.buildGraphElements(
            graphData,
            this.graphLayout,
            (s, x, y, sc, c, ax, ay, bc) =>
              this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
            buildLine,
            md.scene.backgroundColor,
          )
          labels.push(...graphElements.labels)
          graphLines = graphElements.lines
        }
      } else {
        this.graphLayout = null
      }
      // Ruler
      if (md.ui.isRulerVisible) {
        const rulerResult = NVRuler.buildRuler(
          screenSlices,
          (s, x, y, sc, c, ax, ay, bc) =>
            this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
          buildLine,
          md.ui.fontColor,
          md.scene.backgroundColor,
        )
        if (rulerResult) {
          labels.push(...rulerResult.labels)
          graphLines.push(...rulerResult.lines)
        }
      }
      // Persisted measurements and angles
      const persistedResult = NVMeasurement.buildPersistedMeasurements(
        this.model,
        screenSlices,
        (s, x, y, sc, c, ax, ay, bc) =>
          this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
        buildLine,
      )
      if (persistedResult) {
        labels.push(...persistedResult.labels)
        graphLines.push(...persistedResult.lines)
      }
      // Vector annotations
      const annotationResult = NVAnnotation.buildAnnotationRenderData(
        this.model,
        screenSlices,
        buildLine,
        this.fontRenderer.buildText.bind(this.fontRenderer),
      )
      if (annotationResult) {
        this.polygonRenderer.draw(gl, annotationResult)
        graphLines.push(...annotationResult.strokeLines)
        labels.push(...annotationResult.labels)
      }
      // Drag overlay: selection box as a panel rectangle, text as glyph batches
      const overlay = this.model._dragOverlay
      if (overlay?.rect) {
        labels.push({
          data: new Float32Array(0),
          count: 0,
          backColor: overlay.rect.color,
          backRect: [...overlay.rect.ltwh],
          backRadius: 0,
        })
      }
      if (overlay?.text) {
        for (const t of overlay.text) {
          const batch = this.fontRenderer.buildText(
            t.str,
            t.x,
            t.y,
            t.scale,
            t.color,
            t.anchorX,
            t.anchorY,
            t.backColor,
          )
          if (batch.count > 0) labels.push(batch)
        }
      }
      // Grow glyph capacity if needed
      let neededGlyphs = 0
      for (const item of labels) neededGlyphs += item.count
      if (neededGlyphs > this.maxGlyphs) this.maxGlyphs = neededGlyphs
      this.fontRenderer.draw(gl, null, null, null, labels, this.maxGlyphs)
    }
    // Draw graph lines, cross-lines, drag overlay lines, and bounds border via line renderer
    const allLines = [...graphLines, ...crossLinesList]
    // Drag overlay lines (measurement, angle)
    const overlayGL = this.model._dragOverlay
    if (overlayGL?.lines) {
      for (const line of overlayGL.lines) {
        allLines.push(
          buildLine(
            line.startXY[0],
            line.startXY[1],
            line.endXY[0],
            line.endXY[1],
            line.thickness,
            line.color,
          ),
        )
      }
    }
    // Bounds border
    if (this._isSubCanvasBounds && this.options.showBoundsBorder) {
      const bc = (this.options.boundsBorderColor as number[]) ?? [1, 1, 1, 1]
      const bt = (this.options.boundsBorderThickness as number) ?? 2
      allLines.push(buildLine(0, 0, canvasWidth, 0, bt, bc)) // top
      allLines.push(
        buildLine(0, canvasHeight, canvasWidth, canvasHeight, bt, bc),
      ) // bottom
      allLines.push(buildLine(0, 0, 0, canvasHeight, bt, bc)) // left
      allLines.push(
        buildLine(canvasWidth, 0, canvasWidth, canvasHeight, bt, bc),
      ) // right
    }
    if (allLines.length > 0 && this.lineRenderer.isReady) {
      if (allLines.length > this.maxLines) this.maxLines = allLines.length
      this.lineRenderer.draw(gl, null, null, null, allLines, this.maxLines)
    }
    // Disable scissor test at end of render
    if (this._isSubCanvasBounds) {
      gl.disable(gl.SCISSOR_TEST)
    }
  }

  /** Lazy bench harness. Not for production use. See ./bench.ts. */
  get bench(): GLBench {
    if (!this._bench) this._bench = new GLBench(this)
    return this._bench
  }

  /** Benchmark-only: render to canvas and block until the GPU finishes. */
  renderAndFlush(): Promise<void> {
    return this.bench.renderAndFlush()
  }

  /** Benchmark-only: render to an offscreen FBO and block until the GPU finishes. */
  renderAndFlushOffscreen(): Promise<void> {
    return this.bench.renderAndFlushOffscreen()
  }

  resize(): void {
    if (!this.gl) return
    // Calculate device pixel ratio
    let dpr: number
    if (this.forceDevicePixelRatio <= 0) {
      dpr = window.devicePixelRatio || 1
    } else if (this.forceDevicePixelRatio < 0) {
      dpr = 1
    } else {
      dpr = this.forceDevicePixelRatio
    }
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    // Compute bounds pixel rect
    this._computeBoundsPixels()
    const bw = this._boundsWidth
    const bh = this._boundsHeight
    this.lineRenderer.resize(this.gl, bw, bh)
    this.polygonRenderer.resize(this.gl, bw, bh)
    this.fontRenderer.resize(
      this.gl,
      bw,
      bh,
      dpr,
      this.model.ui.fontScale,
      this.model.ui.fontMinSize,
    )
    this.colorbarRenderer.resize(this.gl, bw, bh, this.fontRenderer.fontPx)
    this.thumbnailRenderer.resize(this.gl, bw, bh)
    this.render()
  }

  private _computeBoundsPixels(): void {
    const bounds = this.options.bounds
    const cw = this.canvas.width
    const ch = this.canvas.height
    if (
      !bounds ||
      (bounds[0][0] === 0 &&
        bounds[0][1] === 0 &&
        bounds[1][0] === 1 &&
        bounds[1][1] === 1)
    ) {
      this._boundsOffsetX = 0
      this._boundsOffsetY = 0
      this._boundsWidth = cw
      this._boundsHeight = ch
      this._isSubCanvasBounds = false
      return
    }
    // Round pixel edges, then derive size by subtraction to prevent
    // offset + size > canvas (which breaks copyTextureToTexture on odd dimensions)
    const left = Math.round(bounds[0][0] * cw)
    const right = Math.round(bounds[1][0] * cw)
    const top = Math.round((1 - bounds[1][1]) * ch)
    const bottom = Math.round((1 - bounds[0][1]) * ch)
    this._boundsOffsetX = left
    this._boundsOffsetY = top
    this._boundsWidth = Math.max(1, right - left)
    this._boundsHeight = Math.max(1, bottom - top)
    this._isSubCanvasBounds = true
  }

  getAvailableShaders(): string[] {
    if (!this.meshPipelines) return []
    return Object.keys(this.meshPipelines).filter(
      (s) => !s.startsWith('vertexColor'),
    )
  }

  _getMeshGpu(m: NVMesh): MeshGpuWithShader | null {
    return this.meshResources.get(m) ?? null
  }

  _destroyMeshResources(): void {
    const gl = this.gl
    if (!gl) return
    for (const gpu of this.meshResources.values()) {
      mesh.destroyMeshGpu(gl, gpu)
    }
    this.meshResources.clear()
  }

  _rebuildMeshResources(): void {
    const gl = this.gl
    if (!gl) return
    this._destroyMeshResources()
    const availableShaders = this.getAvailableShaders()
    const meshes = this.model.getMeshes() as NVMesh[]
    for (const m of meshes) {
      let shaderType = m.shaderType || 'phong'
      if (!availableShaders.includes(shaderType)) {
        log.warn(
          `Shader '${shaderType}' not available in WebGL2, falling back to 'phong'`,
        )
        shaderType = 'phong'
      }
      const gpu = mesh.uploadMeshGPU(gl, m, { shaderType })
      this.meshResources.set(m, gpu)
    }
  }

  hitTest(x: number, y: number): ViewHitTest | null {
    for (let idx = 0; idx < this.screenSlices.length; idx++) {
      const tile = this.screenSlices[idx]
      const ltwh = tile.leftTopWidthHeight as number[]
      const left = ltwh[0]
      const top = ltwh[1]
      const width = ltwh[2]
      const height = ltwh[3]
      if (x >= left && x < left + width && y >= top && y < top + height) {
        return {
          tileIndex: idx,
          sliceType: tile.axCorSag,
          isRender: tile.axCorSag === NVConstants.SLICE_TYPE.RENDER,
          normalizedX: (x - left) / width,
          normalizedY: (y - top) / height,
        }
      }
    }
    return null
  }

  refreshDrawing(rgba: Uint8Array, dims: number[]): void {
    if (!this.gl) return
    this.sliceRenderer.updateDrawingTexture(this.gl, rgba, dims)
    this.volumeRenderer.updateDrawingTexture(this.gl, rgba, dims)
  }

  clearDrawing(): void {
    if (!this.gl) return
    this.sliceRenderer.destroyDrawing()
    this.volumeRenderer.destroyDrawing(this.gl)
  }

  async loadThumbnail(url: string): Promise<void> {
    if (!this.gl) return
    await this.thumbnailRenderer.loadThumbnail(this.gl, url)
    this.thumbnailRenderer.resize(
      this.gl,
      this._boundsWidth || this.canvas.width,
      this._boundsHeight || this.canvas.height,
    )
  }

  async depthPick(
    x: number,
    y: number,
  ): Promise<[number, number, number] | null> {
    const hit = this.hitTest(x, y)
    if (!hit) return null
    const tile = this.screenSlices[hit.tileIndex]
    if (!tile) return null
    const gl = this.gl
    if (!gl) return null
    const ltwh = tile.leftTopWidthHeight as number[]
    const md = this.model
    const canvasHeight = this.canvas.height
    // Calculate MVP for this tile (same logic as the render loop)
    let mvpMatrix: mat4
    let rayDir: Float32Array | number[]
    if (hit.isRender && tile.renderOrientation !== undefined && tile.screen) {
      // Mosaic render tile: use same MVP as render loop (origin-centered, tile angles)
      const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
      const result = NVTransforms.calculateMvpMatrix2D(
        ltwh,
        screen.mnMM,
        screen.mxMM,
        Infinity,
        undefined,
        tile.azimuth as number,
        tile.elevation as number,
        md.layout.isRadiological,
        md.volumes[0]?.obliqueRAS,
        md.pivot3D,
        undefined,
        false,
      )
      mvpMatrix = result[0] as mat4
      rayDir = result[3] as Float32Array
    } else if (hit.isRender) {
      const result = NVTransforms.calculateMvpMatrix(
        ltwh,
        md.scene.azimuth,
        md.scene.elevation,
        md.pivot3D,
        md.furthestFromPivot,
        md.scene.scaleMultiplier,
        md.volumes[0]?.obliqueRAS,
      )
      mvpMatrix = result[0] as mat4
      rayDir = result[3] as Float32Array
    } else {
      const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
      const pan = NVSliceLayout.slicePanUV(md.scene.pan2Dxyzmm, tile.axCorSag)
      const result = NVTransforms.calculateMvpMatrix2D(
        ltwh,
        screen.mnMM,
        screen.mxMM,
        Infinity,
        undefined,
        tile.azimuth as number,
        tile.elevation as number,
        md.layout.isRadiological,
        md.volumes[0]?.obliqueRAS,
        undefined,
        pan,
        false,
      )
      mvpMatrix = result[0] as mat4
      rayDir = result[3] as Float32Array
    }
    // Depth-pick via scissor + readPixels (works for all tile types)
    // Offset by bounds origin for shared-canvas support
    const dpBx = this._boundsOffsetX
    const dpBy = this._boundsOffsetY
    gl.viewport(
      dpBx + ltwh[0],
      canvasHeight - dpBy - ltwh[3] - ltwh[1],
      ltwh[2],
      ltwh[3],
    )
    const scissorX = dpBx + Math.floor(x)
    const scissorY = canvasHeight - dpBy - Math.floor(y) - 1
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(scissorX, scissorY, 1, 1)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    // Draw volume with depth-pick shader (raymarches from any viewing angle)
    const volumes = md.getVolumes()
    if (this.volumeRenderer.hasVolume() && volumes.length > 0) {
      const vol = volumes[0]
      if (vol?.matRAS && vol.volScale) {
        this.volumeRenderer.drawDepthPick(
          gl,
          mvpMatrix as Float32Array,
          vol.matRAS as Float32Array,
          vol.volScale,
          rayDir as Float32Array,
          md.clipPlanes,
          md.scene.isClipPlaneCutaway,
          Math.min(volumes.length, 2),
        )
      }
    }
    // Draw meshes with depth-pick shader
    const meshes = (md.getMeshes() as NVMesh[]).filter(
      (m) => (m.opacity ?? 1.0) > 0.0,
    )
    for (const m of meshes) {
      const mGpu = this._getMeshGpu(m)
      if (!mGpu) continue
      mesh.drawDepthPick(gl, mGpu, mvpMatrix as Float32Array)
    }
    // Read back 1 pixel
    const pixel = new Uint8Array(4)
    gl.readPixels(scissorX, scissorY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
    gl.disable(gl.SCISSOR_TEST)
    const bgc = md.scene.backgroundColor
    gl.clearColor(bgc[0], bgc[1], bgc[2], bgc[3])
    // Hit: unpack depth and unproject to mm-space
    if (pixel[3] !== 0) {
      const depth =
        pixel[0] / 255.0 + pixel[1] / 65025.0 + pixel[2] / 16581375.0
      // Volume writes alpha=1.0 (255), mesh writes alpha=0.5 (~128)
      const isMesh = pixel[3] < 200
      log.debug(
        `depthPick: pixel=[${pixel[0]},${pixel[1]},${pixel[2]},${pixel[3]}] depth=${depth} isMesh=${isMesh}`,
      )
      const mmPos = NVTransforms.unprojectScreen(
        hit.normalizedX,
        hit.normalizedY,
        depth,
        mvpMatrix,
      )
      if (!hit.isRender && !isMesh && md.tex2mm) {
        const planeHit = NVTransforms.intersectSlicePlane(
          hit.normalizedX,
          hit.normalizedY,
          mvpMatrix,
          md.tex2mm,
          hit.sliceType,
          md.getSliceTexFrac(NVConstants.sliceTypeDim(hit.sliceType)),
        )
        if (planeHit) return planeHit
      }
      return [mmPos[0], mmPos[1], mmPos[2]]
    }
    // Miss: for 2D slices, fall back to ray-plane intersection
    if (!hit.isRender && volumes.length > 0 && md.tex2mm) {
      return NVTransforms.intersectSlicePlane(
        hit.normalizedX,
        hit.normalizedY,
        mvpMatrix,
        md.tex2mm,
        hit.sliceType,
        md.getSliceTexFrac(NVConstants.sliceTypeDim(hit.sliceType)),
      )
    }
    return null
  }

  destroy(): void {
    const gl = this.gl
    if (!gl) return

    this._destroyMeshResources()
    this.crosshairRenderer.destroy()
    if (this.orientCubeGpu) {
      mesh.destroyMeshGpu(gl, this.orientCubeGpu)
      this.orientCubeGpu = null
    }

    // Delete font texture
    if (this.fontTexture) gl.deleteTexture(this.fontTexture)
    this.fontTexture = null

    // Release benchmark resources (owned by bench module)
    this._bench?.destroy()
    this._bench = null

    // Destroy render layer instances
    this.volumeRenderer.destroy()
    this.lineRenderer.destroy()
    this.polygonRenderer.destroy()
    this.polygon3DRenderer.destroy()
    this.fontRenderer.destroy()
    this.colorbarRenderer.destroy()
    this.thumbnailRenderer.destroy()
    this.sliceRenderer.destroy()
    mesh.destroy(gl)

    this.gl = null
  }
}
