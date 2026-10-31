"""Ground truth loader: HU volume, spacing, bone / vessel / heart masks for a TotalSegmentator case."""
import json
from pathlib import Path

import nibabel as nib
import numpy as np

ROOT = Path('/Users/chris/src/cinematic/TotalSegmentator')
BONE_PREFIX = ('vertebrae_', 'rib_', 'hip_', 'femur_', 'sacrum', 'sternum', 'skull', 'clavicula_', 'scapula_', 'humerus_')
VESSEL_KEYS = ('aorta', 'artery', 'vein', 'vena', 'brachiocephalic_trunk')


def is_bone(n):
  return n.startswith(BONE_PREFIX)


def is_vessel(n):
  return any(k in n for k in VESSEL_KEYS)


def load(case):
  root = ROOT / case
  img = nib.load(root / 'ct.nii.gz')
  hu = np.asarray(img.dataobj).astype(np.float32)
  spacing = np.array(img.header.get_zooms()[:3], dtype=np.float32)
  merged = root / 'ct_labels.nii.gz'
  if merged.exists():
    lab = np.asarray(nib.load(merged).dataobj).astype(np.int32)
    meta = json.load(open(root / 'ct_labels.json'))
    names = dict(zip(meta['I'], meta['labels']))
    def mask(pred):
      ids = [i for i, n in names.items() if pred(n)]
      return np.isin(lab, ids)
    bone, vessel, heart = mask(is_bone), mask(is_vessel), mask(lambda n: n == 'heart')
  else:
    bone = np.zeros(hu.shape, bool); vessel = bone.copy(); heart = bone.copy()
    for p in (root / 'segmentations').glob('*.nii.gz'):
      n = p.name[:-7]
      tgt = bone if is_bone(n) else vessel if is_vessel(n) else heart if n == 'heart' else None
      if tgt is not None:
        tgt |= np.asarray(nib.load(p).dataobj) > 0
  return hu, spacing, bone, vessel, heart


if __name__ == '__main__':
  import sys
  for case in sys.argv[1:] or ['s1212', 's1749']:
    hu, sp, bone, vessel, heart = load(case)
    band = (hu >= 150) & (hu <= 400)
    print(case, hu.shape, sp, 'band voxels', band.sum())
    for name, m in [('bone', bone), ('vessel', vessel), ('heart', heart)]:
      print(f'  {name:7s} n={m.sum():9d} medianHU={np.median(hu[m]):6.0f} inband={(m & band).sum():8d} ({(m & band).sum() / max(m.sum(), 1):.2f})')
    root = ROOT / case
    if (root / 'ct_labels.nii.gz').exists():
      lab = np.asarray(nib.load(root / 'ct_labels.nii.gz').dataobj)
      meta = json.load(open(root / 'ct_labels.json'))
      for i, n in zip(meta['I'], meta['labels']):
        if is_vessel(n) or n == 'heart':
          m = lab == i
          if m.sum():
            print(f'    {n:32s} n={m.sum():8d} med={np.median(hu[m]):5.0f} inband={(m & band).mean() * 0 + (m & band).sum() / m.sum():.2f}')
    else:
      for p in sorted((root / 'segmentations').glob('*.nii.gz')):
        n = p.name[:-7]
        if is_vessel(n) or n == 'heart':
          m = np.asarray(nib.load(p).dataobj) > 0
          if m.sum():
            print(f'    {n:32s} n={m.sum():8d} med={np.median(hu[m]):5.0f} inband={(m & band).sum() / m.sum():.2f}')
