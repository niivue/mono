"""Fixed-threshold curves for distance-to-dense-bone rules on all four volumes.
Rule: remove band voxel if dist(HU > T) < d mm [optionally OR inside closing(T, R)].
Usage: python3 curves.py s1212 s1749 CT_Philips CT_Abdo"""
import sys

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi

from features import categories, closing_depth
from gt import load

D = (2, 3, 4, 5, 6, 8, 10, 12)
CT = '/Users/chris/src/cinematic/ct/'


def load_any(case):
  if case.startswith('CT_'):
    n = nib.load(f'{CT}{case}.nii.gz')
    hu = np.asarray(n.dataobj).astype(np.float32)
    sp = np.array(n.header.get_zooms()[:3], np.float32)
    band = (hu >= 150) & (hu <= 450)  # preset band incl. the 400-450 edge ramp
    cat = np.zeros(hu.shape, np.int8)
    if case == 'CT_Abdo':
      cat[heart_roi(hu, sp, band)] = 1
    names = {0: 'band', 1: 'heart_roi'} if case == 'CT_Abdo' else {0: 'band'}
  else:
    hu, sp, bone, vessel, heart = load(case)
    band, cat = categories(hu, bone, vessel, heart)
    names = {1: 'vessel', 2: 'heart', 4: 'bone_int', 3: 'bone_bnd', 0: 'other'}
  return hu, sp, band, cat, names


def heart_roi(hu, sp, band):
  """CT_Abdo has no labels: heart + ascending aorta = largest 26-connected band component anterior
  of the vertebral bodies (midline dense voxels), 3 mm clear of HU > 800, re-dilated 2 voxels."""
  dense = hu > 800
  zs = slice(hu.shape[2] // 3, 2 * hu.shape[2] // 3)
  xc = np.median(np.nonzero(hu > -500)[0])
  xs, ys, _ = np.nonzero(dense[:, :, zs])
  ys = ys[np.abs(xs - xc) * sp[0] < 15]
  y_spine = np.percentile(ys[ys < np.median(ys)], 90)
  anterior = np.zeros(hu.shape, bool); anterior[:, int(y_spine + 10 / sp[1]):, :] = True
  lab, _ = ndi.label(band & anterior & (ndi.distance_transform_edt(~dense, sampling=sp) > 3), structure=np.ones((3, 3, 3)))
  big = np.argmax(np.bincount(lab.ravel())[1:]) + 1
  return ndi.binary_dilation(lab == big, iterations=2) & band


def table(dist, band, cat, names, extra=None, label=''):
  print(f'  {label:14s}' + ''.join(f'{"d<" + str(d):>8s}' for d in D))
  for c, n in names.items():
    m = band & (cat == c)
    if not m.any(): continue
    f = dist[m]; e = extra[m] if extra is not None else None
    row = [((f < d) | (e >= 0 if e is not None else False)).mean() for d in D]
    print(f'  {n:14s}' + ''.join(f'{v:8.3f}' for v in row))


if __name__ == '__main__':
  for case in sys.argv[1:]:
    hu, sp, band, cat, names = load_any(case)
    print(f'=== {case} spacing={sp.round(2)} band={band.sum()}', {n: int((band & (cat == c)).sum()) for c, n in names.items()})
    print('  removed fraction per category (rule: dist to HU>T < d mm)')
    for T in (500, 600, 700, 800, 1000):
      dist = ndi.distance_transform_edt(hu <= T, sampling=sp).astype(np.float32)
      table(dist, band, cat, names, label=f'T={T}')
      if T == 800:
        for R in (8, 12):
          cd = closing_depth(hu > T, sp, R)
          table(dist, band, cat, names, extra=cd, label=f'T800|close{R}')
          print(f'  closing alone R={R}:', {n: round(float((cd[band & (cat == c)] >= 0).mean()), 3) for c, n in names.items() if (band & (cat == c)).any()})
