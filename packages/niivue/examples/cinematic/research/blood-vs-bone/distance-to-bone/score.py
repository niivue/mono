"""Per-feature AUC and operating points (keep >= 90% vessel) for blood vs bone in band.
Usage: python3 score.py s1212 [s1749 ...]"""
import sys

import numpy as np
from scipy.stats import rankdata

CATS = {0: 'other', 1: 'vessel', 2: 'heart', 3: 'bone_bnd', 4: 'bone_int'}


def auc(pos, neg):
  """Mann-Whitney AUC: P(pos > neg)."""
  r = rankdata(np.concatenate([pos, neg]))
  n1, n2 = len(pos), len(neg)
  return (r[:n1].sum() - n1 * (n1 + 1) / 2) / (n1 * n2)


def operating(f, cat, keep=0.9):
  """Direction: sign making vessel > bone. Threshold keeps `keep` of vessel; returns removal fractions per category."""
  v = f[cat == 1]
  b = f[cat >= 3]
  s = 1.0 if auc(v, b) >= 0.5 else -1.0
  thr = np.quantile(s * v, 1 - keep)
  rem = {CATS[c]: float(((s * f[cat == c]) < thr).mean()) for c in CATS if (cat == c).any()}
  return s, thr, rem


def report(d, names=None):
  cat = d['cat']
  names = names or [k for k in d.files if k not in ('cat', 'idx', 'spacing')]
  print(f'{"feature":20s} {"AUC v/int":>9s} {"AUC v/bnd":>9s} {"AUC v/all":>9s} | removed@90%vessel: {"int":>5s} {"bnd":>5s} {"heart":>5s} {"other":>5s}  thr')
  rows = []
  for k in names:
    f = d[k].astype(np.float64)
    v, bi, bb = f[cat == 1], f[cat == 4], f[cat == 3]
    a_i, a_b, a_all = auc(v, bi), auc(v, bb), auc(v, np.concatenate([bi, bb]))
    s, thr, rem = operating(f, cat)
    rows.append((max(a_all, 1 - a_all), k))
    print(f'{k:20s} {a_i:9.3f} {a_b:9.3f} {a_all:9.3f} | {rem["bone_int"]:24.3f} {rem["bone_bnd"]:5.3f} {rem.get("heart", float("nan")):5.3f} {rem["other"]:5.3f}  {"<" if s > 0 else ">"} {s * thr:.3g}')
  rows.sort(reverse=True)
  print('top by AUC v/all:', ', '.join(f'{k}={a:.3f}' for a, k in rows[:8]))


if __name__ == '__main__':
  for case in sys.argv[1:]:
    d = np.load(f'/Users/chris/src/mono/scratch/fable-study/{case}.npz')
    print(f'=== {case}  n per cat:', {CATS[c]: int((d["cat"] == c).sum()) for c in CATS})
    report(d)
