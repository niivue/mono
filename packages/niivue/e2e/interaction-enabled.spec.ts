import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

test.use({ launchOptions: webgpuLaunchOptions })

for (const backend of ['webgl2', 'webgpu']) {
  for (const isInteractionEnabled of [false, true]) {
    test(`${backend}: interaction ${isInteractionEnabled} survives reinitialization`, async ({
      page,
    }) => {
      await page.goto('/examples/index.html', { waitUntil: 'load' })
      const result = await page.evaluate(
        async ({ backend, isInteractionEnabled }) => {
          const { default: NiiVue } = await import(`/src/index.${backend}.ts`)
          const canvas = document.createElement('canvas')
          canvas.width = canvas.height = 64
          document.body.appendChild(canvas)
          const nv = new NiiVue({ isInteractionEnabled })
          const listeners = () =>
            Object.entries(nv._eventListeners)
              .filter(([, handler]) => typeof handler === 'function')
              .map(([name]) => name)
              .sort()
          try {
            await nv.attachToCanvas(canvas)
            const attached = listeners()
            const restarted = await nv.reinitializeView({ forceRestart: true })
            return { attached, restarted, reinitialized: listeners() }
          } finally {
            nv.destroy()
          }
        },
        { backend, isInteractionEnabled },
      )
      const expected = isInteractionEnabled
        ? [
            'contextmenu',
            'dblclick',
            'dragover',
            'drop',
            'keydown',
            'pointercancel',
            'pointerdown',
            'pointerleave',
            'pointermove',
            'pointerup',
            'wheel',
          ]
        : []
      expect(result.attached).toEqual(expected)
      expect(result.restarted).toBe(true)
      expect(result.reinitialized).toEqual(expected)
    })
  }
}
