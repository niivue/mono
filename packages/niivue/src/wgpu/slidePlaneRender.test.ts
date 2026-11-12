import { describe, expect, test } from 'bun:test'
import type { NVSlide } from '@/slide/NVSlide'
import type { SlidePlaneTile } from '@/slide/slidePlane'
import { SlidePlaneRendererGPU } from './slidePlaneRender'

// Bun has no WebGPU: stub the flag namespaces the renderer reads.
Object.assign(globalThis, {
  GPUBufferUsage: { UNIFORM: 64, COPY_DST: 8, VERTEX: 32 },
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
    queue: { writeBuffer: () => {} },
  }
  return { device: device as unknown as GPUDevice, buffers }
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
    _pipeline: {},
    _uniformBGL: {},
    _sampler: {},
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

  test('buffers replaced in a pass are destroyed on the next pass', () => {
    const { device, buffers } = fakeDevice()
    const r = readyRenderer()
    const mvp = new Float32Array(16)
    r.draw(device, fakePass().pass, mvp, tiles(1), slide)
    r.draw(device, fakePass().pass, mvp, tiles(2), slide)
    expect(buffers.filter((b) => b.destroyed)).toHaveLength(0)
    r.draw(device, fakePass().pass, mvp, tiles(2), slide)
    expect(buffers.filter((b) => b.destroyed)).toHaveLength(1)
  })
})
