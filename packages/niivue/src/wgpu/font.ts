import { log } from '@/logger'
import type { NVFontData } from '@/NVTypes'
import {
  buildTextLayout,
  calculateFontSizePx,
  emptyBatch,
  FLOATS_PER_PANEL,
  type FontMetrics,
  type GlyphBatch,
} from '@/view/NVFont'
import { NVRenderer } from '@/view/NVRenderer'
import fontShaderCode from './font.wgsl?raw'
import panelShaderCode from './panel.wgsl?raw'
import * as wgpu from './wgpu'

export class FontRenderer extends NVRenderer {
  pipeline: GPURenderPipeline | null
  bindLayout: GPUBindGroupLayout | null
  fontTexture: GPUTexture | null
  fontMets: FontMetrics | null
  paramsBuffer: GPUBuffer | null
  panelPipeline: GPURenderPipeline | null
  panelBindLayout: GPUBindGroupLayout | null
  panelBuffer: GPUBuffer | null
  panelBindGroup: GPUBindGroup | null
  maxPanels: number
  fontPx: number

  constructor() {
    super()
    this.pipeline = null
    this.bindLayout = null
    this.fontTexture = null
    this.fontMets = null
    this.paramsBuffer = null
    this.panelPipeline = null
    this.panelBindLayout = null
    this.panelBuffer = null
    this.panelBindGroup = null
    this.maxPanels = 0
    this.fontPx = 16
  }

  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    fontData?: NVFontData,
  ): Promise<void> {
    if (this.isReady) return
    if (!fontData) return
    try {
      // 1. Load Assets — use pre-parsed metrics and atlas URL from fontData
      this.fontMets = fontData.metrics
      this.fontTexture = await wgpu.bitmap2texture(device, fontData.atlasUrl)
      // 2. Define Bind Group Layout
      this.bindLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'read-only-storage' },
          },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        ],
      })
      // 3. Create Render Pipeline
      const fontModule = device.createShaderModule({ code: fontShaderCode })
      const blendState: GPUBlendState = {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      }
      const depthStencil: GPUDepthStencilState = {
        depthWriteEnabled: false,
        depthCompare: 'always',
        format: 'depth24plus',
      }
      this.pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this.bindLayout],
        }),
        multisample: { count: msaaCount },
        vertex: { module: fontModule, entryPoint: 'vertex_main' },
        fragment: {
          module: fontModule,
          entryPoint: 'fragment_main',
          targets: [{ format, blend: blendState }],
        },
        depthStencil,
        primitive: { topology: 'triangle-strip' },
      })
      // Space for uniforms (canvasSize)
      this.paramsBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      // 4. Panel pipeline for label backing rects
      this.panelBindLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.VERTEX,
            buffer: { type: 'read-only-storage' },
          },
        ],
      })
      const panelModule = device.createShaderModule({ code: panelShaderCode })
      this.panelPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
          bindGroupLayouts: [this.panelBindLayout],
        }),
        multisample: { count: msaaCount },
        vertex: { module: panelModule, entryPoint: 'vertex_main' },
        fragment: {
          module: panelModule,
          entryPoint: 'fragment_main',
          targets: [{ format, blend: blendState }],
        },
        depthStencil,
        primitive: { topology: 'triangle-strip' },
      })
      this._growPanelBuffer(device, 128)
      this.isReady = true
    } catch (err) {
      log.error('Failed to initialize font system:', err)
      this.isReady = false
    }
  }

  createBindGroup(
    device: GPUDevice,
    glyphStorageBuffer: GPUBuffer,
    sampler: GPUSampler,
  ): GPUBindGroup | null {
    if (
      !this.isReady ||
      !this.bindLayout ||
      !this.paramsBuffer ||
      !this.fontTexture
    )
      return null
    return device.createBindGroup({
      layout: this.bindLayout,
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: glyphStorageBuffer } },
        { binding: 2, resource: this.fontTexture.createView() },
        { binding: 3, resource: sampler },
      ],
    })
  }

  _growPanelBuffer(device: GPUDevice, needed: number): void {
    if (needed <= this.maxPanels) return
    this.maxPanels = needed
    if (this.panelBuffer) this.panelBuffer.destroy()
    this.panelBuffer = device.createBuffer({
      size: this.maxPanels * FLOATS_PER_PANEL * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    if (this.panelBindLayout && this.paramsBuffer) {
      this.panelBindGroup = device.createBindGroup({
        layout: this.panelBindLayout,
        entries: [
          { binding: 0, resource: { buffer: this.paramsBuffer } },
          { binding: 1, resource: { buffer: this.panelBuffer } },
        ],
      })
    }
  }

  resize(
    device: GPUDevice,
    width: number,
    height: number,
    dpi: number = 1,
    fontSizeScaling: number = 0.4,
    fontMinPx: number = 13,
  ): void {
    if (!this.isReady || !this.paramsBuffer) return
    device.queue.writeBuffer(
      this.paramsBuffer,
      0,
      new Float32Array([width, height]),
    )
    this.fontPx = calculateFontSizePx(
      width,
      height,
      dpi,
      fontSizeScaling,
      fontMinPx,
    )
  }

  buildText(
    str: string,
    x: number,
    y: number,
    scale: number,
    color: number[] = [1, 1, 1, 1],
    anchorX: number = 0,
    anchorY: number = 0,
    backColor: number[] = [0, 0, 0, 0],
  ): GlyphBatch {
    if (!this.isReady || !this.fontMets) return emptyBatch()
    return buildTextLayout(
      str,
      x,
      y,
      this.fontPx,
      scale,
      this.fontMets,
      color,
      anchorX,
      anchorY,
      backColor,
    )
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    bindGroup: GPUBindGroup | null,
    glyphStorageBuffer: GPUBuffer,
    textList: GlyphBatch[],
    maxGlyphs: number,
  ): void {
    if (!this.isReady || textList.length === 0) return
    // Panel pass: draw backing rectangles first
    if (this.panelPipeline && this.panelBuffer) {
      // Count panels needed
      let panelCount = 0
      for (const item of textList) {
        if (item.backColor && item.backColor[3] > 0) panelCount++
      }
      if (panelCount > 0) {
        this._growPanelBuffer(device, panelCount)
        const panelData = new Float32Array(panelCount * FLOATS_PER_PANEL)
        let idx = 0
        for (const item of textList) {
          if (!item.backColor || item.backColor[3] <= 0) continue
          const off = idx * FLOATS_PER_PANEL
          panelData.set(item.backRect, off)
          panelData.set(item.backColor, off + 4)
          panelData[off + 8] = item.backRadius
          idx++
        }
        device.queue.writeBuffer(this.panelBuffer, 0, panelData)
        pass.setPipeline(this.panelPipeline)
        pass.setBindGroup(0, this.panelBindGroup as GPUBindGroup)
        pass.draw(4, panelCount)
      }
    }
    // Glyph pass
    if (!bindGroup || !this.pipeline) return
    // Count total glyphs needed
    let totalChars = 0
    for (const item of textList) totalChars += item.count
    if (totalChars > maxGlyphs) totalChars = maxGlyphs
    const combinedData = new Float32Array(totalChars * 16)
    totalChars = 0
    for (const item of textList) {
      if (totalChars + item.count > maxGlyphs) break
      combinedData.set(item.data, totalChars * 16)
      totalChars += item.count
    }
    device.queue.writeBuffer(glyphStorageBuffer, 0, combinedData)
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(4, totalChars)
  }

  destroy(): void {
    if (this.fontTexture) {
      this.fontTexture.destroy()
      this.fontTexture = null
    }
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    if (this.panelBuffer) {
      this.panelBuffer.destroy()
      this.panelBuffer = null
    }
    this.pipeline = null
    this.bindLayout = null
    this.panelPipeline = null
    this.panelBindLayout = null
    this.panelBindGroup = null
    this.fontMets = null
    this.isReady = false
  }
}
