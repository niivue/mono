import { describe, expect, test } from 'bun:test'
import { FontRenderer } from './font'

// The atlas Image never loads until the test says so.
const pending: Array<{ onload: () => void }> = []
class DeferredImage {
  width = 1
  height = 1
  onload = () => {}
  onerror = () => {}
  set src(_value: string) {
    pending.push(this)
  }
}

// A GL stub that counts live objects: create adds one, delete takes one away.
function countingGL() {
  let live = 0
  const gl = new Proxy(
    {},
    {
      get(_t, name) {
        if (typeof name !== 'string') return undefined
        if (/^[A-Z0-9_]+$/.test(name)) return 1
        if (name === 'getProgramParameter' || name === 'getShaderParameter')
          return () => true
        if (name.startsWith('create') && name !== 'createShader')
          return () => {
            live++
            return {}
          }
        if (name.startsWith('delete') && name !== 'deleteShader')
          return (o: unknown) => {
            if (o) live--
          }
        if (name === 'getAttribLocation') return () => 0
        return () => ({})
      },
    },
  ) as WebGL2RenderingContext
  return { gl, live: () => live }
}

describe('FontRenderer', () => {
  test('an atlas that loads after destroy leaves nothing allocated', async () => {
    const saved = globalThis.Image
    Object.assign(globalThis, { Image: DeferredImage })
    try {
      const { gl, live } = countingGL()
      const font = new FontRenderer()
      const done = font.init(gl, {
        atlasUrl: 'atlas.png',
        metrics: {},
      } as unknown as Parameters<FontRenderer['init']>[1])
      font.destroy()
      pending[0].onload()
      await done
      expect(font.isReady).toBe(false)
      expect(live()).toBe(0)
    } finally {
      Object.assign(globalThis, { Image: saved })
    }
  })
})
