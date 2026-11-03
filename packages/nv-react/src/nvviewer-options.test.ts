import { describe, expect, mock, test } from 'bun:test'
import { registerNiivueMock } from './__mocks__/niivue'

registerNiivueMock()

import type NiiVue from '@niivue/niivue'
import {
  applyLiveOptions,
  hasSetter,
  signature,
  splitOptions,
} from './nvviewer-options'

class Base {
  _gap = 0
  get crosshairGap() {
    return this._gap
  }
  set crosshairGap(v: number) {
    this._gap = v
  }
  isAntiAlias() {}
}
class Viewer extends Base {
  get backend() {
    return 'webgl2'
  }
}

describe('hasSetter', () => {
  test('inherited setter is live', () => {
    expect(hasSetter(Viewer.prototype, 'crosshairGap')).toBe(true)
  })
  test('getter-only, method and absent keys are construction-only', () => {
    expect(hasSetter(Viewer.prototype, 'backend')).toBe(false)
    expect(hasSetter(Viewer.prototype, 'isAntiAlias')).toBe(false)
    expect(hasSetter(Viewer.prototype, 'font')).toBe(false)
  })
})

describe('splitOptions', () => {
  test('leaves sliceType to the NvViewer prop', () => {
    const { live, construction } = splitOptions(Viewer.prototype, {
      sliceType: 1,
    })
    expect(live).toEqual({})
    expect(construction).toEqual({})
  })

  test('splits by setter and skips undefined values', () => {
    const { live, construction } = splitOptions(Viewer.prototype, {
      crosshairGap: 3,
      backend: 'webgpu',
      bounds: undefined,
    })
    expect(live).toEqual({ crosshairGap: 3 })
    expect(construction).toEqual({ backend: 'webgpu' })
  })
})

describe('signature', () => {
  test('compares values, including typed arrays', () => {
    expect(signature({ a: new Float32Array([1, 2]) })).toBe(
      signature({ a: new Float32Array([1, 2]) }),
    )
    expect(signature(new Float32Array([1, 2]))).not.toBe(
      signature(new Float32Array([1, 3])),
    )
    expect(signature([[1, 2]])).not.toBe(signature([[1, 3]]))
  })
})

describe('applyLiveOptions', () => {
  test('sets changed keys only, resets dropped keys, ignores the rest', () => {
    const nv = { a: 1, b: 2, untouched: 9 } as unknown as NiiVue
    applyLiveOptions(nv, { a: 1, crosshairGap: 3 }, { a: 1, b: [4] }, () => {})
    expect(nv as unknown).toEqual({
      a: 1,
      b: [4],
      untouched: 9,
      crosshairGap: 5,
    })
  })
  test('hands the viewer a copy, never the caller array', () => {
    // NiiVue mutates pan2Dxyzmm in place; that must not reach the prop.
    const pan = [0, 0, 0, 1]
    const color = new Float32Array([1, 0, 0, 1])
    const nv = {} as unknown as NiiVue
    applyLiveOptions(
      nv,
      {},
      { pan2Dxyzmm: pan, backgroundColor: color },
      () => {},
    )
    const live = nv as unknown as {
      pan2Dxyzmm: number[]
      backgroundColor: Float32Array
    }
    expect(live.pan2Dxyzmm).toEqual(pan)
    expect(live.pan2Dxyzmm).not.toBe(pan)
    expect(live.backgroundColor).toEqual(color)
    expect(live.backgroundColor).not.toBe(color)
  })

  test('a dropped key resets to a default built with the construction options', () => {
    // Some defaults depend on construction-only options (volumeMatcap on
    // matcaps); the mock's defaults merge its constructor options the same way.
    const nv = { showRender: 1 } as unknown as NiiVue
    applyLiveOptions(nv, { showRender: 1 }, {}, () => {}, { showRender: 3 })
    expect((nv as unknown as { showRender: number }).showRender).toBe(3)
  })

  test('a throwing setter reaches onError and later keys still apply', () => {
    const failure = new Error('bad')
    const nv = {
      set drawColormap(_v: string) {
        throw failure
      },
      crosshairGap: 0,
    } as unknown as NiiVue
    const onError = mock((_e: unknown) => {})
    applyLiveOptions(nv, {}, { drawColormap: 'x', crosshairGap: 2 }, onError)
    expect(onError).toHaveBeenCalledWith(failure)
    expect((nv as unknown as { crosshairGap: number }).crosshairGap).toBe(2)
  })
})
