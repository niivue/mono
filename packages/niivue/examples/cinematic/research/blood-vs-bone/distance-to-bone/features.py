"""Candidate prep-time features for blood-vs-bone in the 150-400 HU band.

Each feature is computed as a full volume, sampled at band voxels, and freed.
Radii are mm (converted per axis). Usage: python3 -I features.py s1212 -> s1212.npz
"""
import sys
import time

import numpy as np
from scipy import ndimage as ndi

BAND = (150, 400)


def vox(R, spacing):
  return [max(1, int(round(R / s))) for s in spacing]


def sobel_mag(hu, spacing):
  g2 = np.zeros(hu.shape, np.float32)
  for a in range(3):
    d = ndi.sobel(hu, axis=a, mode='nearest') / (32 * spacing[a])
    g2 += d * d
  return np.sqrt(g2)


def axis_enclosure(dense, spacing, R):
  """Per axis: nearest dense voxel before and after (mm). Returns hits (0-3 axes with both sides within R)
  and the min over axes of max(d-, d+) ("enclosure radius")."""
  hits = np.zeros(dense.shape, np.int8)
  rad = np.full(dense.shape, np.inf, np.float32)
  for a in range(3):
    n = dense.shape[a]
    idx = np.arange(n, dtype=np.int32).reshape([-1 if i == a else 1 for i in range(3)])
    where = np.where(dense, idx, -1)
    last = np.maximum.accumulate(where, axis=a)
    back = np.where(last >= 0, idx - last, 10 ** 6).astype(np.float32) * spacing[a]
    del where, last
    where = np.where(dense, idx, n * 2)
    nxt = np.flip(np.minimum.accumulate(np.flip(where, axis=a), axis=a), axis=a)
    fwd = np.where(nxt < n * 2, nxt - idx, 10 ** 6).astype(np.float32) * spacing[a]
    del where, nxt
    both = np.maximum(back, fwd)
    hits += (both <= R)
    rad = np.minimum(rad, both)
    del back, fwd, both
  return hits, rad


def closing_depth(dense, spacing, R):
  """Signed depth (mm) inside the morphological closing of `dense` by a ball of radius R: EDT(dilated) - R."""
  dil = ndi.distance_transform_edt(~dense, sampling=spacing) <= R
  return (ndi.distance_transform_edt(dil, sampling=spacing) - R).astype(np.float32)


def local_std(x, spacing, r):
  size = vox(r, spacing)
  m = ndi.uniform_filter(x, size, mode='nearest')
  m2 = ndi.uniform_filter(x * x, size, mode='nearest')
  return np.sqrt(np.maximum(m2 - m * m, 0))


def hessian_eigs(hu, spacing, sigma, idx):
  sig = sigma / spacing
  H = np.zeros((len(idx[0]), 3, 3), np.float32)
  for i in range(3):
    for j in range(i, 3):
      order = [0, 0, 0]; order[i] += 1; order[j] += 1
      d = ndi.gaussian_filter(hu, sig, order=order, mode='nearest')
      H[:, i, j] = H[:, j, i] = d[idx] * sigma * sigma
      del d
  e = np.linalg.eigvalsh(H)  # ascending
  return e[:, 0], e[:, 1], e[:, 2]


def frangi(l1, l2, l3, alpha=0.5, beta=0.5, c=100.0):
  """Bright tubular (Frangi 1998): |l1| small, l2,l3 large negative. Eigenvalues sorted by |.|."""
  a = np.stack([l1, l2, l3], 1)
  o = np.argsort(np.abs(a), 1)
  a = np.take_along_axis(a, o, 1)
  l1, l2, l3 = a[:, 0], a[:, 1], a[:, 2]
  Ra = np.abs(l2) / np.maximum(np.abs(l3), 1e-6)
  Rb = np.abs(l1) / np.maximum(np.sqrt(np.abs(l2 * l3)), 1e-6)
  S = np.sqrt(l1 * l1 + l2 * l2 + l3 * l3)
  v = (1 - np.exp(-Ra * Ra / (2 * alpha * alpha))) * np.exp(-Rb * Rb / (2 * beta * beta)) * (1 - np.exp(-S * S / (2 * c * c)))
  v[(l2 > 0) | (l3 > 0)] = 0
  return v


def profile_features(hu, spacing, g, idx, r):
  """Prior attempt (boundary-study): HU r mm up/down the gradient; |second derivative| and high endpoint."""
  coords = np.array(idx, dtype=np.float32)
  n = g[:, idx[0], idx[1], idx[2]]
  n /= np.maximum(np.linalg.norm(n, axis=0), 1e-6)
  delta = n * r / spacing[:, None]
  hi = ndi.map_coordinates(hu, coords + delta, order=1, mode='nearest')
  lo = ndi.map_coordinates(hu, coords - delta, order=1, mode='nearest')
  h = hu[idx]
  return np.abs(hi - 2 * h + lo) / (r * r), np.maximum(hi, lo)


def compute(hu, spacing, idx, log=print):
  """Returns {name: float32 array over idx}."""
  F = {}
  t0 = time.time()
  def add(name, vol):
    F[name] = vol[idx].astype(np.float32)
    log(f'  {name:18s} {time.time() - t0:6.1f}s')
  F['hu'] = hu[idx]
  g = np.stack([ndi.sobel(hu, axis=a, mode='nearest') / (32 * spacing[a]) for a in range(3)])
  add('gmag', np.sqrt((g * g).sum(0)))
  for r in (2, 4):
    d2, hi = profile_features(hu, spacing, g, idx, r)
    F[f'prof_d2_r{r}'] = d2.astype(np.float32); F[f'prof_hi_r{r}'] = hi.astype(np.float32)
  del g
  for T in (500, 600, 800):
    add(f'dist_T{T}', ndi.distance_transform_edt(hu <= T, sampling=spacing).astype(np.float32))
  for R in (3, 5, 8, 12):
    add(f'maxhu_R{R}', ndi.maximum_filter(hu, vox(R, spacing), mode='nearest'))
  for T in (500, 600):
    dense = hu > T
    for R in (15, 25):
      hits, rad = axis_enclosure(dense, spacing, R)
      add(f'enc_hits_T{T}_R{R}', hits)
      if R == 25:
        add(f'enc_rad_T{T}', rad)
    for R in (8, 12):
      add(f'close_T{T}_R{R}', closing_depth(dense, spacing, R))
  for r in (2, 3, 4):
    add(f'std_r{r}', local_std(hu, spacing, r))
  resid = hu - ndi.gaussian_filter(hu, 2.0 / spacing, mode='nearest')
  add('resid_std_r3', local_std(resid, spacing, 3)); del resid
  band = ((hu >= BAND[0]) & (hu <= BAND[1])).astype(np.float32)
  for R in (3, 5, 8):
    add(f'bandfrac_R{R}', ndi.uniform_filter(band, vox(R, spacing), mode='nearest'))
  del band
  for s in (2, 3, 4):
    l1, l2, l3 = hessian_eigs(hu, spacing, s, idx)
    F[f'hess_l3_s{s}'] = l3  # largest eigenvalue: negative inside bright blobs/tubes
    F[f'hess_l1_s{s}'] = l1
    F[f'frangi_s{s}'] = frangi(l1, l2, l3).astype(np.float32)
    F[f'blob_s{s}'] = (-(l1 + l2 + l3)).astype(np.float32)  # -trace = -Laplacian: bright convex
    log(f'  hessian s{s}        {time.time() - t0:6.1f}s')
  return F


def categories(hu, bone, vessel, heart):
  band = (hu >= BAND[0]) & (hu <= BAND[1])
  ero = ndi.binary_erosion(bone)
  dil = ndi.binary_dilation(bone)
  cat = np.zeros(hu.shape, np.int8)  # 0 other
  cat[dil & ~ero] = 3  # bone boundary (1 voxel either side)
  cat[ero] = 4  # bone interior
  cat[heart & ~dil] = 2
  cat[vessel & ~dil] = 1
  return band, cat


if __name__ == '__main__':
  from gt import load
  case = sys.argv[1]
  hu, spacing, bone, vessel, heart = load(case)
  band, cat = categories(hu, bone, vessel, heart)
  idx = np.nonzero(band)
  print(case, 'band voxels', len(idx[0]), 'cats', np.bincount(cat[idx], minlength=5))
  F = compute(hu, spacing, idx)
  np.savez_compressed(f'/Users/chris/src/mono/scratch/fable-study/{case}.npz', cat=cat[idx], idx=np.array(idx, np.int32), spacing=spacing, **F)
