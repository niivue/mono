import { describe, expect, it, mock } from 'bun:test'

import { baseView, hostOf } from '../testing/fake-view'
import { describeSignal, signalHandlers } from './signals'
import type {
  GraphRange,
  ShownSignal,
  SignalToLoad,
  SignalUpdate,
  View,
} from './view'

const RANGE: GraphRange = {
  min: 0,
  max: 10,
  full: [0, 10],
  axisLabel: 'ppm',
  isWindowed: false,
}

/** A view with signals NiiVue would keep, loaded and changed as its model would. */
function signalView(overrides: Partial<View> = {}) {
  const signals: ShownSignal[] = [
    {
      id: 's0',
      name: 'pulse.tsv',
      kind: 'physio',
      display: { average: false },
      attachedToId: 'v0',
    },
  ]
  const shown = (signal: SignalToLoad): ShownSignal => {
    const { attachToId, ...rest } = signal
    return {
      ...rest,
      id: `s${signals.length}`,
      ...(attachToId ? { attachedToId: attachToId } : {}),
    }
  }
  return baseView({
    signals,
    loadSignals: mock(async (next: SignalToLoad[]) => {
      signals.splice(0, signals.length, ...next.map(shown))
    }),
    addSignal: mock(async (signal: SignalToLoad) => {
      signals.push(shown(signal))
    }),
    removeSignal: mock((index: number) => {
      signals.splice(index, 1)
    }),
    removeAllSignals: mock(() => {
      signals.splice(0)
    }),
    setSignal: mock((index: number, update: SignalUpdate) => {
      const { attachToId, display, ...rest } = update
      Object.assign(signals[index], rest)
      if (display)
        signals[index].display = { ...signals[index].display, ...display }
      if (attachToId) signals[index].attachedToId = attachToId
    }),
    setSignalCursorFraction: mock(),
    stepSignalCursor: mock(),
    graphZoom: mock(),
    graphPan: mock(),
    graphResetView: mock(),
    setGraphRange: mock(),
    getGraphRange: () => RANGE,
    ...overrides,
  })
}

describe('describeSignal', () => {
  it('names a signal by its name, id or index and reports what is set', () => {
    expect(describeSignal({}, 3)).toEqual({ index: 3, name: 'signal 3' })
    expect(describeSignal({ id: 'abc' }, 0)).toEqual({
      index: 0,
      name: 'abc',
      id: 'abc',
    })
    expect(
      describeSignal(
        {
          name: 'n',
          kind: 'spectroscopy',
          url: 'https://x/n',
          followsCrosshair: true,
          annotations: [{ text: 'peak', x: 1, y: 2 }],
        },
        1,
      ),
    ).toEqual({
      index: 1,
      name: 'n',
      kind: 'spectroscopy',
      url: 'https://x/n',
      followsCrosshair: true,
      annotations: [{ text: 'peak', x: 1, y: 2 }],
    })
  })
})

describe('load_signal', () => {
  it('adds a signal with its display, attachment and notes, named from the url', async () => {
    const view = signalView()
    const { load_signal } = signalHandlers(hostOf(view))
    const got = (await load_signal({
      url: 'https://x/mrs.json#a',
      as_signal: true,
      attach_to: 'mni152',
      display: {
        mode: 'Magnitude',
        ppm_range: [0.5, 4.2],
        ppm_ref: null,
        use_hz: false,
        apodize_hz: 2,
        columns: [0, 2],
        legend: true,
      },
      annotations: [{ text: 'NAA', x: 2, y: 0.5, color: [1, 0, 0] }],
    })) as {
      signal: Record<string, unknown>
      signals: unknown[]
      graph: unknown
    }
    expect(view.addSignal).toHaveBeenCalledWith({
      url: 'https://x/mrs.json#a',
      name: 'mrs.json',
      asSignal: true,
      display: {
        mode: 'magnitude',
        ppmRange: [0.5, 4.2],
        ppmRef: null,
        useHz: false,
        apodizeHz: 2,
        selectedColumns: [0, 2],
        showLegend: true,
      },
      attachToId: 'v0',
      annotations: [{ text: 'NAA', x: 2, y: 0.5, color: [1, 0, 0, 1] }],
    })
    expect(got.signal).toMatchObject({ index: 1, name: 'mrs.json', id: 's1' })
    expect(got.signals).toHaveLength(2)
    expect(got.graph).toEqual(RANGE)
    expect(view.drawScene).toHaveBeenCalledTimes(1)
  })

  it('replaces the signals when asked, and says why a load failed', async () => {
    const view = signalView()
    const { load_signal } = signalHandlers(hostOf(view))
    const got = (await load_signal({
      url: 'https://x/a.tsv',
      replace: true,
    })) as { signals: unknown[] }
    expect(view.loadSignals).toHaveBeenCalledWith([
      { url: 'https://x/a.tsv', name: 'a.tsv' },
    ])
    expect(got.signals).toHaveLength(1)
    const failing = signalHandlers(
      hostOf(
        signalView({
          addSignal: mock(async () => {
            throw new Error('bad json')
          }),
        }),
      ),
    )
    await expect(failing.load_signal({ url: 'https://x/b' })).rejects.toThrow(
      'The signal at https://x/b could not be loaded: bad json',
    )
  })

  it('refuses a missing url, a bad note, an unknown volume, and a page that cannot', async () => {
    const { load_signal } = signalHandlers(hostOf(signalView()))
    await expect(load_signal({})).rejects.toThrow('load_signal needs a url.')
    await expect(
      load_signal({ url: 'https://x/a', annotations: [{ text: 'no x' }] }),
    ).rejects.toThrow('Annotation 0 needs text, x and y.')
    await expect(
      load_signal({ url: 'https://x/a', annotations: 'x' }),
    ).rejects.toThrow('annotations must be a list.')
    await expect(
      load_signal({ url: 'https://x/a', attach_to: 'nope' }),
    ).rejects.toThrow('No volume is named "nope".')
    await expect(
      load_signal({ url: 'https://x/a', display: { mode: 'loud' } }),
    ).rejects.toThrow(
      'Unknown mode "loud". One of: real, imag, magnitude, phase.',
    )
    const noIds = signalHandlers(
      hostOf(signalView({ volumes: [{ name: 'plain' }] })),
    )
    await expect(
      noIds.load_signal({ url: 'https://x/a', attach_to: 0 }),
    ).rejects.toThrow("This page's NiiVue does not give its volumes ids.")
    await expect(
      signalHandlers(hostOf(baseView())).load_signal({ url: 'https://x/a' }),
    ).rejects.toThrow("This page's NiiVue cannot load a signal.")
  })
})

describe('list_signals, set_signal and remove_signal', () => {
  it('lists the signals and the graph range', () => {
    const { list_signals } = signalHandlers(hostOf(signalView()))
    expect(list_signals({})).toEqual({
      signals: [
        {
          index: 0,
          name: 'pulse.tsv',
          id: 's0',
          kind: 'physio',
          display: { average: false },
          attachedTo: 'v0',
        },
      ],
      graph: RANGE,
    })
    expect(() => signalHandlers(hostOf(baseView())).list_signals({})).toThrow(
      "This page's NiiVue has no signals.",
    )
  })

  it('changes a signal, only in what was given', () => {
    const view = signalView()
    const { set_signal } = signalHandlers(hostOf(view))
    expect(
      set_signal({ display: { average: true, phase0: 90 }, attach_to: 0 }),
    ).toEqual({
      signal: {
        index: 0,
        name: 'pulse.tsv',
        id: 's0',
        kind: 'physio',
        display: { average: true, phase0: 90 },
        attachedTo: 'v0',
      },
    })
    expect(view.setSignal).toHaveBeenCalledWith(0, {
      display: { average: true, phase0: 90 },
      attachToId: 'v0',
    })
    expect(() => set_signal({})).toThrow(
      'set_signal needs something to set: display, attach_to or annotations.',
    )
    expect(() => set_signal({ display: {} })).toThrow(
      'set_signal needs something',
    )
    expect(() => set_signal({ signal: 4, display: { average: true } })).toThrow(
      'There is no signal 4',
    )
    expect(() =>
      signalHandlers(hostOf(baseView({ signals: [] }))).set_signal({}),
    ).toThrow("This page's NiiVue cannot change a signal.")
  })

  it('removes one signal or all of them', () => {
    const view = signalView()
    const { remove_signal } = signalHandlers(hostOf(view))
    expect(() => remove_signal({})).toThrow(
      'Say which signal: an index from 0, or a name (pulse.tsv).',
    )
    expect(remove_signal({ signal: 'pulse' })).toEqual({
      removed: 'pulse.tsv',
      signals: [],
    })
    expect(remove_signal({ all: true })).toEqual({ signals: [] })
    expect(view.removeAllSignals).toHaveBeenCalledTimes(1)
    const bare = signalHandlers(hostOf(baseView({ signals: [{ name: 'a' }] })))
    expect(() => bare.remove_signal({ signal: 0 })).toThrow(
      "This page's NiiVue cannot remove a signal.",
    )
    expect(() => bare.remove_signal({ all: true })).toThrow(
      "This page's NiiVue cannot remove its signals.",
    )
  })
})

describe('set_graph', () => {
  it('moves and steps the cursor, zooms, pans, ranges and resets the graph', () => {
    const view = signalView()
    const { set_graph } = signalHandlers(hostOf(view))
    expect(set_graph({ cursor: 1.5 })).toEqual({ graph: RANGE })
    expect(view.setSignalCursorFraction).toHaveBeenCalledWith(1)
    set_graph({ step: 'back' })
    expect(view.stepSignalCursor).toHaveBeenCalledWith(-1)
    set_graph({ step: 'forward', zoom: 2, pan: -0.1 })
    expect(view.stepSignalCursor).toHaveBeenLastCalledWith(1)
    expect(view.graphZoom).toHaveBeenCalledWith(2)
    expect(view.graphPan).toHaveBeenCalledWith(-0.1)
    set_graph({ range: [1, 4] })
    expect(view.setGraphRange).toHaveBeenCalledWith([1, 4])
    set_graph({ range: null })
    expect(view.setGraphRange).toHaveBeenLastCalledWith(null)
    set_graph({ reset: true })
    expect(view.graphResetView).toHaveBeenCalledTimes(1)
    expect(view.drawScene).toHaveBeenCalledTimes(6)
  })

  it('refuses nothing to do, a bad zoom or range, and a page that cannot', () => {
    const { set_graph } = signalHandlers(hostOf(signalView()))
    expect(() => set_graph({})).toThrow(
      'set_graph needs something to do: cursor, step, zoom, pan, range or reset.',
    )
    expect(() => set_graph({ zoom: 0 })).toThrow('zoom must be above 0.')
    expect(() => set_graph({ range: [4, 1] })).toThrow(
      'range must be [min, max] with min below max, or null.',
    )
    expect(() => set_graph({ step: 'sideways' })).toThrow('Unknown step')
    const bare = signalHandlers(hostOf(baseView()))
    expect(() => bare.set_graph({ cursor: 0 })).toThrow(
      "This page's NiiVue cannot move the graph cursor.",
    )
    expect(() => bare.set_graph({ zoom: 2 })).toThrow(
      "This page's NiiVue cannot zoom the graph.",
    )
    expect(() => bare.set_graph({ range: null })).toThrow(
      "This page's NiiVue cannot set the graph range.",
    )
    expect(() => bare.set_graph({ reset: true })).toThrow(
      "This page's NiiVue cannot reset the graph.",
    )
  })
})
