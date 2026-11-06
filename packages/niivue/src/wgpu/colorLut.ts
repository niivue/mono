// The slide colour tables (NVSlide.displayColorLut) as WebGPU 3D textures and bind groups.
import type { NVSlideColorLut } from '@/slide/NVSlide'

/** Bindings: 0 3D texture, 1 sampler (a slide colour table, see slide/colorLutShader.ts). */
export function colorLutLayout(device: GPUDevice): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { viewDimension: '3d' },
      },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  })
}

const MAX_COLOR_LUTS = 8

/** One 3D texture and bind group per slide colour table, uploaded on first use. */
export class ColorLutTexturesGPU {
  private readonly _entries = new Map<
    NVSlideColorLut,
    { texture: GPUTexture; group: GPUBindGroup }
  >()

  constructor(
    private readonly device: GPUDevice,
    private readonly layout: GPUBindGroupLayout,
    private readonly sampler: GPUSampler,
  ) {}

  group(lut: NVSlideColorLut): GPUBindGroup {
    const existing = this._entries.get(lut)
    if (existing) {
      // Least recently used goes first: re-insert on every hit.
      this._entries.delete(lut)
      this._entries.set(lut, existing)
      return existing.group
    }
    // A few slides at a time: forget the least recently used table. Its texture
    // is left to garbage collection, not destroyed: a pass still open this
    // frame may have bound it (many managed slides in one frame).
    if (this._entries.size >= MAX_COLOR_LUTS) {
      const oldest = this._entries.keys().next().value as NVSlideColorLut
      this._entries.delete(oldest)
    }
    const n = lut.size
    const texture = this.device.createTexture({
      size: [n, n, n],
      dimension: '3d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture(
      { texture },
      lut.data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: n * 4, rowsPerImage: n },
      [n, n, n],
    )
    const group = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: texture.createView({ dimension: '3d' }) },
        { binding: 1, resource: this.sampler },
      ],
    })
    this._entries.set(lut, { texture, group })
    return group
  }

  clear(): void {
    for (const { texture } of this._entries.values()) texture.destroy()
    this._entries.clear()
  }
}
