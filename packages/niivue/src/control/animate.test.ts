import { describe, expect, test } from 'bun:test'
import type NiiVueGPU from '@/NVControlBase'
import {
  Animation,
  type AnimationChannel,
  type AnimationClock,
  easingFunction,
  planAnimation,
  STALL_GRACE_MS,
  sampleTrack,
  shortestTurn,
} from './animate'

/** A clock that only moves when the test says so. */
function fakeClock() {
  let time = 0
  let nextId = 0
  const frames = new Map<number, () => void>()
  const timers = new Map<number, { at: number; cb: () => void }>()
  const clock: AnimationClock & {
    advance(ms: number): void
    stallFor(ms: number): void
  } = {
    now: () => time,
    requestFrame(cb) {
      frames.set(++nextId, cb)
      return nextId
    },
    cancelFrame(id) {
      frames.delete(id)
    },
    setTimer(cb, ms) {
      timers.set(++nextId, { at: time + ms, cb })
      return nextId
    },
    clearTimer(id) {
      timers.delete(id as number)
    },
    /** Move time on, then run one round of frames and any due timers. */
    advance(ms) {
      time += ms
      const due = [...frames.values()]
      frames.clear()
      for (const cb of due) cb()
      this.stallFor(0)
    },
    /** Move time on with no frames at all, as in a hidden tab. */
    stallFor(ms) {
      time += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= time) {
          timers.delete(id)
          t.cb()
        }
      }
    },
  }
  return clock
}

/** A one-number channel that records every write. */
function recorder(
  from: number,
  to: number,
  kind: 'linear' | 'angle' = 'linear',
) {
  const writes: number[] = []
  const channel: AnimationChannel = {
    name: 'x',
    tracks: [{ from, to, kind }],
    write: ([v]) => {
      writes.push(v)
    },
  }
  return { channel, writes }
}

/** Let settled promises run their callbacks. */
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('easing', () => {
  test('every named easing starts at 0 and ends at 1', () => {
    for (const name of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as const) {
      const ease = easingFunction(name)
      expect(ease(0)).toBe(0)
      expect(ease(1)).toBe(1)
    }
  })

  test('easeInOut is symmetric about the midpoint', () => {
    const ease = easingFunction('easeInOut')
    expect(ease(0.5)).toBeCloseTo(0.5)
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1)
  })

  test('an unknown name falls back to easeInOut', () => {
    const ease = easingFunction('bouncy' as 'linear')
    expect(ease(0.25)).toBeCloseTo(easingFunction('easeInOut')(0.25))
  })
})

describe('shortestTurn', () => {
  test('turns the short way across 0', () => {
    expect(shortestTurn(350, 10)).toBe(20)
    expect(shortestTurn(10, 350)).toBe(-20)
  })

  test('ignores whole turns in the target', () => {
    expect(shortestTurn(0, 370)).toBe(10)
    expect(shortestTurn(0, -350)).toBe(10)
  })

  test('a half turn goes positive', () => {
    expect(shortestTurn(0, 180)).toBe(180)
  })
})

describe('sampleTrack', () => {
  test('an angle passes through 0 rather than 180', () => {
    const tr = { from: 350, to: 10, kind: 'angle' as const }
    expect(sampleTrack(tr, 0.5)).toBeCloseTo(360)
  })

  test('the end is the target exactly, not an equivalent angle', () => {
    expect(sampleTrack({ from: 350, to: 10, kind: 'angle' }, 1)).toBe(10)
  })

  test('an index visits every whole value in between', () => {
    const tr = { from: 0, to: 4, kind: 'index' as const }
    const seen = new Set<number>()
    for (let u = 0; u <= 1; u += 0.01) seen.add(sampleTrack(tr, u))
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4])
  })
})

/** Enough of the controller for planning, with every write recorded. */
function fakeController(over: Record<string, unknown> = {}) {
  const calls: unknown[][] = []
  const ctrl = {
    azimuth: 350,
    elevation: 10,
    scaleMultiplier: 1,
    renderPan: [0, 0],
    pan2Dxyzmm: [0, 0, 0, 1],
    getCrosshairPos: () => [0, 0, 0],
    setCrosshairPos: (p: number[]) => calls.push(['crosshair', p]),
    getClipPlaneDepthAziElev: () => [Number.NaN, Number.NaN, Number.NaN],
    setClipPlaneDepthAziElev: (...a: number[]) => calls.push(['clip', ...a]),
    volumes: [
      { id: 'a', calMin: 0, calMax: 100, opacity: 1, frame4D: 0, nFrame4D: 5 },
    ],
    meshes: [{ opacity: 1 }],
    setVolume: async (i: number, o: object) => {
      calls.push(['volume', i, o])
    },
    setFrame4D: async (id: string, f: number) => {
      calls.push(['frame', id, f])
    },
    setMesh: async (i: number, o: object) => {
      calls.push(['mesh', i, o])
    },
    ...over,
  }
  return { ctrl: ctrl as unknown as NiiVueGPU, calls }
}

describe('planAnimation', () => {
  test('plans a channel only for what the target names', () => {
    const { ctrl } = fakeController()
    const names = planAnimation(ctrl, {
      elevation: 30,
      meshes: { 0: { opacity: 0 } },
    }).map((c) => c.name)
    expect(names).toEqual(['elevation', 'meshes[0]'])
  })

  test('azimuth turns the short way unless angles are literal', () => {
    const { ctrl } = fakeController()
    const [short] = planAnimation(ctrl, { azimuth: 10 })
    expect(short.tracks[0].kind).toBe('angle')
    const [literal] = planAnimation(ctrl, { azimuth: 10 }, 'literal')
    expect(literal.tracks[0].kind).toBe('linear')
  })

  test('drops non-finite values and missing indices', () => {
    const { ctrl } = fakeController()
    const names = planAnimation(ctrl, {
      azimuth: Number.NaN,
      crosshairMM: [0, Number.POSITIVE_INFINITY, 0],
      volumes: { 0: { calMin: 5 }, 3: { opacity: 0 } },
      meshes: { 9: { opacity: 0 } },
    }).map((c) => c.name)
    expect(names).toEqual(['volumes[0]'])
  })

  test('a clip plane with no readable start jumps to the target', () => {
    const { ctrl } = fakeController()
    const [plane] = planAnimation(ctrl, { clipPlanes: { 2: [0.1, 30, 40] } })
    expect(plane.tracks.map((t) => t.from)).toEqual([0.1, 30, 40])
  })

  test('a 4D frame is clamped to the frames the volume has', () => {
    const { ctrl } = fakeController()
    const [frame] = planAnimation(ctrl, { volumes: { 0: { frame4D: 99 } } })
    expect(frame.tracks[0]).toEqual({ from: 0, to: 4, kind: 'index' })
  })

  test('window and opacity are written together in one setVolume', async () => {
    const { ctrl, calls } = fakeController()
    const [vol] = planAnimation(ctrl, {
      volumes: { 0: { calMin: 10, opacity: 0.5 } },
    })
    await vol.write([10, 0.5])
    expect(calls).toEqual([['volume', 0, { calMin: 10, opacity: 0.5 }]])
  })
})

describe('Animation', () => {
  test('moves through eased values and lands on the target', async () => {
    const clock = fakeClock()
    const { channel, writes } = recorder(0, 100)
    const anim = new Animation(
      [channel],
      { duration: 100, easing: 'linear' },
      clock,
    )
    const done = anim.start()
    clock.advance(25)
    clock.advance(25)
    clock.advance(60)
    const result = await done
    expect(writes).toEqual([25, 50, 100])
    expect(result).toEqual({
      completed: true,
      reason: 'finished',
      elapsedMs: 110,
    })
    expect(anim.running).toBe(false)
  })

  test('stop leaves the value where the last frame put it', async () => {
    const clock = fakeClock()
    const { channel, writes } = recorder(0, 100)
    const anim = new Animation(
      [channel],
      { duration: 100, easing: 'linear' },
      clock,
    )
    const done = anim.start()
    clock.advance(40)
    anim.stop('input')
    clock.advance(100)
    expect(writes).toEqual([40])
    expect(await done).toMatchObject({ completed: false, reason: 'input' })
  })

  test('with no frames, it jumps to the target once the grace runs out', async () => {
    const clock = fakeClock()
    const { channel, writes } = recorder(0, 100)
    const done = new Animation([channel], { duration: 100 }, clock).start()
    clock.stallFor(100 + STALL_GRACE_MS - 1)
    expect(writes).toEqual([])
    clock.stallFor(1)
    expect(await done).toMatchObject({ completed: true, reason: 'stalled' })
    expect(writes).toEqual([100])
  })

  test('a zero duration writes the target at once', async () => {
    const clock = fakeClock()
    const { channel, writes } = recorder(0, 100)
    const result = await new Animation(
      [channel],
      { duration: 0 },
      clock,
    ).start()
    expect(writes).toEqual([100])
    expect(result.reason).toBe('finished')
  })

  test('a paced write skips frames while busy, and the target lands last', async () => {
    const clock = fakeClock()
    const writes: number[] = []
    let release = () => {}
    const channel: AnimationChannel = {
      name: 'slow',
      tracks: [{ from: 0, to: 100, kind: 'linear' }],
      write: ([v]) => {
        writes.push(v)
        return new Promise<void>((r) => {
          release = r
        })
      },
    }
    const done = new Animation(
      [channel],
      { duration: 100, easing: 'linear' },
      clock,
    ).start()
    clock.advance(10) // writes 10, then stays busy
    clock.advance(10) // skipped
    clock.advance(10) // skipped
    expect(writes).toEqual([10])
    release()
    await flush()
    clock.advance(10) // free again: writes 40
    clock.advance(70) // past the end: waits for 40, then writes 100
    release()
    await flush()
    release()
    const result = await done
    expect(writes).toEqual([10, 40, 100])
    expect(result.completed).toBe(true)
  })

  test('a target write that fails ends the run as failed, naming the channel', async () => {
    const clock = fakeClock()
    const broken: AnimationChannel = {
      name: 'broken',
      tracks: [{ from: 0, to: 1, kind: 'linear' }],
      write: () => {
        throw new Error('nope')
      },
    }
    const rejecting: AnimationChannel = {
      name: 'volumes[0]',
      tracks: [{ from: 0, to: 1, kind: 'linear' }],
      write: () => Promise.reject(new Error('nope')),
    }
    const fine = recorder(0, 1)
    const result = await new Animation(
      [broken, fine.channel, rejecting],
      { duration: 0 },
      clock,
    ).start()
    expect(result).toMatchObject({
      completed: false,
      reason: 'failed',
      failed: ['broken', 'volumes[0]'],
    })
    expect(fine.writes).toEqual([1])
  })

  test('a frame write that failed is retried at the target', async () => {
    const clock = fakeClock()
    const writes: number[] = []
    let fail = true
    const channel: AnimationChannel = {
      name: 'x',
      tracks: [{ from: 0, to: 100, kind: 'index' }],
      write: ([v]) => {
        writes.push(v)
        if (fail) throw new Error('nope')
      },
    }
    const done = new Animation(
      [channel],
      { duration: 100, easing: 'linear' },
      clock,
    ).start()
    clock.advance(99.6) // samples 100, which fails
    fail = false
    clock.advance(10)
    const result = await done
    expect(writes).toEqual([100, 100])
    expect(result).toMatchObject({ completed: true, reason: 'finished' })
  })

  test('a stop from inside a frame write halts the rest of the frame', async () => {
    const clock = fakeClock()
    const later = recorder(0, 100)
    let run: Animation | null = null
    const stopper: AnimationChannel = {
      name: 'first',
      tracks: [{ from: 0, to: 100, kind: 'linear' }],
      write: () => run?.stop('superseded'),
    }
    run = new Animation(
      [stopper, later.channel],
      { duration: 100, easing: 'linear' },
      clock,
    )
    const done = run.start()
    clock.advance(10)
    clock.advance(10)
    expect(await done).toMatchObject({ completed: false, reason: 'superseded' })
    expect(later.writes).toEqual([])
  })

  test('a stop from inside a target write halts the rest of the landing', async () => {
    const clock = fakeClock()
    const later = recorder(0, 100)
    let run: Animation | null = null
    const stopper: AnimationChannel = {
      name: 'first',
      tracks: [{ from: 0, to: 100, kind: 'linear' }],
      write: () => run?.stop('superseded'),
    }
    run = new Animation([stopper, later.channel], { duration: 0 }, clock)
    expect(await run.start()).toMatchObject({
      completed: false,
      reason: 'superseded',
    })
    expect(later.writes).toEqual([])
  })
})
