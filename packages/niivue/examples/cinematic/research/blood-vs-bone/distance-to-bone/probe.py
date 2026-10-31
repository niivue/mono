"""Follow-up probes. python3 probe.py closing <case> | residual <case> | abdo | philips"""
import json
import sys

import nibabel as nib
import numpy as np
from scipy import ndimage as ndi

from curves import CT, load_any
from features import closing_depth
from png import overlay, write_png

OUT = '/Users/chris/src/mono/scratch/fable-study/'


def closing_probe(case):
  hu, sp, band, cat, names = load_any(case)
  dist = ndi.distance_transform_edt(hu <= 600, sampling=sp)
  for R in (12, 16, 20, 25):
    cd = closing_depth(hu > 600, sp, R) >= 0
    for d in (4, 8):
      rem = dist < d
      print(f'{case} T600 R={R} d<{d}: closing alone', {n: round(float(cd[band & (cat == c)].mean()), 3) for c, n in names.items()},
            '| dist|closing', {n: round(float((cd | rem)[band & (cat == c)].mean()), 3) for c, n in names.items()})


def residual(case):
  hu, sp, band, cat, names = load_any(case)
  lab = np.asarray(nib.load(f'/Users/chris/src/cinematic/TotalSegmentator/{case}/ct_labels.nii.gz').dataobj)
  meta = json.load(open(f'/Users/chris/src/cinematic/TotalSegmentator/{case}/ct_labels.json'))
  name = dict(zip(meta['I'], meta['labels']))
  dist = ndi.distance_transform_edt(hu <= 600, sampling=sp)
  keep = band & (cat == 4) & (dist >= 8)
  tot = band & (cat == 4)
  c = np.bincount(lab[keep], minlength=len(meta['I'])); t = np.bincount(lab[tot], minlength=len(meta['I']))
  o = np.argsort(c)[::-1][:12]
  print(case, 'residual bone_int after T600 d<8:', keep.sum(), 'of', tot.sum())
  for i in o:
    print(f'  {name.get(i, i):22s} kept {c[i]:7d} of {t[i]:7d} ({c[i] / max(t[i], 1):.2f})  median HU of structure {np.median(hu[lab == i]):.0f}')
  write_png(OUT + f'{case}_residual.png', overlay(hu, [(hu > 600, (90, 200, 255)), (tot, (255, 220, 0)), (keep, (255, 60, 60))], axis=0, fracs=(0.45, 0.5, 0.55)))


def abdo():
  n = nib.load(f'{CT}CT_Abdo.nii.gz'); hu = np.asarray(n.dataobj).astype(np.float32); sp = np.array(n.header.get_zooms()[:3])
  band = (hu >= 150) & (hu <= 450)
  dense = hu > 800
  # Spine y-centre from dense voxels in the middle slab; heart ROI = largest band component anterior of it.
  zs = slice(hu.shape[2] // 3, 2 * hu.shape[2] // 3)
  xc = np.median(np.nonzero(hu > -500)[0])
  xs, ys, _ = np.nonzero(dense[:, :, zs])
  ys = ys[np.abs(xs - xc) * sp[0] < 15]  # midline dense = spine + sternum
  y_spine = np.percentile(ys[ys < np.median(ys)], 90)  # anterior edge of the vertebral bodies
  anterior = np.zeros(hu.shape, bool); anterior[:, int(y_spine + 10 / sp[1]):, :] = True
  lab, _ = ndi.label(band & anterior & (ndi.distance_transform_edt(hu <= 800, sampling=sp) > 3), structure=np.ones((3, 3, 3)))
  big = np.argmax(np.bincount(lab.ravel())[1:]) + 1
  heart = ndi.binary_dilation(lab == big, iterations=2) & band
  print('CT_Abdo heart ROI voxels', heart.sum(), 'y_spine', y_spine)
  for T in (600, 800):
    dist = ndi.distance_transform_edt(hu <= T, sampling=sp)
    print(f'  T={T} heart ROI removed:', {d: round(float((dist[heart] < d).mean()), 3) for d in (2, 3, 4, 6, 8, 10, 12)})
    if T == 600:
      write_png(OUT + 'abdo_heart_roi.png', overlay(hu, [(hu > 600, (90, 200, 255)), (heart, (255, 60, 60)), (heart & (dist < 8), (255, 220, 0))], axis=2, fracs=(0.4, 0.5, 0.6)))


def philips():
  n = nib.load(f'{CT}CT_Philips.nii.gz'); hu = np.asarray(n.dataobj).astype(np.float32); sp = np.array(n.header.get_zooms()[:3])
  band = (hu >= 150) & (hu <= 450)
  dist = ndi.distance_transform_edt(hu <= 600, sampling=sp)
  keep = band & (dist >= 8)
  lab, k = ndi.label(keep, structure=np.ones((3, 3, 3)))
  sizes = np.bincount(lab.ravel())[1:]
  print('CT_Philips surviving band voxels', keep.sum(), 'components', k, 'largest (mm3)', (np.sort(sizes)[::-1][:6] * sp.prod()).round())
  write_png(OUT + 'philips_residual.png', overlay(hu, [(hu > 600, (90, 200, 255)), (band, (255, 220, 0)), (keep, (255, 60, 60))], axis=0, fracs=(0.4, 0.5, 0.6)))
  write_png(OUT + 'philips_residual_ax.png', overlay(hu, [(hu > 600, (90, 200, 255)), (band, (255, 220, 0)), (keep, (255, 60, 60))], axis=2, fracs=(0.15, 0.3, 0.5)))


if __name__ == '__main__':
  cmd = sys.argv[1]
  {'closing': lambda: closing_probe(sys.argv[2]), 'residual': lambda: residual(sys.argv[2]), 'abdo': abdo, 'philips': philips}[cmd]()
