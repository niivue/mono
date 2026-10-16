import { describe, expect, test } from 'bun:test'
import { mat4, vec3, vec4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type NVModel from '@/NVModel'
import { MAX_CROSSHAIR_TILES } from '@/view/NVCrosshair'
import { CrosshairRenderer } from './crosshair'

// The parts of NVModel the crosshair reads, for a volume rotated 20 degrees
// about [1, 1, 1]. NVModel itself cannot be imported under Bun.
const obliqueModel = (): NVModel => {
  const tex2mm = mat4.fromRotation(
    mat4.create(),
    (20 * Math.PI) / 180,
    [1, 1, 1],
  )
  mat4.translate(tex2mm, tex2mm, [-100, -100, -100])
  mat4.scale(tex2mm, tex2mm, [200, 200, 200])
  const mm2tex = mat4.invert(mat4.create(), tex2mm) as mat4
  const extentsMin = vec3.fromValues(-120, -120, -120)
  const extentsMax = vec3.fromValues(120, 120, 120)
  const crosshairPos = vec3.fromValues(0.5, 0.5, 0.5)
  const scene2mm = (frac: ArrayLike<number>): vec3 =>
    vec3.fromValues(
      ...([0, 1, 2].map(
        (i) => extentsMin[i] + frac[i] * (extentsMax[i] - extentsMin[i]),
      ) as [number, number, number]),
    )
  return {
    extentsMin,
    extentsMax,
    scene: { crosshairPos },
    ui: { crosshairGap: 10, crosshairColor: [1, 0, 0, 1] },
    tex2mm,
    mm2tex,
    volumes: [],
    scene2mm,
    getSliceTexFrac: (dim: number) => {
      const mm = scene2mm(crosshairPos)
      const tex = vec4.transformMat4(
        vec4.create(),
        vec4.fromValues(mm[0], mm[1], mm[2], 1),
        mm2tex,
      )
      return tex[dim]
    },
  } as unknown as NVModel
}

/** A renderer on a device that only records vertex writes by byte offset. */
const recordingRenderer = () => {
  ;(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
    VERTEX: 0x20,
    INDEX: 0x10,
    UNIFORM: 0x40,
    COPY_DST: 0x8,
  }
  const writes: number[] = []
  const vertexBuffers = new Set<object>()
  const device = {
    createBuffer: (desc: { usage: number }) => {
      const buffer = {}
      if (desc.usage & 0x20) vertexBuffers.add(buffer)
      return buffer
    },
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (buffer: object, offset: number) => {
        if (vertexBuffers.has(buffer)) writes.push(offset)
      },
    },
  } as unknown as GPUDevice
  const renderer = new CrosshairRenderer()
  renderer.init(device, {} as GPUBindGroupLayout)
  return { renderer, writes }
}

describe('CrosshairRenderer (WebGPU) slots', () => {
  const sliceTypes = [SLICE_TYPE.AXIAL, SLICE_TYPE.CORONAL, SLICE_TYPE.SAGITTAL]

  test('tiles with the same geometry share a slot past the slot count', () => {
    const { renderer, writes } = recordingRenderer()
    const model = obliqueModel()
    renderer.beginFrame()
    const slots = Array.from({ length: MAX_CROSSHAIR_TILES + 4 }, (_, i) =>
      renderer.update(model, 1, sliceTypes[i % 3]),
    )
    // Each orientation of an oblique volume has its own arms, so its own slot,
    // and no later tile overwrites it.
    expect(slots.slice(0, 3)).toEqual([0, 1, 2])
    slots.forEach((slot, i) => {
      expect(slot).toBe(i % 3)
    })
    expect(writes.length).toBe(3 * 6)
  })

  test('a new frame starts from the first slot', () => {
    const { renderer } = recordingRenderer()
    const model = obliqueModel()
    renderer.beginFrame()
    renderer.update(model, 1, SLICE_TYPE.AXIAL)
    renderer.update(model, 2, SLICE_TYPE.AXIAL)
    renderer.beginFrame()
    expect(renderer.update(model, 2, SLICE_TYPE.AXIAL)).toBe(0)
  })
})
