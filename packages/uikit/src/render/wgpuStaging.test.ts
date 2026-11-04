// Staging-buffer packing of the WebGPU line/text renderers, checked against a
// fake device that records every writeBuffer and draw (no GPU needed).

import { beforeAll, describe, expect, it } from 'bun:test'
import { FLOATS_PER_LINE, type LineData } from '../line'
import { FLOATS_PER_RECT, type RectData } from '../rect'
import { FLOATS_PER_VERTEX } from '../text/layout'
import { WgpuLineRenderer } from './wgpuLineRenderer'
import { WgpuRectRenderer } from './wgpuRectRenderer'
import { type TextRun, WgpuTextRenderer } from './wgpuTextRenderer'

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

const rect = (v: number): RectData => ({
  data: new Float32Array(FLOATS_PER_RECT).fill(v),
})

describe('WgpuRectRenderer staging', () => {
  const draw = (
    r: WgpuRectRenderer,
    gpu: ReturnType<typeof fakeGpu>,
    rects: RectData[],
  ) => r.draw(gpu.device, gpu.pass, 'bgra8unorm', 1, undefined, rects, 640, 480)

  it('uploads exactly the active range across grow, shrink and holes', () => {
    const gpu = fakeGpu()
    const r = new WgpuRectRenderer()
    draw(r, gpu, [rect(1), rect(2), rect(3)])
    const staging = gpu.writes[1].src
    expect(gpu.writes[0].data.slice(0, 2)).toEqual([640, 480])
    expect(gpu.writes[1].data).toHaveLength(3 * FLOATS_PER_RECT)
    expect(gpu.calls.at(-1)?.args).toEqual([4, 3])

    gpu.reset()
    draw(r, gpu, [rect(7)])
    expect(gpu.writes[1].data).toEqual(Array(FLOATS_PER_RECT).fill(7))
    expect(gpu.writes[1].src).toBe(staging)
    expect(gpu.calls.at(-1)?.args).toEqual([4, 1])

    // A hole after a larger frame is zeroed, not left holding the old rect.
    gpu.reset()
    const holed = [rect(5), rect(6)]
    delete holed[1]
    draw(r, gpu, holed)
    expect(gpu.writes[1].data.slice(FLOATS_PER_RECT)).toEqual(
      Array(FLOATS_PER_RECT).fill(0),
    )

    gpu.reset()
    draw(r, gpu, [])
    expect(gpu.writes).toHaveLength(0)
    expect(gpu.calls).toHaveLength(0)
  })

  it('grows past the initial storage capacity', () => {
    const gpu = fakeGpu()
    const r = new WgpuRectRenderer()
    draw(
      r,
      gpu,
      Array.from({ length: 100 }, (_, i) => rect(i)),
    )
    expect(gpu.writes[1].data).toHaveLength(100 * FLOATS_PER_RECT)
    expect(gpu.writes[1].data.at(-1)).toBe(99)
    expect(gpu.buffers.at(-1)?.size).toBeGreaterThanOrEqual(
      100 * FLOATS_PER_RECT * 4,
    )
  })

  it('zeroes the tail of a short record instead of keeping the prior frame', () => {
    const gpu = fakeGpu()
    const r = new WgpuRectRenderer()
    draw(r, gpu, [rect(1)])
    gpu.reset()
    draw(r, gpu, [{ data: new Float32Array(FLOATS_PER_RECT - 1).fill(2) }])
    expect(gpu.writes[1].data).toEqual([
      ...Array(FLOATS_PER_RECT - 1).fill(2),
      0,
    ])
  })
})

const run = (v: number, verts: number, screenPxRange = v): TextRun => ({
  vertices: new Float32Array(verts * FLOATS_PER_VERTEX).fill(v),
  count: verts,
  screenPxRange,
})

describe('WgpuTextRenderer staging', () => {
  const image = { width: 4, height: 4 } as ImageBitmap
  const drawAll = (
    r: WgpuTextRenderer,
    gpu: ReturnType<typeof fakeGpu>,
    runs: TextRun[],
  ) =>
    r.drawAll(
      gpu.device,
      gpu.pass,
      'bgra8unorm',
      1,
      undefined,
      image,
      runs,
      640,
      480,
    )

  const uniformWrite = (gpu: ReturnType<typeof fakeGpu>) => {
    const u = gpu.buffers.find((b) => b.usage & GPUBufferUsage.UNIFORM)
    return gpu.writes.filter((w) => w.buffer === u)
  }

  it('packs one aligned uniform slot per drawn run, in order', () => {
    const gpu = fakeGpu()
    const r = new WgpuTextRenderer()
    drawAll(r, gpu, [run(1, 3), run(9, 0), run(2, 6)])
    const [u] = uniformWrite(gpu)
    // Two drawn runs -> exactly two 256-byte slots uploaded.
    expect(u.data).toHaveLength(2 * 64)
    expect(u.data.slice(0, 4)).toEqual([640, 480, 1, 0])
    expect(u.data.slice(64, 68)).toEqual([640, 480, 2, 0])
    const vb = 3 * FLOATS_PER_VERTEX * 4
    expect(gpu.calls.map((c) => [c.op, c.args])).toEqual([
      ['bind', [0, {}, [0]]],
      ['vb', [0, expect.anything(), 0, vb]],
      ['draw', [3]],
      ['bind', [0, {}, [256]]],
      ['vb', [0, expect.anything(), vb, 2 * vb]],
      ['draw', [6]],
    ])
  })

  it('reuses staging across grow, shrink and changed content', () => {
    const gpu = fakeGpu()
    const r = new WgpuTextRenderer()
    drawAll(r, gpu, [run(1, 3), run(2, 3), run(3, 3)])
    const first = uniformWrite(gpu)[0]
    expect(first.data).toHaveLength(3 * 64)

    gpu.reset()
    drawAll(r, gpu, [run(4, 3)])
    const [u] = uniformWrite(gpu)
    expect(u.data).toHaveLength(64)
    expect(u.data.slice(0, 4)).toEqual([640, 480, 4, 0])
    expect(u.src).toBe(first.src)
    expect(gpu.calls.filter((c) => c.op === 'draw')).toHaveLength(1)

    gpu.reset()
    drawAll(r, gpu, [run(5, 0)])
    expect(gpu.writes).toHaveLength(0)
    expect(gpu.calls).toHaveLength(0)
  })

  it('re-uploads the atlas only when the font image changes', () => {
    const gpu = fakeGpu()
    const r = new WgpuTextRenderer()
    drawAll(r, gpu, [run(1, 3)])
    drawAll(r, gpu, [run(1, 3)])
    expect(gpu.textures()).toBe(1)
    r.drawAll(
      gpu.device,
      gpu.pass,
      'bgra8unorm',
      1,
      undefined,
      { width: 8, height: 8 } as ImageBitmap,
      [run(1, 3)],
      640,
      480,
    )
    expect(gpu.textures()).toBe(2)
  })
})
