import { expect } from '@playwright/test'
import { webgpuUse } from './launchOptions'
import { test } from './sharedPage'

// ENG-13 through the controller: with only the 3D slide plane drawn,
// setSlidePlaneIndex holds the old plane on screen until the new plane's
// tiles are resident, then shows it whole. A 2-plane grey source (z0 60,
// z1 200) whose z1 reads wait for a gate; frames are read with getCanvasImage.

test.use(webgpuUse)

for (const backend of ['webgl2', 'webgpu'] as const)
  test(`a 3D slide plane switch holds, then shows the new plane whole (${backend})`, async ({
    page,
  }) => {
    const result = await page.evaluate(`(async () => {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        const adapter = await navigator.gpu.requestAdapter().catch(() => null)
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, NVSlide, SLICE_TYPE, axialPlaneTransform } =
        await import('/src/index.ts')
      const W = 32, T = 16
      const manifestOf = (z) => ({
        id: 'planes', name: 'planes', width: W, height: W, dtype: 'uint8', channels: 'gray',
        channelInfo: [{ name: 'g', active: true }],
        levels: [{ index: 0, width: W, height: W, downsample: 1, columns: 2, rows: 2,
          tileWidth: T, tileHeight: T, bitsStored: 8, plane: { z, t: 0 },
          tiles: [0, 1, 2, 3].map((i) => ({ x: i % 2, y: i >> 1, width: T, height: T })) }],
      })
      let open
      const gate = new Promise((res) => { open = res })
      const slide = NVSlide.fromSource({
        manifest: manifestOf(0),
        planes: { z: 2, t: 1 },
        preparePlane: async (p) => manifestOf(p.z),
        bind() {},
        fetchTileBytes: async () => { throw new Error('samples only') },
        fetchTileSamples: async (level) => {
          if (level.plane.z === 1) await gate
          return { samples: new Uint8Array(T * T).fill(level.plane.z ? 200 : 60),
            width: T, height: T, bitsStored: 8, planes: 1 }
        },
      })
      const c = document.createElement('canvas')
      c.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px'
      document.body.appendChild(c)
      const nv = new NiiVue({ backend: '${backend}', devicePixelRatio: 1,
        sliceType: SLICE_TYPE.RENDER, isAntiAlias: false, backgroundColor: [0, 0, 0, 1],
        isOrientCubeVisible: false, isOrientationTextVisible: false })
      await nv.attachToCanvas(c)
      if (nv.backend !== '${backend}') return { skip: 'fell back to ' + nv.backend }
      nv.azimuth = 0
      nv.elevation = 90
      const pixelToWorld = axialPlaneTransform(W, W, {
        xmin: -50, xmax: 50, ymin: -50, ymax: 50, z: 0,
      })
      nv.setSlidePlane(slide, { pixelToWorld, isNearestInterpolation: true })
      // Pixels of the old (60) and new (200) grey in one controller frame.
      const frame = () => {
        const d = nv.getCanvasImage().data
        let old = 0, next = 0
        for (let i = 0; i < d.length; i += 4) {
          const g = d[i]
          if (Math.abs(d[i + 1] - g) > 4 || Math.abs(d[i + 2] - g) > 4) continue
          if (Math.abs(g - 60) <= 6) old++
          else if (Math.abs(g - 200) <= 6) next++
        }
        return { old, next }
      }
      const tick = () => new Promise((res) => setTimeout(res, 20))
      const z0 = [0, 1, 2, 3].map((i) => slide.tileKey(slide.manifest.levels[0], { x: i % 2, y: i >> 1 }))
      for (let i = 0; i < 100 && !z0.every((k) => slide.cachedTile(k)); i++) {
        frame()
        await tick()
      }
      const before = frame()
      let committed = null
      const switching = nv.setSlidePlaneIndex({ z: 1, t: 0 }).then((r) => { committed = r })
      const during = []
      for (let i = 0; i < 5; i++) {
        await tick()
        during.push({ ...frame(), committed })
      }
      open()
      const after = []
      for (let i = 0; i < 100 && committed === null; i++) {
        await tick()
        after.push(frame())
      }
      await switching
      after.push(frame())
      const plane = nv.slidePlaneIndex
      nv.destroy()
      c.remove()
      slide.dispose()
      return { before, during, after, committed, plane }
    })()`)
    type Counts = { old: number; next: number }
    const r = result as {
      skip?: string
      before: Counts
      during: Array<Counts & { committed: boolean | null }>
      after: Counts[]
      committed: boolean
      plane: { z: number; t: number }
    }
    test.skip(Boolean(r.skip), r.skip)
    expect(r.before.old).toBeGreaterThan(1000)
    expect(r.before.next).toBe(0)
    // Held: the switch waits on the gated z1 tiles, the old plane stays whole.
    for (const f of r.during)
      expect(f).toEqual({ old: r.before.old, next: 0, committed: null })
    expect([r.committed, r.plane]).toEqual([true, { z: 1, t: 0 }])
    // Never mixed; after the commit the new plane shows whole.
    for (const f of r.after) expect(f.old === 0 || f.next === 0).toBe(true)
    expect(r.after.at(-1)).toEqual({ old: 0, next: r.before.old })
  })
