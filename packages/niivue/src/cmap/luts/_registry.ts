/**
 * Static registry of the colormap LUT modules in this directory, keyed by path
 * relative to it. A new colormap LUT must be added here; `src/registry.test.ts`
 * fails when a file in this directory is missing from the registry.
 */
import actc from './actc.json'
import afni_blues_inv from './afni_blues_inv.json'
import afni_reds_inv from './afni_reds_inv.json'
import batlow from './batlow.json'
import bcgwhw from './bcgwhw.json'
import bcgwhw_dark from './bcgwhw_dark.json'
import blue from './blue.json'
import blue2cyan from './blue2cyan.json'
import blue2magenta from './blue2magenta.json'
import blue2red from './blue2red.json'
import bluegrn from './bluegrn.json'
import bone from './bone.json'
import bronze from './bronze.json'
import cet_l17 from './cet_l17.json'
import cividis from './cividis.json'
import cool from './cool.json'
import copper from './copper.json'
import copper2 from './copper2.json'
import ct_airways from './ct_airways.json'
import ct_artery from './ct_artery.json'
import ct_bones from './ct_bones.json'
import ct_brain from './ct_brain.json'
import ct_brain_gray from './ct_brain_gray.json'
import ct_cardiac from './ct_cardiac.json'
import ct_head from './ct_head.json'
import ct_kidneys from './ct_kidneys.json'
import ct_liver from './ct_liver.json'
import ct_muscles from './ct_muscles.json'
import ct_scalp from './ct_scalp.json'
import ct_skull from './ct_skull.json'
import ct_soft from './ct_soft.json'
import ct_soft_tissue from './ct_soft_tissue.json'
import ct_surface from './ct_surface.json'
import ct_vessels from './ct_vessels.json'
import ct_w_contrast from './ct_w_contrast.json'
import cubehelix from './cubehelix.json'
import draw from './draw.json'
import electric_blue from './electric_blue.json'
import freesurfer from './freesurfer.json'
import ge_color from './ge_color.json'
import gold from './gold.json'
import gray from './gray.json'
import green from './green.json'
import green2cyan from './green2cyan.json'
import green2orange from './green2orange.json'
import hot from './hot.json'
import hotiron from './hotiron.json'
import hsv from './hsv.json'
import inferno from './inferno.json'
import itksnap from './itksnap.json'
import jet from './jet.json'
import kry from './kry.json'
import linspecer from './linspecer.json'
import lipari from './lipari.json'
import magma from './magma.json'
import mako from './mako.json'
import navia from './navia.json'
import nih from './nih.json'
import plasma from './plasma.json'
import red from './red.json'
import redyell from './redyell.json'
import rocket from './rocket.json'
import roi_i256 from './roi_i256.json'
import slicer3d from './slicer3d.json'
import surface from './surface.json'
import thermal from './thermal.json'
import turbo from './turbo.json'
import violet from './violet.json'
import viridis from './viridis.json'
import warm from './warm.json'
import winter from './winter.json'
import x_rain from './x_rain.json'

export const lutModules = {
  './actc.json': actc,
  './afni_blues_inv.json': afni_blues_inv,
  './afni_reds_inv.json': afni_reds_inv,
  './batlow.json': batlow,
  './bcgwhw.json': bcgwhw,
  './bcgwhw_dark.json': bcgwhw_dark,
  './blue.json': blue,
  './blue2cyan.json': blue2cyan,
  './blue2magenta.json': blue2magenta,
  './blue2red.json': blue2red,
  './bluegrn.json': bluegrn,
  './bone.json': bone,
  './bronze.json': bronze,
  './cet_l17.json': cet_l17,
  './cividis.json': cividis,
  './cool.json': cool,
  './copper.json': copper,
  './copper2.json': copper2,
  './ct_airways.json': ct_airways,
  './ct_artery.json': ct_artery,
  './ct_bones.json': ct_bones,
  './ct_brain.json': ct_brain,
  './ct_brain_gray.json': ct_brain_gray,
  './ct_cardiac.json': ct_cardiac,
  './ct_head.json': ct_head,
  './ct_kidneys.json': ct_kidneys,
  './ct_liver.json': ct_liver,
  './ct_muscles.json': ct_muscles,
  './ct_scalp.json': ct_scalp,
  './ct_skull.json': ct_skull,
  './ct_soft.json': ct_soft,
  './ct_soft_tissue.json': ct_soft_tissue,
  './ct_surface.json': ct_surface,
  './ct_vessels.json': ct_vessels,
  './ct_w_contrast.json': ct_w_contrast,
  './cubehelix.json': cubehelix,
  './draw.json': draw,
  './electric_blue.json': electric_blue,
  './freesurfer.json': freesurfer,
  './ge_color.json': ge_color,
  './gold.json': gold,
  './gray.json': gray,
  './green.json': green,
  './green2cyan.json': green2cyan,
  './green2orange.json': green2orange,
  './hot.json': hot,
  './hotiron.json': hotiron,
  './hsv.json': hsv,
  './inferno.json': inferno,
  './itksnap.json': itksnap,
  './jet.json': jet,
  './kry.json': kry,
  './linspecer.json': linspecer,
  './lipari.json': lipari,
  './magma.json': magma,
  './mako.json': mako,
  './navia.json': navia,
  './nih.json': nih,
  './plasma.json': plasma,
  './red.json': red,
  './redyell.json': redyell,
  './rocket.json': rocket,
  './roi_i256.json': roi_i256,
  './slicer3d.json': slicer3d,
  './surface.json': surface,
  './thermal.json': thermal,
  './turbo.json': turbo,
  './violet.json': violet,
  './viridis.json': viridis,
  './warm.json': warm,
  './winter.json': winter,
  './x_rain.json': x_rain,
}
