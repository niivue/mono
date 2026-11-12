import { afterEach, expect, test } from 'bun:test'
import { SlideRendererGPU } from './slide'

const saved = Object.getOwnPropertyDescriptor(navigator, 'gpu')
afterEach(() => {
  if (saved) Object.defineProperty(navigator, 'gpu', saved)
  else delete (navigator as { gpu?: unknown }).gpu
})

test('a failed WebGPU setup destroys the device it requested', async () => {
  let destroys = 0
  const device = { destroy: () => destroys++ }
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: async () => ({ requestDevice: async () => device }),
    },
  })
  const canvas = { getContext: () => null } as unknown as HTMLCanvasElement
  expect(await SlideRendererGPU.create(canvas)).toBeNull()
  expect(destroys).toBe(1)
})
