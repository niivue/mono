/**
 * Static registry of the mesh reader modules in this directory, keyed by path
 * relative to it. A new mesh reader must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as asc from './asc'
import * as dfs from './dfs'
import * as fs from './fs'
import * as geo from './geo'
import * as gii from './gii'
import * as ico from './ico'
import * as iwm from './iwm'
import * as mz3 from './mz3'
import * as nv from './nv'
import * as obj from './obj'
import * as off from './off'
import * as ply from './ply'
import * as srf from './srf'
import * as stl from './stl'
import * as vtk from './vtk'
import * as wrl from './wrl'
import * as x3d from './x3d'

export const meshReaderModules = {
  './asc.ts': asc,
  './dfs.ts': dfs,
  './fs.ts': fs,
  './geo.ts': geo,
  './gii.ts': gii,
  './ico.ts': ico,
  './iwm.ts': iwm,
  './mz3.ts': mz3,
  './nv.ts': nv,
  './obj.ts': obj,
  './off.ts': off,
  './ply.ts': ply,
  './srf.ts': srf,
  './stl.ts': stl,
  './vtk.ts': vtk,
  './wrl.ts': wrl,
  './x3d.ts': x3d,
}
