/**
 * Static registry of the connectome reader modules in this directory, keyed by path
 * relative to it. A new connectome reader must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as jcon from './jcon'

export const connectomeReaderModules = {
  './jcon.ts': jcon,
}
