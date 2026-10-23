import { expect, test } from '@playwright/test'

// addMesh emits meshLoaded for the mesh it added, and only when it added one.
// The model logs a mesh it cannot read and adds nothing; a removal made while
// a load is in flight must not hide the mesh that load adds.

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const MESH_A = '/meshes/BrainMesh_ICBM152.lh.mz3'
const MESH_B = '/meshes/cortex_5124.mz3'

test('addMesh emits meshLoaded only for a mesh it added', async ({ page }) => {
  test.setTimeout(120_000)

  const result = await page.evaluate(`(async () => {
    const { default: NiiVue } = await import('/src/index.ts')
    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    document.body.appendChild(canvas)
    const nv = new NiiVue({ backend: 'webgl2' })
    await nv.attachToCanvas(canvas)
    const loaded = []
    nv.addEventListener('meshLoaded', (e) => loaded.push(e.detail.mesh))

    // A mesh that cannot be read adds nothing and says nothing.
    await nv.addMesh({ url: '/meshes/does-not-exist.mz3' })
    const afterFailure = { events: loaded.length, meshes: nv.meshes.length }

    // A removal while a load is in flight leaves the count where it started.
    await nv.addMesh({ url: '${MESH_B}' })
    loaded.length = 0
    const adding = nv.addMesh({ url: '${MESH_A}' })
    await nv.removeMesh(0)
    await adding
    const added = nv.meshes[0]
    const raced = {
      events: loaded.length,
      isAdded: loaded[0] === added,
      meshes: nv.meshes.length,
      uploaded: !!nv.view._getMeshGpu(added),
    }
    nv.destroy()
    return { afterFailure, raced }
  })()`)

  expect(result).toEqual({
    afterFailure: { events: 0, meshes: 0 },
    raced: { events: 1, isAdded: true, meshes: 1, uploaded: true },
  })
})
