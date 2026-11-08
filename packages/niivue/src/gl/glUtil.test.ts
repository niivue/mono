import { describe, expect, test } from 'bun:test'
import { PolygonRenderer } from './polygon'
import { Polygon3DRenderer } from './polygon3d'

// Records vertexAttribPointer calls and counts live GL objects.
function recordingGL() {
  let live = 0
  const pointers: number[][] = []
  const gl = new Proxy(
    {},
    {
      get(_t, name) {
        if (typeof name !== 'string') return undefined
        if (/^[A-Z0-9_]+$/.test(name)) return 1
        if (name === 'getProgramParameter' || name === 'getShaderParameter')
          return () => true
        if (name === 'vertexAttribPointer')
          return (
            loc: number,
            size: number,
            _t: number,
            _n: boolean,
            stride: number,
            offset: number,
          ) => pointers.push([loc, size, stride, offset])
        if (name.startsWith('create') && name !== 'createShader')
          return () => {
            live++
            return {}
          }
        if (name.startsWith('delete') && name !== 'deleteShader')
          return (o: unknown) => {
            if (o) live--
          }
        return () => ({})
      },
    },
  ) as WebGL2RenderingContext
  return { gl, pointers, live: () => live }
}

describe('createIndexedGeometry via polygon renderers', () => {
  test('polygon layout: x, y then rgba', () => {
    const { gl, pointers, live } = recordingGL()
    const r = new PolygonRenderer()
    r.init(gl)
    expect(pointers).toEqual([
      [0, 2, 24, 0],
      [1, 4, 24, 8],
    ])
    r.destroy()
    expect(r.isReady).toBe(false)
    expect(live()).toBe(0)
  })

  test('polygon3d layout: x, y, z then rgba', () => {
    const { gl, pointers, live } = recordingGL()
    const r = new Polygon3DRenderer()
    r.init(gl)
    expect(pointers).toEqual([
      [0, 3, 28, 0],
      [1, 4, 28, 12],
    ])
    r.destroy()
    expect(live()).toBe(0)
  })
})
