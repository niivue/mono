import { describe, expect, test } from 'bun:test'
import { BenchGuard } from './NVBench'

function makeView(width = 10) {
  return {
    boundsWidth: width,
    boundsHeight: width,
    resized: 0,
    resize() {
      this.resized++
    },
  }
}

describe('BenchGuard', () => {
  test('refuses a concurrent run', async () => {
    const guard = new BenchGuard(makeView(), () => true, 'busy')
    let release = () => {}
    const first = guard.run(
      'render',
      () => new Promise<void>((r) => (release = r)),
    )
    await expect(guard.run('render', () => {})).rejects.toThrow(
      'render: concurrent call not allowed',
    )
    release()
    await first
    await guard.run('render', () => {})
  })

  test('sizes an unsized view before rendering', async () => {
    const view = makeView(0)
    let rendered = 0
    await new BenchGuard(view, () => true, 'busy').run('render', () => {
      rendered++
    })
    expect(view.resized).toBe(1)
    expect(rendered).toBe(1)
  })

  test('waits for the view, then gives up', async () => {
    const raf = globalThis.requestAnimationFrame
    let frames = 0
    globalThis.requestAnimationFrame = (cb) => {
      frames++
      cb(0)
      return 0
    }
    try {
      await new BenchGuard(makeView(), () => frames >= 3, 'busy').run(
        'render',
        () => {},
      )
      expect(frames).toBe(3)
      const never = new BenchGuard(makeView(), () => false, 'still busy')
      await expect(never.run('render', () => {})).rejects.toThrow('still busy')
    } finally {
      globalThis.requestAnimationFrame = raf
    }
  })

  test('skips the render once disposed', async () => {
    const guard = new BenchGuard(makeView(), () => true, 'busy')
    guard.disposed = true
    let rendered = false
    await guard.run('render', () => {
      rendered = true
    })
    expect(rendered).toBe(false)
  })
})
