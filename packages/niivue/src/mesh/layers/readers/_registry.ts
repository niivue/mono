/**
 * Static registry of the mesh layer reader modules in this directory, keyed by path
 * relative to it. A new mesh layer reader must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as curv from './curv'
import * as smp from './smp'
import * as stc from './stc'

export const layerReaderModules = {
  './curv.ts': curv,
  './smp.ts': smp,
  './stc.ts': stc,
}
