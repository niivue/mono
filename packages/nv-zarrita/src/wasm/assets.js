// Where the wasm module and the decode worker come from. The package's
// default build loads them as files next to this module; the `inline` build
// (dist/inline) replaces this file with assets.inline.js.

/** The wasm module source: a URL to fetch, or the bytes themselves. */
export async function defaultWasmSource() {
  return new URL('./zarrita.wasm', import.meta.url)
}

/** The decode worker script, or undefined when this build has no worker. */
export function defaultWorkerUrl() {
  return new URL('./worker.js', import.meta.url)
}
