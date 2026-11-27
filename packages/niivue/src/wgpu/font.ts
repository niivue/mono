import { WgpuTextRenderer } from '@niivue/uikit'
import { log } from '@/logger'
import { loadImageElement } from '@/NVLoader'
import type { NVFontData } from '@/NVTypes'
import { FLOATS_PER_PANEL, type GlyphBatch, packPanels } from '@/view/NVFont'
import { NVFontRenderer } from '@/view/NVFontRenderer'
import panelShaderCode from './panel.wgsl?raw'
import {
  alphaPipelineDesc,
  overlayDepth,
  uniformBuffer,
  uniformStorageEntries,
} from './pipeline'

export class FontRenderer extends NVFontRenderer {
  // Glyphs draw through uikit's text renderer; the panels stay here.
  private readonly _glyphs = new WgpuTextRenderer()
  private _atlas: ImageBitmap | null = null
  private _scratch = new Float32Array(0)
  private _format: GPUTextureFormat = 'bgra8unorm'
  private _msaaCount = 1
  private _depthFormat: GPUTextureFormat | undefined
  private _width = 1
  private _height = 1
  paramsBuffer: GPUBuffer | null
  panelPipeline: GPURenderPipeline | null
  panelBindLayout: GPUBindGroupLayout | null
  panelBuffer: GPUBuffer | null
  panelBindGroup: GPUBindGroup | null
  maxPanels: number

  constructor() {
    super()
    this.paramsBuffer = null
    this.panelPipeline = null
    this.panelBindLayout = null
    this.panelBuffer = null
    this.panelBindGroup = null
    this.maxPanels = 0
  }

  /** `depthFormat` null: for a pass with no depth attachment (the slide pane). */
  async init(
    device: GPUDevice,
    format: GPUTextureFormat,
    msaaCount: number,
    fontData?: NVFontData,
    depthFormat: GPUTextureFormat | null = 'depth24plus',
  ): Promise<void> {
    if (this.isReady) return
    if (!fontData) return
    try {
      this.fontMets = fontData.metrics
      this._atlas = await createImageBitmap(
        await loadImageElement(fontData.atlasUrl),
      )
      this._format = format
      this._msaaCount = msaaCount
      this._depthFormat = depthFormat ?? undefined
      const depthStencil = depthFormat ? overlayDepth(depthFormat) : undefined
      // Space for uniforms (canvasSize)
      this.paramsBuffer = uniformBuffer(device, 32)
      // Panel pipeline for label backing rects
      this.panelBindLayout = device.createBindGroupLayout({
        entries: uniformStorageEntries(
          GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        ),
      })
      this.panelPipeline = device.createRenderPipeline(
        alphaPipelineDesc(device, {
          module: device.createShaderModule({ code: panelShaderCode }),
          bindGroupLayouts: [this.panelBindLayout],
          format,
          msaaCount,
          depthStencil,
        }),
      )
      this._growPanelBuffer(device, 128)
      this.isReady = true
    } catch (err) {
      log.error('Failed to initialize font system:', err)
      this.isReady = false
    }
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
    this._width = width
    this._height = height
    this.resizeFont(width, height, dpi, fontSizeScaling, fontMinPx)
  }

  draw(
    device: GPUDevice,
    pass: GPURenderPassEncoder,
    textList: GlyphBatch[],
  ): void {
    if (!this.isReady || textList.length === 0) return
    // Panel pass: draw backing rectangles first
    if (this.panelPipeline && this.panelBuffer) {
      const panelData = packPanels(textList)
      if (panelData) {
        const panelCount = panelData.length / FLOATS_PER_PANEL
        this._growPanelBuffer(device, panelCount)
        device.queue.writeBuffer(this.panelBuffer, 0, panelData)
        pass.setPipeline(this.panelPipeline)
        pass.setBindGroup(0, this.panelBindGroup as GPUBindGroup)
        pass.draw(4, panelCount)
      }
    }
    // Glyph pass: every label's records in one instanced draw.
    let total = 0
    for (const item of textList) total += item.count
    if (total === 0 || !this._atlas) return
    if (this._scratch.length < total * 16)
      this._scratch = new Float32Array(total * 16)
    let at = 0
    for (const item of textList) {
      this._scratch.set(item.data, at)
      at += item.count * 16
    }
    this._glyphs.draw(
      device,
      pass,
      this._format,
      this._msaaCount,
      this._depthFormat,
      this._atlas,
      this._scratch,
      total,
      this._width,
      this._height,
    )
  }

  destroy(): void {
    this._glyphs.destroy()
    this._atlas?.close()
    this._atlas = null
    if (this.paramsBuffer) {
      this.paramsBuffer.destroy()
      this.paramsBuffer = null
    }
    if (this.panelBuffer) {
      this.panelBuffer.destroy()
      this.panelBuffer = null
    }
    this.panelPipeline = null
    this.panelBindLayout = null
    this.panelBindGroup = null
    this.fontMets = null
    this.isReady = false
  }
}
