# @niivue/nv-ext-niimath

Browser-side niimath pipelines for [NiiVue](https://github.com/niivue), wrapping the [`@niivue/niimath`](https://www.npmjs.com/package/@niivue/niimath) WebAssembly build of Chris Rorden's [`niimath`](https://github.com/rordenlab/niimath). All processing runs in a Web Worker; no data leaves the browser.

## Installation

```bash
bun add @niivue/nv-ext-niimath
```

Requires `@niivue/niivue` as a peer dependency.

## Usage

```ts
import NiiVueGPU from '@niivue/niivue'
import { Niimath, runNiimathPipeline } from '@niivue/nv-ext-niimath'

const nv = new NiiVueGPU()
await nv.attachTo('gl1')

// One Niimath instance per page — its worker is expensive to spin up.
const niimath = new Niimath()
await niimath.init()

const input = document.querySelector<HTMLInputElement>('#nifti')!
input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return
  const result = await runNiimathPipeline(niimath, file, [
    { method: 's', args: [3] },     // -s 3   (Gaussian smoothing, sigma 3 mm)
    { method: 'thr', args: [0.5] }, // -thr 0.5
    { method: 'bin', args: [] },    // -bin
  ])
  await nv.loadVolumes([
    { url: new File([result], 'processed.nii.gz'), name: 'processed.nii.gz' },
  ])
})
```

## API

### `runNiimathPipeline(niimath, file, steps, outName?): Promise<Blob>`

Walks `steps` and dispatches each to the matching method on the niimath
chain. Returns the final NIfTI result as a `Blob`. The caller owns the
`Niimath` lifetime; this function never terminates the worker so it can
be reused across many pipelines.

**Serial only.** The underlying worker has a single `onmessage` handler
that gets reassigned on every `run()`, so two overlapping calls against
the same `Niimath` instance will steal each other's responses. Either
await the previous call (typical UI pattern: disable Run while a job is
in flight) or instantiate a separate `Niimath` per concurrent stream.

`outName` defaults to `'output.nii.gz'`. The WASM build of niimath
gzip-compresses its output, so a `.nii` filename produces a file the
worker then can't read back (surfaces as a generic
`Uncaught [object Object]` error). Override only if you have a reason.

### `NiimathStep`

```ts
interface NiimathStep {
  method: string                     // niimath flag without '-' (e.g. 's', 'thr')
  args: (string | number)[]          // positional parameters; strings auto-parsed
}
```

### Re-exports

- `Niimath` — the underlying `@niivue/niimath` class for full control.
- `ImageProcessorMethods`, `Operators`, `OperatorDefinition` — types from
  `@niivue/niimath` for callers building UIs against the operator catalog.

## Why a wrapper?

`@niivue/niimath` already exposes a clean method-chain API (`.s(3).thr(0.5).bin().run()`). This wrapper exists so that UIs whose pipelines come from user input (drag-reorderable steps, dropdown selections, etc.) can build a `NiimathStep[]` array and hand it off, rather than having to build the chain via dynamic-method dispatch themselves.

## Try it locally

A full example app lives at [`apps/demo-ext-niimath`](https://github.com/niivue/mono/tree/main/apps/demo-ext-niimath) (UI: sample-volume picker, drag-reorderable pipeline, generated-command preview, history). To run it from a clone of the monorepo:

```bash
bun install                       # From monorepo root
bunx nx dev demo-ext-niimath      # Start dev server (port 8089)
```

## Part of the [NiiVue](https://github.com/niivue) ecosystem
