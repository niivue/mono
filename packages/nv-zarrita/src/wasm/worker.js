// Decode worker: owns one wasm instance. Works as a browser module Worker and
// as a Node worker_threads worker.
import { Decoder } from './core.js'

const WORKER_THREADS = 'node:worker_threads'
let post
let ready

function handle(msg) {
  if (msg.type === 'init') {
    ready = Decoder.create(msg.module)
    return
  }
  ready.then(
    (decoder) => {
      try {
        if (msg.type === 'decodeInto') {
          decoder.decodeInto(msg.spec, new Uint8Array(msg.bytes), msg.target)
          post({ id: msg.id, ok: true })
          return
        }
        const { buffer, stride } = decoder.decode(
          msg.spec,
          new Uint8Array(msg.bytes),
        )
        post({ id: msg.id, ok: true, buffer, stride }, [buffer])
      } catch (e) {
        post({ id: msg.id, ok: false, error: String(e?.message ?? e) })
      }
    },
    (e) =>
      post({
        id: msg.id,
        ok: false,
        error: `zarrita-wasm init failed: ${e?.message ?? e}`,
      }),
  )
}

if (
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  post = (m, t) => self.postMessage(m, t)
  self.onmessage = (e) => handle(e.data)
} else {
  const { parentPort } = await import(/* @vite-ignore */ WORKER_THREADS)
  post = (m, t) => parentPort.postMessage(m, t)
  parentPort.on('message', handle)
}
