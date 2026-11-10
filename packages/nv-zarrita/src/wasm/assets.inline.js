// `zarrita-wasm/inline`: the wasm module is embedded in the JavaScript (base64,
// loaded on first use) and there is no worker pool, so the build fetches no
// files of its own. For hosts that already decode in their own workers, or
// that bundle into a single file or an inline worker.

export async function defaultWasmSource() {
  const { wasmBytes } = await import('./zarrita.wasm.js')
  return wasmBytes()
}

export function defaultWorkerUrl() {
  return undefined
}
