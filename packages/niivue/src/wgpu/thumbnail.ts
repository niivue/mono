import { NVRenderer } from '@/view/NVRenderer'
import {
  alphaPipelineDesc,
  linearSampler,
  overlayDepth,
  texturedLayout,
  uniformBuffer,
} from './pipeline'
import * as wgpu from './wgpu'

const shaderCode = /* wgsl */ `
struct ThumbnailUniforms {
    canvasSize: vec2f,
    texSize: vec2f,
};

@group(0) @binding(0) var<uniform> u: ThumbnailUniforms;
@group(0) @binding(1) var thumbTex: texture_2d<f32>;
@group(0) @binding(2) var thumbSampler: sampler;

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vertex_main(@builtin(vertex_index) vIdx: u32) -> VertexOutput {
    var pos = vec2f(0.0);
    if (vIdx == 1u) { pos.x = 1.0; }
    else if (vIdx == 2u) { pos.y = 1.0; }
    else if (vIdx == 3u) { pos.x = 1.0; pos.y = 1.0; }

    // Aspect-ratio-correct "contain" fit
    let canvasAspect = u.canvasSize.x / u.canvasSize.y;
    let texAspect = u.texSize.x / u.texSize.y;
    var scale = vec2f(1.0);
    if (texAspect > canvasAspect) {
        // Image wider than canvas — letterbox top/bottom
        scale.y = canvasAspect / texAspect;
    } else {
        // Image taller than canvas — pillarbox left/right
        scale.x = texAspect / canvasAspect;
    }
    let offset = (vec2f(1.0) - scale) * 0.5;
    let ndc = (offset + pos * scale) * 2.0 - 1.0;

    var out: VertexOutput;
    out.position = vec4f(ndc.x, -ndc.y, 0.0, 1.0);
    out.uv = pos;
    return out;
}

@fragment
fn fragment_main(in: VertexOutput) -> @location(0) vec4f {
    return textureSample(thumbTex, thumbSampler, in.uv);
}
`

export class ThumbnailRenderer extends NVRenderer {
  private _pipeline: GPURenderPipeline | null = null
  private _bindLayout: GPUBindGroupLayout | null = null
  private _sampler: GPUSampler | null = null
  private _texture: GPUTexture | null = null
  private _paramsBuffer: GPUBuffer | null = null
  private _bindGroup: GPUBindGroup | null = null
  private _texWidth = 0
  private _texHeight = 0

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return

    this._sampler = linearSampler(device)
    this._bindLayout = texturedLayout(device, GPUShaderStage.VERTEX)
    this._pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: shaderCode }),
        bindGroupLayouts: [this._bindLayout],
        format,
        msaaCount,
        depthStencil: overlayDepth(),
      }),
    )
    // 4 floats: canvasW, canvasH, texW, texH
    this._paramsBuffer = uniformBuffer(device, 16)

    this.isReady = true
  }

  async loadThumbnail(device: GPUDevice, url: string): Promise<void> {
    if (
      !this.isReady ||
      !this._bindLayout ||
      !this._sampler ||
      !this._paramsBuffer
    )
      return
    // Destroy old texture
    if (this._texture) {
      this._texture.destroy()
      this._texture = null
    }
    this._texture = await wgpu.bitmap2texture(device, url)
    this._texWidth = this._texture.width
    this._texHeight = this._texture.height
    this._bindGroup = device.createBindGroup({
      layout: this._bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this._paramsBuffer } },
        { binding: 1, resource: this._texture.createView() },
        { binding: 2, resource: this._sampler },
      ],
    })
  }

  resize(device: GPUDevice, canvasWidth: number, canvasHeight: number): void {
    if (!this._paramsBuffer) return
    device.queue.writeBuffer(
      this._paramsBuffer,
      0,
      new Float32Array([
        canvasWidth,
        canvasHeight,
        this._texWidth,
        this._texHeight,
      ]) as Float32Array<ArrayBuffer>,
    )
  }

  draw(_device: GPUDevice, pass: GPURenderPassEncoder): void {
    if (!this._pipeline || !this._bindGroup) return
    pass.setPipeline(this._pipeline)
    pass.setBindGroup(0, this._bindGroup)
    pass.draw(4)
  }

  hasTexture(): boolean {
    return this._texture !== null
  }

  destroy(): void {
    if (this._texture) {
      this._texture.destroy()
      this._texture = null
    }
    if (this._paramsBuffer) {
      this._paramsBuffer.destroy()
      this._paramsBuffer = null
    }
    this._bindGroup = null
    this._sampler = null
    this._pipeline = null
    this._bindLayout = null
    this.isReady = false
  }
}
