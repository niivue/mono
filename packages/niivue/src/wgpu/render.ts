import { log } from "@/logger";
import * as NVTransforms from "@/math/NVTransforms";
import * as NVShapes from "@/mesh/NVShapes";
import { isPaqd } from "@/NVConstants";
import type { NVImage } from "@/NVTypes";
import { NVRenderer } from "@/view/NVRenderer";
import { buildPaqdLut256, paqdResampleRaw, reorientRGBA } from "@/volume/utils";
import { MAX_TILES, UNIFORM_ALIGNMENT } from "./mesh";
import * as orient from "./orient";
import renderFragment from "./render.wgsl?raw";
import { volumeShaderPreamble } from "./volumeShaderLib";
import * as wgpu from "./wgpu";

const renderParamsSize = 416; // bytes for render uniforms (includes clipPlaneColor)
export const alignedRenderSize =
  Math.ceil(renderParamsSize / UNIFORM_ALIGNMENT) * UNIFORM_ALIGNMENT;

export class VolumeRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null;
  bindLayout: GPUBindGroupLayout | null;
  bindGroup: GPUBindGroup | null;
  matcapTexture: GPUTexture | null;
  volumeTexture: GPUTexture | null;
  volumeGradientTexture: GPUTexture | null;
  overlayTexture: GPUTexture | null;
  paqdTexture: GPUTexture | null;
  paqdLutTexture: GPUTexture | null;
  drawingTexture: GPUTexture | null;
  placeholderOverlay: GPUTexture | null;
  placeholderLut2D: GPUTexture | null;
  sampler: GPUSampler | null;
  samplerNearest: GPUSampler | null;
  paramsBuffer: GPUBuffer | null;
  vertexBuffer: GPUBuffer | null;
  indexBuffer: GPUBuffer | null;
  cube: { vertices: number[]; indices: number[] };
  maxTextureDimension3D: number;
  depthFormat: GPUTextureFormat;
  private _device: GPUDevice | null;
  private _bindTexVol: GPUTexture | null = null;
  private _bindTexGrad: GPUTexture | null = null;
  private _bindTexMatcap: GPUTexture | null = null;
  private _bindTexOverlay: GPUTexture | null = null;
  private _bindTexPaqd: GPUTexture | null = null;
  private _bindTexDraw: GPUTexture | null = null;
  private _bindTexLut: GPUTexture | null = null;

  constructor() {
    super();
    this.pipeline = null;
    this.bindLayout = null;
    this.bindGroup = null;
    this.matcapTexture = null;
    this.volumeTexture = null;
    this.volumeGradientTexture = null;
    this.overlayTexture = null;
    this.paqdTexture = null;
    this.paqdLutTexture = null;
    this.drawingTexture = null;
    this.placeholderOverlay = null;
    this.placeholderLut2D = null;
    this.sampler = null;
    this.samplerNearest = null;
    this.paramsBuffer = null;
    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.cube = NVShapes.getCubeMesh();
    this.maxTextureDimension3D = 0;
    this.depthFormat = "depth24plus";
    this._device = null;
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    maxTextureDimension3D: number,
    depthFormat: GPUTextureFormat = "depth24plus",
  ): Promise<void> {
    this._device = device;
    this.depthFormat = depthFormat;
    if (this.isReady) return;

    this.maxTextureDimension3D = maxTextureDimension3D;

    // Create samplers
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    this.samplerNearest = device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
    });

    // Create vertex buffer for cube
    this.vertexBuffer = device.createBuffer({
      size: this.cube.vertices.length * 4,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(this.vertexBuffer.getMappedRange()).set(
      this.cube.vertices,
    );
    this.vertexBuffer.unmap();

    // Create index buffer for cube
    this.indexBuffer = device.createBuffer({
      size: this.cube.indices.length * 2,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint16Array(this.indexBuffer.getMappedRange()).set(this.cube.indices);
    this.indexBuffer.unmap();

    // Create uniform buffer sized for MAX_TILES
    this.paramsBuffer = device.createBuffer({
      size: alignedRenderSize * MAX_TILES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create placeholder 2x2x2 RGBA overlay texture (all zeros - transparent black)
    this.placeholderOverlay = device.createTexture({
      size: [2, 2, 2],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      dimension: "3d",
    });

    // Create placeholder 1x1 2D texture for PAQD LUT (transparent)
    this.placeholderLut2D = device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.matcapTexture = null;

    // Create bind group layout
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: renderParamsSize,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "2d" },
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
          texture: { viewDimension: "3d" },
        },
        {
          binding: 7,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "3d" },
        },
        {
          binding: 8,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "non-filtering" },
        },
        {
          binding: 9,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { viewDimension: "2d" },
        },
      ],
    });

    // Create render pipeline
    const shaderModule = device.createShaderModule({
      code: volumeShaderPreamble + renderFragment,
    });
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: msaaCount },
      vertex: {
        module: shaderModule,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ format: "float32x3", offset: 0, shaderLocation: 0 }],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragment_main",
        targets: [
          {
            format: format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: "less",
        format: this.depthFormat,
      },
      primitive: {
        topology: "triangle-strip",
        stripIndexFormat: "uint16",
        cullMode: "back",
      },
    });

    this.isReady = true;
  }

  async updateVolume(
    device: GPUDevice,
    vol: NVImage,
    matcap: string = "",
  ): Promise<void> {
    if (!this.isReady) return;

    const dimMax = Math.max(
      Math.max(vol.hdr.dims[1], vol.hdr.dims[2]),
      vol.hdr.dims[3],
    );
    if (dimMax > this.maxTextureDimension3D) {
      log.warn(
        `${dimMax} exceeds the maxTextureDimension3D (${this.maxTextureDimension3D}) of this WebGPU adapter`,
      );
    }

    // Destroy old textures
    if (this.volumeTexture) this.volumeTexture.destroy();
    if (this.volumeGradientTexture) this.volumeGradientTexture.destroy();
    if (this.matcapTexture) this.matcapTexture.destroy();
    // Create new textures
    this.matcapTexture = await wgpu.bitmap2textureOrFallback(device, matcap);
    const mtx = NVTransforms.calculateOverlayTransformMatrix(vol, vol);
    this.volumeTexture = await orient.volume2Texture(
      device,
      vol,
      vol,
      mtx as Float32Array,
      0,
    );
    this.volumeGradientTexture = await wgpu.volume2TextureGradientRGBA(
      device,
      this.volumeTexture,
    );
  }

  async updateOverlays(
    device: GPUDevice,
    baseVol: NVImage,
    overlayVols: NVImage[],
    _paqdUniforms: readonly number[],
  ): Promise<void> {
    if (!this.isReady) return;
    this.clearOverlay();
    this.clearPaqd();

    if (!baseVol.dimsRAS) return;
    const dimsOut = [
      baseVol.dimsRAS[1],
      baseVol.dimsRAS[2],
      baseVol.dimsRAS[3],
    ];

    // Filter out overlays with zero opacity
    const visible = overlayVols.filter((v) => (v.opacity ?? 1) > 0);
    if (visible.length === 0) return;

    // Separate PAQD from standard overlays
    const paqdVols = visible.filter((v) => isPaqd(v.hdr) && v.colormapLabel);
    const standardVols = visible.filter((v) => !isPaqd(v.hdr));

    // Upload first PAQD as raw data + LUT texture (GPU shaders do LUT lookup + easing)
    if (paqdVols.length > 0) {
      const vol = paqdVols[0];
      if (
        vol.img &&
        vol.dimsRAS &&
        vol.img2RASstep &&
        vol.img2RASstart &&
        vol.colormapLabel
      ) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol);
        const isRAS =
          vol.img2RASstep[0] === 1 &&
          vol.img2RASstep[1] === vol.dimsRAS[1] &&
          vol.img2RASstep[2] === vol.dimsRAS[1] * vol.dimsRAS[2];
        let raw = new Uint8Array(
            vol.img.buffer,
            vol.img.byteOffset,
            vol.img.byteLength,
          );
        if (!isRAS) {
          raw = reorientRGBA(
            raw,
            4,
            vol.dimsRAS,
            vol.img2RASstart,
            vol.img2RASstep,
          );
        }
        const ovDims = [vol.dimsRAS[1], vol.dimsRAS[2], vol.dimsRAS[3]];
        const paqdData = paqdResampleRaw(
          raw,
          dimsOut,
          ovDims,
          mtx as Float32Array,
        );
        this.paqdTexture = device.createTexture({
          size: dimsOut,
          format: "rgba8unorm",
          dimension: "3d",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: this.paqdTexture },
          paqdData.buffer as ArrayBuffer,
          { bytesPerRow: dimsOut[0] * 4, rowsPerImage: dimsOut[1] },
          dimsOut,
        );
        // Upload 256-entry padded LUT as 2D texture
        const lutMin = vol.colormapLabel.min ?? 0;
        const lut256 = buildPaqdLut256(vol.colormapLabel.lut, lutMin);
        this.paqdLutTexture = device.createTexture({
          size: [256, 1],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
          { texture: this.paqdLutTexture },
          lut256.buffer as ArrayBuffer,
          { bytesPerRow: 256 * 4, rowsPerImage: 1 },
          [256, 1],
        );
      }
    }

    // Upload standard overlays
    if (standardVols.length === 1) {
      const vol = standardVols[0];
      const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol);
      this.overlayTexture = await orient.volume2Texture(
        device,
        vol,
        baseVol,
        mtx as Float32Array,
        vol.opacity ?? 1,
      );
    } else if (standardVols.length > 1) {
      const overlayTextures: GPUTexture[] = [];
      for (const vol of standardVols) {
        const mtx = NVTransforms.calculateOverlayTransformMatrix(baseVol, vol);
        overlayTextures.push(
          await orient.volume2Texture(
            device,
            vol,
            baseVol,
            mtx as Float32Array,
            vol.opacity ?? 1,
          ),
        );
      }
      this.overlayTexture = await orient.blendOverlaysGPU(
        device,
        overlayTextures,
        dimsOut,
      );
      for (const tex of overlayTextures) tex.destroy();
    }
  }

  clearOverlay(): void {
    if (this.overlayTexture) {
      this.overlayTexture.destroy();
      this.overlayTexture = null;
    }
  }

  clearPaqd(): void {
    if (this.paqdTexture) {
      this.paqdTexture.destroy();
      this.paqdTexture = null;
    }
    if (this.paqdLutTexture) {
      this.paqdLutTexture.destroy();
      this.paqdLutTexture = null;
    }
  }

  updateBindGroup(device: GPUDevice): void {
    if (
      !this.isReady ||
      !this.bindLayout ||
      !this.paramsBuffer ||
      !this.sampler ||
      !this.samplerNearest
    )
      return;
    if (
      !this.volumeTexture ||
      !this.matcapTexture ||
      !this.volumeGradientTexture ||
      !this.placeholderOverlay ||
      !this.placeholderLut2D
    )
      return;

    const overlayTex = this.overlayTexture || this.placeholderOverlay;
    const paqdTex = this.paqdTexture || this.placeholderOverlay;
    const drawTex = this.drawingTexture || this.placeholderOverlay;
    const paqdLutTex = this.paqdLutTexture || this.placeholderLut2D;

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
      return;
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
    });
    this._bindTexVol = this.volumeTexture;
    this._bindTexGrad = this.volumeGradientTexture;
    this._bindTexMatcap = this.matcapTexture;
    this._bindTexOverlay = overlayTex;
    this._bindTexPaqd = paqdTex;
    this._bindTexDraw = drawTex;
    this._bindTexLut = paqdLutTex;
  }

  updateDrawingTexture(
    device: GPUDevice,
    rgba: Uint8Array,
    dims: number[],
  ): void {
    if (!this.isReady) return;
    if (!this.drawingTexture) {
      this.drawingTexture = device.createTexture({
        size: dims,
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        dimension: "3d",
      });
    }
    device.queue.writeTexture(
      { texture: this.drawingTexture },
      rgba as Uint8Array<ArrayBuffer>,
      { bytesPerRow: dims[0] * 4, rowsPerImage: dims[1] },
      dims,
    );
  }

  destroyDrawing(): void {
    if (this.drawingTexture) {
      this.drawingTexture.destroy();
      this.drawingTexture = null;
    }
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
  ): void {
    if (
      !this.isReady ||
      !this.pipeline ||
      !this.bindGroup ||
      !this.paramsBuffer ||
      !this.vertexBuffer ||
      !this.indexBuffer
    )
      return;

    const renderOffset = Math.trunc(tileIndex * alignedRenderSize);
    if (!Number.isFinite(renderOffset)) return;

    device.queue.writeBuffer(
      this.paramsBuffer,
      renderOffset,
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
      ]),
    );

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup, [renderOffset]);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, "uint16");
    pass.drawIndexed(this.cube.indices.length);
  }

  async loadMatcap(device: GPUDevice, matcapUrl: string): Promise<void> {
    if (!this.isReady) return;

    try {
      const newTex = await wgpu.bitmap2textureOrFallback(device, matcapUrl);
      if (this.matcapTexture) this.matcapTexture.destroy();
      this.matcapTexture = newTex;
      // Wait for GPU to finish upload
      await device.queue.onSubmittedWorkDone();
    } catch (e) {
      log.warn("Matcap load failed", e);
    }
  }

  hasVolume(): boolean {
    return this.volumeTexture !== null;
  }

  hasOverlay(): boolean {
    return this.overlayTexture !== null;
  }

  destroy(): void {
    // Destroy textures
    if (this.matcapTexture) {
      this.matcapTexture.destroy();
      this.matcapTexture = null;
    }
    if (this.volumeTexture) {
      this.volumeTexture.destroy();
      this.volumeTexture = null;
    }
    if (this.volumeGradientTexture) {
      this.volumeGradientTexture.destroy();
      this.volumeGradientTexture = null;
    }
    if (this.overlayTexture) {
      this.overlayTexture.destroy();
      this.overlayTexture = null;
    }
    if (this.paqdTexture) {
      this.paqdTexture.destroy();
      this.paqdTexture = null;
    }
    if (this.drawingTexture) {
      this.drawingTexture.destroy();
      this.drawingTexture = null;
    }
    if (this.placeholderOverlay) {
      this.placeholderOverlay.destroy();
      this.placeholderOverlay = null;
    }

    // Destroy buffers
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy();
      this.paramsBuffer = null;
    }
    if (this.vertexBuffer) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = null;
    }
    if (this.indexBuffer) {
      this.indexBuffer.destroy();
      this.indexBuffer = null;
    }

    // Clear references
    this.bindGroup = null;
    this.sampler = null;
    this.samplerNearest = null;
    this.pipeline = null;
    this.bindLayout = null;
    this._bindTexVol = null;
    this._bindTexGrad = null;
    this._bindTexMatcap = null;
    this._bindTexOverlay = null;
    this._bindTexPaqd = null;
    this._bindTexDraw = null;
    this._bindTexLut = null;
    this.isReady = false;

    // Destroy per-device cached pipelines
    if (this._device) {
      orient.destroy(this._device);
      this._device = null;
    }
  }
}
