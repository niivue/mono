"""Final rule, CPU reference: w = smoothstep(D0, D1, dist(HU > T)) * (0 if inside closing(T, RC) else 1).
Prints mean weight and fraction suppressed (w < 0.5) per category. python3 rule.py s1212 s1749 CT_Philips CT_Abdo"""
import sys

import numpy as np
from scipy import ndimage as ndi

from curves import load_any

T, D0, D1, RC = 600, 2.0, 8.0, 20.0


def smoothstep(a, b, x):
  t = np.clip((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)


def weight(hu, sp, T=T, D0=D0, D1=D1, RC=RC):
  dense = hu > T
  d1 = ndi.distance_transform_edt(~dense, sampling=sp)
  w = smoothstep(D0, D1, d1).astype(np.float32)
  if RC > 0:
    d2 = ndi.distance_transform_edt(d1 <= RC, sampling=sp)
    w[d2 >= RC] = 0
  return w


if __name__ == '__main__':
  for case in sys.argv[1:]:
    hu, sp, band, cat, names = load_any(case)
    for rc in (RC, 0):
      w = weight(hu, sp, RC=rc)
      print(f'{case} T={T} ramp {D0}-{D1} mm closing R={rc}:', '  '.join(
        f'{n}: mean w {w[band & (cat == c)].mean():.3f}, suppressed {(w[band & (cat == c)] < 0.5).mean():.3f}' for c, n in names.items() if (band & (cat == c)).any()))
