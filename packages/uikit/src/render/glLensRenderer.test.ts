import { expect, test } from 'bun:test'
import { layoutMagnifier } from '../magnifier'
import { GlLensRenderer } from './glLensRenderer'

// A WebGL2 stand-in: every call succeeds; blits and deletes are counted.
function fakeGl() {
  const calls: Record<string, number> = {}
  const uniforms: number[][] = []
  const size = { drawingBufferWidth: 100, drawingBufferHeight: 100 }
  const gl = new Proxy(size, {
    get(target, key: string) {
      if (key in target) return target[key as keyof typeof target]
      if (/^[A-Z_0-9]+$/.test(key)) return 0
      return (...args: unknown[]) => {
        calls[key] = (calls[key] ?? 0) + 1
        if (key === 'uniform4f') uniforms.push(args.slice(1) as number[])
        if (key === 'getParameter') return null
        if (key === 'getContextAttributes') return {}
        return key.startsWith('create') || key.startsWith('get') ? {} : true
      }
    },
  })
  return { gl: gl as unknown as WebGL2RenderingContext, calls, uniforms, size }
}

test('lenses in one frame share one scene copy, so overlapping lenses do not compound', () => {
  const { gl, calls } = fakeGl()
  const bounds = { x: 0, y: 0, width: 100, height: 100 }
  const layout = layoutMagnifier({
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    dpr: 1,
    radiusCss: 20,
    zoom: 3,
  })
  if (!layout) throw new Error('no layout')
  const a = new GlLensRenderer()
  const b = new GlLensRenderer()
  const frame1 = {}
  a.draw(gl, bounds, layout, [0, 0, 0, 1], frame1)
  b.draw(gl, bounds, layout, [0, 0, 0, 1], frame1)
  expect(calls.blitFramebuffer).toBe(1)
  b.draw(gl, bounds, layout, [0, 0, 0, 1], {})
  expect(calls.blitFramebuffer).toBe(2)
  // The shared copy outlives the first lens and goes with the last.
  a.destroy()
  expect(calls.deleteTexture).toBeUndefined()
  b.destroy()
  expect(calls.deleteTexture).toBe(1)
})

test('the scene copy follows the canvas when it shrinks, so off-canvas parts fill', () => {
  const { gl, uniforms, size } = fakeGl()
  const layout = layoutMagnifier({
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    dpr: 1,
    radiusCss: 20,
    zoom: 3,
  })
  if (!layout) throw new Error('no layout')
  const lens = new GlLensRenderer()
  const bounds = { x: 0, y: 0, width: 200, height: 200 }
  size.drawingBufferWidth = size.drawingBufferHeight = 200
  lens.draw(gl, bounds, layout, [0, 0, 0, 1], {})
  size.drawingBufferWidth = size.drawingBufferHeight = 100
  lens.draw(gl, bounds, layout, [0, 0, 0, 1], {})
  // imageRect (the last uniform4f): the texture is now the 100 px canvas.
  expect(uniforms.at(-1)?.slice(2)).toEqual([100, 100])
  lens.destroy()
})

test('a small view low on a big canvas copies only its own extent', () => {
  const { gl, uniforms, size } = fakeGl()
  size.drawingBufferWidth = size.drawingBufferHeight = 4096
  const layout = layoutMagnifier({
    x: 64,
    y: 64,
    width: 128,
    height: 128,
    dpr: 1,
    radiusCss: 20,
    zoom: 3,
  })
  if (!layout) throw new Error('no layout')
  const lens = new GlLensRenderer()
  lens.draw(
    gl,
    { x: 0, y: 4096 - 128, width: 128, height: 128 },
    layout,
    [0, 0, 0, 1],
    {},
  )
  expect(uniforms.at(-1)?.slice(2)).toEqual([128, 128])
  lens.destroy()
})
