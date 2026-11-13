import { expect } from '@playwright/test'
import { nimlTract } from '../src/testing/nimlTract'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu']) {
  test(`drops a NIML tract onto a viewer (${backend})`, async ({ page }) => {
    const result = await page.evaluate(
      async ({ backend, bytes }) => {
        const { default: NiiVue } = await import('/src/index.ts')
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        document.body.appendChild(canvas)
        const nv = new NiiVue({ backend })
        await nv.attachToCanvas(canvas)
        const transfer = new DataTransfer()
        transfer.items.add(
          new File([new Uint8Array(bytes)], 'bundles.niml.tract'),
        )
        const loaded = new Promise<void>((resolve) =>
          nv.addEventListener('meshLoaded', () => resolve(), { once: true }),
        )
        canvas.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer }))
        await loaded
        await nv.whenUpdatesSettle()
        const mesh = nv.meshes[0]
        return {
          kind: mesh.kind,
          offsets: Array.from(mesh.trx.offsets),
          bundles: Array.from(mesh.trx.dps.tract),
          uploaded: !!nv.view._getMeshGpu(mesh),
          image: !!nv.getCanvasImage(),
        }
      },
      { backend, bytes: Array.from(nimlTract()) },
    )
    expect(result).toEqual({
      kind: 'tract',
      offsets: [0, 2, 5, 7],
      bundles: [21, 21, 47],
      uploaded: true,
      image: true,
    })
  })
}
