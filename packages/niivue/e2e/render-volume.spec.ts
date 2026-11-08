import { registerScenes, type Scene } from './renderHarness'

// Reference images for volume rendering features: render modes, chunked
// volumes, lighting, matcaps, overlay density, modulation, instances, world
// boxes, layout inset and the crosshair and label colours on 2D slices. See
// renderHarness.ts for how scenes run and how to update the references.

// 32^3 phantom into 2x2x2 bricks (stride = limit - 6 for the 3-voxel halo):
// every axis has a seam, and WebGPU streams 8 bricks, not 64.
const CHUNK_LIMIT = 24
const RENDER = 4

const SCENES: Scene[] = [
  {
    // VOLUME_RENDER_MODE is one field: MAXIMUM and SLICES must each draw
    // their own picture (a `> 0.5` test once drew SLICES as MAXIMUM).
    // COMPOSITE is the `render` scene of render-reference.spec.ts.
    name: 'render-modes',
    options: { sliceType: RENDER },
    setup: async ({ nv, lib, p }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.MAXIMUM
    },
    steps: [
      {
        name: 'slices',
        run: async ({ nv, lib }) => {
          nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
        },
      },
    ],
  },
  {
    // A chunked volume draws one cube per brick, so a plane crossing a brick
    // boundary could be composited twice (a seam) or by neither (a gap): it
    // must draw exactly like the whole volume.
    name: 'render-slices-chunked',
    sameAs: 'render-modes--slices',
    options: { sliceType: RENDER, maxTextureDimension3D: CHUNK_LIMIT },
    setup: async ({ nv, view, lib, p, check }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      check(view().volumeRenderer.hasChunkedVolume, 'volume is chunked')
    },
  },
  {
    name: 'render-lit',
    options: { sliceType: RENDER, volumeIllumination: 0.7 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
    },
  },
  {
    // The gradient texture is built only once lighting needs it: turning
    // illumination on after an unlit load must draw exactly what loading lit
    // draws (a deferred build that never ran looks like lighting being off).
    name: 'render-lit-deferred',
    options: { sliceType: RENDER },
    setup: async ({ nv, view, p, check }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      check(
        !view().volumeRenderer.volumeGradientTexture,
        'no gradient texture while unlit',
      )
    },
    steps: [
      {
        name: 'lit',
        sameAs: 'render-lit',
        run: async ({ nv, view, check, settle }) => {
          nv.volumeIllumination = 0.7
          await settle()
          check(
            view().volumeRenderer.volumeGradientTexture,
            'lighting built the gradient texture',
          )
        },
      },
    ],
  },
  {
    // Matcap names resolve case-insensitively to opts.matcaps URLs (#442,
    // #443); the setter changes the rendered matcap and setting it back
    // restores the picture. Unlit volumes never sample the matcap.
    name: 'matcap',
    options: {
      sliceType: RENDER,
      volumeIllumination: 0.5,
      matcaps: {
        cortex: '/src/assets/matcaps/Cortex.jpg',
        shiny: '/src/assets/matcaps/Shiny.jpg',
      },
    },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
    },
    steps: [
      {
        name: 'shiny',
        run: async ({ nv }) => {
          nv.volumeMatcap = 'SHINY'
        },
      },
      {
        name: 'cortex',
        sameAs: 'matcap',
        run: async ({ nv }) => {
          nv.volumeMatcap = 'Cortex'
        },
      },
    ],
  },
  {
    // A matcap that fails to load draws the instance default, with a warning.
    name: 'matcap-missing',
    sameAs: 'matcap',
    options: {
      sliceType: RENDER,
      volumeIllumination: 0.5,
      matcaps: { cortex: '/src/assets/matcaps/Cortex.jpg' },
    },
    setup: async ({ nv, p, check, settle }) => {
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (...a: unknown[]) => {
        warnings.push(a.map(String).join(' '))
        warn(...a)
      }
      nv.volumeMatcap = '/missing/Gold.jpg'
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      await settle()
      console.warn = warn
      check(
        !warnings.some((w) => w.includes('updateVolume failed')),
        'the volume still uploads',
      )
      check(
        warnings.some(
          (w) =>
            w.includes('/missing/Gold.jpg') &&
            w.includes('drawing the default matcap'),
        ),
        `warned: ${warnings.join(' | ')}`,
      )
    },
  },
  {
    // With no matcaps there is no default: a failed one draws plain white,
    // which differs from the default (so the default is really drawn).
    name: 'matcap-none',
    options: { sliceType: RENDER, volumeIllumination: 0.5, matcaps: {} },
    setup: async ({ nv, p }) => {
      nv.volumeMatcap = '/missing/Gold.jpg'
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
    },
  },
  {
    // volumeIsOverlayOpacityCorrected (#366): the overlay march takes the
    // background's step-size correction, so a translucent overlay's density
    // does not change with volumeSampleRate. Uncorrected, it does. The base
    // is drawn at opacity 0, so only the overlay shows.
    name: 'overlay-density',
    options: { sliceType: RENDER },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([
        { url: p.anatomy('base.nii'), opacity: 0 },
        {
          url: p.anatomy(),
          colormap: 'red',
          calMin: 50,
          calMax: 150,
          opacity: 0.05,
        },
      ])
      nv.volumeSampleRate = 1
    },
    steps: [
      {
        name: 'rate2',
        sameAs: 'overlay-density',
        run: async ({ nv }) => {
          nv.volumeSampleRate = 2
        },
      },
      {
        name: 'rate4',
        sameAs: 'overlay-density',
        run: async ({ nv }) => {
          nv.volumeSampleRate = 4
        },
      },
      {
        // At one sample per voxel the correction is a no-op.
        name: 'uncorrected-rate1',
        sameAs: 'overlay-density',
        run: async ({ nv }) => {
          nv.volumeIsOverlayOpacityCorrected = false
          nv.volumeSampleRate = 1
        },
      },
      {
        name: 'uncorrected-rate4',
        run: async ({ nv }) => {
          nv.volumeSampleRate = 4
        },
      },
    ],
  },
  {
    // Two volumes from one file keep their own textures (#346): the texture
    // cache once keyed on the url, so both instances drew the last upload.
    name: 'instances-same-file',
    options: { sliceType: RENDER },
    setup: async ({ nv, p }) => {
      const file = p.anatomy()
      await nv.loadVolumes([
        { url: file, name: 'grey' },
        { url: file, name: 'grey hot', colormap: 'hot' },
      ])
      await nv.setInstances([
        {
          id: 'grey',
          space: 'global3d',
          volumeId: nv.volumes[0].id,
          position: [-7, 0, 0],
          scale: 10,
        },
        {
          id: 'hot',
          space: 'global3d',
          volumeId: nv.volumes[1].id,
          position: [7, 0, 0],
          scale: 10,
        },
      ])
    },
  },
  {
    // World-space boxes are projected per 3D tile (#347): a box zoomed past
    // its render tile must not bleed into the 2D tiles.
    name: 'focus-box-zoomed',
    options: { sliceType: 3, showRender: 1, multiplanarType: 2 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy() }])
      nv.scaleMultiplier = 4
      nv.focusBox = {
        min: [-6, -6, -6],
        max: [6, 6, 6],
        color: [1, 0, 0, 1],
        thickness: 3,
      }
    },
  },
  {
    // Each of two render tiles shows its focus box and LOD box; clearing them
    // leaves the plain volumes.
    name: 'focus-box-instances',
    // Box edges at this angle land on the same pixels on Metal and SwiftShader.
    options: { sliceType: RENDER, azimuth: 30, elevation: 20 },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy(), name: 'v' }])
      const id = nv.volumes[0].id
      await nv.setInstances([
        {
          id: 'a',
          volumeId: id,
          bounds: [
            [0, 0],
            [0.5, 1],
          ],
        },
        {
          id: 'b',
          volumeId: id,
          bounds: [
            [0.5, 0],
            [1, 1],
          ],
        },
      ])
      const box = (s: number) => ({
        min: [-s, -s, -s] as [number, number, number],
        max: [s, s, s] as [number, number, number],
        color: [1, 0, 0, 1] as [number, number, number, number],
        thickness: 4,
      })
      nv.focusBox = box(14)
      nv.lodBoxes = [box(7)]
    },
    steps: [
      {
        name: 'cleared',
        run: async ({ nv }) => {
          nv.focusBox = null
          nv.lodBoxes = null
        },
      },
    ],
  },
  {
    // An overlay's modulation (setModulationImage) must survive the chunked
    // path (#256). Anatomy under a red mask alpha-modulated by a y ramp, in
    // SLICES (the one 3D mode that draws whole and chunked alike).
    name: 'modulation',
    options: { sliceType: RENDER },
    setup: async ({ nv, lib, p }) => {
      await nv.loadVolumes([
        { url: p.anatomy(), colormap: 'gray' },
        { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1, opacity: 1 },
        { url: p.ramp(), calMin: 0, calMax: 1, opacity: 0 },
      ])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      await nv.setModulationImage(nv.volumes[1].id, nv.volumes[2].id, 1)
    },
  },
  {
    // The same scene forced down the chunked path draws the same; dropping
    // the modulation then changes it (so the match was of modulated renders).
    name: 'modulation-chunked',
    sameAs: 'modulation',
    options: { sliceType: RENDER, maxTextureDimension3D: CHUNK_LIMIT },
    setup: async ({ nv, view, lib, p, check }) => {
      await nv.loadVolumes([
        { url: p.anatomy(), colormap: 'gray' },
        { url: p.mask(), colormap: 'red', calMin: 0, calMax: 1, opacity: 1 },
        { url: p.ramp(), calMin: 0, calMax: 1, opacity: 0 },
      ])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      await nv.setModulationImage(nv.volumes[1].id, nv.volumes[2].id, 1)
      check(view().volumeRenderer.hasChunkedVolume, 'volume is chunked')
    },
    steps: [
      {
        name: 'unmodulated',
        run: async ({ nv }) => {
          await nv.setModulationImage(nv.volumes[1].id, '', 0)
        },
      },
    ],
  },
  {
    // A visible SLICES pick lies on one of the three crosshair planes.
    name: 'slices-pick',
    sameAs: 'render-modes--slices',
    options: { sliceType: RENDER },
    setup: async ({ nv, view, lib, p, check, settle }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      await settle()
      const mm = await view().depthPick(80, 80)
      const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
      check(mm, 'the centre pick hits')
      check(
        mm && [0, 1, 2].some((i) => Math.abs(mm[i] - cross[i]) <= 1),
        `pick ${mm} on a plane through ${cross}`,
      )
    },
  },
  {
    // Every SLICES pick lands on a plane or on nothing: the chunked CPU pick
    // has a near-surface fallback for the marched modes, and a plane miss
    // must not fall into it. Clip Dark, so air is empty.
    name: 'slices-pick-chunked',
    options: {
      sliceType: RENDER,
      maxTextureDimension3D: CHUNK_LIMIT,
      volumeIsAlphaClipDark: true,
    },
    setup: async ({ nv, view, lib, p, check, settle }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      check(view().volumeRenderer.hasChunkedVolume, 'volume is chunked')
      await settle()
      const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
      const off: string[] = []
      let hits = 0
      let misses = 0
      for (let y = 8; y < 160; y += 8)
        for (let x = 8; x < 160; x += 8) {
          const mm = await view().depthPick(x, y)
          if (!mm) {
            misses++
            continue
          }
          hits++
          if (![0, 1, 2].some((i) => Math.abs(mm[i] - cross[i]) <= 1))
            off.push(`${x},${y}: ${Array.from(mm)}`)
        }
      // A sweep that never hit, or never missed, proves nothing.
      check(hits > 0 && misses > 0, `hits ${hits}, misses ${misses}`)
      check(off.length === 0, `picks off every plane: ${off.slice(0, 5)}`)
    },
  },
  {
    // SLICES draws the drawing on a plane even where the base is transparent,
    // so a pick must see it there too. Paint the axial crosshair slice (and
    // its neighbours): new picks appear, all on that plane, none lost. This
    // whole volume takes the GPU depth pass.
    name: 'slices-pick-drawing',
    options: { sliceType: RENDER, volumeIsAlphaClipDark: true },
    setup: async ({ nv, view, lib, p, check, settle }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      await settle()
      const sweep = async () => {
        const hits = new Map<string, number[]>()
        for (let y = 8; y < 160; y += 8)
          for (let x = 8; x < 160; x += 8) {
            const mm = await view().depthPick(x, y)
            if (mm) hits.set(`${x},${y}`, Array.from(mm))
          }
        return hits
      }
      const before = await sweep()
      nv.createEmptyDrawing()
      const dv = nv.drawingVolume
      if (!dv?.dimsRAS) throw new Error('no drawing volume')
      const [nx, ny, nz] = [dv.dimsRAS[1], dv.dimsRAS[2], dv.dimsRAS[3]]
      const zc = Math.floor(nv.model.scene.crosshairPos[2] * nz)
      const img = dv.img as Uint8Array
      for (let z = Math.max(0, zc - 1); z <= Math.min(nz - 1, zc + 1); z++)
        img.fill(1, z * nx * ny, (z + 1) * nx * ny)
      nv.refreshDrawing()
      await settle()
      const after = await sweep()
      const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
      const added = [...after].filter(([k]) => !before.has(k))
      const lost = [...before.keys()].filter((k) => !after.has(k))
      check(before.size > 0 && added.length > 0, `added ${added.length}`)
      check(lost.length === 0, `lost ${lost.length} picks`)
      // Paint covers three voxel slices: a new pick lies in that band (on
      // whichever plane crosses it), and every pick lies on some plane.
      const offBand = added.filter(([, mm]) => Math.abs(mm[2] - cross[2]) > 2.5)
      check(offBand.length === 0, `new picks off the paint: ${offBand}`)
      const offPlane = [...after].filter(
        ([, mm]) => ![0, 1, 2].some((i) => Math.abs(mm[i] - cross[i]) <= 1),
      )
      check(offPlane.length === 0, `picks off every plane: ${offPlane}`)
    },
  },
  {
    // The same on a streamed volume, which takes the CPU ray walk: only a
    // chunked SOURCE carries a base pick sampler (from its coarse floor), so
    // only it can reject a crossing as transparent and then accept it for the
    // drawing. One 32^3 level at 2 mm: a bright ball in air.
    name: 'slices-pick-drawing-streamed',
    options: { sliceType: RENDER, volumeIsAlphaClipDark: true },
    setup: async ({ nv, view, lib, check, settle }) => {
      const N = 32
      const R = 9
      const vox = new Uint8Array(N * N * N)
      for (let z = 0; z < N; z++)
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++)
            if ((x - 15.5) ** 2 + (y - 15.5) ** 2 + (z - 15.5) ** 2 < R * R)
              vox[x + N * (y + N * z)] = 200
      await nv.loadChunkedVolume(
        {
          datatypeCode: 2,
          levels: [{ level: 0, shape: [N, N, N], spacing: [2, 2, 2] }],
          fetchChunk: async ({
            texOrigin: o,
            texDims: d,
          }: {
            texOrigin: number[]
            texDims: number[]
          }) => {
            const out = new Uint8Array(d[0] * d[1] * d[2])
            for (let z = 0; z < d[2]; z++)
              for (let y = 0; y < d[1]; y++)
                for (let x = 0; x < d[0]; x++) {
                  const [sx, sy, sz] = [o[0] + x, o[1] + y, o[2] + z]
                  if (sx < N && sy < N && sz < N)
                    out[x + d[0] * (y + d[1] * z)] = vox[sx + N * (sy + N * sz)]
                }
            return out
          },
        } as unknown as Parameters<typeof nv.loadChunkedVolume>[0],
        { calMin: 50, calMax: 255, colormap: 'gray' },
      )
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.SLICES
      check(view().volumeRenderer.hasChunkedVolume, 'volume is chunked')
      await settle()
      const sweep = async () => {
        const hits = new Map<string, number[]>()
        for (let y = 8; y < 160; y += 8)
          for (let x = 8; x < 160; x += 8) {
            const mm = await view().depthPick(x, y)
            if (mm) hits.set(`${x},${y}`, Array.from(mm))
          }
        return hits
      }
      const before = await sweep()
      nv.createEmptyDrawing()
      const dv = nv.drawingVolume
      if (!dv?.dimsRAS) throw new Error('no drawing volume')
      const [nx, ny, nz] = [dv.dimsRAS[1], dv.dimsRAS[2], dv.dimsRAS[3]]
      const zc = Math.floor(nv.model.scene.crosshairPos[2] * nz)
      const img = dv.img as Uint8Array
      for (let z = Math.max(0, zc - 1); z <= Math.min(nz - 1, zc + 1); z++)
        img.fill(1, z * nx * ny, (z + 1) * nx * ny)
      nv.refreshDrawing()
      await settle()
      const after = await sweep()
      const cross = nv.model.scene2mm(nv.model.scene.crosshairPos)
      const added = [...after].filter(([k]) => !before.has(k))
      const lost = [...before.keys()].filter((k) => !after.has(k))
      check(before.size > 0 && added.length > 0, `added ${added.length}`)
      check(lost.length === 0, `lost ${lost.length} picks`)
      // Paint covers three voxel slices: a new pick lies in that band (on
      // whichever plane crosses it), and every pick lies on some plane.
      const offBand = added.filter(([, mm]) => Math.abs(mm[2] - cross[2]) > 5)
      check(offBand.length === 0, `new picks off the paint: ${offBand}`)
      const offPlane = [...after].filter(
        ([, mm]) => ![0, 1, 2].some((i) => Math.abs(mm[i] - cross[i]) <= 2),
      )
      check(offPlane.length === 0, `picks off every plane: ${offPlane}`)
    },
  },
  {
    // crosshairColorPerAxis tints each segment by the world axis it extends
    // along: axial shows X (red) and Y (green), coronal X and Z (blue),
    // sagittal Y and Z. The default is the `crosshair` scene.
    name: 'crosshair-per-axis',
    options: {
      sliceType: 0,
      is3DCrosshairVisible: true,
      crosshairWidth: 2,
      crosshairGap: 0,
    },
    setup: async ({ nv, p }) => {
      nv.crosshairColorPerAxis = [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ]
      await nv.loadVolumes([{ url: p.anatomy() }])
      nv.crosshairPos = [0.3, 0.65, 0.5]
    },
    steps: [
      {
        name: 'coronal',
        run: async ({ nv }) => {
          nv.sliceType = 1
        },
      },
      {
        name: 'sagittal',
        run: async ({ nv }) => {
          nv.sliceType = 2
        },
      },
    ],
  },
  {
    // A volume's hiddenLabels draw transparent in 2D and 3D; showing them
    // again restores the picture.
    name: 'hidden-labels',
    options: { sliceType: 1 },
    setup: async ({ nv, p }) => {
      nv.addColormap('e2eOctants', {
        R: [0, 230, 0, 0, 230, 230, 0, 255, 128],
        G: [0, 25, 200, 0, 230, 0, 230, 128, 128],
        B: [0, 75, 0, 230, 0, 230, 230, 0, 255],
        A: [0, 255, 255, 255, 255, 255, 255, 255, 255],
        I: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        labels: ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      })
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.labels(), colormap: 'e2eOctants', opacity: 0.6 },
      ])
      await nv.setVolume(1, { hiddenLabels: [2, 5, 7] })
    },
    steps: [
      {
        name: 'render',
        run: async ({ nv, lib }) => {
          nv.sliceType = lib.SLICE_TYPE.RENDER
        },
      },
      {
        name: 'render-all-hidden',
        run: async ({ nv }) => {
          await nv.setVolume(1, { hiddenLabels: [1, 2, 3, 4, 5, 6, 7, 8] })
        },
      },
      {
        name: 'coronal-shown',
        sameAs: 'labels-coronal',
        run: async ({ nv }) => {
          nv.sliceType = 1
          await nv.setVolume(1, { hiddenLabels: [] })
        },
      },
    ],
  },
  {
    // The `labels` scene of render-reference.spec.ts, here as the reference
    // for hidden labels shown again.
    name: 'labels-coronal',
    options: { sliceType: 1 },
    setup: async ({ nv, p }) => {
      nv.addColormap('e2eOctants', {
        R: [0, 230, 0, 0, 230, 230, 0, 255, 128],
        G: [0, 25, 200, 0, 230, 0, 230, 128, 128],
        B: [0, 75, 0, 230, 0, 230, 230, 0, 255],
        A: [0, 255, 255, 255, 255, 255, 255, 255, 255],
        I: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        labels: ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      })
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.labels(), colormap: 'e2eOctants', opacity: 0.6 },
      ])
    },
  },
  {
    // layoutInset keeps a strip of the canvas clear of tiles and colorbar
    // (an in-canvas control panel owns it), while overlay renderers still get
    // the whole view.
    name: 'layout-inset',
    options: {
      sliceType: 0,
      isColorbarVisible: true,
      layoutInset: [60, 0, 0, 0],
    },
    setup: async ({ nv, view, p, check, settle }) => {
      let overlayWidth = 0
      nv.registerOverlayRenderer({
        drawOverlay: (f: { bounds: { width: number } }) => {
          overlayWidth = f.bounds.width
        },
      })
      await nv.loadVolumes([{ url: p.anatomy() }])
      await settle()
      const tileLeft = view().screenSlices[0].leftTopWidthHeight[0]
      const origin = view().colorbarRenderer.getLayout().originX
      check(tileLeft >= 60, `tile left ${tileLeft}`)
      check(origin === 60, `colorbar origin ${origin}`)
      check(overlayWidth === 160, `overlay width ${overlayWidth}`)
    },
  },
]

registerScenes(SCENES)
