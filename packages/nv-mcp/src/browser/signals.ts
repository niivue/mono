/**
 * Signals: a physiological trace or a spectroscopy voxel, and the graph
 * they are drawn on.
 */

import {
  choice,
  clamp,
  color,
  flag,
  nameFromUrl,
  number,
  numbers,
  type Params,
  put,
  record,
  text,
} from './params'
import { pickIndex } from './pick'
import type {
  Handlers,
  NiiVueHost,
  ShownSignal,
  SignalAnnotation,
  SignalDisplay,
  SignalToLoad,
  SignalUpdate,
} from './view'

const MODES = ['real', 'imag', 'magnitude', 'phase'] as const

/** A signal as the tools report it. */
export function describeSignal(signal: ShownSignal, index: number) {
  return {
    index,
    name: signal.name ?? signal.id ?? `signal ${index}`,
    ...(signal.id ? { id: signal.id } : {}),
    ...(signal.kind ? { kind: signal.kind } : {}),
    ...(signal.url ? { url: signal.url } : {}),
    ...(signal.display ? { display: signal.display } : {}),
    ...(signal.attachedToId ? { attachedTo: signal.attachedToId } : {}),
    ...(signal.followsCrosshair ? { followsCrosshair: true } : {}),
    ...(signal.annotations?.length ? { annotations: signal.annotations } : {}),
  }
}

/** How a signal is drawn, read off a `display` object. */
function displayFields(params: Params): SignalDisplay {
  const display: SignalDisplay = {}
  put(display, 'average', flag(params, 'average'))
  put(display, 'mode', choice(params, 'mode', MODES))
  const range = params?.ppm_range
  if (range !== undefined) {
    if (range === null) display.ppmRange = null
    else {
      const pair = numbers(params, 'ppm_range', 2)
      if (pair) display.ppmRange = [pair[0], pair[1]]
    }
  }
  const ref = params?.ppm_ref
  if (ref !== undefined)
    display.ppmRef = ref === null ? null : (number(params, 'ppm_ref') ?? null)
  put(display, 'useHz', flag(params, 'use_hz'))
  put(display, 'halveFirstPoint', flag(params, 'halve_first_point'))
  put(display, 'apodizeHz', number(params, 'apodize_hz'))
  put(display, 'phase0', number(params, 'phase0'))
  put(display, 'phase1Ms', number(params, 'phase1_ms'))
  const columns = params?.columns
  if (columns !== undefined) {
    if (columns === null) display.selectedColumns = null
    else {
      const list = numbers(params, 'columns')
      if (list) display.selectedColumns = list
    }
  }
  put(display, 'showLegend', flag(params, 'legend'))
  return display
}

/** Notes on the graph, read off a list. */
function annotationList(params: Params): SignalAnnotation[] | undefined {
  const list = params?.annotations
  if (list === undefined || list === null) return undefined
  if (!Array.isArray(list)) throw new Error('annotations must be a list.')
  return list.map((note, i) => {
    const fields = record({ note }, 'note') ?? {}
    const label = text(fields, 'text')
    const x = number(fields, 'x')
    const y = number(fields, 'y')
    if (!label || x === undefined || y === undefined)
      throw new Error(`Annotation ${i} needs text, x and y.`)
    const made: SignalAnnotation = { text: label, x, y }
    put(made, 'color', color(fields, 'color'))
    return made
  })
}

/** The handlers for the signal and graph tools. */
export function signalHandlers(host: NiiVueHost): Handlers {
  const { view } = host

  const signals = (): ReadonlyArray<ShownSignal> => {
    if (!view.signals) throw new Error("This page's NiiVue has no signals.")
    return view.signals
  }
  const signalsShown = () => signals().map(describeSignal)
  const attachTo = (params: Params): string | undefined => {
    const wanted = params?.attach_to
    if (wanted === undefined || wanted === null) return undefined
    const index = pickIndex(view.volumes, wanted, 'volume')
    const id = view.volumes[index].id
    if (id === undefined)
      throw new Error("This page's NiiVue does not give its volumes ids.")
    return id
  }
  const graph = () => ({
    ...(view.getGraphRange ? { graph: view.getGraphRange() } : {}),
  })

  return {
    async load_signal(params: Params) {
      host.beforeAnswer?.()
      const url = text(params, 'url')
      if (!url) throw new Error('load_signal needs a url.')
      const replace = flag(params, 'replace') ?? false
      if ((replace ? !view.loadSignals : !view.addSignal) || !view.signals)
        throw new Error("This page's NiiVue cannot load a signal.")
      if (replace && !view.removeAllSignals)
        throw new Error("This page's NiiVue cannot replace its signals.")
      const signal: SignalToLoad = {
        url,
        name: text(params, 'name') ?? nameFromUrl(url),
      }
      put(signal, 'asSignal', flag(params, 'as_signal'))
      const display = record(params, 'display')
      if (display) signal.display = displayFields(display)
      put(signal, 'attachToId', attachTo(params))
      put(signal, 'annotations', annotationList(params))
      // NiiVue's loadSignals appends, so a replacement clears first; it
      // then goes through loadSignals for the graph window reset.
      if (replace) view.removeAllSignals?.()
      try {
        if (replace) await view.loadSignals?.([signal])
        else await view.addSignal?.(signal)
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        throw new Error(`The signal at ${url} could not be loaded: ${why}`)
      }
      view.drawScene()
      const index = view.signals.length - 1
      return {
        signal: describeSignal(view.signals[index], index),
        signals: signalsShown(),
        ...graph(),
      }
    },

    list_signals() {
      host.beforeAnswer?.()
      return { signals: signalsShown(), ...graph() }
    },

    set_signal(params: Params) {
      host.beforeAnswer?.()
      if (!view.setSignal)
        throw new Error("This page's NiiVue cannot change a signal.")
      const index = pickIndex(signals(), params?.signal, 'signal', 0)
      const update: SignalUpdate = {}
      const display = record(params, 'display')
      if (display) {
        const fields = displayFields(display)
        if (Object.keys(fields).length) update.display = fields
      }
      put(update, 'attachToId', attachTo(params))
      put(update, 'annotations', annotationList(params))
      if (!Object.keys(update).length)
        throw new Error(
          'set_signal needs something to set: display, attach_to or annotations.',
        )
      view.setSignal(index, update)
      view.drawScene()
      return { signal: describeSignal(signals()[index], index) }
    },

    remove_signal(params: Params) {
      host.beforeAnswer?.()
      if (flag(params, 'all')) {
        if (!view.removeAllSignals)
          throw new Error("This page's NiiVue cannot remove its signals.")
        view.removeAllSignals()
        view.drawScene()
        return { signals: [] }
      }
      if (!view.removeSignal)
        throw new Error("This page's NiiVue cannot remove a signal.")
      const index = pickIndex(signals(), params?.signal, 'signal')
      const removed = describeSignal(signals()[index], index).name
      view.removeSignal(index)
      view.drawScene()
      return { removed, signals: signalsShown() }
    },

    set_graph(params: Params) {
      host.beforeAnswer?.()
      let changed = false
      const refuse = (what: string) => {
        throw new Error(`This page's NiiVue cannot ${what}.`)
      }
      const cursor = number(params, 'cursor')
      if (cursor !== undefined) {
        if (!view.setSignalCursorFraction) refuse('move the graph cursor')
        view.setSignalCursorFraction?.(clamp(cursor, 0, 1))
        changed = true
      }
      const step = choice(params, 'step', ['forward', 'back'] as const)
      if (step) {
        if (!view.stepSignalCursor) refuse('step the graph cursor')
        view.stepSignalCursor?.(step === 'forward' ? 1 : -1)
        changed = true
      }
      const zoom = number(params, 'zoom')
      if (zoom !== undefined) {
        if (!view.graphZoom) refuse('zoom the graph')
        if (zoom <= 0) throw new Error('zoom must be above 0.')
        view.graphZoom?.(zoom)
        changed = true
      }
      const pan = number(params, 'pan')
      if (pan !== undefined) {
        if (!view.graphPan) refuse('pan the graph')
        view.graphPan?.(pan)
        changed = true
      }
      const range = params?.range
      if (range !== undefined) {
        if (!view.setGraphRange) refuse('set the graph range')
        if (range === null) view.setGraphRange?.(null)
        else {
          const pair = numbers(params, 'range', 2)
          if (!pair || pair[0] >= pair[1])
            throw new Error(
              'range must be [min, max] with min below max, or null.',
            )
          view.setGraphRange?.([pair[0], pair[1]])
        }
        changed = true
      }
      if (flag(params, 'reset')) {
        if (!view.graphResetView) refuse('reset the graph')
        view.graphResetView?.()
        changed = true
      }
      if (!changed)
        throw new Error(
          'set_graph needs something to do: cursor, step, zoom, pan, range or reset.',
        )
      view.drawScene()
      return graph()
    },
  }
}
