import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import type { NVMesh } from '@/NVTypes'
import { captureErrors, serveDevImages } from '@/testing/headless'

// addMesh emits meshLoaded for the mesh it added, and only when it added one.
// The model logs a mesh it cannot read and adds nothing; a removal made while
// a load is in flight must not hide the mesh that load adds. That the raced
// mesh also reaches the GPU is pinned by e2e/add-mesh-events.spec.ts.

// Over HTTP, so the missing mesh is a real 404.
const server = serveDevImages()
const MESH = server.url('/meshes/cortex_5124.mz3')

test('addMesh emits meshLoaded only for a mesh it added', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const loaded: NVMesh[] = []
  nv.addEventListener('meshLoaded', (e) => loaded.push(e.detail.mesh))

  // A mesh that cannot be read adds nothing and says nothing.
  const errors = captureErrors()
  await nv.addMesh({ url: server.url('/meshes/does-not-exist.mz3') })
  errors.restore()
  expect(errors.messages.join('\n')).toContain('404')
  expect({ events: loaded.length, meshes: nv.meshes.length }).toEqual({
    events: 0,
    meshes: 0,
  })

  // A removal while a load is in flight leaves the count where it started.
  await nv.addMesh({ url: MESH })
  loaded.length = 0
  const adding = nv.addMesh({ url: MESH })
  await nv.removeMesh(0)
  await adding
  expect(nv.meshes).toHaveLength(1)
  expect(loaded).toHaveLength(1)
  expect(loaded[0]).toBe(nv.meshes[0])
})
