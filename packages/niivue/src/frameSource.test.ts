import { expect, test } from 'bun:test'
import NiiVue, { NiiDataType, type VolumeFrameSource } from '@/index'
import {
  captureWarnings,
  documentFile,
  rejectionMessage,
} from '@/testing/headless'
import { channelVolumeFile } from '@/volume/channelVolumeFile'

// Lazy time: a volume whose frameSource fetches frames on setFrame4D.

const DIMS = [4, 3, 2] as const
const N = DIMS[0] * DIMS[1] * DIMS[2]

/** Frame t of channel c: every voxel holds 100 * t + c. */
const frameOf = (t: number, c: number) => new Uint16Array(N).fill(100 * t + c)

type Gate = { resolve: () => void; reject: (e: Error) => void }

/** A source whose loads wait for `gates[t]` when one is set. */
function source(
  c: number,
  group: object,
  gates: Map<number, Gate> = new Map(),
  aborted: number[] = [],
): VolumeFrameSource {
  return {
    count: 5,
    frame: 0,
    group,
    load: (t, signal) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => aborted.push(t))
        const gate = gates.get(t)
        if (!gate) return resolve(frameOf(t, c))
        gate.resolve = () => resolve(frameOf(t, c))
        gate.reject = reject
      }),
  }
}

async function load(
  sources: VolumeFrameSource[],
  colormap?: string,
): Promise<NiiVue> {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadVolumes(
    sources.map((frameSource, c) => ({
      url: channelVolumeFile(
        DIMS,
        [1, 1, 1],
        NiiDataType.DT_UINT16,
        frameOf(frameSource.frame, c),
        `c${c}`,
      ),
      frameSource,
      colormap,
    })),
  )
  return nv
}

const gate = (): Gate => ({ resolve: () => {}, reject: () => {} })

test('setFrame4D fetches the frame and switches the whole group together', async () => {
  const group = {}
  const nv = await load([source(0, group), source(1, group), source(2, {})])
  const changes: number[] = []
  nv.addEventListener('frameChange', (e) => changes.push(e.detail.frame))
  await nv.setFrame4D('c0.nii', 3)
  expect(nv.volumes.map((v) => v.img?.[0])).toEqual([300, 301, 2])
  expect(nv.getFrame4D('c1.nii')).toBe(3)
  expect(nv.getFrame4D('c2.nii')).toBe(0)
  expect(changes).toEqual([3, 3])
  // Still a one-frame image: renderers index img by frame4D.
  expect(nv.volumes[0].nFrame4D).toBe(1)
  expect(nv.volumes[0].frame4D).toBe(0)
  // Clamped to the source's frame count.
  await nv.setFrame4D('c0.nii', 99)
  expect(nv.getFrame4D('c0.nii')).toBe(4)
})

test('the latest request wins and aborts the one before it', async () => {
  const gates = new Map([
    [1, gate()],
    [2, gate()],
  ])
  const aborted: number[] = []
  const nv = await load([source(0, {}, gates, aborted)])
  const first = nv.setFrame4D('c0.nii', 1)
  const second = nv.setFrame4D('c0.nii', 2)
  expect(aborted).toEqual([1])
  gates.get(2)?.resolve()
  await second
  gates.get(1)?.resolve()
  await first
  expect(nv.getFrame4D('c0.nii')).toBe(2)
  expect(nv.volumes[0].img?.[0]).toBe(200)
})

test('a failed fetch rejects and keeps the shown frame', async () => {
  const gates = new Map([[1, gate()]])
  const nv = await load([source(0, {}, gates)])
  const switching = nv.setFrame4D('c0.nii', 1)
  const warnings = captureWarnings()
  gates.get(1)?.reject(new Error('offline'))
  expect(await rejectionMessage(switching)).toBe('offline')
  warnings.restore()
  expect(warnings.messages[0]).toContain('frame 1 could not be loaded')
  expect(nv.getFrame4D('c0.nii')).toBe(0)
  expect(nv.volumes[0].img?.[0]).toBe(0)
})

test('setVolume({ frame4D }) goes through the source', async () => {
  const nv = await load([source(0, {})])
  await nv.setVolume(0, { frame4D: 2, opacity: 0.5 })
  expect(nv.getFrame4D('c0.nii')).toBe(2)
  expect(nv.volumes[0].frame4D).toBe(0)
  expect(nv.volumes[0].opacity).toBe(0.5)
  // The window comes from the frame held, whatever frame is asked.
  await nv.recalculateCalMinMax(0, 2)
  expect(nv.volumes[0].calMax).toBe(200)
})

test('a document keeps the shown frame as a plain volume', async () => {
  const nv = await load([source(0, {})])
  await nv.setFrame4D('c0.nii', 2)
  const restored = new NiiVue({ backend: 'webgl2' })
  await restored.loadDocument(documentFile(nv.serializeDocument()))
  const [vol] = restored.volumes
  expect(vol.img?.[0]).toBe(200)
  expect(vol.frame4D).toBe(0)
  expect(vol.frameSource).toBeUndefined()
})

test('a generated label colormap grows to the IDs of a fetched frame', async () => {
  const nv = await load([source(0, {})], 'Random')
  const before = nv.volumes[0].colormapLabel
  expect(before?.max).toBeLessThan(400)
  await nv.setFrame4D('c0.nii', 4)
  expect(nv.volumes[0].colormapLabel?.max).toBeGreaterThanOrEqual(400)
})

test('a group clamps to its shortest member', async () => {
  const group = {}
  const short = { ...source(1, group), count: 2 }
  const nv = await load([source(0, group), short])
  await nv.setFrame4D('c0.nii', 4)
  expect(nv.getFrame4D('c0.nii')).toBe(1)
  expect(nv.getFrame4D('c1.nii')).toBe(1)
})

test('setVolume({ frame4D, ... }) skips a volume removed during the fetch', async () => {
  const gates = new Map([[1, gate()]])
  const nv = await load([source(0, {}, gates)])
  await nv.addVolume({
    url: channelVolumeFile(
      DIMS,
      [1, 1, 1],
      NiiDataType.DT_UINT16,
      frameOf(0, 9),
      'b',
    ),
  })
  const request = nv.setVolume(0, { frame4D: 1, opacity: 0.2 })
  await nv.removeVolume(0)
  gates.get(1)?.resolve()
  await request
  expect(nv.volumes.map((v) => v.opacity)).toEqual([1])
})

test('setVolume({ frame4D, ... }) keeps the other options when the fetch fails', async () => {
  const gates = new Map([[1, gate()]])
  const nv = await load([source(0, {}, gates)])
  const warnings = captureWarnings()
  const request = nv.setVolume(0, { frame4D: 1, opacity: 0.3 })
  gates.get(1)?.reject(new Error('offline'))
  expect(await rejectionMessage(request)).toBe('offline')
  warnings.restore()
  expect(nv.volumes[0].opacity).toBe(0.3)
})

test('two viewers loading one source keep their own frame', async () => {
  const shared = source(0, {})
  const a = await load([shared])
  const b = await load([shared])
  await a.setFrame4D('c0.nii', 3)
  await b.setFrame4D('c0.nii', 3)
  expect(b.volumes[0].img?.[0]).toBe(300)
  expect(b.getFrame4D('c0.nii')).toBe(3)
})
