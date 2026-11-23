import { expect, test } from 'bun:test'
import { layoutMagnifier } from '../magnifier'
import { GlLensRenderer } from './glLensRenderer'

// A WebGL2 stand-in: every call succeeds; blits and deletes are counted.
function fakeGl() {
  const calls: Record<string, number> = {}
  const gl = new Proxy(
    { drawingBufferWidth: 100, drawingBufferHeight: 100 },
    {
      get(target, key: string) {
        if (key in target) return target[key as keyof typeof target]
        if (/^[A-Z_0-9]+$/.test(key)) return 0
        return (..._: unknown[]) => {
          calls[key] = (calls[key] ?? 0) + 1
          if (key === 'getParameter') return null
          if (key === 'getContextAttributes') return {}
          return key.startsWith('create') || key.startsWith('get') ? {} : true
        }
      },
    },
  )
  return { gl: gl as unknown as WebGL2RenderingContext, calls }
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
