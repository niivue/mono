import { describe, expect, it, mock } from 'bun:test'
import { MAX_INSTANCES } from '../limits'
import { baseView, hostOf } from '../testing/fake-view'
import { instanceHandlers, instancesState } from './instances'
import type { GlobalCamera, Instance, ShownVolume, View } from './view'

const DEG = Math.PI / 180

/** A view whose setInstances and setGlobalCamera keep what they are given, as NiiVue's do. */
function instView(volumes?: ShownVolume[], overrides: Partial<View> = {}) {
  const calls: string[] = []
  const view: View = baseView({
    volumes: volumes ?? [
      { name: 'mni152.nii.gz', id: 'v0', url: '/volumes/mni152.nii.gz' },
      { name: 'chris_t1.nii.gz', id: 'v1', url: '/volumes/chris_t1.nii.gz' },
    ],
    opts: {},
    setInstances: mock(async (list: Instance[] | null) => {
      calls.push(list ? `instances ${list.length}` : 'clear')
      ;(view.opts ?? {}).instances = list?.length ? list : undefined
    }),
    setGlobalCamera: mock((cam: GlobalCamera) => {
      calls.push('camera')
      ;(view.opts ?? {}).globalCamera = cam
    }),
    ...overrides,
  })
  return { view, calls }
}

const run = (view: View, params: Record<string, unknown>) =>
  instanceHandlers(hostOf(view)).set_instances(params) as Promise<
    Record<string, unknown>
  >

describe('set_instances', () => {
  it('lays out global3d instances in radians and reports them in degrees', async () => {
    const { view } = instView()
    const out = await run(view, {
      instances: [
        {
          id: 'left',
          volume: 0,
          position: [-1, 0, 0],
          orientation: [0, 90, 0],
        },
        { id: 'right', volume: 'chris_t1.nii.gz', scale: 2 },
      ],
    })
    expect(view.opts?.instances).toEqual([
      {
        id: 'left',
        volumeId: 'mni152.nii.gz',
        space: 'global3d',
        position: [-1, 0, 0],
        orientation: [0, 90 * DEG, 0],
      },
      {
        id: 'right',
        volumeId: 'chris_t1.nii.gz',
        space: 'global3d',
        position: [0, 0, 0],
        scale: 2,
      },
    ])
    expect(out.instances).toEqual([
      {
        id: 'left',
        space: 'global3d',
        volume: { index: 0, name: 'mni152.nii.gz' },
        position: [-1, 0, 0],
        scale: 1,
        orientation: [0, 90, 0],
      },
      {
        id: 'right',
        space: 'global3d',
        volume: { index: 1, name: 'chris_t1.nii.gz' },
        position: [0, 0, 0],
        scale: 2,
      },
    ])
    expect(view.drawScene).toHaveBeenCalled()
  })

  it('names unnamed instances by their place in the list', async () => {
    const { view } = instView()
    await run(view, { instances: [{}, {}] })
    expect(view.opts?.instances?.map((i) => i.id)).toEqual([
      'instance 0',
      'instance 1',
    ])
  })

  it('places the camera before the instances, in radians, and reports it in degrees', async () => {
    const { view, calls } = instView()
    const out = await run(view, {
      instances: [{ id: 'a' }],
      camera: { position: [0, 0, 0], yaw: 90, pitch: -30, fov: 70 },
    })
    expect(calls).toEqual(['camera', 'instances 1'])
    const cam = view.opts?.globalCamera
    expect(cam?.yaw).toBeCloseTo(Math.PI / 2)
    expect(cam?.pitch).toBeCloseTo(-Math.PI / 6)
    expect(cam?.fov).toBe(70)
    expect(out.globalCamera).toEqual({
      position: [0, 0, 0],
      yaw: 90,
      pitch: -30,
      fov: 70,
    })
  })

  it('moves the camera alone once instances are set', async () => {
    const { view, calls } = instView()
    await run(view, { instances: [{ id: 'a' }] })
    await run(view, { camera: { position: [0, 0, 5] } })
    expect(calls).toEqual(['instances 1', 'camera'])
  })

  it('lays out canvas tiles from bounds', async () => {
    const { view } = instView()
    const out = await run(view, {
      instances: [{ id: 'tile', bounds: [0, 0, 0.5, 1] }],
    })
    expect(view.opts?.instances).toEqual([
      {
        id: 'tile',
        space: 'canvas',
        bounds: [
          [0, 0],
          [0.5, 1],
        ],
      },
    ])
    expect(out.instances).toEqual([
      {
        id: 'tile',
        space: 'canvas',
        volume: { index: 0, name: 'mni152.nii.gz' },
        bounds: [0, 0, 0.5, 1],
      },
    ])
  })

  it('clears with null, not an empty list', async () => {
    const { view, calls } = instView()
    await run(view, { instances: [{ id: 'a' }] })
    const out = await run(view, { clear: true })
    expect(calls).toEqual(['instances 1', 'clear'])
    expect(view.setInstances).toHaveBeenLastCalledWith(null)
    expect(out).toEqual({ instances: [] })
    expect(instancesState(view)).toEqual({})
  })

  it('clears once every volume is closed', async () => {
    const { view } = instView([])
    await run(view, { clear: true })
    expect(view.setInstances).toHaveBeenLastCalledWith(null)
  })

  describe('refuses, leaving the scene as it was', () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['instances with clear', { instances: [{}], clear: true }, /not both/],
      ['nothing to do', {}, /needs instances/],
      ['an empty list', { instances: [] }, /empty.*clear/],
      [
        'too many',
        { instances: Array.from({ length: MAX_INSTANCES + 1 }, () => ({})) },
        /At most 100/,
      ],
      ['a list of non-objects', { instances: [1] }, /list of objects/],
      [
        'two of one id',
        { instances: [{ id: 'a' }, { id: 'a' }] },
        /share the id "a"/,
      ],
      ['an unknown volume', { instances: [{ volume: 5 }] }, /volume/],
      [
        'canvas fields on a global3d instance',
        { instances: [{ position: [0, 0, 0], bounds: [0, 0, 1, 1] }] },
        /canvas tile/,
      ],
      [
        'global3d fields on a canvas tile',
        { instances: [{ space: 'canvas', scale: 2 }] },
        /global3d instance/,
      ],
      [
        'an unknown space',
        { instances: [{ space: 'world' }] },
        /global3d or canvas/,
      ],
      [
        'bounds outside 0 to 1',
        { instances: [{ bounds: [0, 0, 2, 1] }] },
        /each 0 to 1/,
      ],
      [
        'reversed bounds',
        { instances: [{ bounds: [0.5, 0, 0.2, 1] }] },
        /lower left/,
      ],
      ['a zero scale', { instances: [{ scale: 0 }] }, /scale must be above 0/],
      [
        'a negative axis scale',
        { instances: [{ scale: [1, -1, 1] }] },
        /scale must be above 0/,
      ],
      [
        'a camera with clear',
        { clear: true, camera: { position: [0, 0, 0] } },
        /nothing to show/,
      ],
      [
        'a camera with no instances',
        { camera: { position: [0, 0, 0] } },
        /none are set/,
      ],
      [
        'a pitch past straight up',
        { instances: [{}], camera: { position: [0, 0, 0], pitch: 120 } },
        /pitch must be -90 to 90/,
      ],
      [
        'a flat field of view',
        { instances: [{}], camera: { position: [0, 0, 0], fov: 180 } },
        /fov must be above 0 and below 180/,
      ],
      [
        'far before near',
        { instances: [{}], camera: { position: [0, 0, 0], near: 5, far: 2 } },
        /far must be beyond near/,
      ],
    ]
    for (const [what, params, message] of cases)
      it(what, async () => {
        const { view } = instView()
        await expect(run(view, params)).rejects.toThrow(message)
        expect(view.setInstances).not.toHaveBeenCalled()
        expect(view.setGlobalCamera).not.toHaveBeenCalled()
      })
  })

  it('refuses a volume NiiVue would find under another one', async () => {
    const { view } = instView([
      { name: 'brain', id: 'v0', url: '/a.nii.gz' },
      { name: 'brain', id: 'v1', url: '/b.nii.gz' },
    ])
    await expect(run(view, { instances: [{ volume: 1 }] })).rejects.toThrow(
      /would draw volume 0/,
    )
  })

  it('refuses a volume with no name or address to find it by', async () => {
    const { view } = instView([
      { name: 'mni', id: 'v0', url: '/volumes/mni152.nii.gz' },
      { name: '', id: 'v1', url: '' },
    ])
    await expect(run(view, { instances: [{ volume: 1 }] })).rejects.toThrow(
      /Volume 1 has no name/,
    )
  })

  it('refuses a volume that shares its file with any loaded volume, laid out or not', async () => {
    const { view } = instView([
      { name: 'mni', id: 'v0', url: '/volumes/mni152.nii.gz' },
      { name: 'mni hot', id: 'v1', url: '/volumes/mni152.nii.gz' },
      { name: 't1', id: 'v2', url: '/volumes/chris_t1.nii.gz' },
    ])
    const sharing =
      /Volumes 0 \("mni"\) and 1 \("mni hot"\) were both loaded from one file/
    await expect(
      run(view, { instances: [{ volume: 0 }, { volume: 1 }] }),
    ).rejects.toThrow(sharing)
    // NiiVue's texture cache holds every loaded volume, so laying out only
    // one copy could still draw the other's texture.
    await expect(
      run(view, { instances: [{ volume: 0 }, { volume: 0 }] }),
    ).rejects.toThrow(sharing)
    await expect(run(view, { instances: [{ volume: 1 }] })).rejects.toThrow(
      sharing,
    )
    // The page's addresses stay out of what the agent is told.
    await expect(run(view, { instances: [{ volume: 0 }] })).rejects.not.toThrow(
      /\/volumes\//,
    )
    expect(view.setInstances).not.toHaveBeenCalled()
    // A volume with its file to itself is fine, as are many copies of it.
    await run(view, { instances: [{ volume: 2 }, { volume: 2 }] })
    expect(view.setInstances).toHaveBeenCalled()
  })

  it('refuses a canvas tile any volume but the base, which NiiVue draws in every tile', async () => {
    const { view } = instView()
    await expect(
      run(view, { instances: [{ volume: 1, bounds: [0, 0, 1, 1] }] }),
    ).rejects.toThrow(
      /canvas tile draws the base volume \(volume 0\), not volume 1/,
    )
    expect(view.setInstances).not.toHaveBeenCalled()
    await run(view, { instances: [{ volume: 0, bounds: [0, 0, 1, 1] }] })
    expect(view.opts?.instances?.[0].volumeId).toBe('mni152.nii.gz')
  })

  it('refuses before a volume loads, and on a NiiVue without instances', async () => {
    await expect(run(instView([]).view, { instances: [{}] })).rejects.toThrow(
      /No volume/,
    )
    await expect(
      run(instView(undefined, { setInstances: undefined }).view, {
        instances: [{}],
      }),
    ).rejects.toThrow(/cannot lay out instances/)
  })
})
