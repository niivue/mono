import { describe, expect, test } from 'bun:test'
import type { NVSlide } from '@/slide/NVSlide'
import type { SlidePlaneTile } from '@/slide/slidePlane'
import { SlidePlaneRendererGPU } from './slidePlaneRender'

// Bun has no WebGPU: stub the flag namespaces the renderer reads.
Object.assign(globalThis, {
  GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8, VERTEX: 32 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2 },
})

type FakeBuffer = { id: number; destroyed: boolean; destroy(): void }

function fakeDevice() {
  const buffers: FakeBuffer[] = []
  const device = {
    createBuffer: () => {
      const b: FakeBuffer = {
        id: buffers.length,
        destroyed: false,
        destroy() {
          b.destroyed = true
        },
      }
      buffers.push(b)
      return b
    },
    createBindGroup: (d: { entries: { resource: unknown }[] }) => ({
      buffer: (d.entries[0].resource as { buffer: FakeBuffer }).buffer,
    }),
    queue: {
      writeBuffer: (b: FakeBuffer) => {
        writes.push(b)
      },
    },
  }
  const writes: FakeBuffer[] = []
  return { device: device as unknown as GPUDevice, buffers, writes }
}

function fakePass() {
  const bound: { uniform: FakeBuffer[]; vertex: FakeBuffer[] } = {
    uniform: [],
    vertex: [],
  }
  const pass = {
    setPipeline: () => {},
    setBindGroup: (i: number, g: { buffer: FakeBuffer }) => {
      if (i === 0) bound.uniform.push(g.buffer)
    },
    setVertexBuffer: (_: number, b: FakeBuffer) => bound.vertex.push(b),
    draw: () => {},
  }
  return { pass: pass as unknown as GPURenderPassEncoder, bound }
}

function readyRenderer(): SlidePlaneRendererGPU {
  const r = new SlidePlaneRendererGPU()
  Object.assign(r, {
    _isReady: true,
    _pipelineFor: () => ({}),
    _uniformBGL: {},
    _sampler: {},
    _nearestSampler: {},
  })
  return r
}

const tiles = (n: number): SlidePlaneTile[] =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        key: `t${i}`,
        width: 1,
        height: 1,
        corners: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
          [1, 1, 0],
        ],
      }) as unknown as SlidePlaneTile,
  )

const slide = {
  manifest: {},
  displayColorLut: null,
  cachedTile: () => null,
  setRendererBudget: () => {},
} as unknown as NVSlide

describe('SlidePlaneRendererGPU', () => {
  test('two render tiles in one pass keep their own uniform and vertex buffers', () => {
    const { device } = fakeDevice()
    const r = readyRenderer()
    const mvp = new Float32Array(16)
    for (const frame of [0, 1]) {
      const { pass, bound } = fakePass()
      // Each tile gets its own tile list, as NVViewGPU builds per render tile.
      r.draw(device, pass, mvp, tiles(1 + frame), slide)
      r.draw(device, pass, mvp, tiles(2 + frame), slide)
      expect(bound.uniform[0]).not.toBe(bound.uniform[1])
      expect(bound.vertex[0]).not.toBe(bound.vertex[1])
      // Nothing bound in this (unsubmitted) pass may be destroyed.
      for (const b of [...bound.uniform, ...bound.vertex])
        expect(b.destroyed).toBe(false)
    }
  })

  test('a vertex buffer outgrown in a pass is destroyed on the next pass', () => {
    const { device, buffers } = fakeDevice()
    const r = readyRenderer()
    const mvp = new Float32Array(16)
    r.draw(device, fakePass().pass, mvp, tiles(1), slide)
    // Fits the first buffer (room for twice the first set): reused.
    r.draw(device, fakePass().pass, mvp, tiles(2), slide)
    expect(buffers).toHaveLength(2) // uniform + vertex
    r.draw(device, fakePass().pass, mvp, tiles(8), slide)
    expect(buffers.filter((b) => b.destroyed)).toHaveLength(0)
    r.draw(device, fakePass().pass, mvp, tiles(8), slide)
    expect(buffers.filter((b) => b.destroyed)).toHaveLength(1)
  })

  test('the same tiles in a new array do not rewrite the vertex buffer', () => {
    const { device, buffers, writes } = fakeDevice()
    const r = readyRenderer()
    const mvp = new Float32Array(16)
    const set = tiles(3)
    r.draw(device, fakePass().pass, mvp, set, slide)
    const vertex = buffers[1]
    const before = writes.filter((b) => b === vertex).length
    r.draw(device, fakePass().pass, mvp, [...set], slide)
    expect(writes.filter((b) => b === vertex).length).toBe(before)
    r.draw(device, fakePass().pass, mvp, set.slice(1), slide)
    expect(writes.filter((b) => b === vertex).length).toBe(before + 1)
  })

  test('two slides in one pass keep their own absent colour', () => {
    const { device } = fakeDevice()
    // Each 1x1 texture remembers the last colour written to it.
    const colorOf = new Map<object, number[]>()
    Object.assign(device, {
      createTexture: () => ({ createView: () => ({}), destroy: () => {} }),
      queue: {
        writeBuffer: () => {},
        writeTexture: (d: { texture: object }, data: Uint8ClampedArray) =>
          colorOf.set(d.texture, [...data]),
      },
    })
    const r = readyRenderer()
    const groupTexture = new Map<object, object>()
    Object.assign(r, {
      _textureBGL: {},
      _group: (_: GPUDevice, texture: object) => {
        const g = {}
        groupTexture.set(g, texture)
        return g
      },
    })
    const absent: object[] = []
    const { pass } = fakePass()
    Object.assign(pass, {
      setBindGroup: (i: number, g: object) => {
        if (i === 1) absent.push(g)
      },
    })
    const dicom = (backgroundColor: number[]) =>
      ({
        ...slide,
        manifest: { width: 1, height: 1, backgroundColor: [0, 0, 0] },
        backgroundColor,
      }) as unknown as NVSlide
    const p2w = [1, 0, 0, 0, 1, 0]
    const mvp = new Float32Array(16)
    r.draw(device, pass, mvp, tiles(1), dicom([1, 0, 0, 1]), 1, p2w)
    r.draw(device, pass, mvp, tiles(1), dicom([0, 0, 1, 1]), 1, p2w)
    expect(
      absent.map((g) => colorOf.get(groupTexture.get(g) as object)),
    ).toEqual([
      [255, 0, 0, 255],
      [0, 0, 255, 255],
    ])
  })
})
