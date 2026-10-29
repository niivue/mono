/**
 * Static registry of the mesh writer modules in this directory, keyed by path
 * relative to it. A new mesh writer must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as iwm from './iwm'
import * as mz3 from './mz3'
import * as obj from './obj'
import * as stl from './stl'

export const meshWriterModules = {
  './iwm.ts': iwm,
  './mz3.ts': mz3,
  './obj.ts': obj,
  './stl.ts': stl,
}
