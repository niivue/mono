import type { ColorbarInfo } from '@/NVTypes'
import {
  COLORBAR_GAP,
  type ColorbarLayout,
  colorbarGridLayout,
  deriveBorderColor,
} from '@/view/NVColorbar'
import { NVRenderer } from '@/view/NVRenderer'
import colorbarShaderCode from './colorbar.wgsl?raw'
import * as wgpu from './wgpu'

type ColorbarGPU = {
  texture: GPUTexture
  paramsBuffer: GPUBuffer
  bindGroup: GPUBindGroup
}

export class ColorbarRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  sampler: GPUSampler | null
  colorbars: ColorbarGPU[]
  private _colorbarInfos: ColorbarInfo[]
  canvasWidth: number
  canvasHeight: number
  private _fontPx: number
  private _opacity: number
  private _margin: number
  private _heightRatio: number
  private _borderColor: [number, number, number, number]

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.sampler = null
    this.colorbars = []
    this._colorbarInfos = []
    this.canvasWidth = 1
    this.canvasHeight = 1
    this._fontPx = 0
    this._opacity = 1
    this._margin = 20
    this._heightRatio = 1.2
    this._borderColor = [0, 0, 0, 1]
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
  ): Promise<void> {
    if (this.isReady) return

    // Create sampler
    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    })

    // Create bind group layout
    this.bindLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    // Create pipeline
    const colorbarModule = device.createShaderModule({
      code: colorbarShaderCode,
    })
    this.pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindLayout],
      }),
      multisample: { count: msaaCount },
      vertex: { module: colorbarModule, entryPoint: 'vertex_main' },
      fragment: {
        module: colorbarModule,
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
        depthWriteEnabled: false,
        depthCompare: 'always',
        format: 'depth24plus',
      },
      primitive: { topology: 'triangle-strip' },
    })

    this.isReady = true
  }

  resize(device: GPUDevice, width: number, height: number, fontPx = 0): void {
    this.canvasWidth = width
    this.canvasHeight = height
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
      this.canvasWidth,
      this.canvasHeight,
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

  getLayout(): ColorbarLayout {
    return {
      margin: this._margin,
      heightRatio: this._heightRatio,
      gap: COLORBAR_GAP,
      canvasWidth: this.canvasWidth,
      canvasHeight: this.canvasHeight,
      borderColor: [...this._borderColor],
      fontPx: this._fontPx,
    }
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

      const texture = await wgpu.lut2texture(device, colorbars[i].colormapName)
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

  configure(
    device: GPUDevice,
    options: {
      opacity?: number
      margin?: number
      heightRatio?: number
      borderColor?: [number, number, number, number]
    } = {},
  ): void {
    if (options.opacity !== undefined) this._opacity = options.opacity
    if (options.margin !== undefined) this._margin = options.margin
    if (options.heightRatio !== undefined)
      this._heightRatio = options.heightRatio
    if (options.borderColor !== undefined)
      this._borderColor = options.borderColor
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
