import { describe, expect, test } from 'bun:test'
import NiiVue from './index'
import NVControlBase from './NVControlBase'
import { NVWorker } from './workers/NVWorker'

describe('NVControlBase under bun test', () => {
  test('the package entry loads and constructs without a canvas', () => {
    const nv = new NiiVue()
    expect(nv).toBeInstanceOf(NVControlBase)
    expect(nv.volumes).toEqual([])
  })

  test('worker bridges take their main-thread path', () => {
    expect(NVWorker.isSupported()).toBe(false)
  })
})
