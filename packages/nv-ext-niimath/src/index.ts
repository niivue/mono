/**
 * @niivue/nv-ext-niimath
 *
 * Browser-side niimath pipelines for NiiVue, wrapping the
 * `@niivue/niimath` WebAssembly build of Chris Rorden's niimath.
 *
 * Most callers want one function:
 *
 *   - {@link runNiimathPipeline} — apply a sequence of niimath operations
 *     to a `File` and resolve to the resulting `Blob`.
 *
 * The underlying `Niimath` class is re-exported for callers who want full
 * control over worker lifecycle (e.g. reusing a single instance across
 * many runs).
 *
 * Usage:
 * ```ts
 * import NiiVueGPU from '@niivue/niivue'
 * import { Niimath, runNiimathPipeline } from '@niivue/nv-ext-niimath'
 *
 * const nv = new NiiVueGPU()
 * await nv.attachTo('gl1')
 *
 * const niimath = new Niimath()
 * await niimath.init()
 *
 * const result = await runNiimathPipeline(niimath, inputFile, [
 *   { method: 's', args: [3] },     // -s 3   (Gaussian smoothing)
 *   { method: 'thr', args: [0.5] }, // -thr 0.5
 *   { method: 'bin', args: [] },    // -bin
 * ])
 *
 * await nv.loadVolumes([{ url: result, name: 'processed.nii.gz' }])
 * ```
 */

import { type ImageProcessorMethods, Niimath } from '@niivue/niimath'

export type {
  ImageProcessorMethods,
  OperatorDefinition,
  Operators,
} from '@niivue/niimath'
// Re-export so callers can drop down to the raw API when they need
// operators we don't expose helpers for, or want to manage the worker
// lifecycle directly.
export { Niimath }

/**
 * One step in a niimath pipeline.
 *
 * `method` is the niimath operator name **without** the leading dash —
 * e.g. `'s'` for `-s`, `'thr'` for `-thr`, `'bin'` for `-bin`. See the
 * [niimath operator catalog](https://github.com/rordenlab/niimath#options).
 *
 * `args` are positional parameters. Strings that parse as numbers are
 * converted automatically; pass numbers directly if you already have them.
 */
export interface NiimathStep {
  method: string
  args: (string | number)[]
}

type Chain = ImageProcessorMethods & { run(outName?: string): Promise<Blob> }

/**
 * Run a sequence of niimath operations against an input file.
 *
 * The caller owns the `Niimath` instance — pass an already-`init()`ed one.
 * That lets you reuse a single worker across many pipelines (the WASM
 * cold-start is non-trivial; reuse matters for interactive UIs).
 *
 * **Serial only.** The underlying `@niivue/niimath` worker has a single
 * `onmessage` handler that gets reassigned on every `run()` call, so two
 * overlapping `runNiimathPipeline` calls against the same `Niimath`
 * instance will steal each other's responses. Either await the previous
 * call before kicking off the next one (the typical UI pattern: disable
 * the Run button while a job is in flight), or instantiate a separate
 * `Niimath` per concurrent stream.
 *
 * @param niimath  An initialised `Niimath` instance (after `await niimath.init()`).
 * @param file     Input NIfTI as a browser `File`.
 * @param steps    Pipeline steps; applied in order.
 * @param outName  Output filename in the WASM filesystem; must end in
 *                 `.nii.gz` since the WASM build always gzips its output.
 * @returns        The processed NIfTI as a `Blob` (gzipped).
 *
 * @throws If a step references a method the WASM build doesn't expose.
 */
export async function runNiimathPipeline(
  niimath: Niimath,
  file: File,
  steps: NiimathStep[],
  outName = 'output.nii.gz',
): Promise<Blob> {
  if (!outName.toLowerCase().endsWith('.nii.gz')) {
    throw new Error(
      `outName must end with .nii.gz; got "${outName}". The WASM build of niimath always gzips its output.`,
    )
  }
  let chain = niimath.image(file) as unknown as Chain
  for (const step of steps) {
    const args = step.args.map((a) => {
      if (typeof a === 'number') return a
      const trimmed = a.trim()
      const n = Number(trimmed)
      return Number.isFinite(n) && trimmed.length > 0 ? n : trimmed
    })
    // niimath generates each operator method as an *own* property on the
    // ImageProcessor instance, so `Object.hasOwn` reliably rejects
    // inherited names like `constructor`/`toString` that would otherwise
    // dispatch to harmless-but-cryptic prototype methods.
    const obj = chain as unknown as Record<
      string,
      ((...a: (string | number)[]) => Chain) | undefined
    >
    if (
      !Object.hasOwn(obj, step.method) ||
      typeof obj[step.method] !== 'function'
    ) {
      throw new Error(`Unknown niimath method: -${step.method}`)
    }
    chain = obj[step.method]?.apply(chain, args) as Chain
  }
  return await chain.run(outName)
}
