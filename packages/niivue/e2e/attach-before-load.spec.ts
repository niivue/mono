import { expect, test } from '@playwright/test'

// niivue/mono#61: loading a volume while attachToCanvas was still initializing threw
// `createBindGroup ... 'buffer' ... Required member is undefined` and left a random
// subset of canvases blank. attachToCanvas assigned ctrl.view before awaiting
// view.init(), so the `if (!this.view) return` guard in updateGLVolume waved the load
// through to a view whose device already existed but whose buffers did not.
//
// The concurrent-load test only reproduces where a real WebGPU adapter exists (a
// headed run, or a GPU-backed runner). Headless chromium reports no adapter, so init
// fails at its first step and the WebGL2 fallback serves the load. The view-publishing
// test holds the invariant in either environment.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// Import NiiVue and expose a factory for throwaway offscreen canvases.
const setup = `
  const { default: NiiVue } = await import('/src/index.ts')
  const mkCanvas = () => {
    const c = document.createElement('canvas')
    c.width = 64; c.height = 64
    c.style.cssText = 'position:fixed;left:-9999px'
    document.body.appendChild(c)
    return c
  }
`

test('attachToCanvas does not publish the view until init resolves', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    const nv = new NiiVue({ backend: 'webgpu' })
    const attaching = nv.attachToCanvas(mkCanvas())
    const during = nv.view
    await attaching
    return { duringIsNull: during === null, afterIsSet: nv.view !== null }
  })()`)

  expect(r.duringIsNull).toBe(true)
  expect(r.afterIsSet).toBe(true)
})

test('a volume loaded concurrently with attach still loads', async ({
  page,
}) => {
  test.setTimeout(90_000)

  const r = await page.evaluate(`(async () => {
    ${setup}
    const nv = new NiiVue({ backend: 'webgpu' })
    const attaching = nv.attachToCanvas(mkCanvas())
    let error = null
    const loading = nv
      .loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
      .catch((e) => { error = e.message })
    await Promise.all([attaching, loading])
    return { error, volumes: nv.volumes.length }
  })()`)

  expect(r.error).toBeNull()
  expect(r.volumes).toBe(1)
})
