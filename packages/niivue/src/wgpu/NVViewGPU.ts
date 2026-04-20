import { mat4 } from "gl-matrix";
import { log } from "@/logger";
import * as NVTransforms from "@/math/NVTransforms";
import { deg2rad } from "@/math/NVTransforms";
import { generateNormals } from "@/mesh/NVMesh";
import * as NVShapes from "@/mesh/NVShapes";
import * as NVConstants from "@/NVConstants";
import type NVModel from "@/NVModel";
import type {
  NVMesh,
  NVViewOptions,
  ViewHitTest,
  WebGPUMeshGPU,
} from "@/NVTypes";
import * as NVAnnotation from "@/view/NVAnnotation";
import { buildColorbarLabels, colorbarTotalHeight } from "@/view/NVColorbar";
import { crosscutMM } from "@/view/NVCrosscut";
import { BYTES_PER_VERTEX } from "@/view/NVCrosshair";
import { resolveHeaderLabel } from "@/view/NVFont";
import * as NVGraph from "@/view/NVGraph";
import * as NVLegend from "@/view/NVLegend";
import { buildLine } from "@/view/NVLine";
import * as NVMeasurement from "@/view/NVMeasurement";
import * as NVRuler from "@/view/NVRuler";
import type { SliceTile } from "@/view/NVSliceLayout";
import * as NVSliceLayout from "@/view/NVSliceLayout";
import * as NVUILayout from "@/view/NVUILayout";
import { ColorbarRenderer } from "./colorbar";
import { CrosshairRenderer } from "./crosshair";
import * as depthPick from "./depthPick";
import { FontRenderer } from "./font";
import { LineRenderer } from "./line";
import * as mesh from "./mesh";
import { maskOverlayByBackground } from "./orient";
import { PolygonRenderer } from "./polygon";
import { Polygon3DRenderer } from "./polygon3d";
import { VolumeRenderer } from "./render";
import { SliceRenderer } from "./slice";
import { ThumbnailRenderer } from "./thumbnail";
import * as wgpu from "./wgpu";

type MeshGpuWithShader = WebGPUMeshGPU & { shaderType?: string };

/** Shared GPU context per canvas for multi-instance bounds support */
type SharedGPUContext = {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  maxTextureDimension2D: number;
  maxTextureDimension3D: number;
  refCount: number;
  views: Set<NVView>;
};
const sharedGPUContexts = new WeakMap<HTMLCanvasElement, SharedGPUContext>();

export default class NVView {
  canvas: HTMLCanvasElement;
  model: NVModel;
  options: NVViewOptions;
  isAntiAlias: boolean;
  forceDevicePixelRatio: number;
  device: GPUDevice | null;
  context: GPUCanvasContext | null;
  preferredCanvasFormat: GPUTextureFormat;
  sampler: GPUSampler | null;
  buffers: Record<string, GPUBuffer>;
  msaaTexture: GPUTexture | null;
  depthTexture: GPUTexture | null;
  crosshairRenderer: CrosshairRenderer;
  screenSlices: SliceTile[];
  legendLayout: import("@/view/NVLegend").LegendLayout | null;
  graphLayout: NVGraph.GraphLayout | null;
  isBusy: boolean;
  maxTextureDimension2D: number;
  maxTextureDimension3D: number;
  lineRenderer: LineRenderer;
  polygonRenderer: PolygonRenderer;
  polygon3DRenderer: Polygon3DRenderer;
  fontRenderer: FontRenderer;
  colorbarRenderer: ColorbarRenderer;
  sliceRenderer: SliceRenderer;
  volumeRenderer: VolumeRenderer;
  meshBindGroupLayout: GPUBindGroupLayout | null;
  meshPipelines: Record<string, GPURenderPipeline> | null;
  meshXRayPipelines: Record<string, GPURenderPipeline> | null;
  lineBindGroup: GPUBindGroup | null;
  fontBindGroup: GPUBindGroup | null;
  maxGlyphs: number;
  maxLines: number;
  meshResources: Map<NVMesh, MeshGpuWithShader>;
  orientCubeGpu: WebGPUMeshGPU | null;
  thumbnailRenderer: ThumbnailRenderer;
  // Bounds: pixel rect for sub-canvas rendering
  private _boundsWidth = 0;
  private _boundsHeight = 0;
  private _boundsOffsetX = 0;
  private _boundsOffsetY = 0;
  private _isSubCanvasBounds = false;
  private _boundsColorTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;
  private _msaaTextureView: GPUTextureView | null = null;
  // Reusable scratch buffer for mesh uniform writes — avoids per-call Float32Array allocation
  private _uniformScratch = new Float32Array(mesh.MESH_UNIFORM_SIZE / 4);

  constructor(
    canvas: HTMLCanvasElement,
    model: NVModel,
    options: NVViewOptions = {},
  ) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      throw new Error("NVView requires a valid HTMLCanvasElement");
    }
    this.canvas = canvas;
    this.model = model;
    this.options = options;
    this.isAntiAlias = options.isAntiAlias ?? false;
    this.forceDevicePixelRatio = options.devicePixelRatio ?? -1;
    // State & resources (model owns them)
    this.device = null;
    this.context = null;
    this.preferredCanvasFormat = "bgra8unorm";
    this.sampler = null;
    this.buffers = {};
    this.msaaTexture = null;
    this.depthTexture = null;
    this.crosshairRenderer = new CrosshairRenderer();
    // Screen layout state (for hit testing)
    this.screenSlices = [];
    this.legendLayout = null;
    this.graphLayout = null;
    this.isBusy = false;
    this.maxTextureDimension2D = 0;
    this.maxTextureDimension3D = 0;
    // Render layer instances
    this.lineRenderer = new LineRenderer();
    this.polygonRenderer = new PolygonRenderer();
    this.polygon3DRenderer = new Polygon3DRenderer();
    this.fontRenderer = new FontRenderer();
    this.colorbarRenderer = new ColorbarRenderer();
    this.sliceRenderer = new SliceRenderer();
    this.volumeRenderer = new VolumeRenderer();
    this.meshBindGroupLayout = null;
    this.meshPipelines = null;
    this.meshXRayPipelines = null;
    this.lineBindGroup = null;
    this.fontBindGroup = null;
    this.maxGlyphs = 0;
    this.maxLines = 0;
    this.meshResources = new Map();
    this.orientCubeGpu = null;
    this.thumbnailRenderer = new ThumbnailRenderer();
  }

  async init(): Promise<void> {
    await this._initWebGPU();
    await this._createResources();
    await this._createPipelines();
    await this.updateBindGroups();
  }

  async _createPipelines(): Promise<void> {
    const device = this.device;
    if (!device) return;
    // Mesh Pipeline
    this.meshBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: mesh.MESH_UNIFORM_SIZE,
          },
        },
      ],
    });
    const format = this.preferredCanvasFormat;
    const msaa = this.isAntiAlias ? 4 : 1;
    const layoutBGL = this.meshBindGroupLayout;
    const meshPipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [layoutBGL],
    });
    this.meshPipelines = {
      phong: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_phong",
      ),
      crevice: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_crevice",
      ),
      crosscut: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_crosscut",
        "depth24plus",
        "vertex_main",
        "always",
        false,
        "none",
      ),
      flat: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_flat",
        "depth24plus",
        "vertex_flat",
      ),
      matte: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_matte",
      ),
      outline: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_outline",
      ),
      rim: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_rim",
      ),
      silhouette: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_silhouette",
      ),
      toon: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_toon",
      ),
      vertexColor: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_vertexColor",
      ),
      vertexColorNoDepth: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_vertexColor",
        "depth24plus",
        "vertex_main",
        "always",
        false,
      ),
    };
    // X-ray pipelines: depth test = greater (only occluded fragments drawn), no depth write
    this.meshXRayPipelines = {
      phong: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_phong",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      crevice: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_crevice",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      crosscut: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_crosscut",
        "depth24plus",
        "vertex_main",
        "always",
        false,
        "none",
      ),
      flat: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_flat",
        "depth24plus",
        "vertex_flat",
        "greater",
        false,
      ),
      matte: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_matte",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      outline: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_outline",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      rim: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_rim",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      silhouette: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_silhouette",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      toon: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_toon",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
      vertexColor: mesh.createMeshPipeline(
        device,
        format,
        msaa,
        meshPipelineLayout,
        "fragment_vertexColor",
        "depth24plus",
        "vertex_main",
        "greater",
        false,
      ),
    };
    // Initialize crosshair renderer with pre-allocated buffers
    this.crosshairRenderer.init(device, layoutBGL);
    // Create orientation cube mesh
    this._createOrientCube(device, layoutBGL);
    // Initialize depth-pick pipelines (reuse existing bind group layouts)
    depthPick.init(
      device,
      this.volumeRenderer.bindLayout,
      this.meshBindGroupLayout,
    );
  }

  _createOrientCube(
    device: GPUDevice,
    bindGroupLayout: GPUBindGroupLayout,
  ): void {
    const cubeData = NVShapes.createOrientCube();
    const positions = new Float32Array(cubeData.positions);
    const indices = new Uint32Array(cubeData.indices);
    const normals = generateNormals(positions, indices);
    const numVerts = positions.length / 3;
    const vertexData = new ArrayBuffer(numVerts * BYTES_PER_VERTEX);
    const f32 = new Float32Array(vertexData);
    const u32 = new Uint32Array(vertexData);
    for (let v = 0; v < numVerts; v++) {
      const off = (v * BYTES_PER_VERTEX) / 4;
      f32[off] = positions[v * 3];
      f32[off + 1] = positions[v * 3 + 1];
      f32[off + 2] = positions[v * 3 + 2];
      f32[off + 3] = normals[v * 3];
      f32[off + 4] = normals[v * 3 + 1];
      f32[off + 5] = normals[v * 3 + 2];
      u32[off + 6] = cubeData.colors[v];
    }
    const vertexBuffer = device.createBuffer({
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Uint8Array(vertexBuffer.getMappedRange()).set(
      new Uint8Array(vertexData),
    );
    vertexBuffer.unmap();
    const indexBuffer = device.createBuffer({
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint32Array(indexBuffer.getMappedRange()).set(indices);
    indexBuffer.unmap();
    const uniformBuffer = device.createBuffer({
      size: mesh.alignedMeshSize * mesh.MAX_TILES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: uniformBuffer, size: mesh.MESH_UNIFORM_SIZE },
        },
      ],
    });
    this.orientCubeGpu = {
      vertexBuffer,
      indexBuffer,
      uniformBuffer,
      indexCount: indices.length,
      bindGroup,
      alignedMeshSize: mesh.alignedMeshSize,
    };
  }

  async updateBindGroups(): Promise<void> {
    this.isBusy = true;
    const buffs = this.buffers;
    const device = this.device;
    if (!device) return;
    const vols = this.model.getVolumes();

    await this.colorbarRenderer.buildColorbars(
      device,
      this.model.collectColorbars(),
      this.model.scene.backgroundColor,
    );
    if (vols.length > 0) {
      await this.volumeRenderer.updateVolume(
        device,
        vols[0],
        this.model.volume.matcap,
      );
    }
    if (vols.length > 1) {
      await this.volumeRenderer.updateOverlays(
        device,
        vols[0],
        vols.slice(1),
        this.model.volume.paqdUniforms,
      );
      if (
        this.model.volume.isBackgroundMasking &&
        this.volumeRenderer.overlayTexture &&
        this.volumeRenderer.volumeTexture
      ) {
        this.volumeRenderer.overlayTexture = await maskOverlayByBackground(
          device,
          this.volumeRenderer.volumeTexture,
          this.volumeRenderer.overlayTexture,
        );
      }
    } else {
      this.volumeRenderer.clearOverlay();
    }
    this.volumeRenderer.updateBindGroup(device);
    if (this.volumeRenderer.volumeTexture) {
      this.sliceRenderer.updateBindGroup(
        device,
        this.volumeRenderer.volumeTexture,
        this.volumeRenderer.overlayTexture,
        this.volumeRenderer.paqdTexture,
        this.volumeRenderer.paqdLutTexture,
      );
    }
    this.lineBindGroup = this.lineRenderer.createBindGroup(
      device,
      this.buffers.lineStorage,
    );
    if (this.fontRenderer.isReady && this.sampler) {
      this.fontBindGroup = this.fontRenderer.createBindGroup(
        device,
        buffs.glyphStorage,
        this.sampler,
      );
    }
    const meshes = this.model.getMeshes() as NVMesh[];
    const availableShaders = this.getAvailableShaders();
    if (!this.meshBindGroupLayout) return;
    this._destroyMeshResources();
    for (const m of meshes) {
      let shaderType = m.shaderType || "phong";
      if (!availableShaders.includes(shaderType)) {
        log.warn(
          `Shader '${shaderType}' not available in WebGPU, falling back to 'phong'`,
        );
        shaderType = "phong";
      }
      const gpuData = mesh.uploadMeshGPU(device, m, { shaderType });
      const mGpu: MeshGpuWithShader = {
        vertexBuffer: gpuData.vertexBuffer,
        indexBuffer: gpuData.indexBuffer,
        uniformBuffer: gpuData.uniformBuffer,
        indexCount: gpuData.indexCount,
        bindGroup: null,
        alignedMeshSize: mesh.alignedMeshSize,
        shaderType,
      };
      this.meshResources.set(m, mGpu);
      if (!mGpu) {
        continue;
      }
      if (!mGpu.uniformBuffer) {
        continue;
      }
      if (!mGpu?.bindGroup) {
        mGpu.bindGroup = device.createBindGroup({
          layout: this.meshBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: {
                buffer: mGpu.uniformBuffer,
                size: mesh.MESH_UNIFORM_SIZE,
              },
            },
          ],
        });
      }
    }
    this.isBusy = false;
  }

  render(): void {
    const md = this.model;
    if (!this.device || !this.context || !this.depthTexture) return;
    // Skip render if canvas is detached (e.g., replaced during backend switch)
    if (!this.canvas.parentNode) return;
    const device = this.device;
    if (this.isBusy || !this.fontRenderer.isReady) {
      requestAnimationFrame(() => this.render());
      return;
    }
    // Determine render targets based on bounds mode
    const canvasTexture = this.context.getCurrentTexture();
    const bw = this._boundsWidth;
    const bh = this._boundsHeight;
    const isSub = this._isSubCanvasBounds && this._boundsColorTexture;
    // For sub-canvas: render to intermediate texture, then copy to canvas
    // For full canvas: render directly to canvas texture (current behavior)
    const colorTarget = isSub
      ? this._boundsColorTexture?.createView()
      : canvasTexture.createView();
    const resolveTarget =
      this.isAntiAlias && this.msaaTexture ? colorTarget : undefined;
    if (this.isAntiAlias && this.msaaTexture && !this._msaaTextureView) {
      this._msaaTextureView = this.msaaTexture.createView();
    }
    const renderView =
      this.isAntiAlias && this._msaaTextureView
        ? this._msaaTextureView
        : colorTarget;
    if (!this._depthTextureView) {
      this._depthTextureView = this.depthTexture.createView();
    }
    // Thumbnail mode: draw only the thumbnail image and return
    if (md.ui.isThumbnailVisible && this.thumbnailRenderer.hasTexture()) {
      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: renderView,
            resolveTarget,
            loadOp: "clear",
            clearValue: md.scene.backgroundColor,
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: this._depthTextureView!,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      pass.setViewport(0, 0, bw, bh, 0.0, 1.0);
      this.thumbnailRenderer.draw(device, pass);
      pass.end();
      if (isSub) {
        this._copyBoundsToCanvas(commandEncoder, canvasTexture);
      }
      device.queue.submit([commandEncoder.finish()]);
      return;
    }
    // Clear labels at start of each render
    const labels: ReturnType<typeof this.fontRenderer.buildText>[] = [];
    const labelColor = md.ui.fontColor;
    // Use bounds dimensions as effective canvas size
    const canvasWidth = bw;
    const canvasHeight = bh;
    const commandEncoder = device.createCommandEncoder();
    const renderPassDesc: GPURenderPassDescriptor = {
      colorAttachments: [
        {
          view: renderView,
          resolveTarget,
          loadOp: "clear",
          clearValue: md.scene.backgroundColor,
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    };
    const pass = commandEncoder.beginRenderPass(renderPassDesc);
    const volumes = md.getVolumes();
    // Reserve vertical space for colorbars so tiles don't overlap them
    const cbHeight = md.ui.isColorbarVisible
      ? colorbarTotalHeight(
          this.colorbarRenderer.getColorbarInfos(),
          this.colorbarRenderer.getLayout(),
        )
      : 0;
    // Reserve horizontal space for legend and graph on the right side
    const legendEntries = md.collectLegendEntries();
    const legendWidth =
      md.ui.isLegendVisible && legendEntries.length > 0
        ? NVLegend.legendTotalWidth(legendEntries, canvasWidth, canvasHeight)
        : 0;
    const graphData = md.collectGraphData();
    const graphWidth = graphData
      ? NVGraph.graphTotalWidth(graphData, canvasWidth, canvasHeight)
      : 0;
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
    });
    this.screenSlices = screenSlices;
    // Update crosshair geometry based on current model state
    if (this.crosshairRenderer.isReady) {
      this.crosshairRenderer.update(md);
    }
    const ann3DData = md.annotation.isVisibleIn3D
      ? NVAnnotation.buildAnnotation3DRenderData(md)
      : null;
    const crossLinesList: ReturnType<typeof buildLine>[] = [];
    for (let i = 0; i < screenSlices.length; i++) {
      const tile = screenSlices[i];
      const ltwh = tile.leftTopWidthHeight as number[];
      let [mvpMatrix, , normalMatrix, rayDir] = NVTransforms.calculateMvpMatrix(
        ltwh,
        md.scene.azimuth,
        md.scene.elevation,
        md.pivot3D,
        md.furthestFromPivot,
        md.scene.scaleMultiplier,
        md.volumes[0]?.obliqueRAS,
      );
      if (tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER) {
        const screen = tile.screen as { mnMM: number[]; mxMM: number[] };
        const pan = NVSliceLayout.slicePanUV(
          md.scene.pan2Dxyzmm,
          tile.axCorSag,
        );
        const mvp2d = NVTransforms.calculateMvpMatrix2D(
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
        );
        mvpMatrix = mvp2d[0];
        normalMatrix = mvp2d[2];
        rayDir = mvp2d[3];
        // Cache MVP and plane equation for fast interactive picking
        tile.mvpMatrix = mat4.clone(mvpMatrix as mat4);
        if (md.tex2mm) {
          const sliceDim = NVConstants.sliceTypeDim(tile.axCorSag);
          const sf =
            tile.sliceMM !== undefined
              ? md.getSliceTexFracAtMM(sliceDim, tile.sliceMM)
              : md.getSliceTexFrac(sliceDim);
          const plane = NVTransforms.slicePlaneEquation(
            md.tex2mm,
            tile.axCorSag,
            sf,
          );
          if (plane) {
            tile.planeNormal = plane.normal;
            tile.planePoint = plane.point;
          }
        }
      } else if (tile.screen) {
        // Mosaic render tile: use screen bounds with origin centering for rotation stability
        const screen = tile.screen as { mnMM: number[]; mxMM: number[] };
        const mvp2d = NVTransforms.calculateMvpMatrix2D(
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
        );
        mvpMatrix = mvp2d[0];
        normalMatrix = mvp2d[2];
        rayDir = mvp2d[3];
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
          );
        }
      }
      // each tile is drawn to a unique screen region
      pass.setViewport(ltwh[0], ltwh[1], ltwh[2], ltwh[3], 0.0, 1.0);
      if (this.volumeRenderer.hasVolume() && volumes.length > 0) {
        const matRAS = volumes[0].matRAS;
        const volScale = volumes[0].volScale;
        if (!matRAS || !volScale) {
          continue;
        }
        if (tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER) {
          const sliceDim = NVConstants.sliceTypeDim(tile.axCorSag);
          const sliceFrac =
            tile.sliceMM !== undefined
              ? md.getSliceTexFracAtMM(sliceDim, tile.sliceMM)
              : md.getSliceTexFrac(sliceDim);
          this.sliceRenderer.draw(
            device,
            pass,
            volumes[0],
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
            i,
            Math.min(volumes.length, 2),
            md.volume.isNearestInterpolation,
            1,
            this.volumeRenderer.paqdTexture ? 1 : 0,
            md.volume.paqdUniforms,
            md.volume.isV1SliceShader,
          );
        } else {
          this.volumeRenderer.draw(
            device,
            pass,
            i,
            mvpMatrix as unknown as Float32Array,
            normalMatrix as unknown as Float32Array,
            matRAS as unknown as Float32Array,
            volScale as unknown as Float32Array,
            rayDir as unknown as Float32Array,
            md.volume.illumination,
            Math.min(volumes.length, 2),
            md.scene.clipPlaneColor,
            md.clipPlanes,
            md.scene.isClipPlaneCutaway,
            md.volume.paqdUniforms,
          );
        }
      }
      // Layer 2a: Crosshairs (skip on all mosaic tiles)
      const isMosaicTile =
        tile.renderOrientation !== undefined || tile.sliceMM !== undefined;
      if (
        md.ui.is3DCrosshairVisible &&
        !isMosaicTile &&
        this.crosshairRenderer.isReady &&
        this.meshPipelines
      ) {
        const pipeline = this.meshPipelines.phong;
        if (pipeline) {
          this.crosshairRenderer.draw(
            device,
            pass,
            pipeline,
            mvpMatrix as Float32Array,
            normalMatrix as Float32Array,
            i,
            tile.axCorSag,
          );
        }
      }
      // Layer 2b: Meshes (also limited to same tile)
      const meshes = (md.getMeshes() as NVMesh[]).filter(
        (m) => (m.opacity ?? 1.0) > 0.0,
      );
      // Compute crosscut uniform for this tile (crosshair mm with axis masking for 2D)
      const ccMM = crosscutMM(md, tile.axCorSag);
      // Mesh-specific MVP: constrain near/far to meshThicknessOn2D around slice plane
      let meshMvp = mvpMatrix;
      let meshNorm = normalMatrix;
      if (
        tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER &&
        md.mesh.thicknessOn2D !== Infinity
      ) {
        const clipMM = md.scene2mm(md.scene.crosshairPos);
        if (tile.sliceMM !== undefined) {
          clipMM[NVConstants.sliceTypeDim(tile.axCorSag)] = tile.sliceMM;
        }
        const screen = tile.screen as { mnMM: number[]; mxMM: number[] };
        const pan = NVSliceLayout.slicePanUV(
          md.scene.pan2Dxyzmm,
          tile.axCorSag,
        );
        const meshMvp2d = NVTransforms.calculateMvpMatrix2D(
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
        );
        meshMvp = meshMvp2d[0];
        meshNorm = meshMvp2d[2];
      }
      if (meshes.length > 0 && this.meshPipelines) {
        for (let meshIdx = 0; meshIdx < meshes.length; meshIdx++) {
          const m = meshes[meshIdx];
          const mGpu = this._getMeshGpu(m);
          if (!mGpu) continue;
          if (!mGpu.uniformBuffer || !mGpu.vertexBuffer || !mGpu.indexBuffer)
            continue;
          // Each mesh has its own uniform buffer; use slice index for dynamic offset
          const meshStride = mGpu.alignedMeshSize ?? mesh.alignedMeshSize;
          const dynamicOffset = Math.trunc(i * meshStride);
          if (!Number.isFinite(dynamicOffset)) {
            continue;
          }
          const s = this._uniformScratch;
          s.set(meshMvp as ArrayLike<number>, 0);
          s.set(meshNorm as ArrayLike<number>, 16);
          s.set(m.clipPlane as ArrayLike<number>, 32);
          s[36] = m.opacity ?? 1.0;
          // s[37-39] = 0 (pad, zero-initialized at allocation, never written non-zero)
          s.set(ccMM as ArrayLike<number>, 40);
          device.queue.writeBuffer(mGpu.uniformBuffer, dynamicOffset, s);
          const shaderType = mGpu.shaderType || m.shaderType || "phong";
          const pipeline = this.meshPipelines[shaderType];
          if (pipeline) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, mGpu.bindGroup, [dynamicOffset]);
            pass.setVertexBuffer(0, mGpu.vertexBuffer);
            pass.setIndexBuffer(mGpu.indexBuffer, "uint32");
            pass.drawIndexed(mGpu.indexCount);
          }
        }
      }
      // Layer 2b-xray: Mesh X-ray pass (depth greater, reduced opacity)
      // Use offset tile slots (i + screenSlices.length) so writeBuffer doesn't
      // overwrite the normal-pass uniforms before the GPU executes them.
      const xrayAlpha = md.mesh.xRay;
      const xrayTile = i + screenSlices.length;
      if (xrayAlpha > 0 && this.meshXRayPipelines) {
        // Re-draw crosshairs with xray (skip on all mosaic tiles)
        if (
          md.ui.is3DCrosshairVisible &&
          !isMosaicTile &&
          this.crosshairRenderer.isReady
        ) {
          const xPipeline = this.meshXRayPipelines.phong;
          if (xPipeline) {
            this.crosshairRenderer.drawXRay(
              device,
              pass,
              xPipeline,
              mvpMatrix as Float32Array,
              normalMatrix as Float32Array,
              xrayTile,
              tile.axCorSag,
              xrayAlpha,
            );
          }
        }
        // Re-draw meshes with xray
        if (meshes.length > 0) {
          for (let meshIdx = 0; meshIdx < meshes.length; meshIdx++) {
            const m = meshes[meshIdx];
            const mGpu = this._getMeshGpu(m);
            if (!mGpu) continue;
            if (!mGpu.uniformBuffer || !mGpu.vertexBuffer || !mGpu.indexBuffer)
              continue;
            const meshStride = mGpu.alignedMeshSize ?? mesh.alignedMeshSize;
            const dynamicOffset = Math.trunc(xrayTile * meshStride);
            if (!Number.isFinite(dynamicOffset)) continue;
            const s = this._uniformScratch;
            s.set(meshMvp as ArrayLike<number>, 0);
            s.set(meshNorm as ArrayLike<number>, 16);
            s.set(m.clipPlane as ArrayLike<number>, 32);
            s[36] = (m.opacity ?? 1.0) * xrayAlpha;
            s.set(ccMM as ArrayLike<number>, 40);
            device.queue.writeBuffer(mGpu.uniformBuffer, dynamicOffset, s);
            const shaderType = mGpu.shaderType || m.shaderType || "phong";
            const xPipeline = this.meshXRayPipelines[shaderType];
            if (xPipeline) {
              pass.setPipeline(xPipeline);
              pass.setBindGroup(0, mGpu.bindGroup, [dynamicOffset]);
              pass.setVertexBuffer(0, mGpu.vertexBuffer);
              pass.setIndexBuffer(mGpu.indexBuffer, "uint32");
              pass.drawIndexed(mGpu.indexCount);
            }
          }
        }
      }
      // Layer 2b-ann: 3D annotations (RENDER tiles only)
      if (
        tile.axCorSag === NVConstants.SLICE_TYPE.RENDER &&
        ann3DData &&
        this.polygon3DRenderer.isReady
      ) {
        this.polygon3DRenderer.draw(
          device,
          pass,
          ann3DData,
          mvpMatrix as Float32Array,
        );
        // X-ray pass: show annotations behind volume at reduced opacity
        this.polygon3DRenderer.drawXRay(
          device,
          pass,
          ann3DData,
          mvpMatrix as Float32Array,
          0.5,
        );
      }
      // Layer 2c: Orientation cube (RENDER tiles only, skip mosaic renders)
      if (
        tile.axCorSag === NVConstants.SLICE_TYPE.RENDER &&
        tile.renderOrientation === undefined &&
        md.ui.isOrientCubeVisible &&
        this.orientCubeGpu &&
        this.meshPipelines
      ) {
        const cubePos = NVUILayout.orientCubePosition(ltwh);
        if (cubePos) {
          const { x, y, sz } = cubePos;
          const proj = mat4.create();
          mat4.orthoZO(proj, 0, ltwh[2], 0, ltwh[3], -10 * sz, 10 * sz);
          const model = mat4.create();
          mat4.translate(model, model, [x, y, 0]);
          mat4.scale(model, model, [sz, sz, sz]);
          mat4.rotateX(model, model, deg2rad(270 - md.scene.elevation));
          mat4.rotateZ(model, model, deg2rad(-md.scene.azimuth));
          const cubeMVP = mat4.create();
          mat4.multiply(cubeMVP, proj, model);
          const identNorm = mat4.create();
          const gpu = this.orientCubeGpu;
          const dynamicOffset = Math.trunc(i * gpu.alignedMeshSize!);
          const s = this._uniformScratch;
          s.set(cubeMVP as unknown as ArrayLike<number>, 0);
          s.set(identNorm as unknown as ArrayLike<number>, 16);
          s.fill(0, 32); // zero clipPlane, pad, ccMM (offsets 32–43)
          s[36] = 1.0; // opacity
          device.queue.writeBuffer(gpu.uniformBuffer!, dynamicOffset, s);
          const pipeline = this.meshPipelines.vertexColorNoDepth;
          if (pipeline) {
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, gpu.bindGroup, [dynamicOffset]);
            pass.setVertexBuffer(0, gpu.vertexBuffer!);
            pass.setIndexBuffer(gpu.indexBuffer!, "uint32");
            pass.drawIndexed(gpu.indexCount);
          }
        }
      }
      // Orientation labels for this tile (positions relative to canvas, not tile)
      // In mosaic mode, labels are off by default; L tag enables, L- disables
      if (
        tile.axCorSag !== NVConstants.SLICE_TYPE.RENDER &&
        (tile.showLabels ?? md.ui.isOrientationTextVisible)
      ) {
        const isRadio = md.layout.isRadiological;
        const tileLeft = ltwh[0];
        const tileTop = ltwh[1];
        const tileWidth = ltwh[2];
        const tileHeight = ltwh[3];
        const labelScale = 1.0;
        const labelMargin = 4;
        // Left-center label (anchorX=0 left-aligned, anchorY=0.5 vertically centered)
        if (
          tile.axCorSag === NVConstants.SLICE_TYPE.AXIAL ||
          tile.axCorSag === NVConstants.SLICE_TYPE.CORONAL
        ) {
          const leftLabel = isRadio ? "R" : "L";
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
          );
        } else if (tile.axCorSag === NVConstants.SLICE_TYPE.SAGITTAL) {
          const leftLabel = isRadio ? "A" : "P";
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
          );
        }
        // Center-top label (anchorX=0.5 horizontally centered, anchorY=0 text below point)
        if (tile.axCorSag === NVConstants.SLICE_TYPE.AXIAL) {
          labels.push(
            this.fontRenderer.buildText(
              "A",
              tileLeft + tileWidth / 2,
              tileTop + labelMargin,
              labelScale,
              labelColor,
              0.5,
              0,
            ),
          );
        } else if (
          tile.axCorSag === NVConstants.SLICE_TYPE.CORONAL ||
          tile.axCorSag === NVConstants.SLICE_TYPE.SAGITTAL
        ) {
          labels.push(
            this.fontRenderer.buildText(
              "S",
              tileLeft + tileWidth / 2,
              tileTop + labelMargin,
              labelScale,
              labelColor,
              0.5,
              0,
            ),
          );
        }
      }
    } //for each screen slice (tile)
    // Use full canvas for colormaps / lines / fonts ---
    pass.setViewport(0, 0, canvasWidth, canvasHeight, 0.0, 1.0);
    // Layer 3: Colormap bars (full-canvas; pipeline uses depthCompare: 'always')
    if (this.model.ui.isColorbarVisible) {
      this.colorbarRenderer.draw(device, pass);
    }
    // Layer 4: Lines (full-canvas) — used by graph
    let graphLines: ReturnType<typeof buildLine>[] = [];
    // Layer 5: Font (full-canvas)
    if (this.fontRenderer.isReady && this.fontBindGroup) {
      const hasContent =
        this.model.getMeshes().length > 0 || volumes.length > 0;
      const headerStr = resolveHeaderLabel(
        this.model.ui.placeholderText,
        hasContent,
        "WebGPU",
        log.level === "debug",
      );
      if (headerStr !== "") {
        labels.push(
          this.fontRenderer.buildText(
            headerStr,
            canvasWidth * 0.5,
            0,
            1.5,
            [0, 0, 0, 1],
            0.5,
            -0.2,
            [0.5, 0.2, 0.6, 0.8],
          ),
        );
      }
      // Colorbar labels and tick marks
      if (this.model.ui.isColorbarVisible) {
        const colorbarLabels = buildColorbarLabels(
          this.colorbarRenderer.getColorbarInfos(),
          (s, x, y, sc, c, ax, ay, bc) =>
            this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
          this.colorbarRenderer.getLayout(),
        );
        labels.push(...colorbarLabels);
      }
      // Legend labels for label colormaps
      if (md.ui.isLegendVisible && legendEntries.length > 0) {
        this.legendLayout = NVLegend.computeLegendLayout(
          legendEntries,
          canvasWidth,
          canvasHeight,
          cbHeight,
          canvasWidth - legendWidth - graphWidth,
        );
        if (this.legendLayout) {
          const legendLabels = NVLegend.buildLegendLabels(
            this.legendLayout,
            (s, x, y, sc, c, ax, ay, bc) =>
              this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
            md.scene.backgroundColor,
          );
          labels.push(...legendLabels);
        }
      } else {
        this.legendLayout = null;
      }
      // Graph labels and lines for 4D frame intensity
      if (graphData && graphWidth > 0) {
        const graphDpr =
          this.forceDevicePixelRatio > 0
            ? this.forceDevicePixelRatio
            : window.devicePixelRatio || 1;
        this.graphLayout = NVGraph.computeGraphLayout(
          graphData,
          canvasWidth,
          canvasHeight,
          cbHeight,
          graphDpr,
        );
        if (this.graphLayout) {
          const graphElements = NVGraph.buildGraphElements(
            graphData,
            this.graphLayout,
            (s, x, y, sc, c, ax, ay, bc) =>
              this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
            buildLine,
            md.scene.backgroundColor,
          );
          labels.push(...graphElements.labels);
          graphLines = graphElements.lines;
        }
      } else {
        this.graphLayout = null;
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
        );
        if (rulerResult) {
          labels.push(...rulerResult.labels);
          graphLines.push(...rulerResult.lines);
        }
      }
      // Persisted measurements and angles
      const persistedResult = NVMeasurement.buildPersistedMeasurements(
        this.model,
        screenSlices,
        (s, x, y, sc, c, ax, ay, bc) =>
          this.fontRenderer.buildText(s, x, y, sc, c, ax, ay, bc),
        buildLine,
      );
      if (persistedResult) {
        labels.push(...persistedResult.labels);
        graphLines.push(...persistedResult.lines);
      }
      // Vector annotations
      const annotationResult = NVAnnotation.buildAnnotationRenderData(
        this.model,
        screenSlices,
        buildLine,
        this.fontRenderer.buildText.bind(this.fontRenderer),
      );
      if (annotationResult) {
        this.polygonRenderer.draw(device, pass, annotationResult);
        graphLines.push(...annotationResult.strokeLines);
        labels.push(...annotationResult.labels);
      }
      // Drag overlay: selection box as a panel rectangle, text as glyph batches
      const overlay = this.model._dragOverlay;
      if (overlay?.rect) {
        labels.push({
          data: new Float32Array(0),
          count: 0,
          backColor: overlay.rect.color,
          backRect: [...overlay.rect.ltwh],
          backRadius: 0,
        });
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
          );
          if (batch.count > 0) labels.push(batch);
        }
      }
      // Grow glyph storage if needed
      let neededGlyphs = 0;
      for (const item of labels) neededGlyphs += item.count;
      if (neededGlyphs > this.maxGlyphs) {
        this.maxGlyphs = neededGlyphs;
        this.buffers.glyphStorage.destroy();
        this.buffers.glyphStorage = device.createBuffer({
          size: this.maxGlyphs * 64,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.fontBindGroup = this.fontRenderer.createBindGroup(
          device,
          this.buffers.glyphStorage,
          this.sampler!,
        );
      }
      this.fontRenderer.draw(
        device,
        pass,
        this.fontBindGroup,
        this.buffers.glyphStorage,
        labels,
        this.maxGlyphs,
      );
    }
    // Draw graph lines, cross-lines, drag overlay lines, and bounds border via line renderer
    const allLines = [...graphLines, ...crossLinesList];
    // Drag overlay lines (measurement, angle)
    const overlayLines = this.model._dragOverlay;
    if (overlayLines?.lines) {
      for (const line of overlayLines.lines) {
        allLines.push(
          buildLine(
            line.startXY[0],
            line.startXY[1],
            line.endXY[0],
            line.endXY[1],
            line.thickness,
            line.color,
          ),
        );
      }
    }
    // Bounds border
    if (this._isSubCanvasBounds && this.options.showBoundsBorder) {
      const bc = (this.options.boundsBorderColor as number[]) ?? [1, 1, 1, 1];
      const bt = (this.options.boundsBorderThickness as number) ?? 2;
      allLines.push(buildLine(0, 0, canvasWidth, 0, bt, bc));
      allLines.push(
        buildLine(0, canvasHeight, canvasWidth, canvasHeight, bt, bc),
      );
      allLines.push(buildLine(0, 0, 0, canvasHeight, bt, bc));
      allLines.push(
        buildLine(canvasWidth, 0, canvasWidth, canvasHeight, bt, bc),
      );
    }
    if (allLines.length > 0 && this.lineBindGroup) {
      if (allLines.length > this.maxLines) {
        this.maxLines = allLines.length;
        this.buffers.lineStorage.destroy();
        this.buffers.lineStorage = device.createBuffer({
          size: this.maxLines * 48,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        this.lineBindGroup = this.lineRenderer.createBindGroup(
          device,
          this.buffers.lineStorage,
        );
      }
      this.lineRenderer.draw(
        device,
        pass,
        this.lineBindGroup,
        this.buffers.lineStorage,
        allLines,
        this.maxLines,
      );
    }
    pass.end();
    // Copy intermediate texture to canvas at bounds offset
    if (isSub) {
      this._copyBoundsToCanvas(commandEncoder, canvasTexture);
    }
    device.queue.submit([commandEncoder.finish()]);
  }

  /** Copy this view's intermediate texture and all siblings' to the canvas */
  private _copyBoundsToCanvas(
    commandEncoder: GPUCommandEncoder,
    canvasTexture: GPUTexture,
  ): void {
    const cw = canvasTexture.width;
    const ch = canvasTexture.height;
    // Validate dimensions before copy — during rapid resize, textures may be
    // stale (sized for previous canvas) causing out-of-bounds GPU errors
    const bt = this._boundsColorTexture!;
    if (
      bt.width >= this._boundsWidth &&
      bt.height >= this._boundsHeight &&
      this._boundsOffsetX + this._boundsWidth <= cw &&
      this._boundsOffsetY + this._boundsHeight <= ch
    ) {
      commandEncoder.copyTextureToTexture(
        { texture: bt },
        {
          texture: canvasTexture,
          origin: { x: this._boundsOffsetX, y: this._boundsOffsetY },
        },
        { width: this._boundsWidth, height: this._boundsHeight },
      );
    }
    // Also copy sibling views' cached textures so their regions persist
    // (WebGPU getCurrentTexture() returns a new blank texture each frame)
    const shared = sharedGPUContexts.get(this.canvas);
    if (shared) {
      for (const sibling of shared.views) {
        if (sibling === this) continue;
        const st = sibling._boundsColorTexture;
        if (st && sibling._isSubCanvasBounds) {
          if (
            st.width >= sibling._boundsWidth &&
            st.height >= sibling._boundsHeight &&
            sibling._boundsOffsetX + sibling._boundsWidth <= cw &&
            sibling._boundsOffsetY + sibling._boundsHeight <= ch
          ) {
            commandEncoder.copyTextureToTexture(
              { texture: st },
              {
                texture: canvasTexture,
                origin: {
                  x: sibling._boundsOffsetX,
                  y: sibling._boundsOffsetY,
                },
              },
              { width: sibling._boundsWidth, height: sibling._boundsHeight },
            );
          }
        }
      }
    }
  }

  async _initWebGPU(): Promise<void> {
    if (!navigator.gpu) throw new Error("WebGPU not supported in this browser");
    // Check for shared context on same canvas (multi-instance bounds support)
    const shared = sharedGPUContexts.get(this.canvas);
    if (shared) {
      this.device = shared.device;
      this.context = shared.context;
      this.preferredCanvasFormat = shared.format;
      this.maxTextureDimension2D = shared.maxTextureDimension2D;
      this.maxTextureDimension3D = shared.maxTextureDimension3D;
      shared.refCount++;
      shared.views.add(this);
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("Failed to get WebGPU adapter");

    this.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
    this.maxTextureDimension3D = adapter.limits.maxTextureDimension3D;
    const adapterInfo = (
      adapter as unknown as { info?: { architecture?: string } }
    ).info;
    const arch = adapterInfo?.architecture ?? "unknown";
    const preferredBufferSize = 4294967292; // 4 GB (4294967296) byte aligned
    const maxBufferSize = Math.min(
      adapter.limits.maxBufferSize,
      preferredBufferSize,
    );
    const maxStorageBufferBindingSize = Math.min(
      adapter.limits.maxStorageBufferBindingSize,
      preferredBufferSize,
    );
    if (adapter.limits.maxBufferSize < preferredBufferSize) {
      log.warn(
        `GPU maxBufferSize is ${adapter.limits.maxBufferSize} (< 4 GB): large volumes may fail`,
      );
    }
    // Future opportunity: hardware mesh clipping via WebGPU `clip-distances`.
    // Adapter support is still patchy (notably Safari) so the block below is
    // kept parked for a future feature. When activating:
    //  1) uncomment the feature-presence check and log via `log.warn(...)`,
    //     not `console.error` (severity: degraded path, not defect);
    //  2) add `requiredFeatures: ["clip-distances"]` to the existing
    //     `adapter.requestDevice({ requiredLimits: ... })` call a few lines
    //     below — do NOT add a second `requestDevice` call, or you will
    //     silently drop the `requiredLimits` (and with it large-volume
    //     support) on every machine.
    // if (!adapter.features.has("clip-distances")) {
    //   console.error("Hardware clip distances not supported on this device")
    // }
    // this.device = await adapter.requestDevice({requiredFeatures: ["clip-distances"],})
    log.info(
      `WebGPU via ${arch} maxTexture 2D:${this.maxTextureDimension2D} 3D:${this.maxTextureDimension3D} maxBuffer:${maxBufferSize} antiAlias:${this.isAntiAlias}`,
    );
    this.device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize,
        maxStorageBufferBindingSize,
        maxTextureDimension2D: this.maxTextureDimension2D,
      },
    });
    this.context = this.canvas.getContext("webgpu");
    if (!this.context) {
      throw new Error("Unable to initialize WebGPU context");
    }
    this.preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.preferredCanvasFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      alphaMode: "premultiplied",
    });
    // Cache for sharing with other instances on same canvas
    sharedGPUContexts.set(this.canvas, {
      device: this.device,
      context: this.context,
      format: this.preferredCanvasFormat,
      maxTextureDimension2D: this.maxTextureDimension2D,
      maxTextureDimension3D: this.maxTextureDimension3D,
      refCount: 1,
      views: new Set([this]),
    });
  }

  async _createResources(): Promise<void> {
    if (!this.device) return;
    const msaaCount = this.isAntiAlias ? 4 : 1;
    // Initialize render layer modules
    let dpr = window.devicePixelRatio || 1;
    if (this.forceDevicePixelRatio > 0) dpr = this.forceDevicePixelRatio;
    await this.lineRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
    );
    this.lineRenderer.resize(
      this.device,
      this.canvas.width,
      this.canvas.height,
    );
    await this.polygonRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
    );
    this.polygonRenderer.resize(
      this.device,
      this.canvas.width,
      this.canvas.height,
    );
    await this.polygon3DRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
    );
    await this.fontRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
      this.options.font,
    );
    this.fontRenderer.resize(
      this.device,
      this.canvas.width,
      this.canvas.height,
      dpr,
      this.model.ui.fontScale,
      this.model.ui.fontMinSize,
    );
    await this.colorbarRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
    );
    this.colorbarRenderer.resize(
      this.device,
      this.canvas.width,
      this.canvas.height,
      this.fontRenderer.fontPx,
    );
    await this.thumbnailRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
    );
    await this.sliceRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
    );
    await this.volumeRenderer.init(
      this.device,
      this.preferredCanvasFormat,
      msaaCount,
      this.maxTextureDimension3D,
    );
    // Storage Buffers
    this.maxGlyphs = 2048; // Increased for legends with many entries
    this.buffers.glyphStorage = this.device.createBuffer({
      size: this.maxGlyphs * 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.maxLines = 1024;
    this.buffers.lineStorage = this.device.createBuffer({
      size: this.maxLines * 48,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Sampler for font bind groups
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    // Crosshair renderer is initialized in _createPipelines after meshBindGroupLayout is created
  }

  resize(): void {
    if (!this.device || !this.context) return;
    if (!this.canvas.parentNode) return;
    let dpr = window.devicePixelRatio || 1;
    if (this.forceDevicePixelRatio > 0) dpr = this.forceDevicePixelRatio;
    const rect = this.canvas.getBoundingClientRect();
    const newW = Math.max(1, Math.floor(rect.width * dpr));
    const newH = Math.max(1, Math.floor(rect.height * dpr));
    const canvasChanged =
      this.canvas.width !== newW || this.canvas.height !== newH;
    if (canvasChanged) {
      this.canvas.width = newW;
      this.canvas.height = newH;
      this.context.configure({
        device: this.device,
        format: this.preferredCanvasFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        alphaMode: "premultiplied",
      });
    }
    this._resizeSelf(dpr);
    // When canvas changed, resize + render all siblings first so their
    // bounds textures are valid before we copy them in our own render
    if (canvasChanged) {
      const shared = sharedGPUContexts.get(this.canvas);
      if (shared) {
        for (const sibling of shared.views) {
          if (sibling === this) continue;
          sibling._resizeSelf(dpr);
          sibling.render();
        }
      }
    }
    this.render();
  }

  /** Recompute bounds pixels, update textures, and resize renderers */
  private _resizeSelf(dpr: number): void {
    this._computeBoundsPixels();
    const bw = this._boundsWidth;
    const bh = this._boundsHeight;
    this._updateMultisampleTarget();
    this.lineRenderer.resize(this.device!, bw, bh);
    this.polygonRenderer.resize(this.device!, bw, bh);
    this.fontRenderer.resize(
      this.device!,
      bw,
      bh,
      dpr,
      this.model.ui.fontScale,
      this.model.ui.fontMinSize,
    );
    this.colorbarRenderer.resize(
      this.device!,
      bw,
      bh,
      this.fontRenderer.fontPx,
    );
    this.thumbnailRenderer.resize(this.device!, bw, bh);
  }

  private _computeBoundsPixels(): void {
    const bounds = this.options.bounds;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (
      !bounds ||
      (bounds[0][0] === 0 &&
        bounds[0][1] === 0 &&
        bounds[1][0] === 1 &&
        bounds[1][1] === 1)
    ) {
      this._boundsOffsetX = 0;
      this._boundsOffsetY = 0;
      this._boundsWidth = cw;
      this._boundsHeight = ch;
      this._isSubCanvasBounds = false;
      return;
    }
    // Round pixel edges, then derive size by subtraction to prevent
    // offset + size > canvas (which breaks copyTextureToTexture on odd dimensions)
    const left = Math.round(bounds[0][0] * cw);
    const right = Math.round(bounds[1][0] * cw);
    const top = Math.round((1 - bounds[1][1]) * ch);
    const bottom = Math.round((1 - bounds[0][1]) * ch);
    this._boundsOffsetX = left;
    this._boundsOffsetY = top;
    this._boundsWidth = Math.max(1, right - left);
    this._boundsHeight = Math.max(1, bottom - top);
    this._isSubCanvasBounds = true;
  }

  _updateMultisampleTarget(): void {
    if (!this.device) return;
    // Use bounds dimensions for texture sizing
    const tw = this._boundsWidth || this.canvas.width;
    const th = this._boundsHeight || this.canvas.height;
    if (this.isAntiAlias) {
      // Skip recreation if already the right size (avoids destroying content during sibling resize)
      if (
        !this.msaaTexture ||
        this.msaaTexture.width !== tw ||
        this.msaaTexture.height !== th
      ) {
        if (this.msaaTexture) this.msaaTexture.destroy();
        this._msaaTextureView = null;
        this.msaaTexture = this.device.createTexture({
          size: [tw, th],
          sampleCount: 4,
          format: this.preferredCanvasFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
      }
    } else {
      if (this.msaaTexture) {
        this.msaaTexture.destroy();
        this.msaaTexture = null;
        this._msaaTextureView = null;
      }
    }
    // Create intermediate color texture for sub-canvas bounds (copy to canvas after render)
    if (this._isSubCanvasBounds) {
      if (
        !this._boundsColorTexture ||
        this._boundsColorTexture.width !== tw ||
        this._boundsColorTexture.height !== th
      ) {
        if (this._boundsColorTexture) this._boundsColorTexture.destroy();
        this._boundsColorTexture = this.device.createTexture({
          size: [tw, th],
          format: this.preferredCanvasFormat,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        });
      }
    } else {
      if (this._boundsColorTexture) {
        this._boundsColorTexture.destroy();
        this._boundsColorTexture = null;
      }
    }
    this._updateDepthTexture();
  }

  _updateDepthTexture(): void {
    if (!this.device) return;
    const tw = this._boundsWidth || this.canvas.width;
    const th = this._boundsHeight || this.canvas.height;
    const samples = this.isAntiAlias ? 4 : 1;
    if (
      this.depthTexture &&
      this.depthTexture.width === tw &&
      this.depthTexture.height === th &&
      this.depthTexture.sampleCount === samples
    ) {
      return;
    }
    if (this.depthTexture) this.depthTexture.destroy();
    this._depthTextureView = null;
    this.depthTexture = this.device.createTexture({
      size: [tw, th],
      format: "depth24plus",
      sampleCount: samples,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  getAvailableShaders(): string[] {
    if (!this.meshPipelines) return [];
    return Object.keys(this.meshPipelines).filter(
      (s) => !s.startsWith("vertexColor"),
    );
  }

  _getMeshGpu(m: NVMesh): MeshGpuWithShader | null {
    return this.meshResources.get(m) ?? null;
  }

  _destroyMeshResources(): void {
    for (const gpu of this.meshResources.values()) {
      mesh.destroyMesh(gpu);
    }
    this.meshResources.clear();
  }

  hitTest(x: number, y: number): ViewHitTest | null {
    for (let idx = 0; idx < this.screenSlices.length; idx++) {
      const tile = this.screenSlices[idx];
      const ltwh = tile.leftTopWidthHeight as number[];
      const left = ltwh[0];
      const top = ltwh[1];
      const width = ltwh[2];
      const height = ltwh[3];
      if (x >= left && x < left + width && y >= top && y < top + height) {
        return {
          tileIndex: idx,
          sliceType: tile.axCorSag,
          isRender: tile.axCorSag === NVConstants.SLICE_TYPE.RENDER,
          normalizedX: (x - left) / width,
          normalizedY: (y - top) / height,
        };
      }
    }
    return null;
  }

  refreshDrawing(rgba: Uint8Array, dims: number[]): void {
    if (!this.device) return;
    const needsRebind =
      !this.sliceRenderer.drawingTexture || !this.volumeRenderer.drawingTexture;
    this.sliceRenderer.updateDrawingTexture(this.device, rgba, dims);
    this.volumeRenderer.updateDrawingTexture(this.device, rgba, dims);
    if (needsRebind) {
      // Rebuild bind groups to reference the newly created drawing textures
      if (this.volumeRenderer.volumeTexture) {
        this.sliceRenderer.updateBindGroup(
          this.device,
          this.volumeRenderer.volumeTexture,
          this.volumeRenderer.overlayTexture,
          this.volumeRenderer.paqdTexture,
          this.volumeRenderer.paqdLutTexture,
        );
      }
      this.volumeRenderer.updateBindGroup(this.device);
    }
  }

  clearDrawing(): void {
    this.sliceRenderer.destroyDrawing();
    this.volumeRenderer.destroyDrawing();
    // Rebuild bind groups so shaders see the placeholder
    if (this.device && this.volumeRenderer.volumeTexture) {
      this.sliceRenderer.updateBindGroup(
        this.device,
        this.volumeRenderer.volumeTexture,
        this.volumeRenderer.overlayTexture,
        this.volumeRenderer.paqdTexture,
        this.volumeRenderer.paqdLutTexture,
      );
      this.volumeRenderer.updateBindGroup(this.device);
    }
  }

  async loadThumbnail(url: string): Promise<void> {
    if (!this.device) return;
    await this.thumbnailRenderer.loadThumbnail(this.device, url);
    this.thumbnailRenderer.resize(
      this.device,
      this._boundsWidth || this.canvas.width,
      this._boundsHeight || this.canvas.height,
    );
  }

  async depthPick(
    x: number,
    y: number,
  ): Promise<[number, number, number] | null> {
    const hit = this.hitTest(x, y);
    if (!hit) return null;
    const tile = this.screenSlices[hit.tileIndex];
    if (!tile) return null;
    const ltwh = tile.leftTopWidthHeight as number[];
    const md = this.model;
    const device = this.device;
    if (!device) return null;
    // Calculate MVP for this tile (same logic as render loop)
    let mvpMatrix: mat4 | Float32Array;
    let normalMatrix: mat4 | Float32Array;
    let rayDir: Float32Array | number[];
    if (hit.isRender && tile.renderOrientation !== undefined && tile.screen) {
      // Mosaic render tile: use same MVP as render loop (origin-centered, tile angles)
      const screen = tile.screen as { mnMM: number[]; mxMM: number[] };
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
      );
      mvpMatrix = result[0] as mat4;
      normalMatrix = result[2] as mat4;
      rayDir = result[3] as Float32Array;
    } else if (hit.isRender) {
      const result = NVTransforms.calculateMvpMatrix(
        ltwh,
        md.scene.azimuth,
        md.scene.elevation,
        md.pivot3D,
        md.furthestFromPivot,
        md.scene.scaleMultiplier,
        md.volumes[0]?.obliqueRAS,
      );
      mvpMatrix = result[0] as mat4;
      normalMatrix = result[2] as mat4;
      rayDir = result[3] as Float32Array;
    } else {
      const screen = tile.screen as { mnMM: number[]; mxMM: number[] };
      if (!screen) return null;
      const pan = NVSliceLayout.slicePanUV(md.scene.pan2Dxyzmm, tile.axCorSag);
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
      );
      mvpMatrix = result[0] as mat4;
      normalMatrix = result[2] as mat4;
      rayDir = result[3] as Float32Array;
    }
    // Build pick-matrix-modified MVP that zooms to 1 pixel
    const tileW = ltwh[2];
    const tileH = ltwh[3];
    const pickMVP = depthPick.buildPickMVP(
      hit.normalizedX,
      hit.normalizedY,
      tileW,
      tileH,
      mvpMatrix as Float32Array,
    );
    // Prepare volume draw params
    const volumes = md.getVolumes();
    const vr = this.volumeRenderer;
    let volumeUniformData: Float32Array | null = null;
    if (vr.hasVolume() && volumes.length > 0 && (volumes[0].opacity ?? 1) > 0) {
      const matRAS = volumes[0].matRAS;
      const volScale = volumes[0].volScale;
      if (matRAS && volScale) {
        volumeUniformData = new Float32Array([
          ...pickMVP,
          ...(normalMatrix as Float32Array),
          ...(matRAS as Float32Array),
          ...volScale,
          1.0,
          ...(rayDir as Float32Array),
          1.0,
          md.volume.illumination,
          Math.min(volumes.length, 2),
          md.scene.isClipPlaneCutaway ? 1.0 : 0.0,
          0.0,
          ...md.scene.clipPlaneColor,
          ...md.clipPlanes,
        ]);
      }
    }
    // Prepare mesh draw params
    const meshList = (md.getMeshes() as NVMesh[]).filter(
      (m) => (m.opacity ?? 1.0) > 0.0,
    );
    const meshDrawParams: depthPick.DepthPickDrawParams["meshes"] = [];
    for (const m of meshList) {
      const mGpu = this._getMeshGpu(m);
      if (!mGpu?.uniformBuffer || !mGpu.vertexBuffer || !mGpu.indexBuffer)
        continue;
      meshDrawParams.push({
        bindGroup: mGpu.bindGroup,
        vertexBuffer: mGpu.vertexBuffer,
        indexBuffer: mGpu.indexBuffer,
        indexCount: mGpu.indexCount,
        uniformBuffer: mGpu.uniformBuffer,
        uniformData: new Float32Array([
          ...pickMVP,
          ...(normalMatrix as Float32Array),
          ...m.clipPlane,
          m.opacity ?? 1.0,
          0.0,
          0.0,
          0.0,
          0.0,
          0.0,
          0.0,
          0.0,
        ]),
        alignedSize: mGpu.alignedMeshSize ?? mesh.alignedMeshSize,
      });
    }
    // Run the depth-pick render + readback
    const result = await depthPick.pick({
      device,
      volumeBindGroup: vr.bindGroup,
      volumeVertexBuffer: vr.vertexBuffer,
      volumeIndexBuffer: vr.indexBuffer,
      volumeIndexCount: vr.cube.indices.length,
      volumeParamsBuffer: vr.paramsBuffer,
      volumeUniformData,
      meshes: meshDrawParams,
    });
    if (result !== null) {
      const mmPos = NVTransforms.unprojectScreen(
        hit.normalizedX,
        hit.normalizedY,
        result.depth,
        mvpMatrix as mat4,
      );
      if (!hit.isRender && !result.isMesh && md.tex2mm) {
        // For 2D slices with volume hits, use ray-plane intersection to
        // find the correct mm position on the (possibly oblique) slice plane.
        const planeHit = NVTransforms.intersectSlicePlane(
          hit.normalizedX,
          hit.normalizedY,
          mvpMatrix as mat4,
          md.tex2mm,
          hit.sliceType,
          md.getSliceTexFrac(NVConstants.sliceTypeDim(hit.sliceType)),
        );
        if (planeHit) return planeHit;
      }
      return [mmPos[0], mmPos[1], mmPos[2]];
    }
    // Miss: for 2D slices, fall back to ray-plane intersection
    if (!hit.isRender && volumes.length > 0 && md.tex2mm) {
      return NVTransforms.intersectSlicePlane(
        hit.normalizedX,
        hit.normalizedY,
        mvpMatrix as mat4,
        md.tex2mm,
        hit.sliceType,
        md.getSliceTexFrac(NVConstants.sliceTypeDim(hit.sliceType)),
      );
    }
    return null;
  }

  destroy(): void {
    // Destroy GPU resources for volumes and remove .gpu structure
    const vols = this.model.getVolumes();
    for (const vol of vols) {
      if (vol.gpu) {
        // Volume .gpu contains lut/lutNegative (CPU arrays, no destroy needed)
        // but we delete the structure to force recreation
        delete vol.gpu;
      }
    }

    // Destroy GPU resources for all meshes (view-owned map)
    this._destroyMeshResources();
    this.crosshairRenderer.destroy();
    if (this.orientCubeGpu) {
      mesh.destroyMesh(this.orientCubeGpu);
      this.orientCubeGpu = null;
    }

    // Destroy MSAA, bounds color, and depth textures
    if (this.msaaTexture) {
      this.msaaTexture.destroy();
      this.msaaTexture = null;
    }
    this._msaaTextureView = null;
    if (this._boundsColorTexture) {
      this._boundsColorTexture.destroy();
      this._boundsColorTexture = null;
    }
    if (this.depthTexture) {
      this.depthTexture.destroy();
      this.depthTexture = null;
    }
    this._depthTextureView = null;

    // Destroy buffers
    if (this.buffers.glyphStorage) {
      this.buffers.glyphStorage.destroy();
    }
    if (this.buffers.lineStorage) {
      this.buffers.lineStorage.destroy();
    }
    this.buffers = {};

    // Destroy render layer modules
    this.lineRenderer.destroy();
    this.polygonRenderer.destroy();
    this.polygon3DRenderer.destroy();
    this.fontRenderer.destroy();
    this.colorbarRenderer.destroy();
    this.thumbnailRenderer.destroy();
    this.sliceRenderer.destroy();
    this.volumeRenderer.destroy();
    if (this.device) {
      depthPick.destroy(this.device);
      wgpu.destroy(this.device);
    }

    // Decrement shared context ref count
    const shared = sharedGPUContexts.get(this.canvas);
    if (shared) {
      shared.views.delete(this);
      shared.refCount--;
      if (shared.refCount <= 0) {
        sharedGPUContexts.delete(this.canvas);
      }
    }

    // Clear references
    this.device = null;
    this.context = null;
    this.sampler = null;
    this.meshBindGroupLayout = null;
    this.meshPipelines = null;
    this.meshXRayPipelines = null;
    this.lineBindGroup = null;
    this.fontBindGroup = null;
  }
}
