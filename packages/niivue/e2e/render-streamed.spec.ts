import { registerScenes, type Scene } from './renderHarness'

// Streamed volumes: channel stacks (M14-06), whose chunked channels fuse each
// base chunk's drawn bricks into the overlay slot and must draw what the same
// channels draw stacked whole; picking on a stack (M14-03, #370); lazy time
// (VOL-01). Two 32^3 uint8 channels on one 1 mm grid: a red ball and an
// overlapping green ball.

const RENDER = 4
// Each streamed brick marches the overlay slot, which SwiftShader's WebGPU
// pays per pixel: a small canvas keeps the stack scenes inside the timeout.
const STACK_PX = 80

const SCENES: Scene[] = [
  {
    name: 'stack-whole',
    size: [STACK_PX, STACK_PX],
    options: { sliceType: RENDER },
    setup: async ({ nv, lib }) => {
      const ball = (c: number[]) => {
        const v = new Uint8Array(32 ** 3)
        for (let z = 0; z < 32; z++)
          for (let y = 0; y < 32; y++)
            for (let x = 0; x < 32; x++)
              if ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 < 81)
                v[x + 32 * (y + 32 * z)] = 200
        return v
      }
      const make = (
        lib as unknown as {
          createStreamingNVImage: (s: unknown) => { img: unknown }
        }
      ).createStreamingNVImage
      const vols = [
        [12, 14, 16, 'red'],
        [19, 16, 16, 'green'],
      ].map(([x, y, z, colormap], i) => {
        const v = make({
          shape: [32, 32, 32],
          spacing: [1, 1, 1],
          datatypeCode: 2,
          calMin: 0,
          calMax: 255,
          colormap,
          name: `c${i}`,
          id: `c${i}`,
          url: `c${i}`,
        })
        v.img = ball([x as number, y as number, z as number])
        return v
      })
      nv.volumeIsChannelStack = true
      nv.volumeOverlayColorBlend = 3
      for (const v of vols)
        await nv.addVolume(v as Parameters<typeof nv.addVolume>[0])
    },
    steps: [
      {
        name: 'axial',
        run: async ({ nv }) => {
          nv.sliceType = 0
        },
      },
    ],
  },
  {
    // A stack picks from every drawn channel: hiding volumes[0] still leaves
    // the green ball pickable, and each ball alone picks a subset (#370).
    name: 'stack-pick',
    slow: true,
    size: [STACK_PX, STACK_PX],
    sameAs: 'stack-whole',
    options: { sliceType: RENDER },
    setup: async ({ nv, lib, view, check, settle }) => {
      const ball = (c: number[]) => {
        const v = new Uint8Array(32 ** 3)
        for (let z = 0; z < 32; z++)
          for (let y = 0; y < 32; y++)
            for (let x = 0; x < 32; x++)
              if ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 < 81)
                v[x + 32 * (y + 32 * z)] = 200
        return v
      }
      const make = (
        lib as unknown as {
          createStreamingNVImage: (s: unknown) => { img: unknown }
        }
      ).createStreamingNVImage
      nv.volumeIsChannelStack = true
      nv.volumeOverlayColorBlend = 3
      for (const [i, [x, y, z, colormap]] of [
        [12, 14, 16, 'red'],
        [19, 16, 16, 'green'],
      ].entries()) {
        const v = make({
          shape: [32, 32, 32],
          spacing: [1, 1, 1],
          datatypeCode: 2,
          calMin: 0,
          calMax: 255,
          colormap,
          name: `c${i}`,
          id: `c${i}`,
          url: `c${i}`,
        })
        v.img = ball([x as number, y as number, z as number])
        await nv.addVolume(v as Parameters<typeof nv.addVolume>[0])
      }
      const sweep = async () => {
        await settle()
        const hits = new Set<string>()
        for (let y = 2; y < 80; y += 3)
          for (let x = 2; x < 80; x += 3)
            if (await view().depthPick(x, y)) hits.add(`${x},${y}`)
        return hits
      }
      const both = await sweep()
      await nv.setVolume(0, { visible: false })
      const green = await sweep()
      await nv.setVolume(0, { visible: true })
      await nv.setVolume(1, { visible: false })
      const red = await sweep()
      await nv.setVolume(1, { visible: true })
      check(green.size > 0, 'hidden volumes[0]: the green ball still picks')
      check(
        red.size > 0 && green.size < both.size,
        `green ${green.size} of ${both.size}`,
      )
      check(red.size < both.size, `red ${red.size} of ${both.size}`)
      const outside = [...green].filter((k) => !both.has(k))
      check(outside.length === 0, `green picks off both: ${outside.length}`)
      await settle()
    },
  },
  {
    // Each brick ray-marches on its own, so the 3D capture differs from the
    // whole stack by a few hundred pixels of sampling phase (as any chunked
    // COMPOSITE does) and keeps its own reference; the 2D slice must match.
    name: 'stack-streamed',
    slow: true,
    size: [STACK_PX, STACK_PX],
    options: { sliceType: RENDER, maxTextureDimension3D: 24 },
    setup: async ({ nv, view, check, settle }) => {
      const ball = (c: number[]) => {
        const v = new Uint8Array(32 ** 3)
        for (let z = 0; z < 32; z++)
          for (let y = 0; y < 32; y++)
            for (let x = 0; x < 32; x++)
              if ((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2 < 81)
                v[x + 32 * (y + 32 * z)] = 200
        return v
      }
      nv.volumeIsChannelStack = true
      nv.volumeOverlayColorBlend = 3
      for (const [i, [x, y, z, colormap]] of [
        [12, 14, 16, 'red'],
        [19, 16, 16, 'green'],
      ].entries()) {
        const vox = ball([x as number, y as number, z as number])
        await nv.loadChunkedVolume(
          {
            datatypeCode: 2,
            levels: [{ level: 0, shape: [32, 32, 32], spacing: [1, 1, 1] }],
            fetchChunk: async ({
              texOrigin: o,
              texDims: d,
            }: {
              texOrigin: number[]
              texDims: number[]
            }) => {
              const out = new Uint8Array(d[0] * d[1] * d[2])
              for (let k = 0; k < d[2]; k++)
                for (let j = 0; j < d[1]; j++)
                  for (let h = 0; h < d[0]; h++) {
                    const [sx, sy, sz] = [o[0] + h, o[1] + j, o[2] + k]
                    if (sx < 32 && sy < 32 && sz < 32)
                      out[h + d[0] * (j + d[1] * k)] =
                        vox[sx + 32 * (sy + 32 * sz)]
                  }
              return out
            },
          } as unknown as Parameters<typeof nv.loadChunkedVolume>[0],
          {
            calMin: 0,
            calMax: 255,
            colormap: colormap as string,
            name: `c${i}`,
            id: `c${i}`,
            coarseFloor: false,
          },
        )
      }
      check(view().volumeRenderer.hasChunkedVolume, 'volume is chunked')
      await settle()
    },
    steps: [
      {
        name: 'axial',
        sameAs: 'stack-whole--axial',
        run: async ({ nv, settle }) => {
          nv.sliceType = 0
          await settle()
        },
      },
    ],
  },
  {
    // The default streamed configuration: a coarse floor and crosshair-follow
    // plan swaps (which re-key chunk indices under the fuse), plus the CPU
    // pick on a streamed stack with volumes[0] hidden (#370).
    name: 'stack-streamed-floor',
    slow: true,
    size: [STACK_PX, STACK_PX],
    options: { sliceType: RENDER, maxTextureDimension3D: 24 },
    setup: async ({ nv, view, check, settle }) => {
      const ball = (c: number[], n: number) => {
        const v = new Uint8Array(n ** 3)
        const k = 32 / n
        for (let z = 0; z < n; z++)
          for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++)
              if (
                ((x + 0.5) * k - c[0]) ** 2 +
                  ((y + 0.5) * k - c[1]) ** 2 +
                  ((z + 0.5) * k - c[2]) ** 2 <
                81
              )
                v[x + n * (y + n * z)] = 200
        return v
      }
      nv.volumeIsChannelStack = true
      nv.volumeOverlayColorBlend = 3
      for (const [i, [x, y, z, colormap]] of [
        [12, 14, 16, 'red'],
        [19, 16, 16, 'green'],
      ].entries()) {
        const c = [x as number, y as number, z as number]
        const levels = [ball(c, 32), ball(c, 16)]
        await nv.loadChunkedVolume(
          {
            datatypeCode: 2,
            levels: [
              { level: 0, shape: [32, 32, 32], spacing: [1, 1, 1] },
              { level: 1, shape: [16, 16, 16], spacing: [2, 2, 2] },
            ],
            fetchChunk: async ({
              texOrigin: o,
              texDims: d,
              levelIndex,
            }: {
              texOrigin: number[]
              texDims: number[]
              levelIndex: number
            }) => {
              const n = levelIndex ? 16 : 32
              const vox = levels[levelIndex]
              const out = new Uint8Array(d[0] * d[1] * d[2])
              for (let kk = 0; kk < d[2]; kk++)
                for (let j = 0; j < d[1]; j++)
                  for (let h = 0; h < d[0]; h++) {
                    const [sx, sy, sz] = [o[0] + h, o[1] + j, o[2] + kk]
                    if (sx < n && sy < n && sz < n)
                      out[h + d[0] * (j + d[1] * kk)] =
                        vox[sx + n * (sy + n * sz)]
                  }
              return out
            },
          } as unknown as Parameters<typeof nv.loadChunkedVolume>[0],
          {
            calMin: 0,
            calMax: 255,
            colormap: colormap as string,
            name: `c${i}`,
            id: `c${i}`,
          },
        )
      }
      check(view().volumeRenderer.hasChunkedVolume, 'volume is chunked')
      await settle()
      const sweep = async () => {
        await settle()
        const hits = new Map<string, number[]>()
        for (let y = 4; y < 80; y += 6)
          for (let x = 4; x < 80; x += 6) {
            const mm = await view().depthPick(x, y)
            if (mm) hits.set(`${x},${y}`, Array.from(mm))
          }
        return hits
      }
      // Off the balls the CPU pick lands on the box, so compare where it
      // lands: hiding volumes[0] still picks (it picked nothing before #370's
      // fix), and the red ball's picks move off it.
      const both = await sweep()
      await nv.setVolume(0, { visible: false })
      const green = await sweep()
      await nv.setVolume(0, { visible: true })
      const moved = [...both].filter(([k, mm]) => {
        const g = green.get(k)
        return !g || Math.hypot(g[0] - mm[0], g[1] - mm[1], g[2] - mm[2]) > 1
      })
      check(green.size > 0, 'hidden volumes[0]: the stack still picks')
      check(
        moved.length > 0 && moved.length < both.size,
        `moved ${moved.length} of ${both.size}`,
      )
      await settle()
    },
    steps: [
      {
        name: 'refocus',
        run: async ({ nv, settle }) => {
          nv.setCrosshairPos([28, 28, 28])
          await settle()
        },
      },
      {
        // Back at the centre on a 2D slice: the floor stays hidden under the
        // fused stack (black around the balls). Not sameAs the whole stack:
        // after the refocus the plan keeps a few coarse bricks at the edges.
        name: 'axial',
        run: async ({ nv, settle }) => {
          nv.crosshairPos = [0.5, 0.5, 0.5]
          nv.sliceType = 0
          await settle()
        },
      },
    ],
  },
  {
    // Lazy time on a streamed volume, frame 1 loaded directly: the reference
    // a switch to frame 1 must reach, with no frame-0 brick or floor left.
    name: 'frames-direct',
    options: { sliceType: RENDER, maxTextureDimension3D: 24 },
    setup: async ({ nv, settle }) => {
      const ball = (c: number[], n: number) => {
        const v = new Uint8Array(n ** 3)
        const s = 32 / n
        for (let z = 0; z < n; z++)
          for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++)
              if (
                ((x + 0.5) * s - c[0]) ** 2 +
                  ((y + 0.5) * s - c[1]) ** 2 +
                  ((z + 0.5) * s - c[2]) ** 2 <
                81
              )
                v[x + n * (y + n * z)] = 200
        return v
      }
      const at = [
        [10, 16, 16],
        [22, 16, 16],
      ]
      const fine = at.map((c) => ball(c, 32))
      const coarse = at.map((c) => ball(c, 16))
      const chunked = await nv.loadChunkedVolume(
        {
          datatypeCode: 2,
          frames: 2,
          levels: [
            { level: 0, shape: [32, 32, 32], spacing: [1, 1, 1] },
            { level: 1, shape: [16, 16, 16], spacing: [2, 2, 2] },
          ],
          fetchChunk: async ({
            texOrigin: o,
            texDims: d,
            levelIndex,
            frame = 0,
          }: {
            texOrigin: number[]
            texDims: number[]
            levelIndex: number
            frame?: number
          }) => {
            const n = levelIndex ? 16 : 32
            const vox = (levelIndex ? coarse : fine)[frame]
            const out = new Uint8Array(d[0] * d[1] * d[2])
            for (let k = 0; k < d[2]; k++)
              for (let j = 0; j < d[1]; j++)
                for (let h = 0; h < d[0]; h++) {
                  const [sx, sy, sz] = [o[0] + h, o[1] + j, o[2] + k]
                  if (sx < n && sy < n && sz < n)
                    out[h + d[0] * (j + d[1] * k)] = vox[sx + n * (sy + n * sz)]
                }
            return out
          },
        } as unknown as Parameters<typeof nv.loadChunkedVolume>[0],
        { calMin: 0, calMax: 255, colormap: 'gray', frame: 1 },
      )
      ;(globalThis as { chunked?: unknown }).chunked = chunked
      await settle()
    },
  },
  {
    // Opened at frame 0 (its own picture), then switched: the switch must
    // draw exactly what opening at frame 1 draws, on both backends.
    name: 'frames-switched',
    options: { sliceType: RENDER, maxTextureDimension3D: 24 },
    setup: async ({ nv, settle }) => {
      const ball = (c: number[], n: number) => {
        const v = new Uint8Array(n ** 3)
        const s = 32 / n
        for (let z = 0; z < n; z++)
          for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++)
              if (
                ((x + 0.5) * s - c[0]) ** 2 +
                  ((y + 0.5) * s - c[1]) ** 2 +
                  ((z + 0.5) * s - c[2]) ** 2 <
                81
              )
                v[x + n * (y + n * z)] = 200
        return v
      }
      const at = [
        [10, 16, 16],
        [22, 16, 16],
      ]
      const fine = at.map((c) => ball(c, 32))
      const coarse = at.map((c) => ball(c, 16))
      const chunked = await nv.loadChunkedVolume(
        {
          datatypeCode: 2,
          frames: 2,
          levels: [
            { level: 0, shape: [32, 32, 32], spacing: [1, 1, 1] },
            { level: 1, shape: [16, 16, 16], spacing: [2, 2, 2] },
          ],
          fetchChunk: async ({
            texOrigin: o,
            texDims: d,
            levelIndex,
            frame = 0,
          }: {
            texOrigin: number[]
            texDims: number[]
            levelIndex: number
            frame?: number
          }) => {
            const n = levelIndex ? 16 : 32
            const vox = (levelIndex ? coarse : fine)[frame]
            const out = new Uint8Array(d[0] * d[1] * d[2])
            for (let k = 0; k < d[2]; k++)
              for (let j = 0; j < d[1]; j++)
                for (let h = 0; h < d[0]; h++) {
                  const [sx, sy, sz] = [o[0] + h, o[1] + j, o[2] + k]
                  if (sx < n && sy < n && sz < n)
                    out[h + d[0] * (j + d[1] * k)] = vox[sx + n * (sy + n * sz)]
                }
            return out
          },
        } as unknown as Parameters<typeof nv.loadChunkedVolume>[0],
        { calMin: 0, calMax: 255, colormap: 'gray', frame: 0 },
      )
      ;(globalThis as { chunked?: unknown }).chunked = chunked
      await settle()
    },
    steps: [
      {
        name: 'to-1',
        sameAs: 'frames-direct',
        run: async ({ settle, check }) => {
          const c = (
            globalThis as {
              chunked?: {
                setFrame: (t: number) => Promise<void>
                frame: number
              }
            }
          ).chunked
          await c?.setFrame(1)
          check(c?.frame === 1, 'frame 1 shown')
          await settle()
        },
      },
    ],
  },
]

registerScenes(SCENES)
