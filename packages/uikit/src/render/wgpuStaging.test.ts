// Staging-buffer packing of the WebGPU instanced (line, rect) and text renderers, checked against a
// fake device that records every writeBuffer and draw (no GPU needed).

import { beforeAll, describe, expect, it } from 'bun:test'
import { FLOATS_PER_LINE, type LineData } from '../line'
import { FLOATS_PER_GLYPH } from '../text/layout'
import { WgpuLineRenderer } from './wgpuInstanced'
import { WgpuTextRenderer } from './wgpuTextRenderer'

type Write = {
  buffer: object
  offset: number
  data: number[]
  src: Float32Array
}
type Call = { op: string; args: unknown[] }

function fakeGpu() {
  const writes: Write[] = []
  const calls: Call[] = []
  const buffers: { size: number; usage: number }[] = []
  let textures = 0
  const device = {
    createBuffer: (d: { size: number; usage: number }) => {
      const b = { ...d, destroy: () => {} }
      buffers.push(b)
      return b
    },
    createBindGroupLayout: () => ({}),
    createBindGroup: () => ({}),
    createShaderModule: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createSampler: () => ({}),
    createTexture: () => {
      textures++
      return { destroy: () => {}, createView: () => ({}) }
    },
    queue: {
      writeBuffer: (
        buffer: object,
        offset: number,
        data: Float32Array,
        dataOffset = 0,
        size = data.length - dataOffset,
      ) => {
        writes.push({
          buffer,
          offset,
          data: [...data.subarray(dataOffset, dataOffset + size)],
          src: data,
        })
      },
      copyExternalImageToTexture: () => {},
    },
  }
  const pass = {
    setPipeline: () => {},
    setBindGroup: (...args: unknown[]) => calls.push({ op: 'bind', args }),
    setVertexBuffer: (...args: unknown[]) => calls.push({ op: 'vb', args }),
    draw: (...args: unknown[]) => calls.push({ op: 'draw', args }),
  }
  return {
    device: device as unknown as GPUDevice,
    pass: pass as unknown as GPURenderPassEncoder,
    writes,
    calls,
    buffers,
    textures: () => textures,
    reset() {
      writes.length = 0
      calls.length = 0
    },
  }
}

beforeAll(() => {
  // WebGPU flag namespaces are absent outside a browser; values are irrelevant.
  const g = globalThis as Record<string, unknown>
  g.GPUBufferUsage ??= { UNIFORM: 1, VERTEX: 2, STORAGE: 4, COPY_DST: 8 }
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 }
  g.GPUTextureUsage ??= {
    TEXTURE_BINDING: 1,
    COPY_DST: 2,
    RENDER_ATTACHMENT: 4,
  }
})

const line = (v: number): LineData => ({
  data: new Float32Array(FLOATS_PER_LINE).fill(v),
})

describe('WgpuLineRenderer staging', () => {
  const draw = (
    r: WgpuLineRenderer,
    gpu: ReturnType<typeof fakeGpu>,
    lines: LineData[],
  ) => r.draw(gpu.device, gpu.pass, 'bgra8unorm', 1, undefined, lines, 640, 480)

  it('uploads exactly the active range across grow, shrink and holes', () => {
    const gpu = fakeGpu()
    const r = new WgpuLineRenderer()
    draw(r, gpu, [line(1), line(2), line(3)])
    const storage = gpu.writes[1]
    const staging = storage.src
    expect(gpu.writes[0].data.slice(0, 2)).toEqual([640, 480])
    expect(storage.data).toHaveLength(3 * FLOATS_PER_LINE)
    expect(gpu.calls.at(-1)?.args).toEqual([4, 3])

    gpu.reset()
    draw(r, gpu, [line(7)])
    expect(gpu.writes[1].data).toEqual(Array(FLOATS_PER_LINE).fill(7))
    expect(gpu.writes[1].src).toBe(staging)
    expect(gpu.calls.at(-1)?.args).toEqual([4, 1])

    // A hole after a larger frame is zeroed, not left holding the old line.
    gpu.reset()
    const holed = [line(5), line(6)]
    delete holed[1]
    draw(r, gpu, holed)
    expect(gpu.writes[1].data.slice(FLOATS_PER_LINE)).toEqual(
      Array(FLOATS_PER_LINE).fill(0),
    )

    gpu.reset()
    draw(r, gpu, [])
    expect(gpu.writes).toHaveLength(0)
    expect(gpu.calls).toHaveLength(0)
  })

  it('zeroes the tail of a short record instead of keeping the prior frame', () => {
    const gpu = fakeGpu()
    const r = new WgpuLineRenderer()
    draw(r, gpu, [line(1)])
    gpu.reset()
    // An 11-float record (3-value color, no alpha) must leave the last float 0.
    draw(r, gpu, [{ data: new Float32Array(FLOATS_PER_LINE - 1).fill(2) }])
    expect(gpu.writes[1].data).toEqual([
      ...Array(FLOATS_PER_LINE - 1).fill(2),
      0,
    ])
  })

  it('grows past the initial storage capacity', () => {
    const gpu = fakeGpu()
    const r = new WgpuLineRenderer()
    const many = Array.from({ length: 100 }, (_, i) => line(i))
    draw(r, gpu, many)
    expect(gpu.writes[1].data).toHaveLength(100 * FLOATS_PER_LINE)
    expect(gpu.writes[1].data.at(-1)).toBe(99)
    expect(gpu.buffers.at(-1)?.size).toBeGreaterThanOrEqual(
      100 * FLOATS_PER_LINE * 4,
    )
  })
})

describe('WgpuTextRenderer staging', () => {
  const atlas = { width: 4, height: 4 } as ImageBitmap
  const draw = (
    r: WgpuTextRenderer,
    gpu: ReturnType<typeof fakeGpu>,
    glyphs: Float32Array,
    count: number,
    image = atlas,
  ) =>
    r.draw(
      gpu.device,
      gpu.pass,
      'bgra8unorm',
      1,
      undefined,
      image,
      glyphs,
      count,
      640,
      480,
    )

  // The buffer grows and is reused: a later, smaller draw must upload only its
  // own records, not stale ones past them.
  it('uploads only the drawn records, in one instanced draw', () => {
    const gpu = fakeGpu()
    const r = new WgpuTextRenderer()
    draw(r, gpu, new Float32Array(300 * FLOATS_PER_GLYPH).fill(1), 300)
    gpu.reset()
    draw(r, gpu, new Float32Array(300 * FLOATS_PER_GLYPH).fill(2), 2)
    const glyphWrite = gpu.writes.find((w) => w.data.length > 4)
    expect(glyphWrite?.data).toHaveLength(2 * FLOATS_PER_GLYPH)
    expect(gpu.calls.filter((c) => c.op === 'draw').map((c) => c.args)).toEqual(
      [[4, 2]],
    )
  })

  it('re-uploads the atlas only when its source changes', () => {
    const gpu = fakeGpu()
    const r = new WgpuTextRenderer()
    const one = new Float32Array(FLOATS_PER_GLYPH)
    draw(r, gpu, one, 1)
    draw(r, gpu, one, 1)
    expect(gpu.textures()).toBe(1)
    draw(r, gpu, one, 1, { width: 8, height: 8 } as ImageBitmap)
    expect(gpu.textures()).toBe(2)
  })
})
