/**
 * Static registry of the volume writer modules in this directory, keyed by path
 * relative to it. A new volume writer must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as iwi from './iwi'
import * as nii from './nii'

export const volumeWriterModules = {
  './iwi.ts': iwi,
  './nii.ts': nii,
}
