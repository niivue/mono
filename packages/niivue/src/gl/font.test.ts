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

describe('FontRenderer', () => {
  test('an atlas that loads after destroy does not revive the renderer', async () => {
    const saved = globalThis.Image
    Object.assign(globalThis, { Image: DeferredImage })
    try {
      const font = new FontRenderer()
      const done = font.init(
        {} as WebGL2RenderingContext,
        {
          atlasUrl: 'atlas.png',
          metrics: {},
        } as unknown as Parameters<FontRenderer['init']>[1],
      )
      font.destroy()
      pending[0].onload()
      await done
      expect(font.isReady).toBe(false)
    } finally {
      Object.assign(globalThis, { Image: saved })
    }
  })
})
