import type { ColorbarInfo } from '@/NVTypes'
import { colorbarGridLayout, deriveBorderColor } from '@/view/NVColorbar'
import {
  type ColorbarOptions,
  NVColorbarRenderer,
} from '@/view/NVColorbarRenderer'
import colorbarShaderCode from './colorbar.wgsl?raw'
import {
  alphaPipelineDesc,
  linearSampler,
  overlayDepth,
  texturedLayout,
} from './pipeline'
import * as wgpu from './wgpu'

type ColorbarGPU = {
  texture: GPUTexture
  paramsBuffer: GPUBuffer
  bindGroup: GPUBindGroup
}

export class ColorbarRenderer extends NVColorbarRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  sampler: GPUSampler | null
  colorbars: ColorbarGPU[]
  private _colorbarInfos: ColorbarInfo[]

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.sampler = null
    this.colorbars = []
    this._colorbarInfos = []
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return

    this.sampler = linearSampler(device)
    this.bindLayout = texturedLayout(
      device,
      GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
    )
    this.pipeline = device.createRenderPipeline(
      alphaPipelineDesc(device, {
        module: device.createShaderModule({ code: colorbarShaderCode }),
        bindGroupLayouts: [this.bindLayout],
        format,
        msaaCount,
        depthStencil: overlayDepth(),
      }),
    )

    this.isReady = true
  }

  /**
   * The part of the canvas the colorbars lay out in ([x, y, width, height]
   * device px, from `layout.inset`); the whole canvas when null.
   */
  setContentRect(device: GPUDevice, rect: number[] | null): void {
    const old = this._content
    if (old === rect || (old && rect && old.every((v, i) => v === rect[i])))
      return
    this._content = rect
    this._writeAllParams(device)
  }

  resize(device: GPUDevice, width: number, height: number, fontPx = 0): void {
    this._canvasWidth = width
    this._canvasHeight = height
    this._fontPx = fontPx
    this._writeAllParams(device)
  }

  private _buildParamsData(rect: {
    x: number
    y: number
    w: number
    h: number
  }): Float32Array {
    return new Float32Array([
      this._canvasWidth,
      this._canvasHeight,
      this._opacity,
      rect.h * 0.5,
      rect.x, // rect.x
      rect.y, // rect.y
      rect.w, // rect.width
      rect.h, // rect.height
      this._borderColor[0],
      this._borderColor[1],
      this._borderColor[2],
      this._borderColor[3],
      Math.ceil(rect.h / 15),
      0,
      0,
      0, // padding
      0,
      0,
      0,
      0, // pad to 5 vec4s (80 bytes)
    ])
  }

  private _writeAllParams(device: GPUDevice): void {
    const { rects } = colorbarGridLayout(this._colorbarInfos, this.getLayout())
    for (let i = 0; i < this.colorbars.length; i++) {
      device.queue.writeBuffer(
        this.colorbars[i].paramsBuffer,
        0,
        this._buildParamsData(rects[i]) as Float32Array<ArrayBuffer>,
      )
    }
  }

  async buildColorbars(
    device: GPUDevice,
    colorbars: ColorbarInfo[],
    backColor?: [number, number, number, number],
  ): Promise<void> {
    if (!this.isReady || !this.bindLayout || !this.sampler) return

    if (backColor) {
      this._borderColor = deriveBorderColor(backColor)
    }

    // Destroy old entries
    for (const bar of this.colorbars) {
      bar.texture.destroy()
      bar.paramsBuffer.destroy()
    }
    this.colorbars = []
    this._colorbarInfos = colorbars

    // Build new entries
    const { rects } = colorbarGridLayout(colorbars, this.getLayout())
    for (let i = 0; i < colorbars.length; i++) {
      const paramsBuffer = device.createBuffer({
        size: 80,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(
        paramsBuffer,
        0,
        this._buildParamsData(rects[i]) as Float32Array<ArrayBuffer>,
      )

      const texture = await wgpu.lut2texture(
        device,
        colorbars[i].colormapName,
        colorbars[i].isInverted,
      )
      const bindGroup = device.createBindGroup({
        layout: this.bindLayout,
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })
      this.colorbars.push({ texture, paramsBuffer, bindGroup })
    }
  }

  getColorbarInfos(): ColorbarInfo[] {
    return this._colorbarInfos
  }

  configure(device: GPUDevice, options: ColorbarOptions = {}): void {
    this.applyOptions(options)
    this._writeAllParams(device)
  }

  draw(_device: GPUDevice, pass: GPURenderPassEncoder): void {
    if (!this.isReady || !this.pipeline || this.colorbars.length === 0) return
    pass.setPipeline(this.pipeline)
    for (const bar of this.colorbars) {
      pass.setBindGroup(0, bar.bindGroup)
      pass.draw(4)
    }
  }

  hasColorbar(): boolean {
    return this.colorbars.length > 0
  }

  destroy(): void {
    for (const bar of this.colorbars) {
      bar.texture.destroy()
      bar.paramsBuffer.destroy()
    }
    this.colorbars = []
    this.sampler = null
    this.pipeline = null
    this.bindLayout = null
    this.isReady = false
  }
}
