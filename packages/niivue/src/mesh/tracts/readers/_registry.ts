/**
 * Static registry of the tract reader modules in this directory, keyed by path
 * relative to it. A new tract reader must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as tck from './tck'
import * as trk from './trk'
import * as trx from './trx'
import * as tt from './tt'

export const tractReaderModules = {
  './tck.ts': tck,
  './trk.ts': trk,
  './trx.ts': trx,
  './tt.ts': tt,
}
