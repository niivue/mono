// Drives the generated widget's command queue with a fake NiiVue and model
// (issue #439: a running animateTo must not block stopAnimation).
import { expect, mock, test } from 'bun:test'

const log: string[] = []
let endAnimation = (_reason: string) => {}
let endLoad = () => {}
let endSettle = () => {}

class FakeNiiVue {
  registerVolumeTransform() {}
  addEventListener() {}
  removeEventListener() {}
  attachToCanvas() {
    return Promise.resolve()
  }
  animateTo() {
    log.push('animate:start')
    return new Promise<string>((resolve) => {
      endAnimation = resolve
    })
  }
  whenChunkStreamSettles() {
    log.push('settle:start')
    return new Promise<void>((resolve) => {
      endSettle = () => {
        log.push('settle:end')
        resolve()
      }
    })
  }
  stopAnimation() {
    log.push('stop')
    endAnimation('stopped')
  }
  loadVolumes() {
    log.push('load:start')
    return new Promise<void>((resolve) => {
      endLoad = () => {
        log.push('load:end')
        resolve()
      }
    })
  }
  setOpacity() {
    log.push('setOpacity')
  }
}

mock.module('@niivue/niivue', () => ({ default: FakeNiiVue }))
mock.module('@niivue/nv-ext-image-processing', () => ({
  conform: {},
  connectedLabel: {},
  otsu: {},
  removeHaze: {},
}))
mock.module('@niivue/nv-ext-drawing', () => ({
  findDrawingBoundarySlices: () => null,
  interpolateMaskSlices: () => null,
}))
mock.module('@niivue/nv-ext-tile/zarr', () => ({
  loadOmeZarrVolumes: async () => [],
  streamOmeZarr: async () => ({}),
}))

const g = globalThis as Record<string, unknown>
g.document = {
  createElement: () => ({ style: {}, addEventListener() {} }),
}
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0)

const { default: widget } = await import(
  '../src/ipyniivue/static/_widget.template.js'
)

type Handler = () => void
function fakeModel() {
  const values: Record<string, unknown> = { _anywidget_id: crypto.randomUUID() }
  const handlers: Record<string, Handler[]> = {}
  const responses: { req_id: number; ok: boolean; result?: unknown }[] = []
  let seq = 0
  const model = {
    get: (k: string) => values[k],
    set: (k: string, v: unknown) => {
      values[k] = v
      const body = (v as { body?: { kind?: string } })?.body
      if (k === '_msg_outbox' && body?.kind === 'response')
        responses.push(body as (typeof responses)[number])
    },
    save_changes() {},
    on: (evt: string, h: Handler) => {
      handlers[evt] ??= []
      handlers[evt].push(h)
    },
    off() {},
    send: (cmd: string, args: unknown[] = []) => {
      seq++
      values._msg_inbox = [{ seq, body: { cmd, args, req_id: seq } }]
      for (const h of handlers['change:_msg_inbox'] ?? []) h()
      return seq
    },
  }
  return { model, responses }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

async function mounted() {
  const { model, responses } = fakeModel()
  await widget.initialize({ model })
  await widget.render({ model, el: { appendChild() {} } })
  return { model, responses }
}

test('stopAnimation runs while animateTo is pending', async () => {
  log.length = 0
  const { model, responses } = await mounted()
  const animId = model.send('animateTo', [{ azimuth: 180 }])
  model.send('stopAnimation')
  await tick()
  expect(log).toEqual(['animate:start', 'stop'])
  expect(responses.find((r) => r.req_id === animId)).toMatchObject({
    ok: true,
    result: 'stopped',
  })
})

test('other commands still wait for the previous promise', async () => {
  log.length = 0
  const { model } = await mounted()
  model.send('loadVolumes', [[]])
  model.send('setOpacity', [0, 0.5])
  await tick()
  expect(log).toEqual(['load:start'])
  endLoad()
  await tick()
  expect(log).toEqual(['load:start', 'load:end', 'setOpacity'])
})

// Python's when_chunk_stream_settles() is fire-and-forget; the queue is its only barrier.
test('whenChunkStreamSettles holds the queue', async () => {
  log.length = 0
  const { model } = await mounted()
  model.send('whenChunkStreamSettles')
  model.send('setOpacity', [0, 0.5])
  await tick()
  expect(log).toEqual(['settle:start'])
  endSettle()
  await tick()
  expect(log).toEqual(['settle:start', 'settle:end', 'setOpacity'])
})
