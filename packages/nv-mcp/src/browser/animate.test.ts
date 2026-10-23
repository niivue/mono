import { describe, expect, it, mock } from 'bun:test'

import { baseView, hostOf } from '../testing/fake-view'
import { animateHandlers } from './animate'
import type {
  AnimationOptions,
  AnimationResult,
  AnimationTarget,
  ShownMesh,
  ShownVolume,
  View,
} from './view'

const FINISHED: AnimationResult = {
  completed: true,
  reason: 'finished',
  elapsedMs: 512.4,
}

/** A view whose animateTo records what it was asked and lands on it. */
function animView(overrides: Partial<View> = {}) {
  const calls: Array<[AnimationTarget, AnimationOptions | undefined]> = []
  const volumes: ShownVolume[] = [
    { name: 'mni152.nii.gz', id: 'v0', calMin: 0, calMax: 100, opacity: 1 },
    {
      name: 'bold.nii.gz',
      id: 'v1',
      calMin: 2,
      calMax: 8,
      opacity: 0.5,
      frame4D: 0,
      nFrame4D: 10,
    },
  ]
  const meshes: ShownMesh[] = [{ name: 'lh.pial', opacity: 1 }]
  const view = baseView({
    volumes,
    meshes,
    scaleMultiplier: 1,
    isAnimating: false,
    animateTo: mock(
      async (target: AnimationTarget, options?: AnimationOptions) => {
        calls.push([target, options])
        if (target.azimuth !== undefined) view.azimuth = target.azimuth
        return FINISHED
      },
    ),
    stopAnimation: mock(() => {
      view.isAnimating = false
    }),
    ...overrides,
  })
  return { view, calls }
}

const run = (view: View, params: Record<string, unknown>) =>
  animateHandlers(hostOf(view)).animate(params) as Promise<
    Record<string, unknown>
  >

describe('animate', () => {
  it('hands NiiVue the target by its own names and reports where it ended', async () => {
    const { view, calls } = animView()
    const result = await run(view, {
      azimuth: 200,
      elevation: 30,
      zoom: 1.5,
      render_pan: [0.1, -0.1],
      pan_2d: [1, 2, 3, 2],
      crosshair_mm: [10, -5, 4],
      duration_ms: 800,
      easing: 'linear',
      angles: 'literal',
      interrupt_on_input: false,
    })
    expect(calls).toEqual([
      [
        {
          azimuth: 200,
          elevation: 30,
          scaleMultiplier: 1.5,
          renderPan: [0.1, -0.1],
          pan2Dxyzmm: [1, 2, 3, 2],
          crosshairMM: [10, -5, 4],
        },
        {
          duration: 800,
          easing: 'linear',
          angles: 'literal',
          interruptOnInput: false,
        },
      ],
    ])
    expect(result).toMatchObject({
      completed: true,
      reason: 'finished',
      elapsedMs: 512,
      camera: { azimuth: 200, elevation: 15, zoom: 1 },
    })
    expect(view.drawScene).toHaveBeenCalled()
  })

  it('leaves the options NiiVue defaults out when they are not given', async () => {
    const { view, calls } = animView()
    await run(view, { azimuth: 10 })
    expect(calls[0][1]).toEqual({})
  })

  it('names volumes and meshes by index or name, and merges repeats', async () => {
    const { view, calls } = animView()
    await run(view, {
      volumes: [
        { volume: 'bold', opacity: 0 },
        { volume: 1, frame: 9, cal_max: 9 },
        { cal_min: 5 },
      ],
      meshes: [{ mesh: 'pial', opacity: 0.2 }],
    })
    expect(calls[0][0]).toEqual({
      volumes: {
        0: { calMin: 5 },
        1: { opacity: 0, frame4D: 9, calMax: 9 },
      },
      meshes: { 0: { opacity: 0.2 } },
    })
  })

  it('fills a clip plane out from where it is, and needs all three when nothing is cut', async () => {
    const cut = animView({
      getClipPlaneDepthAziElev: mock(
        () => [0.2, 90, 10] as [number, number, number],
      ),
    })
    await run(cut.view, { clip_planes: [{ azimuth: 180 }] })
    expect(cut.calls[0][0]).toEqual({ clipPlanes: { 0: [0.2, 180, 10] } })

    const { view } = animView()
    await expect(
      run(view, { clip_planes: [{ index: 2, depth: 0 }] }),
    ).rejects.toThrow('Clip plane 2 cuts nothing yet')
    await run(view, {
      clip_planes: [{ index: 2, depth: 0, azimuth: 0, elevation: 0 }],
    })
  })

  it('refuses what NiiVue would quietly drop or leave empty', async () => {
    const { view, calls } = animView()
    await expect(run(view, {})).rejects.toThrow(
      'animate needs something to move to',
    )
    await expect(run(view, { volumes: [{ volume: 3 }] })).rejects.toThrow(
      'There is no volume 3',
    )
    await expect(
      run(view, { volumes: [{ volume: 1, frame: 10 }] }),
    ).rejects.toThrow('bold.nii.gz has 10 frames')
    await expect(
      run(view, { volumes: [{ volume: 1, cal_min: 9 }] }),
    ).rejects.toThrow('cal_min (9) must not be above cal_max (8)')
    await expect(run(view, { volumes: [{ volume: 0 }] })).rejects.toThrow(
      'mni152.nii.gz needs something to move to',
    )
    await expect(run(view, { meshes: [{ mesh: 'rh' }] })).rejects.toThrow(
      'No mesh is named "rh"',
    )
    await expect(
      run(view, { azimuth: 10, duration_ms: 20000 }),
    ).rejects.toThrow('duration_ms must be 0 to 10000')
    await expect(run(view, { pan_2d: [0, 0, 0, 0] })).rejects.toThrow(
      'The zoom in pan_2d must be above 0.',
    )
    await expect(run(view, { easing: 'bouncy', azimuth: 1 })).rejects.toThrow(
      'Unknown easing',
    )
    expect(calls).toEqual([])
  })

  it('reports a move the person cut short', async () => {
    const { view } = animView({
      animateTo: mock(async () => ({
        completed: false,
        reason: 'input' as const,
        elapsedMs: 120,
      })),
    })
    expect(await run(view, { azimuth: 10 })).toMatchObject({
      completed: false,
      reason: 'input',
      elapsedMs: 120,
    })
  })

  it('answers at once without wait, leaving the move running', async () => {
    let finish = (_r: AnimationResult) => {}
    const { view } = animView({
      animateTo: mock(
        () =>
          new Promise<AnimationResult>((r) => {
            finish = r
          }),
      ),
    })
    expect(await run(view, { azimuth: 10, elevation: 5, wait: false })).toEqual(
      {
        started: true,
        durationMs: 500,
        moving: ['azimuth', 'elevation'],
      },
    )
    expect(view.drawScene).not.toHaveBeenCalled()
    finish(FINISHED)
  })

  it('tells the person where a move of the crosshair or a cut left them', async () => {
    const { view } = animView()
    const announce = mock((_text: string) => {})
    const host = {
      ...hostOf(view),
      announce,
      describe: async () =>
        'Crosshair at 48, -14, 56 mm, in the right precentral gyrus.',
      planeName: () => 'posterior',
    }
    await animateHandlers(host).animate({
      crosshair_mm: [48, -14, 56],
      clip_planes: [{ depth: 0.2, azimuth: 180, elevation: 0 }],
    })
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenCalledWith(
      'Crosshair at 48, -14, 56 mm, in the right precentral gyrus. Cut plane: posterior.',
    )
    // A camera move is the person's view, not a place: nothing to announce.
    announce.mockClear()
    await animateHandlers(host).animate({ azimuth: 30 })
    expect(announce).not.toHaveBeenCalled()
  })

  it('announces a move left running once it ends', async () => {
    let finish = (_r: AnimationResult) => {}
    const { view } = animView({
      animateTo: mock(
        () =>
          new Promise<AnimationResult>((r) => {
            finish = r
          }),
      ),
    })
    const announce = mock((_text: string) => {})
    const host = { ...hostOf(view), announce }
    await animateHandlers(host).animate({
      crosshair_mm: [1, 2, 3],
      wait: false,
    })
    expect(announce).not.toHaveBeenCalled()
    finish(FINISHED)
    await new Promise((r) => setTimeout(r, 0))
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce.mock.calls[0][0]).toStartWith('Crosshair at ')
  })

  it('stays quiet about a move a newer one replaced', async () => {
    const { view } = animView({
      animateTo: mock(async () => ({
        ...FINISHED,
        completed: false,
        reason: 'superseded' as const,
      })),
    })
    const announce = mock((_text: string) => {})
    await animateHandlers({ ...hostOf(view), announce }).animate({
      crosshair_mm: [1, 2, 3],
    })
    expect(announce).not.toHaveBeenCalled()
  })

  it('stops a move where it is', async () => {
    const { view } = animView({ isAnimating: true })
    const result = await run(view, { stop: true })
    expect(view.stopAnimation).toHaveBeenCalled()
    expect(result).toMatchObject({ stopped: true, camera: { azimuth: 110 } })
    expect(await run(view, { stop: true })).toMatchObject({ stopped: false })
  })

  it('moves the camera and fades a mesh with no volume loaded', async () => {
    const { view, calls } = animView({ volumes: [] })
    expect(
      await run(view, { azimuth: 30, meshes: [{ mesh: 0, opacity: 0.2 }] }),
    ).toMatchObject({ completed: true, reason: 'finished' })
    expect(calls[0][0]).toEqual({
      azimuth: 30,
      meshes: { 0: { opacity: 0.2 } },
    })
    await expect(
      run(view, { volumes: [{ volume: 0, opacity: 0.5 }] }),
    ).rejects.toThrow('No volume is loaded: load one with load_volume first.')
  })

  it('stops a move with nothing loaded, and refuses to start one', async () => {
    const { view } = animView({ volumes: [], meshes: [], isAnimating: true })
    expect(await run(view, { stop: true })).toMatchObject({ stopped: true })
    await expect(run(view, { azimuth: 10 })).rejects.toThrow(
      'Nothing is loaded to move: load a volume with load_volume or a mesh with load_mesh first.',
    )
  })

  it('names the parts NiiVue could not land', async () => {
    const { view } = animView({
      animateTo: mock(async () => ({
        completed: false,
        reason: 'failed' as const,
        elapsedMs: 500,
        failed: ['volumes[1]'],
      })),
    })
    expect(
      await run(view, { volumes: [{ volume: 1, opacity: 1 }] }),
    ).toMatchObject({
      completed: false,
      reason: 'failed',
      failed: ['volumes[1]'],
    })
  })

  it('refuses in words on a NiiVue without animateTo', async () => {
    const view = baseView()
    await expect(run(view, { azimuth: 10 })).rejects.toThrow(
      "This page's NiiVue cannot animate.",
    )
  })
})
