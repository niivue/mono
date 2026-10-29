/**
 * @niivue/nv-ext-dcm2niix
 *
 * Browser-side DICOM-to-NIfTI conversion for NiiVue. The conversion glue
 * (`runDcm2niix`, `traverseDataTransferItems`, worker lifetime, timeouts,
 * output grouping) now lives upstream in `@niivue/dcm2niix` 1.4, so this
 * package re-exports it unchanged for existing imports. New code can import
 * `@niivue/dcm2niix` directly.
 *
 * Usage:
 * ```ts
 * import { runDcm2niix } from '@niivue/nv-ext-dcm2niix'
 *
 * input.addEventListener('change', async () => {
 *   const niftiFiles = await runDcm2niix(input.files)
 *   await nv.loadVolumes([{ url: niftiFiles[0] }])
 * })
 * ```
 */

import type { runDcm2niix } from '@niivue/dcm2niix'

export type {
  ConvertOptions,
  ConvertResult,
  Dcm2niixProcessor,
  OutputFile,
  Series,
  SeriesListing,
} from '@niivue/dcm2niix'
// biome-ignore lint/performance/noBarrelFile: package entry point, kept so existing imports keep working
export {
  convert,
  Dcm2niix,
  exitCodes,
  filesFromDataTransfer,
  groupOutputs,
  listSeries,
  runDcm2niix,
  traverseDataTransferItems,
} from '@niivue/dcm2niix'

/** Options for {@link runDcm2niix}: `niftiOnly` (default `true`) plus `convert` options such as `signal` and `timeoutMs`. */
export type RunDcm2niixOptions = NonNullable<Parameters<typeof runDcm2niix>[1]>
