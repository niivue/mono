import type NiiVue from '../src/NVControl'
import { registerScenes, type Scene } from './renderHarness'

// Reference images for live data updates: each step edits loaded data
// (updateVolumeData, updateMeshPositions, isDirty in-place edits, colormap
// re-registration, chunk plan swaps) and the capture after it must show the
// new data, while `check`s pin how the result was reached (which GPU
// resources were kept, which passes ran). See renderHarness.ts for how scenes
// run and how to update the references.

type Img = Uint8Array
type Cache = {
  inputTexture?: unknown
  sourceTexture?: unknown
  dataVersion?: number
} | null
type Plan = Parameters<NiiVue['swapVolumeChunkPlan']>[1]
// State one step hands to the next; the shared page's reset deletes it.
type Stash = { __e2e: Record<string, unknown> }

// Edits write a checkerboard of 4-voxel squares (60 / 200) on the shared
// 32^3 grid, `p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60))`
// (scenes cannot share a helper): an edit's result can only match its
// reference if the new voxels are drawn.

const SCENES: Scene[] = [
  // ---- updateVolumeData / updateMeshPositions fast paths ----
  {
    // The orient caches key on the `img` buffer, which an in-place edit
    // keeps: before `_dataVersion` an edited volume drew its old voxels. The
    // edit re-uploads into the existing cache and leaves meshes alone.
    name: 'volume-data',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy() }])
      await nv.loadMeshes([{ url: p.sphereMesh(), opacity: 0 }])
    },
    steps: [
      {
        name: 'replaced',
        run: async ({ nv, view, p, check }) => {
          const mesh = view()._getMeshGpu(nv.meshes[0])
          const cache = view().volumeRenderer.volumeOrientCache as Cache
          const source = cache?.inputTexture ?? cache?.sourceTexture
          await nv.updateVolumeData(
            0,
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
          const after = view().volumeRenderer.volumeOrientCache as Cache
          check(view()._getMeshGpu(nv.meshes[0]) === mesh, 'mesh kept')
          check(
            cache &&
              after === cache &&
              (after?.inputTexture ?? after?.sourceTexture) === source,
            'orient cache and source texture kept',
          )
        },
      },
      {
        // The caller edits `img` in place, then calls without data.
        name: 'in-place',
        sameAs: 'volume-data',
        run: async ({ nv, p }) => {
          ;(nv.volumes[0].img as Img).set(p.anatomyImg())
          await nv.updateVolumeData(0)
        },
      },
    ],
  },
  {
    // Editing an overlay re-runs only the overlay pass, through its cache.
    name: 'overlay-data',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1 },
      ])
    },
    steps: [
      {
        // The left half of the mask only.
        name: 'half',
        run: async ({ nv, view, check }) => {
          const renderer = view().volumeRenderer
          const cache = renderer.overlayOrientCache
          const update = renderer.updateVolume
          let backgroundPasses = 0
          renderer.updateVolume = (...a: unknown[]) => {
            backgroundPasses++
            return update.apply(renderer, a)
          }
          const half = (nv.volumes[1].img as Img).map((v, i) =>
            i % 32 < 16 ? v : 0,
          )
          await nv.updateVolumeData(1, half)
          renderer.updateVolume = update
          check(backgroundPasses === 0, `background passes ${backgroundPasses}`)
          check(cache && renderer.overlayOrientCache === cache, 'cache kept')
        },
      },
    ],
  },
  {
    // The one-frame form of updateVolumeData writes only the shown frame, and
    // an in-place isDirty edit of it shows too. Frame 1 starts as the
    // checkerboard.
    name: 'frame-data',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      const n = p.N ** 3
      const img = new Uint8Array(2 * n)
      img.set(p.anatomyImg())
      img.set(
        p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
        n,
      )
      await nv.loadVolumes([
        {
          // The window comes from frame 0, the anatomy, as in `volume-data`.
          url: p.nifti({ name: 'two.nii', dims: [32, 32, 32], img, frames: 2 }),
        },
      ])
      await nv.setFrame4D(nv.volumes[0].id, 1)
    },
    steps: [
      {
        name: 'edited',
        sameAs: 'volume-data',
        run: async ({ nv, p, check }) => {
          const v = nv.volumes[0]
          const n = p.N ** 3
          const frame0 = (v.img as Img).slice(0, n)
          await nv.updateVolumeData(0, p.anatomyImg())
          const img = v.img as Img
          check(
            frame0.every((x, i) => img[i] === x),
            'frame 0 untouched',
          )
          check(
            p.anatomyImg().every((x, i) => img[n + i] === x),
            'frame 1 written',
          )
        },
      },
      {
        name: 'dirty',
        sameAs: 'frame-data',
        run: async ({ nv, p }) => {
          const v = nv.volumes[0]
          ;(v.img as Img).set(
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
            p.N ** 3,
          )
          v.isDirty = true
          await nv.updateGLVolume()
        },
      },
    ],
  },
  {
    // updateMeshPositions writes into the existing buffer: no rebuild.
    name: 'mesh-positions',
    options: { sliceType: 4 },
    setup: async ({ nv, p }) => {
      await nv.loadMeshes([{ url: p.sphereMesh(), color: [0.9, 0.7, 0.3, 1] }])
    },
    steps: [
      {
        name: 'shrunk',
        run: async ({ nv, view, check }) => {
          const gpu = view()._getMeshGpu(nv.meshes[0])
          const full = nv.updateGLVolume
          let rebuilds = 0
          nv.updateGLVolume = () => {
            rebuilds++
            return full.call(nv)
          }
          const pts = nv.meshes[0].positions
          const shrunk = pts.map((v) => v * 0.5)
          nv.updateMeshPositions(0, shrunk)
          nv.updateGLVolume = full
          check(view()._getMeshGpu(nv.meshes[0]) === gpu, 'buffer kept')
          check(rebuilds === 0, `full rebuilds ${rebuilds}`)
          check(nv.meshes[0].positions[0] === shrunk[0], 'positions copied')
        },
      },
    ],
  },

  // ---- isDirty in-place edits through the ordinary update path ----
  {
    // Overlay edited in place, then setVolume: re-uploads into the overlay's
    // own texture and leaves the clean background alone.
    name: 'dirty-edits',
    sameAs: 'overlay-data',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1 },
      ])
      ;(globalThis as unknown as Stash).__e2e = {
        bg: (nv.volumes[0].img as Img).slice(),
        ov: (nv.volumes[1].img as Img).slice(),
      }
    },
    steps: [
      {
        name: 'overlay',
        sameAs: 'overlay-data--half',
        run: async ({ nv, view, check }) => {
          const [bg, ov] = nv.volumes
          const r = view().volumeRenderer
          const bgCache = r.volumeOrientCache as Cache
          const bgVersion = bgCache?.dataVersion
          const bgData = (bg as { _dataVersion?: number })._dataVersion
          const ovCache = r.overlayOrientCache as Cache
          const ovSource = ovCache?.inputTexture ?? ovCache?.sourceTexture
          const img = ov.img as Img
          for (let i = 0; i < img.length; i++) if (i % 32 >= 16) img[i] = 0
          ov.isDirty = true
          await nv.setVolume(1, { opacity: 1 })
          const ovAfter = r.overlayOrientCache as Cache
          check(ov.isDirty === false, 'flag cleared')
          check(
            ovCache &&
              ovAfter === ovCache &&
              (ovAfter?.inputTexture ?? ovAfter?.sourceTexture) === ovSource,
            'overlay re-uploaded into its texture',
          )
          check(
            bgCache &&
              r.volumeOrientCache === bgCache &&
              bgCache.dataVersion === bgVersion &&
              (bg as { _dataVersion?: number })._dataVersion === bgData,
            'clean background not re-uploaded',
          )
        },
      },
      {
        name: 'background',
        run: async ({ nv, p }) => {
          const bg = nv.volumes[0]
          ;(bg.img as Img).set(
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
          bg.isDirty = true
          await nv.updateGLVolume()
        },
      },
      {
        // A dirty overlay joins a scoped updateVolumeData of the background.
        name: 'restored',
        sameAs: 'overlay-data',
        run: async ({ nv }) => {
          const s = (globalThis as unknown as Stash).__e2e as {
            bg: Img
            ov: Img
          }
          ;(nv.volumes[1].img as Img).set(s.ov)
          nv.volumes[1].isDirty = true
          await nv.updateVolumeData(0, s.bg)
        },
      },
      {
        // An affine-only update takes the overlay-only fast path when
        // nothing is dirty, and rebuilds (so the edit shows) when the
        // background is.
        name: 'affine',
        run: async ({ nv, view, p, check }) => {
          const v = view()
          const bind = v.updateBindGroups
          if (!bind) throw new Error('no updateBindGroups')
          let binds = 0
          v.updateBindGroups = (...a: unknown[]) => {
            binds++
            return bind.apply(v, a)
          }
          const still = {
            translation: [0, 0, 0],
            rotation: [0, 0, 0],
            scale: [1, 1, 1],
          } as Parameters<NiiVue['applyVolumeTransform']>[1]
          await nv.applyVolumeTransform(1, still)
          check(binds === 0, `fast path ran ${binds} full binds`)
          const bg = nv.volumes[0]
          ;(bg.img as Img).set(
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
          bg.isDirty = true
          await nv.applyVolumeTransform(1, still)
          v.updateBindGroups = bind
          check(binds > 0, 'a dirty background takes the full path')
        },
      },
    ],
  },
  {
    // Re-registering a colormap name replaces the cached colours.
    name: 'colormap-reregister',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      nv.addColormap('liveSwap', { R: [0, 255], G: [0, 0], B: [0, 0] })
      await nv.loadVolumes([{ url: p.anatomy(), colormap: 'liveSwap' }])
    },
    steps: [
      {
        name: 'green',
        run: async ({ nv }) => {
          nv.addColormap('liveSwap', { R: [0, 0], G: [0, 255], B: [0, 0] })
          await nv.updateGLVolume()
        },
      },
    ],
  },
  {
    // View recreation rebuilds every texture; a modulator edited in place and
    // flagged isDirty must have its weights recomputed there too. The red
    // overlay is scaled by the background's windowed intensity.
    name: 'modulation-recreated',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1 },
      ])
      await nv.setModulationImage(nv.volumes[1].id, nv.volumes[0].id, 0)
    },
    steps: [
      {
        name: 'recreated',
        run: async ({ nv, p, check }) => {
          const bg = nv.volumes[0]
          ;(bg.img as Img).set(
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
          bg.isDirty = true
          await nv.reinitializeView({})
          check(bg.isDirty === false, 'flag cleared')
        },
      },
    ],
  },

  // ---- RGB/RGBA volumes keep one texture per slot ----
  {
    // RGB volumes skip the orient pass; they keep one texture and write new
    // voxels into it, and skip the upload while the voxels are unchanged.
    name: 'rgb-data',
    options: { sliceType: 0 },
    setup: async ({ nv, view, p }) => {
      await nv.loadVolumes([{ url: p.rgb() }])
      const v = view()
      // Counts 3D texture allocations and uploads into one texture.
      const allocs = { n: 0 }
      const uploads = { n: 0, into: null as unknown }
      if (v.gl) {
        const gl = v.gl
        const storage = gl.texStorage3D.bind(gl)
        const image = gl.texImage3D.bind(gl)
        const sub = gl.texSubImage3D.bind(gl)
        gl.texStorage3D = (...a: Parameters<typeof storage>) => {
          allocs.n++
          return storage(...a)
        }
        gl.texImage3D = ((...a: Parameters<typeof sub>) => {
          allocs.n++
          return (image as (...b: unknown[]) => void)(...a)
        }) as typeof gl.texImage3D
        gl.texSubImage3D = ((...a: Parameters<typeof sub>) => {
          if (gl.getParameter(gl.TEXTURE_BINDING_3D) === uploads.into)
            uploads.n++
          return (sub as (...b: unknown[]) => void)(...a)
        }) as typeof gl.texSubImage3D
      } else if (v.device) {
        const device = v.device
        const create = device.createTexture.bind(device)
        device.createTexture = (d: GPUTextureDescriptor) => {
          if (d.dimension === '3d') allocs.n++
          return create(d)
        }
        const write = device.queue.writeTexture.bind(device.queue)
        device.queue.writeTexture = (dst, ...a) => {
          if (dst.texture === uploads.into) uploads.n++
          return write(dst, ...a)
        }
        device.addEventListener('uncapturederror', (e) => {
          ;(globalThis as unknown as Stash).__e2e.errors = String(
            (e as GPUUncapturedErrorEvent).error.message,
          )
        })
      }
      ;(globalThis as unknown as Stash).__e2e = {
        allocs,
        uploads,
        original: (nv.volumes[0].img as Img).slice(),
      }
    },
    steps: [
      {
        // Channels rotated: red along y, green inside, blue along x.
        name: 'edited',
        run: async ({ nv, view, check }) => {
          const s = (globalThis as unknown as Stash).__e2e as {
            allocs: { n: number }
            uploads: { n: number; into: unknown }
            original: Img
          }
          const r = view().volumeRenderer
          const tex = r.volumeRgbaCache?.texture
          check(tex && r.volumeTexture === tex, 'volume draws its RGB cache')
          s.allocs.n = 0
          s.uploads.into = tex
          s.uploads.n = 0
          const o = s.original
          const rotated = o.map((_, i) => o[i - (i % 3) + (((i % 3) + 1) % 3)])
          await nv.updateVolumeData(0, rotated)
        },
      },
      {
        name: 'restored',
        sameAs: 'rgb-data',
        run: async ({ nv, view, check }) => {
          const s = (globalThis as unknown as Stash).__e2e as {
            allocs: { n: number }
            uploads: { n: number; into: unknown }
            original: Img
          }
          await nv.updateVolumeData(0, s.original)
          check(s.uploads.n === 2, `uploads for two edits: ${s.uploads.n}`)
          s.uploads.n = 0
          await nv.setVolume(0, { opacity: 1 })
          check(s.uploads.n === 0, `idle update uploads ${s.uploads.n}`)
          check(s.allocs.n === 0, `allocations ${s.allocs.n}`)
          const r = view().volumeRenderer
          check(r.volumeTexture === s.uploads.into, 'texture kept')
        },
      },
      {
        // An overlay on the same grid over a dim background (alpha 10: not
        // lit, not masked), edited: it writes into the kept overlay texture.
        name: 'overlay',
        run: async ({ nv, view, p, check }) => {
          const s = (globalThis as unknown as Stash).__e2e as {
            allocs: { n: number }
            uploads: { n: number; into: unknown }
            original: Img
          }
          const file = p.rgb()
          await nv.loadVolumes([{ url: file }, { url: file }])
          await nv.updateVolumeData(
            0,
            new Uint8Array(s.original.length).fill(10),
          )
          const tex = view().volumeRenderer.overlayRgbaCache?.texture
          check(tex, 'overlay RGB cache')
          s.uploads.into = tex
          s.allocs.n = 0
          const o = s.original
          const rotated = o.map((_, i) => o[i - (i % 3) + (((i % 3) + 1) % 3)])
          await nv.updateVolumeData(1, rotated)
          await nv.updateVolumeData(1, o)
          s.uploads.n = 0
          await nv.setVolume(1, { opacity: 1 })
          check(s.uploads.n === 0, `idle overlay uploads ${s.uploads.n}`)
          check(s.allocs.n === 0, `overlay allocations ${s.allocs.n}`)
          check(
            view().volumeRenderer.overlayRgbaCache?.texture === tex,
            'overlay texture kept',
          )
        },
      },
      {
        // Background masking must not free the kept overlay texture (the
        // WebGPU mask pass used to destroy its input), and edits still show.
        name: 'masked-edit',
        run: async ({ nv, view, check, settle }) => {
          const s = (globalThis as unknown as Stash).__e2e as {
            uploads: { into: unknown }
            original: Img
          }
          nv.volumeIsBackgroundMasking = true
          await settle()
          const o = s.original
          const rotated = o.map((_, i) => o[i - (i % 3) + (((i % 3) + 1) % 3)])
          await nv.updateVolumeData(1, rotated)
          check(
            view().volumeRenderer.overlayRgbaCache?.texture === s.uploads.into,
            'masking keeps the overlay texture',
          )
        },
      },
      {
        name: 'masked-restored',
        sameAs: 'rgb-data--overlay',
        run: async ({ nv }) => {
          const s = (globalThis as unknown as Stash).__e2e as { original: Img }
          await nv.updateVolumeData(1, s.original)
        },
      },
      {
        // A black background masks the whole overlay out.
        name: 'masked-out',
        run: async ({ nv }) => {
          const s = (globalThis as unknown as Stash).__e2e as { original: Img }
          await nv.updateVolumeData(0, new Uint8Array(s.original.length))
        },
      },
      {
        // The masking setter alone rebuilds the overlay (#367), and the
        // overlay's own voxels come back (WebGL2 masks in place).
        name: 'unmasked',
        run: async ({ nv }) => {
          nv.volumeIsBackgroundMasking = false
        },
      },
      {
        name: 'unmasked-updated',
        sameAs: 'rgb-data--unmasked',
        run: async ({ nv }) => {
          await nv.setVolume(1, { opacity: 1 })
        },
      },
      {
        name: 'masked-by-setter',
        sameAs: 'rgb-data--masked-out',
        run: async ({ nv }) => {
          nv.volumeIsBackgroundMasking = true
        },
      },
      {
        // A scalar overlay under masking (the WebGPU mask pass also freed the
        // scalar orient cache's output): its edits show too.
        name: 'scalar-masked',
        sameAs: 'overlay-data',
        run: async ({ nv, p }) => {
          await nv.loadVolumes([
            { url: p.anatomy() },
            { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1 },
          ])
          ;(globalThis as unknown as Stash).__e2e.mask = (
            nv.volumes[1].img as Img
          ).slice()
        },
      },
      {
        name: 'scalar-half',
        sameAs: 'overlay-data--half',
        run: async ({ nv }) => {
          const half = (nv.volumes[1].img as Img).map((v, i) =>
            i % 32 < 16 ? v : 0,
          )
          await nv.updateVolumeData(1, half)
        },
      },
      {
        name: 'scalar-restored',
        sameAs: 'overlay-data',
        run: async ({ nv }) => {
          const { mask } = (globalThis as unknown as Stash).__e2e as {
            mask: Img
          }
          await nv.updateVolumeData(1, mask)
        },
      },
      {
        // Editing a modulator rewrites only its target's weights.
        name: 'modulator-edited',
        run: async ({ nv, view, p, check }) => {
          const [bg, ov] = nv.volumes
          await nv.setModulationImage(ov.id, bg.id)
          const cache = view().volumeRenderer.overlayOrientCache
          await nv.updateVolumeData(
            0,
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
          check(
            view().volumeRenderer.overlayOrientCache === cache,
            'target cache kept',
          )
          const errors = (globalThis as unknown as Stash).__e2e.errors
          check(!errors, `GPU errors: ${errors}`)
        },
      },
    ],
  },
  {
    // A 4D RGB volume shows the selected frame (prepareRGBAData once read
    // frame 0 always): frame 1 is blank, then written, then cleared.
    name: 'rgb-4d',
    sameAs: 'rgb-data',
    options: { sliceType: 0 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.rgb() }])
      const v = nv.volumes[0]
      const frame = (v.img as Img).slice()
      const img = new Uint8Array(frame.length * 2)
      img.set(frame)
      v.img = img
      v.nFrame4D = 2
      v.isDirty = true
      await nv.updateGLVolume()
      ;(globalThis as unknown as Stash).__e2e = { frame }
    },
    steps: [
      {
        name: 'frame1',
        run: async ({ nv }) => {
          await nv.setFrame4D(nv.volumes[0].id, 1)
        },
      },
      {
        name: 'frame1-written',
        sameAs: 'rgb-data',
        run: async ({ nv }) => {
          const { frame } = (globalThis as unknown as Stash).__e2e as {
            frame: Img
          }
          await nv.updateVolumeData(0, frame)
        },
      },
      {
        name: 'frame1-cleared',
        sameAs: 'rgb-4d--frame1',
        run: async ({ nv, check }) => {
          const { frame } = (globalThis as unknown as Stash).__e2e as {
            frame: Img
          }
          await nv.updateVolumeData(0, new Uint8Array(frame.length))
          const img = nv.volumes[0].img as Img
          check(
            frame.every((x, i) => img[i] === x),
            'frame 0 intact',
          )
        },
      },
      {
        name: 'frame0',
        sameAs: 'rgb-data',
        run: async ({ nv }) => {
          await nv.setFrame4D(nv.volumes[0].id, 0)
        },
      },
    ],
  },

  // ---- chunk plan swaps ----
  {
    // A chunk-plan swap (multi-LOD refocus) must survive a texture refresh
    // that lands while it awaits its uploader: the refresh must not evict
    // the cached entry with every brick it holds while the swap goes on to
    // mutate it. The replacement plan has the same content, so a correct
    // swap keeps the entry and every brick, and each capture shows the
    // whole ball in the current colormap. A 32^3 ball in a forced 2^3 plan.
    name: 'swap-race',
    options: { sliceType: 4 },
    setup: async ({ nv, view, lib, p, check, settle }) => {
      const errors: string[] = []
      const error = console.error
      console.error = (...a: unknown[]) => {
        errors.push(a.map(String).join(' '))
        error(...a)
      }
      ;(globalThis as unknown as Stash).__e2e = { errors }
      const ball = p.grid((x, y, z) =>
        Math.hypot(x - 16, y - 16, z - 16) < 14.4
          ? 50 + ((x + y + z) % 200)
          : 0,
      )
      await nv.loadVolumes([
        { url: p.nifti({ name: 'ball.nii', dims: [32, 32, 32], img: ball }) },
      ])
      const vol = nv.volumes[0]
      vol.chunkPlan = lib.chunkVolumeGrid(
        [32, 32, 32],
        [2, 2, 2],
        4096,
        [3, 3, 3],
      ) as typeof vol.chunkPlan
      await nv.updateGLVolume()
      await settle()
      check(nv.chunkStreamStats()?.resident === 8, 'every brick resident')
      // Control: the swap on its own keeps the entry and every brick.
      const { volumeCacheKey } = await import('/src/volume/orientChunked.ts')
      const cache = view().volumeRenderer._texCache
      const before = cache.get(volumeCacheKey(vol))
      const quiet = lib.chunkVolumeGrid(
        [32, 32, 32],
        [2, 2, 2],
        4096,
        [3, 3, 3],
      ) as Plan
      await nv.swapVolumeChunkPlan(vol.id, quiet)
      const after = cache.get(volumeCacheKey(vol))
      check(
        after === before && after?.plan === quiet,
        'quiet swap keeps the entry',
      )
      check(
        nv.chunkStreamStats()?.resident === 8,
        'quiet swap keeps the bricks',
      )
    },
    steps: [
      {
        name: 'update-refresh-first',
        sameAs: 'swap-race',
        run: async ({ nv, view, lib, check, settle }) => {
          const vol = nv.volumes[0]
          const cache = view().volumeRenderer._texCache
          const { volumeCacheKey } = await import(
            '/src/volume/orientChunked.ts'
          )
          const key = volumeCacheKey(vol)
          await settle()
          check(nv.chunkStreamStats()?.resident === 8, 'filled before the race')
          const old = cache.get(key)
          const plan = lib.chunkVolumeGrid(
            [32, 32, 32],
            [2, 2, 2],
            4096,
            [3, 3, 3],
          ) as Plan
          const refresh = nv.updateGLVolume()
          const swap = nv.swapVolumeChunkPlan(vol.id, plan)
          await Promise.all([swap, refresh])
          const live = cache.get(key)
          check(live === old, 'the swapped entry is kept')
          check(live?.plan === plan, 'the entry holds the new plan')
          // Bricks held by an evicted entry would never be freed.
          check(
            live === old || !old?.manager.residentCount,
            'no orphaned bricks',
          )
          // updateGLVolume changes nothing the bricks bake in: it keeps them.
          check(nv.chunkStreamStats()?.resident === 8, 'bricks kept')
          const { errors } = (globalThis as unknown as Stash).__e2e as {
            errors: string[]
          }
          check(errors.length === 0, `errors: ${errors}`)
        },
      },
      {
        name: 'update-swap-first',
        sameAs: 'swap-race',
        run: async ({ nv, view, lib, check, settle }) => {
          const vol = nv.volumes[0]
          const cache = view().volumeRenderer._texCache
          const { volumeCacheKey } = await import(
            '/src/volume/orientChunked.ts'
          )
          const key = volumeCacheKey(vol)
          await settle()
          check(nv.chunkStreamStats()?.resident === 8, 'filled before the race')
          const old = cache.get(key)
          const plan = lib.chunkVolumeGrid(
            [32, 32, 32],
            [2, 2, 2],
            4096,
            [3, 3, 3],
          ) as Plan
          const swap = nv.swapVolumeChunkPlan(vol.id, plan)
          const refresh = nv.updateGLVolume()
          await Promise.all([swap, refresh])
          const live = cache.get(key)
          check(live === old, 'the swapped entry is kept')
          check(live?.plan === plan, 'the entry holds the new plan')
          // Bricks held by an evicted entry would never be freed.
          check(
            live === old || !old?.manager.residentCount,
            'no orphaned bricks',
          )
          // updateGLVolume changes nothing the bricks bake in: it keeps them.
          check(nv.chunkStreamStats()?.resident === 8, 'bricks kept')
          const { errors } = (globalThis as unknown as Stash).__e2e as {
            errors: string[]
          }
          check(errors.length === 0, `errors: ${errors}`)
        },
      },
      {
        name: 'hot-refresh-first',
        run: async ({ nv, view, lib, check, settle }) => {
          const vol = nv.volumes[0]
          const cache = view().volumeRenderer._texCache
          const { volumeCacheKey } = await import(
            '/src/volume/orientChunked.ts'
          )
          const key = volumeCacheKey(vol)
          await settle()
          check(nv.chunkStreamStats()?.resident === 8, 'filled before the race')
          const old = cache.get(key)
          const plan = lib.chunkVolumeGrid(
            [32, 32, 32],
            [2, 2, 2],
            4096,
            [3, 3, 3],
          ) as Plan
          const refresh = nv.setVolume(0, { colormap: 'hot' })
          const swap = nv.swapVolumeChunkPlan(vol.id, plan)
          await Promise.all([swap, refresh])
          const live = cache.get(key)
          check(live === old, 'the swapped entry is kept')
          check(live?.plan === plan, 'the entry holds the new plan')
          // Bricks held by an evicted entry would never be freed.
          check(
            live === old || !old?.manager.residentCount,
            'no orphaned bricks',
          )
          const { errors } = (globalThis as unknown as Stash).__e2e as {
            errors: string[]
          }
          check(errors.length === 0, `errors: ${errors}`)
        },
      },
      {
        name: 'winter-swap-first',
        run: async ({ nv, view, lib, check, settle }) => {
          const vol = nv.volumes[0]
          const cache = view().volumeRenderer._texCache
          const { volumeCacheKey } = await import(
            '/src/volume/orientChunked.ts'
          )
          const key = volumeCacheKey(vol)
          await settle()
          check(nv.chunkStreamStats()?.resident === 8, 'filled before the race')
          const old = cache.get(key)
          const plan = lib.chunkVolumeGrid(
            [32, 32, 32],
            [2, 2, 2],
            4096,
            [3, 3, 3],
          ) as Plan
          const swap = nv.swapVolumeChunkPlan(vol.id, plan)
          const refresh = nv.setVolume(0, { colormap: 'winter' })
          await Promise.all([swap, refresh])
          const live = cache.get(key)
          check(live === old, 'the swapped entry is kept')
          check(live?.plan === plan, 'the entry holds the new plan')
          // Bricks held by an evicted entry would never be freed.
          check(
            live === old || !old?.manager.residentCount,
            'no orphaned bricks',
          )
          const { errors } = (globalThis as unknown as Stash).__e2e as {
            errors: string[]
          }
          check(errors.length === 0, `errors: ${errors}`)
        },
      },
      {
        // A colormap set but not yet refreshed: the resident bricks still
        // bake the old one, so a swap must re-stream rather than carry them
        // into the new plan.
        name: 'unrefreshed-colormap',
        run: async ({ nv, lib, check, settle }) => {
          await settle()
          const vol = nv.volumes[0]
          vol.colormap = 'hot'
          await nv.swapVolumeChunkPlan(
            vol.id,
            lib.chunkVolumeGrid(
              [32, 32, 32],
              [2, 2, 2],
              4096,
              [3, 3, 3],
            ) as Plan,
          )
          const resident = nv.chunkStreamStats()?.resident
          check(resident === 1, `stale bricks carried over: ${resident}`)
        },
        sameAs: 'swap-race--hot-refresh-first',
      },
    ],
  },
  {
    // setVolumeChunkGrid resolves with every brick of a 3D view resident and
    // drawn (whenChunkStreamSettles behaviour is in chunk-stream-settle).
    name: 'chunk-grid-3d',
    options: { sliceType: 4 },
    setup: async ({ nv, p, check }) => {
      const ball = p.grid((x, y, z) =>
        Math.hypot(x - 16, y - 16, z - 16) < 14.4
          ? 50 + ((x + y + z) % 200)
          : 0,
      )
      await nv.loadVolumes([
        { url: p.nifti({ name: 'ball.nii', dims: [32, 32, 32], img: ball }) },
      ])
      await nv.setVolumeChunkGrid(0, [2, 2, 2])
      const s = nv.chunkStreamStats()
      check(
        s?.resident === 8 && s.total === 8 && s.pending + s.inFlight === 0,
        `stream ${JSON.stringify(s)}`,
      )
    },
  },

  // ---- cached textures keyed by url/name ----
  {
    // Multi-instance mode caches each volume's baked texture by url/name; a
    // colormap change, a re-registered colormap name, a new window or an
    // in-place edit must each rebuild it.
    name: 'instance-display',
    options: {
      instances: [
        {
          id: 'only',
          bounds: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    },
    setup: async ({ nv, p }) => {
      nv.addColormap('instSwap', {
        R: [0, 255],
        G: [0, 0],
        B: [0, 0],
        A: [0, 255],
      })
      await nv.loadVolumes([{ url: p.anatomy(), colormap: 'red' }])
      await nv.setInstances([
        {
          id: 'only',
          bounds: [
            [0, 0],
            [1, 1],
          ],
        },
      ])
    },
    steps: [
      {
        name: 'green',
        run: async ({ nv }) => {
          await nv.setVolume(0, { colormap: 'green' })
        },
      },
      {
        // Every voxel below calMin.
        name: 'windowed-out',
        run: async ({ nv }) => {
          await nv.setVolume(0, { calMin: 1e9, calMax: 2e9 })
        },
      },
      {
        name: 'swap-red',
        run: async ({ nv }) => {
          await nv.setVolume(0, {
            colormap: 'instSwap',
            calMin: 40,
            calMax: 255,
          })
        },
      },
      {
        name: 'swap-green',
        run: async ({ nv }) => {
          nv.addColormap('instSwap', {
            R: [0, 0],
            G: [0, 255],
            B: [0, 0],
            A: [0, 255],
          })
          await nv.updateGLVolume()
        },
      },
      {
        name: 'checker',
        run: async ({ nv, p }) => {
          await nv.updateVolumeData(
            0,
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
        },
      },
    ],
  },
  {
    // A volume drawn as chunks bakes its bricks, and chunkedDisplayKey
    // decides when to re-stream them: an isDirty edit must re-stream.
    name: 'chunked-dirty',
    sameAs: 'volume-data',
    options: { sliceType: 0 },
    setup: async ({ nv, lib, p, check }) => {
      await nv.loadVolumes([{ url: p.anatomy() }])
      const v = nv.volumes[0]
      v.chunkPlan = lib.chunkVolumeGrid(
        [32, 32, 32],
        [2, 2, 2],
        4096,
        [3, 3, 3],
      ) as typeof v.chunkPlan
      await nv.updateGLVolume()
      check(nv.chunkStreamStats(), 'volume is chunked')
      ;(globalThis as unknown as Stash).__e2e = { img: (v.img as Img).slice() }
    },
    steps: [
      {
        name: 'edited',
        sameAs: 'volume-data--replaced',
        run: async ({ nv, p }) => {
          const v = nv.volumes[0]
          ;(v.img as Img).set(
            p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60)),
          )
          v.isDirty = true
          await nv.updateGLVolume()
        },
      },
      {
        name: 'restored',
        sameAs: 'volume-data',
        run: async ({ nv }) => {
          const v = nv.volumes[0]
          const { img } = (globalThis as unknown as Stash).__e2e as { img: Img }
          ;(v.img as Img).set(img)
          v.isDirty = true
          await nv.updateGLVolume()
        },
      },
      {
        // New voxels assigned to `img` at the same data version (the way a
        // reload starts at version 0) must not match the cached bricks.
        name: 'replaced',
        sameAs: 'volume-data--replaced',
        run: async ({ nv, p, check }) => {
          const v = nv.volumes[0] as {
            _dataVersion?: number
          } & (typeof nv.volumes)[0]
          const version = v._dataVersion
          v.img = p.grid((x, y) => (((x >> 2) + (y >> 2)) % 2 ? 200 : 60))
          await nv.updateGLVolume()
          check(v._dataVersion === version, 'same data version')
        },
      },
    ],
  },
  {
    // The same for the multi-instance texture cached under the same name.
    name: 'instance-replaced',
    options: {
      instances: [
        {
          id: 'only',
          bounds: [
            [0, 0],
            [1, 1],
          ],
        },
      ],
    },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy() }])
      await nv.setInstances([
        {
          id: 'only',
          bounds: [
            [0, 0],
            [1, 1],
          ],
        },
      ])
    },
    steps: [
      {
        name: 'replaced',
        run: async ({ nv, p }) => {
          nv.volumes[0].img = p.grid((x, y) =>
            ((x >> 2) + (y >> 2)) % 2 ? 200 : 60,
          )
          await nv.updateGLVolume()
        },
      },
    ],
  },
  {
    // setBaseCoarseFloor skips re-orienting a level it already baked, but not
    // after an edit, a new buffer, or for a loaded volume passed as the floor
    // (whose own texture must follow the edit too).
    name: 'coarse-floor',
    sameAs: 'overlay-data',
    options: { sliceType: 0 },
    setup: async ({ nv, view, p, check }) => {
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1 },
      ])
      const ov = nv.volumes[1]
      // A separate level, as an app supplies one (not one of nv.volumes).
      const floor = Object.assign(
        Object.create(Object.getPrototypeOf(ov)),
        ov,
        {
          img: (ov.img as Img).slice(),
        },
      ) as typeof ov
      const tex = () => view().volumeRenderer.coarseFloorTexture
      await nv.setBaseCoarseFloor(floor)
      const first = tex()
      check(first, 'floor texture built')
      await nv.setBaseCoarseFloor(floor)
      check(tex() === first, 'unchanged floor reused')
      ;(floor.img as Img).fill(0)
      floor.isDirty = true
      await nv.setBaseCoarseFloor(floor)
      const edited = tex()
      check(edited !== first && floor.isDirty === false, 'edit re-oriented')
      floor.img = (floor.img as Img).slice()
      await nv.setBaseCoarseFloor(floor)
      check(tex() !== edited, 'new buffer re-oriented')
      await nv.setBaseCoarseFloor(null)
    },
    steps: [
      {
        // A loaded volume passed as the floor: its own texture follows the
        // edit too, not only the floor.
        name: 'loaded-floor',
        sameAs: 'overlay-data--half',
        run: async ({ nv, view, check }) => {
          const ov = nv.volumes[1]
          const tex = () => view().volumeRenderer.coarseFloorTexture
          await nv.setBaseCoarseFloor(ov)
          const first = tex()
          const img = ov.img as Img
          for (let i = 0; i < img.length; i++) if (i % 32 >= 16) img[i] = 0
          ov.isDirty = true
          await nv.setBaseCoarseFloor(ov)
          check(tex() !== first && ov.isDirty === false, 'floor rebuilt')
          await nv.setBaseCoarseFloor(null)
        },
      },
    ],
  },
]

registerScenes(SCENES)
