import { registerScenes, type Scene } from './renderHarness'

// Reference images for mesh features: scoped GPU rebuilds, the 2D mesh slab,
// x-ray and crosscut2. See renderHarness.ts for how scenes run and how to
// update the references.

// Stash for state one step hands to the next (the steps are separate
// functions sent to the page). The shared page's reset deletes it.
type Stash = { __e2e: Record<string, unknown> }

const SCENES: Scene[] = [
  {
    // GPU rebuilds re-upload only the meshes that changed (#scoped rebuilds):
    // each mesh's GPU entry (view._getMeshGpu) is a new object only when that
    // mesh was re-uploaded, so identity shows which meshes a call rebuilt, and
    // each capture shows the result reached the screen without touching the
    // other two spheres.
    name: 'mesh-edits',
    options: { sliceType: 4 },
    setup: async ({ nv, view, p, check }) => {
      const g = globalThis as unknown as Stash
      await nv.loadVolumes([{ url: p.anatomy(), opacity: 0 }])
      await nv.loadMeshes([
        {
          url: p.sphereMesh({ name: 'a.obj', center: [-9, 0, 0], radius: 7 }),
          color: [1, 1, 1, 1],
        },
        {
          url: p.sphereMesh({ name: 'b.obj', center: [9, 0, 0], radius: 7 }),
          color: [0.3, 0.6, 1, 1],
        },
        {
          url: p.sphereMesh({ name: 'c.obj', center: [0, 0, 10], radius: 5 }),
          color: [1, 0.6, 0.1, 1],
        },
      ])
      const gpus = () => nv.meshes.map((m) => view()._getMeshGpu(m))
      const kept = (a: unknown[], b: unknown[]) =>
        a.length === b.length && a.every((x, i) => x !== null && x === b[i])
      // Volume-only setters keep every mesh's buffers.
      let before = gpus()
      await nv.setVolume(0, { colormap: 'hot' })
      check(kept(before, gpus()), 'setVolume keeps mesh buffers')
      const affine = nv.getVolumeAffine(0)
      affine[0][3] += 2
      await nv.setVolumeAffine(0, affine)
      check(kept(before, gpus()), 'setVolumeAffine keeps mesh buffers')
      // Remove the last mesh: the others keep their buffers; add it back:
      // only it is uploaded.
      const removed = nv.meshes[2]
      await nv.removeMesh(2)
      check(kept(before.slice(0, 2), gpus()), 'removeMesh keeps the others')
      check(view()._getMeshGpu(removed) === null, 'removeMesh frees it')
      await nv.addMesh(removed)
      const after = gpus()
      check(kept(before.slice(0, 2), after.slice(0, 2)), 'addMesh keeps them')
      check(after[2] && after[2] !== before[2], 'addMesh uploads it')
      before = gpus()
      g.__e2e = { before }
    },
    steps: [
      {
        // Opacity is a draw-time uniform: no re-upload, yet the redraw shows it.
        name: 'hidden',
        run: async ({ nv, view, check }) => {
          const { before } = (globalThis as unknown as Stash).__e2e as {
            before: unknown[]
          }
          await nv.setMesh(0, { opacity: 0 })
          const now = nv.meshes.map((m) => view()._getMeshGpu(m))
          check(
            now.every((x, i) => x === before[i]),
            'opacity keeps every buffer',
          )
        },
      },
      {
        // A shader change keeps the buffers, records the shader, draws it.
        name: 'toon',
        run: async ({ nv, view, check }) => {
          const { before } = (globalThis as unknown as Stash).__e2e as {
            before: unknown[]
          }
          await nv.setMesh(0, { opacity: 1 })
          await nv.setMesh(0, { shaderType: 'toon' })
          const now = nv.meshes.map((m) => view()._getMeshGpu(m))
          check(
            now.every((x, i) => x === before[i]),
            'shaderType keeps every buffer',
          )
          check(
            (now[0] as { shaderType: string }).shaderType === 'toon',
            'shaderType recorded',
          )
        },
      },
      {
        // A colour rewrites per-vertex colours: only that mesh re-uploads.
        name: 'red',
        run: async ({ nv, view, check }) => {
          await nv.setMesh(0, { shaderType: 'phong' })
          const before = nv.meshes.map((m) => view()._getMeshGpu(m))
          await nv.setMesh(0, { color: [1, 0, 0, 1] })
          const now = nv.meshes.map((m) => view()._getMeshGpu(m))
          check(now[0] !== before[0], 'colour re-uploads the mesh')
          check(
            now[1] === before[1] && now[2] === before[2],
            'colour keeps the others',
          )
        },
      },
      {
        // Layers are composited into the vertex colours: each layer setter
        // re-uploads that mesh only.
        name: 'layer',
        run: async ({ nv, view, p, check }) => {
          await nv.setMesh(0, { color: [1, 1, 1, 1] })
          const before = nv.meshes.map((m) => view()._getMeshGpu(m))
          await nv.addMeshLayer(0, {
            url: p.sphereLayer(),
            colormap: 'green',
            calMin: 0,
            calMax: 12,
            opacity: 1,
          })
          const now = nv.meshes.map((m) => view()._getMeshGpu(m))
          check(now[0] !== before[0], 'addMeshLayer re-uploads the mesh')
          check(
            now[1] === before[1] && now[2] === before[2],
            'addMeshLayer keeps the others',
          )
        },
      },
      {
        name: 'layer-blue',
        run: async ({ nv, view, check }) => {
          const before = view()._getMeshGpu(nv.meshes[0])
          await nv.setMeshLayerProperty(0, 0, { colormap: 'blue' })
          check(
            view()._getMeshGpu(nv.meshes[0]) !== before,
            'setMeshLayerProperty re-uploads',
          )
        },
      },
      {
        name: 'layer-removed',
        sameAs: 'mesh-edits',
        run: async ({ nv, view, check }) => {
          const before = view()._getMeshGpu(nv.meshes[0])
          await nv.removeMeshLayer(0, 0)
          check(
            view()._getMeshGpu(nv.meshes[0]) !== before,
            'removeMeshLayer re-uploads',
          )
        },
      },
      {
        // updateMeshPositions falling back to a rebuild (no writable buffer,
        // as mid-rebuild) must re-upload the moved mesh.
        name: 'shrunk',
        run: async ({ nv, view, check, settle }) => {
          const pts = nv.meshes[0].positions
          const c = [0, 0, 0]
          const n = pts.length / 3
          for (let i = 0; i < pts.length; i++) c[i % 3] += pts[i] / n
          const shrunk = new Float32Array(pts.length)
          for (let i = 0; i < pts.length; i++)
            shrunk[i] = c[i % 3] + (pts[i] - c[i % 3]) * 0.5
          const old = view()._getMeshGpu(nv.meshes[0])
          const v = view()
          const write = v.updateMeshVertices
          v.updateMeshVertices = () => false
          nv.updateMeshPositions(0, shrunk)
          v.updateMeshVertices = write
          await settle()
          check(view()._getMeshGpu(nv.meshes[0]) !== old, 'fallback uploads')
        },
      },
      {
        // The public full rebuild re-uploads every mesh, same picture.
        name: 'full-rebuild',
        sameAs: 'mesh-edits--shrunk',
        run: async ({ nv, view, check }) => {
          const before = nv.meshes.map((m) => view()._getMeshGpu(m))
          await nv.updateGLVolume()
          const now = nv.meshes.map((m) => view()._getMeshGpu(m))
          check(
            now.every((x, i) => x !== null && x !== before[i]),
            'updateGLVolume re-uploads every mesh',
          )
        },
      },
    ],
  },
  {
    // A finite meshThicknessOn2D slab follows the displayed voxel plane
    // (#451): on an oblique volume, moving within the slice keeps the voxel
    // plane and so the mesh, though the world depth changes.
    name: 'mesh-slab',
    options: { sliceType: 0, meshThicknessOn2D: 3 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.oblique() }])
      await nv.loadMeshes([
        { url: p.sphereMesh(), rgba255: [255, 255, 0, 255] },
      ])
      // Onto a voxel centre, so the moves below stay in this voxel plane.
      nv.moveCrosshairInVox(0, 0, 0)
      const depth = nv.model.scene2mm(nv.model.scene.crosshairPos)[2]
      ;(globalThis as unknown as Stash).__e2e = { depth }
    },
    steps: [
      {
        name: 'right',
        sameAs: 'mesh-slab',
        run: async ({ nv }) => {
          nv.moveCrosshairInVox(8, 0, 0)
        },
      },
      {
        name: 'left',
        sameAs: 'mesh-slab',
        run: async ({ nv, check }) => {
          const right = nv.model.scene2mm(nv.model.scene.crosshairPos)[2]
          nv.moveCrosshairInVox(-16, 0, 0)
          const left = nv.model.scene2mm(nv.model.scene.crosshairPos)[2]
          // The moves really cross world depth: the slice is oblique.
          check(Math.abs(right - left) > 3, `depth ${right} vs ${left}`)
        },
      },
      {
        // The whole slab draws over the slice: hiding it reveals no more.
        name: 'no-slice',
        run: async ({ nv }) => {
          await nv.setVolume(0, { opacity: 0 })
        },
      },
    ],
  },
  {
    // Meshes inside a slab x-ray each other: a red square above a blue one.
    name: 'mesh-xray',
    options: { sliceType: 0, meshThicknessOn2D: 3, meshXRay: 0 },
    setup: async ({ nv, p }) => {
      const square = (z: number, name: string) =>
        p.obj(
          name,
          [
            [-20, -20, z],
            [20, -20, z],
            [20, 20, z],
            [-20, 20, z],
          ],
          [
            [0, 1, 2],
            [0, 2, 3],
          ],
        )
      await nv.loadMeshes([
        { url: square(1, 'red.obj'), rgba255: [255, 0, 0, 255] },
        { url: square(-1, 'blue.obj'), rgba255: [0, 0, 255, 255] },
      ])
    },
    steps: [
      {
        name: 'xray',
        run: async ({ nv }) => {
          nv.meshXRay = 0.5
        },
      },
    ],
  },
  {
    // crosscut2 outlines the mesh where it meets the DISPLAYED voxel plane:
    // within an oblique axial slice the outline holds still (#92).
    name: 'crosscut2-oblique',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.oblique() }])
      await nv.loadMeshes([
        { url: p.sphereMesh(), color: [0, 1, 0, 1], shaderType: 'crosscut2' },
      ])
      // Onto a voxel centre, so the move below stays in this voxel plane.
      nv.moveCrosshairInVox(0, 0, 0)
    },
    steps: [
      {
        name: 'moved',
        sameAs: 'crosscut2-oblique',
        run: async ({ nv }) => {
          nv.moveCrosshairInVox(6, -4, 0)
        },
      },
    ],
  },
  {
    // A wall seen exactly edge-on rasterizes to nothing, so fragment crosscut
    // draws nothing; crosscut2 builds the outline as geometry.
    name: 'crosscut2-edge-on',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadMeshes([
        {
          url: p.obj(
            'wall.obj',
            [
              [0, -40, -40],
              [0, 40, -40],
              [0, 40, 40],
              [0, -40, 40],
            ],
            [
              [0, 1, 2],
              [0, 2, 3],
            ],
          ),
          color: [0, 1, 0, 1],
          shaderType: 'crosscut',
        },
      ])
      nv.setCrosshairPos([0, 0, 0])
    },
    steps: [
      {
        name: 'crosscut2',
        run: async ({ nv }) => {
          await nv.setMesh(0, { shaderType: 'crosscut2' })
        },
      },
    ],
  },
  {
    // Culling bounds are cached per mesh; the documented full rebuild must
    // refresh them after an untracked in-place index edit. Two walls in
    // x = 0: z in [-40, -10] (drawn) and z in [10, 40] (spare).
    name: 'crosscut2-index-edit',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadMeshes([
        {
          url: p.obj(
            'walls.obj',
            [
              [0, -40, -40],
              [0, 40, -40],
              [0, 40, -10],
              [0, -40, -10],
              [0, -40, 10],
              [0, 40, 10],
              [0, 40, 40],
              [0, -40, 40],
            ],
            [
              [0, 1, 2],
              [0, 2, 3],
            ],
          ),
          color: [0, 1, 0, 1],
          shaderType: 'crosscut2',
        },
      ])
      nv.setCrosshairPos([0, 0, 25])
    },
    steps: [
      {
        name: 'edited',
        run: async ({ nv }) => {
          nv.meshes[0].indices.set([4, 5, 6, 4, 6, 7])
          await nv.updateGLVolume()
        },
      },
    ],
  },
  {
    // A live vertex update refreshes the culling bounds and the WebGL2
    // vertex texture (rewritten in place when its size is unchanged); the
    // second move must replace what the first wrote.
    name: 'crosscut2-positions',
    sameAs: 'crosscut2-index-edit',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadMeshes([
        {
          url: p.obj(
            'wall.obj',
            [
              [0, -40, -40],
              [0, 40, -40],
              [0, 40, -10],
              [0, -40, -10],
              [0, -40, 10],
              [0, 40, 10],
              [0, 40, 40],
              [0, -40, 40],
            ],
            [
              [0, 1, 2],
              [0, 2, 3],
            ],
          ),
          color: [0, 1, 0, 1],
          shaderType: 'crosscut2',
        },
      ])
      nv.setCrosshairPos([0, 0, 25])
    },
    steps: [
      {
        name: 'moved',
        sameAs: 'crosscut2-index-edit--edited',
        run: async ({ nv }) => {
          const moved = Float32Array.from(nv.meshes[0].positions)
          for (let v = 0; v < 4; v++) moved[v * 3 + 2] += 50
          nv.updateMeshPositions(0, moved)
        },
      },
      {
        name: 'restored',
        sameAs: 'crosscut2-index-edit',
        run: async ({ nv }) => {
          const back = Float32Array.from(nv.meshes[0].positions)
          for (let v = 0; v < 4; v++) back[v * 3 + 2] -= 50
          nv.updateMeshPositions(0, back)
        },
      },
    ],
  },
  {
    // Translucent blending depends on triangle order, so crosscut2's cluster
    // order must stay in its own index copy: the render tile draws the same
    // before and after crosscut2 was the slice shader.
    name: 'crosscut2-translucent',
    options: { sliceType: 3, showRender: 1, multiplanarType: 2 },
    setup: async ({ nv, p }) => {
      await nv.loadMeshes([{ url: p.sphereMesh(), opacity: 0.5 }])
    },
    steps: [
      {
        name: 'crosscut2',
        run: async ({ nv }) => {
          await nv.setMesh(0, { sliceShaderType: 'crosscut2' })
        },
      },
      {
        name: 'restored',
        sameAs: 'crosscut2-translucent',
        run: async ({ nv }) => {
          await nv.setMesh(0, { sliceShaderType: '' })
        },
      },
    ],
  },
]

registerScenes(SCENES)
