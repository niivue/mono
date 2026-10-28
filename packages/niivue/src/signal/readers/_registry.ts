/**
 * Static registry of the signal reader modules in this directory, keyed by path
 * relative to it. A new signal reader must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as nii from './nii'
import * as tsv from './tsv'

export const signalReaderModules = {
  './nii.ts': nii,
  './tsv.ts': tsv,
}
