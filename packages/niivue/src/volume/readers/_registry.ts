/**
 * Static registry of the volume reader modules in this directory, keyed by path
 * relative to it. A new volume reader must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import * as afni from './afni'
import * as bmp from './bmp'
import * as ecat from './ecat'
import * as fib from './fib'
import * as iwi from './iwi'
import * as mgh from './mgh'
import * as mha from './mha'
import * as mif from './mif'
import * as nii from './nii'
import * as npy from './npy'
import * as nrrd from './nrrd'
import * as src from './src'
import * as tiff from './tiff'
import * as vmr from './vmr'

export const volumeReaderModules = {
  './afni.ts': afni,
  './bmp.ts': bmp,
  './ecat.ts': ecat,
  './fib.ts': fib,
  './iwi.ts': iwi,
  './mgh.ts': mgh,
  './mha.ts': mha,
  './mif.ts': mif,
  './nii.ts': nii,
  './npy.ts': npy,
  './nrrd.ts': nrrd,
  './src.ts': src,
  './tiff.ts': tiff,
  './vmr.ts': vmr,
}
