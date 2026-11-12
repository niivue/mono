import { afterEach, expect, spyOn, test } from 'bun:test'
import { SlideRenderer } from '@/gl/slide'
import { webgl2SlideBackend } from './slideViewWebGL2'

const canvas = {
  getContext: () => ({}),
} as unknown as HTMLCanvasElement
const options = { antialias: false }
const spies: Array<{ mockRestore(): void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

test('a failed init destroys the renderer and rethrows the init error', async () => {
  let destroys = 0
  spies.push(
    spyOn(SlideRenderer.prototype, 'init').mockImplementation(() => {
      throw new Error('init failed')
    }),
    spyOn(SlideRenderer.prototype, 'destroy').mockImplementation(() => {
      destroys++
      throw new Error('teardown failed')
    }),
  )
  await expect(webgl2SlideBackend.create(canvas, options)).rejects.toThrow(
    'init failed',
  )
  expect(destroys).toBe(1)
})

test('destroy deletes both shader programs', () => {
  const deleted: unknown[] = []
  // Every GL call is a no-op; deleteProgram records what it was given.
  const gl = new Proxy(
    {},
    {
      get: (_t, name) =>
        name === 'deleteProgram' ? (p: unknown) => deleted.push(p) : () => null,
    },
  )
  const r = new SlideRenderer()
  Object.assign(r, {
    _gl: gl,
    _plainShader: { program: 'plain' },
    _lutShader: { program: 'lut' },
  })
  r.destroy()
  expect(deleted).toEqual(['plain', 'lut'])
})
