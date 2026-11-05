// Instance-data packing of the WebGL2 line/rect renderers, checked against a
// fake context that records each bufferData upload (no GPU needed).

import { describe, expect, it } from 'bun:test'
import { FLOATS_PER_LINE } from '../line'
import { FLOATS_PER_RECT } from '../rect'
import { GlLineRenderer } from './glLineRenderer'
import { GlRectRenderer } from './glRectRenderer'

/** A WebGL2 stand-in: every call succeeds; bufferData keeps a copy of the upload. */
function fakeGl() {
  const uploads: number[][] = []
  const gl = new Proxy(
    {
      getShaderParameter: () => true,
      getProgramParameter: () => true,
      getAttribLocation: () => 0,
      bufferData: (
        _t: number,
        src: Float32Array,
        _u: number,
        off: number,
        len: number,
      ) => {
        uploads.push([...src.subarray(off, off + len)])
      },
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (() => ({})) },
  )
  return { gl: gl as unknown as WebGL2RenderingContext, uploads }
}

describe('GL renderer instance packing', () => {
  for (const [name, Renderer, floats] of [
    ['GlLineRenderer', GlLineRenderer, FLOATS_PER_LINE],
    ['GlRectRenderer', GlRectRenderer, FLOATS_PER_RECT],
  ] as const) {
    it(`${name} zeroes the tail of a short record instead of keeping the prior frame`, () => {
      const { gl, uploads } = fakeGl()
      const r = new Renderer()
      r.draw(gl, [{ data: new Float32Array(floats).fill(1) }], 100, 100)
      r.draw(gl, [{ data: new Float32Array(floats - 1).fill(2) }], 100, 100)
      expect(uploads[1]).toEqual([...Array(floats - 1).fill(2), 0])
    })
  }
})
