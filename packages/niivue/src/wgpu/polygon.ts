import type { AnnotationRenderData } from "@/view/NVAnnotation";
import { NVRenderer } from "@/view/NVRenderer";
import shaderCode from "./polygon.wgsl?raw";

export class PolygonRenderer extends NVRenderer {
  private _pipeline: GPURenderPipeline | null = null;
  private _uniformBuffer: GPUBuffer | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _bindGroup: GPUBindGroup | null = null;
  private _vertexBuffer: GPUBuffer | null = null;
  private _indexBuffer: GPUBuffer | null = null;
  private _maxVertices = 0;
  private _maxIndices = 0;

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return;

    this._uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    this._bindGroup = device.createBindGroup({
      layout: this._bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this._uniformBuffer } }],
    });

    const module = device.createShaderModule({ code: shaderCode });

    this._pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this._bindGroupLayout],
      }),
      multisample: { count: msaaCount },
      vertex: {
        module,
        entryPoint: "vertex_main",
        buffers: [
          {
            arrayStride: 24, // 6 floats: x, y, r, g, b, a
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x2" }, // position
              { shaderLocation: 1, offset: 8, format: "float32x4" }, // color
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fragment_main",
        targets: [
          {
            format,
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
        depthWriteEnabled: false,
        depthCompare: "always",
        format: "depth24plus",
      },
      primitive: { topology: "triangle-list" },
    });

    this.isReady = true;
  }

  resize(device: GPUDevice, width: number, height: number): void {
    if (!this.isReady || !this._uniformBuffer) return;
    device.queue.writeBuffer(
      this._uniformBuffer,
      0,
      new Float32Array([width, height, 0, 0]),
    );
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    data: AnnotationRenderData,
  ): void {
    if (!this.isReady || !this._pipeline || !this._bindGroup) return;
    if (data.fillVertices.length === 0 || data.fillIndices.length === 0) return;

    const vertexBytes = data.fillVertices.byteLength;
    const indexBytes = data.fillIndices.byteLength;

    // Grow buffers on demand
    if (!this._vertexBuffer || vertexBytes > this._maxVertices * 24) {
      if (this._vertexBuffer) this._vertexBuffer.destroy();
      this._maxVertices = Math.max(data.fillVertices.length / 6, 256);
      this._vertexBuffer = device.createBuffer({
        size: this._maxVertices * 24,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    if (!this._indexBuffer || indexBytes > this._maxIndices * 4) {
      if (this._indexBuffer) this._indexBuffer.destroy();
      this._maxIndices = Math.max(data.fillIndices.length, 512);
      this._indexBuffer = device.createBuffer({
        size: this._maxIndices * 4,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
    }

    device.queue.writeBuffer(
      this._vertexBuffer,
      0,
      data.fillVertices as Float32Array<ArrayBuffer>,
    );
    device.queue.writeBuffer(
      this._indexBuffer,
      0,
      data.fillIndices as Uint32Array<ArrayBuffer>,
    );

    pass.setPipeline(this._pipeline);
    pass.setBindGroup(0, this._bindGroup);
    pass.setVertexBuffer(0, this._vertexBuffer);
    pass.setIndexBuffer(this._indexBuffer, "uint32");
    pass.drawIndexed(data.fillIndices.length);
  }

  destroy(): void {
    if (this._vertexBuffer) {
      this._vertexBuffer.destroy();
      this._vertexBuffer = null;
    }
    if (this._indexBuffer) {
      this._indexBuffer.destroy();
      this._indexBuffer = null;
    }
    if (this._uniformBuffer) {
      this._uniformBuffer.destroy();
      this._uniformBuffer = null;
    }
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._bindGroup = null;
    this.isReady = false;
  }
}
